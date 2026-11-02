import fs from 'node:fs';
import http from 'node:http';
import {createHash} from 'node:crypto';
import pg from 'pg';
import {ConfigurationFile as configuration} from '../configuration/ConfigurationFile.mjs';
import {ServiceHosts as hosts} from '../../domain/configuration/ClusterConfiguration.mjs';
import {Lifecycle} from '../compute/Lifecycle.mjs';
import {Activity, AlwaysOn as alwaysOn} from '../../domain/compute/Activity.mjs';
import {SecretText as secretText} from '../../domain/compute/ComputeSpecification.mjs';

const state = process.env.NEON_STATE || '/state';
const project = process.env.NEON_DOCKER_PROJECT;
const network = process.env.NEON_DOCKER_NETWORK;
const volume = process.env.NEON_DOCKER_STATE_VOLUME;
if (![project, network, volume].every(value => /^[a-zA-Z0-9][a-zA-Z0-9_.-]+$/.test(value || ''))) throw Error('Docker deployment identity required');
const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
function deployment() {
  const config = configuration();
  if (config.identity) throw Error('OIDC requires the Kubernetes enterprise controller; Compose identity configuration is unsupported');
  return config;
}
async function docker(method, route, body) {
  return new Promise((resolve, reject) => {
    const request = http.request({socketPath: '/var/run/docker.sock', path: '/v1.45' + route, method,
      headers: {'Content-Type': 'application/json'}}, response => {
      const chunks = []; let size = 0;
      response.on('data', data => {size += data.length; if (size > 4 * 1024 * 1024) response.destroy(Error('Docker response limit')); else chunks.push(data);});
      response.on('error', reject);
      response.on('end', () => {
        if (response.statusCode >= 300) return reject(Object.assign(Error('Docker API HTTP ' + response.statusCode), {code: 'DOCKER_' + response.statusCode}));
        try {resolve(size ? JSON.parse(Buffer.concat(chunks).toString()) : null);} catch (error) {reject(error);}
      });
    });
    request.setTimeout(75000, () => request.destroy(Error('Docker API deadline')));
    request.on('error', reject); if (body) request.write(JSON.stringify(body)); request.end();
  });
}
const filters = labels => '?all=1&filters=' + encodeURIComponent(JSON.stringify({label: Object.entries(labels).map(([key, value]) => key + '=' + value)}));
class ComposeApi {
  constructor() {this.namespace = 'compose';}
  async list(kind) {
    if (kind !== 'configmaps') throw Error('Unsupported Compose lookup');
    const config = deployment();
    if (config.name !== project) throw Error('Compose project and config.name must match');
    if (!fs.existsSync(state + '/provisioned')) return [];
    return config.tenants.map(tenant => {
      const name = 'neon-' + tenant.endpointId;
      let status = {}; try {status = JSON.parse(fs.readFileSync(`${state}/tenants/${tenant.endpointId}/status.json`));} catch (error) {if (error.code !== 'ENOENT') throw error;}
      return {metadata: {name, uid: hash([project, tenant.tenantId, tenant.timelineId])}, data: {
        'endpoint.json': JSON.stringify({...tenant, projectId: project, branchId: tenant.name, nodeName: 'docker', image: config.computeImage,
          computeSpecSecret: tenant.endpointId + '-spec', adminSecret: tenant.endpointId + '-admin', rolesSecret: tenant.endpointId + '-roles',
          tlsSecret: tenant.endpointId + '-tls', caSecret: 'neon-service-ca'}), 'status.json': JSON.stringify(status)}};
    });
  }
  async get(kind, name) {
    if (kind !== 'secrets') throw Error('Unsupported Compose lookup');
    if (name === 'neon-service-ca') return {data: {'ca.crt': fs.readFileSync(state + '/ca.crt').toString('base64')}};
    const match = name.match(/^(ep-[a-z][a-z0-9-]*)-(roles|admin)$/);
    if (!match || !deployment().tenants.some(tenant => tenant.endpointId === match[1])) throw Error('Unknown tenant credential');
    const key = match[2] + '.json';
    return {data: {[key]: fs.readFileSync(`${state}/tenants/${match[1]}/${key}`).toString('base64')}};
  }
}
class ComposeLifecycle extends Lifecycle {
  async container(endpoint) {
    const list = await docker('GET', '/containers/json' + filters({'neon.klustr.io/cluster': project, 'neon.klustr.io/endpoint': endpoint.endpointId}));
    if (list.length > 1) throw Error('Multiple compute writers detected');
    if (!list.length) return null;
    const result = await docker('GET', '/containers/' + list[0].Id + '/json');
    if (result.Config.Labels['neon.klustr.io/writer'] !== endpoint.uid) throw Error('Writer identity mismatch');
    return result;
  }
  async status(endpoint, fields) {
    this.leader.require(); const file = `${state}/tenants/${endpoint.endpointId}/status.json`;
    endpoint.status = {...endpoint.status, ...fields, updatedAt: new Date().toISOString()};
    const descriptor = fs.openSync(file + '.tmp', 'w', 0o600);
    try {fs.writeFileSync(descriptor, JSON.stringify(endpoint.status)); fs.fsyncSync(descriptor);} finally {fs.closeSync(descriptor);}
    fs.renameSync(file + '.tmp', file);
    const directory = fs.openSync(`${state}/tenants/${endpoint.endpointId}`, 'r');
    try {fs.fsyncSync(directory);} finally {fs.closeSync(directory);}
  }
  async client(endpoint) {
    const credentials = JSON.parse(secretText(await this.api.get('secrets', endpoint.adminSecret), 'admin.json'));
    return this.connect({...credentials, database: 'postgres', host: hosts('compose').compute(endpoint.endpointId), port: 5432,
      application_name: 'neon-lifecycle-controller', connectionTimeoutMillis: 3000, query_timeout: 12000,
      ssl: {rejectUnauthorized: true, ca: fs.readFileSync(state + '/ca.crt'), servername: hosts('compose').compute(endpoint.endpointId)}});
  }
  async create(endpoint) {
    const dir = `tenants/${endpoint.endpointId}`;
    // Docker requires the image locally. Pulling is an operator/Compose action,
    // never an unbounded request on the first application connection.
    const result = await docker('POST', '/containers/create?name=' + encodeURIComponent(project + '-' + endpoint.endpointId), {
      Image: endpoint.image, User: '10001:10001',
      Labels: {'neon.klustr.io/cluster': project, 'neon.klustr.io/endpoint': endpoint.endpointId, 'neon.klustr.io/writer': endpoint.uid,
        'neon.klustr.io/compute-revision': endpoint.computeRevision,
        'com.docker.compose.project': project, 'com.docker.compose.service': 'compute-' + endpoint.endpointId},
      Env: ['OTEL_SDK_DISABLED=true'],
      Cmd: ['--dev', '--pgbin', '/opt/postgres/v18/bin/postgres', '--pgdata', '/var/lib/neon/pgdata',
        '--connstr', 'postgresql://cloud_admin@localhost/postgres', '--compute-id', endpoint.endpointId, '--config', '/run/compute-spec/config.json'],
      HostConfig: {ReadonlyRootfs: true, CapDrop: ['ALL'], SecurityOpt: ['no-new-privileges:true'],
        Memory: endpoint.resources?.dockerMemoryBytes || 2147483648, NanoCpus: (endpoint.resources?.dockerCpus || 2) * 1e9,
        ShmSize: 268435456, RestartPolicy: {Name: 'no'},
        Tmpfs: {'/tmp': 'rw,nosuid,nodev,size=268435456,uid=10001,gid=10001'},
        Mounts: [{Type: 'volume', Source: volume, Target: '/run/compute-spec', ReadOnly: true, VolumeOptions: {Subpath: dir}},
          {Type: 'volume', Source: volume, Target: '/run/compute-tls', ReadOnly: true, VolumeOptions: {Subpath: dir}},
          {Type: 'volume', Source: project + '-' + endpoint.endpointId + '-cache', Target: '/var/lib/neon'}]},
      NetworkingConfig: {EndpointsConfig: {[network]: {Aliases: [hosts('compose').compute(endpoint.endpointId)]}}}
    });
    return docker('GET', '/containers/' + result.Id + '/json');
  }
  async wake(endpoint) {return this.serialized(endpoint, async () => {
    let container = await this.container(endpoint);
    if (container && container.Config.Labels['neon.klustr.io/compute-revision'] !== endpoint.computeRevision) {
      if (container.State.Running || endpoint.status.phase !== 'Dormant') throw Error('Configuration changes require a completed suspend first');
      this.leader.require();
      // Remove only the stopped container. Its named cache volume and all
      // durable storage remain intact; Docker is never asked to remove volumes.
      await docker('DELETE', '/containers/' + container.Id + '?force=false&v=false'); container = null;
    }
    if (!container) container = await this.create(endpoint);
    if (endpoint.status.phase === 'Draining' && container.State.Running) await this.suspend(endpoint);
    container = await this.container(endpoint);
    if (!container.State.Running) {
      await this.status(endpoint, {phase: 'Waking'});
      await docker('POST', '/containers/' + container.Id + '/start');
    }
    await this.wait(endpoint, async () => {
      let client;
      try {
        client = await this.client(endpoint);
        const row = (await client.query("SELECT current_setting('server_version_num')::int AS version, pg_is_in_recovery() AS recovery, neon.bounded_commit_guard_status()::json AS guard")).rows[0];
        if (row.version < 180000 || row.version >= 190000 || row.recovery || !row.guard.enabled || !row.guard.quorum_available) return false;
        if (endpoint.status.drainedLSN && !(await client.query('SELECT pg_current_wal_insert_lsn() >= $1::pg_lsn AS recovered', [endpoint.status.drainedLSN])).rows[0].recovered) return false;
        return true;
      } catch {return false;} finally {if (client) await client.end();}
    });
    await this.status(endpoint, {phase: 'Active'});
    const hostname = hosts('compose').compute(endpoint.endpointId);
    return {address: hostname + ':5432', server_name: hostname, aux: {endpoint_id: endpoint.endpointId,
      project_id: project, branch_id: endpoint.branchId, compute_id: container.Id, cold_start_info: 'pool_miss'}};
  });}
  async suspend(endpoint) {
    if (alwaysOn(endpoint)) return;
    await this.closeActivity(endpoint);
    await this.status(endpoint, {phase: 'Draining'});
    const client = await this.client(endpoint);
    try {
      if (await this.activeClients(client)) {await this.status(endpoint, {phase: 'Active'}); return;}
      await client.query("SELECT pg_terminate_backend(pid,1000) FROM pg_stat_activity WHERE pid<>pg_backend_pid() AND backend_type='client backend' AND state='idle' AND application_name<>'neon-lifecycle-controller' AND usename<>'cloud_admin'");
      const lsn = (await client.query('SELECT neon.bounded_commit_guard_drain()::text AS lsn')).rows[0].lsn;
      if (!/^[0-9A-F]+\/[0-9A-F]+$/i.test(lsn)) throw Error('Invalid drain frontier');
      await this.status(endpoint, {drainedLSN: lsn});
    } finally {await client.end();}
    const container = await this.container(endpoint);
    this.leader.require();
    await docker('POST', '/containers/' + container.Id + '/stop?t=60');
    await this.status(endpoint, {phase: 'Dormant'});
  }
  async idle(endpoint) {return this.serialized(endpoint, async () => {
    const container = await this.container(endpoint);
    if (!container?.State.Running) return;
    if (endpoint.status.phase === 'Draining') return this.suspend(endpoint);
    let monitor = this.activity.get(endpoint.uid);
    if (!monitor) {monitor = {client: await this.client(endpoint), tracker: new Activity()}; this.activity.set(endpoint.uid, monitor);}
    try {if (monitor.tracker.observe(await this.activitySample(monitor.client), endpoint)) await this.suspend(endpoint);}
    catch (error) {await this.closeActivity(endpoint); throw error;}
  });}
}

/**
 * @typedef {Object} ComposeLeadership
 * @property {boolean} active - Whether exactly one controller container is observed running in the configured Compose project.
 * @property {string | null} lastError - Bounded Docker observation failure, without secrets.
 * @property {string} identity - Local Compose controller authority marker; not a distributed fencing token.
 * @property {() => Promise<void>} tick - Observe controller count and revoke activity when observation fails.
 * @property {() => void} require - Reject mutations unless this single-host controller currently has authority.
 */
/**
 * @typedef {Object} ComposeRuntime
 * @property {ComposeApi} api - Compose-backed endpoint definition adapter.
 * @property {ComposeLeadership} leader - Single-host mutation guard based on the controller container inventory.
 * @property {ComposeLifecycle} lifecycle - PostgreSQL/compute container lifecycle adapter.
 */
/**
 * Initialize the single-host Compose adapters and local controller authority.
 * Requires a trusted Docker-capable administrative caller; side effects load deployment state and construct adapters without starting or deleting databases.
 * @returns {Promise<ComposeRuntime>} Provider runtime selected by process composition.
 * @throws {Error} On unsupported identity configuration or unavailable deployment state.
 */
export async function ComposeRuntimeInit() {
  deployment();
  const api = new ComposeApi();
  // Refuse multiple live controllers; Compose scale-out is not a fencing system.
  const leader = {active: false, lastError: null, identity: 'compose', async tick() {
    try {const rows = await docker('GET', '/containers/json' + filters({'com.docker.compose.project': project,
      'com.docker.compose.service': 'controller'})); this.active = rows.filter(row => row.State === 'running').length === 1;}
    catch {this.active = false; this.lastError = 'DOCKER_UNAVAILABLE';}
  }, require() {if (!this.active) throw Error('Compose controller ownership unavailable');}};
  const lifecycle = new ComposeLifecycle(api, leader, async options => {
    const client = new pg.Client(options); client.on('error', () => {}); await client.connect(); return client;
  });
  return {api, leader, lifecycle};
}
