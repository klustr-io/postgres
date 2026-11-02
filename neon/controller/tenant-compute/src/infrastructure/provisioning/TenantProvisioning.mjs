// Deployment initialization is ordinary source, shared by Compose and Kubernetes.
// State/Secrets are retained across reruns; this code never deletes storage data.
import fs from 'node:fs';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import {generateKeyPairSync, randomBytes, sign, pbkdf2Sync, createHmac, createHash} from 'node:crypto';
import {ServiceHosts as hosts} from '../../domain/configuration/ClusterConfiguration.mjs';
import {RenderComputeSpec as renderSpec, SecretText as secretText} from '../../domain/compute/ComputeSpecification.mjs';
import {ComputeOAuth, OAuthHba} from '../../domain/identity/ComputeOAuth.mjs';

/**
 * @typedef {Object} ProvisioningInvocation
 * @property {ReturnType<import('../configuration/ConfigurationFile.mjs').ConfigurationFile>} config - Validated deployment configuration.
 * @property {() => void} requireLeader - Lease assertion, called before side effects.
 * @property {string} platform - Deployment platform.
 * @property {string} namespace - Kubernetes namespace.
 * @property {string} state - Private scratch directory.
 * @property {import('../kubernetes/Kubernetes.mjs').Kubernetes | null} api - Kubernetes adapter, or null for Compose.
 */

/**
 * Execute a provisioning command with invocation-owned configuration and adapters.
 * @param {'init' | 'provision' | 'reconcile'} operation - Provisioning command.
 * @param {ProvisioningInvocation} invocation - Explicit invocation dependencies.
 * @returns {Promise<void>} Resolves after requested provisioning side effects.
 */
export async function ExecuteProvisioning(operation, {config, requireLeader, platform, namespace, state, api}) {
requireLeader();
const host = hosts(platform, namespace);
const read = name => fs.readFileSync(path.join(state, name), 'utf8');
function write(name, value) {
  const file = path.join(state, name); fs.mkdirSync(path.dirname(file), {recursive: true, mode: 0o700});
  const descriptor = fs.openSync(file + '.tmp', 'w', 0o600);
  try {fs.writeFileSync(descriptor, typeof value === 'string' ? value : JSON.stringify(value)); fs.fsyncSync(descriptor);} finally {fs.closeSync(descriptor);}
  fs.renameSync(file + '.tmp', file);
}
function jwt(key, scope, tenant_id) {
  const body = Buffer.from(JSON.stringify({scope, ...(tenant_id ? {tenant_id} : {})})).toString('base64url');
  const message = Buffer.from('eyJhbGciOiJFZERTQSIsInR5cCI6IkpXVCJ9.' + body);
  return message + '.' + sign(null, message, key).toString('base64url');
}
function scram(password) {
  const salt = randomBytes(16), salted = pbkdf2Sync(password, salt, 4096, 32, 'sha256');
  const client = createHmac('sha256', salted).update('Client Key').digest();
  return `SCRAM-SHA-256$4096:${salt.toString('base64')}$${createHash('sha256').update(client).digest('base64')}:${createHmac('sha256', salted).update('Server Key').digest('base64')}`;
}
function certificate(name, dns, usage = 'serverAuth') {
  const run = args => execFileSync('/usr/bin/openssl', args, {cwd: state, stdio: ['ignore', 'ignore', 'pipe']});
  // Service FQDNs can exceed the X.509 common-name limit; identity is in SAN.
  run(['req', '-new', '-newkey', 'rsa:2048', '-nodes', '-keyout', name + '.key', '-out', name + '.csr', '-subj', '/CN=Neon service']);
  write(name + '.ext', 'subjectAltName=' + dns.map(value => 'DNS:' + value).join(',') + '\nextendedKeyUsage=' + usage + '\nbasicConstraints=CA:FALSE\n');
  run(['x509', '-req', '-in', name + '.csr', '-CA', 'ca.crt', '-CAkey', 'ca.key', '-set_serial', '0x' + randomBytes(16).toString('hex'),
    '-out', name + '.crt', '-days', '365', '-extfile', name + '.ext']);
}
async function secret(name, data, createOnly = true) {
  requireLeader();
  const existing = await api.optional('secrets', name);
  if (existing && existing.metadata.labels?.['neon.klustr.io/cluster'] !== config.name) throw Error('Secret belongs to a different deployment: ' + name);
  if (existing && (createOnly || JSON.stringify(existing.data) === JSON.stringify(Object.fromEntries(Object.entries(data).map(([key, value]) => [key, Buffer.from(value).toString('base64')]))))) return existing;
  const body = {apiVersion: 'v1', kind: 'Secret', metadata: {name, labels: {'neon.klustr.io/cluster': config.name}}, type: 'Opaque',
    data: Object.fromEntries(Object.entries(data).map(([key, value]) => [key, Buffer.from(value).toString('base64')]))};
  if (existing) return api.patch('secrets', name, {...body, metadata: {...body.metadata, resourceVersion: existing.metadata.resourceVersion}});
  return api.create('secrets', body);
}
async function initialize() {
await RestoreBootstrapState();
InitializeServiceCredentials();
for (const tenant of process.env.NEON_INITIALIZE_ONLY === 'true' ? [] : config.tenants) await InitializeTenantCredentials(tenant);
if(api)await PersistServiceSecrets();else FinalizeComposeFiles();
console.log('Deployment credentials and storage configuration initialized; no credentials logged');
}
async function RestoreBootstrapState() {
fs.mkdirSync(state, {recursive: true, mode: 0o700});
  if (api) {
    const existing = await api.optional('secrets', 'neon-bootstrap-state');
    if (existing) for (const [name, value] of Object.entries(existing.data)) write(name, Buffer.from(value, 'base64').toString());
  }
}
function InitializeServiceCredentials() {
const identity = JSON.stringify({name: config.name, s3: config.s3, domain: config.domain, platform, namespace});
  if (fs.existsSync(path.join(state, 'identity.json')) && read('identity.json') !== identity)
    throw Error('Existing deployment identity differs; changing storage location/domain requires an explicit migration');
  write('identity.json', identity);
  if (!fs.existsSync(path.join(state, 'storage.key'))) {
    const keys = generateKeyPairSync('ed25519');
    write('storage.key', keys.privateKey.export({type: 'pkcs8', format: 'pem'}));
    write('storage.pub', keys.publicKey.export({type: 'spki', format: 'pem'}));
  }
  const key = read('storage.key');
  if (!fs.existsSync(path.join(state, 'ca.key'))) {
    execFileSync('/usr/bin/openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '3650',
      '-keyout', path.join(state, 'ca.key'), '-out', path.join(state, 'ca.crt'), '-subj', '/CN=Neon deployment CA',
      '-addext', 'basicConstraints=critical,CA:TRUE', '-addext', 'keyUsage=critical,keyCertSign,cRLSign'], {stdio: ['ignore', 'ignore', 'pipe']});
  }
  for (const [name, dns] of [['controller', [...new Set([host.controller, 'neon-controller'])]], ['proxy', ['*.' + config.domain]]])
    if (!fs.existsSync(path.join(state, name + '.key')) || !fs.existsSync(path.join(state, name + '.crt'))) certificate(name, dns);
  if (!fs.existsSync(path.join(state, 'keda-client.key')) || !fs.existsSync(path.join(state, 'keda-client.crt'))) certificate('keda-client', ['neon-keda'], 'clientAuth');
  for (const name of ['metadata-password', 'controller-token', 'management-token'])
    if (!fs.existsSync(path.join(state, name))) write(name, randomBytes(32).toString('hex'));
  write('admin.jwt', jwt(key, 'admin')); write('pageserver.jwt', jwt(key, 'pageserverapi'));
  write('safekeeper.jwt', jwt(key, 'safekeeperdata')); write('generations.jwt', jwt(key, 'generations_api'));
  write('peer.jwt', jwt(key, 'controller_peer'));
  const q = JSON.stringify;
  const remote = role => '{bucket_name=' + q(config.s3.bucket) + ',bucket_region=' + q(config.s3.region) +
    ',prefix_in_bucket=' + q(config.s3.prefix + '/' + role) + ',endpoint=' + q(config.s3.endpoint) + '}';
  write('remote.toml', remote('safekeeper'));
  write('pageserver.toml', `listen_pg_addr="0.0.0.0:6400"
listen_http_addr="0.0.0.0:9898"
pg_distrib_dir="/opt/postgres"
http_auth_type="NeonJWT"
pg_auth_type="NeonJWT"
grpc_auth_type="NeonJWT"
auth_validation_public_key_path="/run/neon/storage.pub"
broker_endpoint=${q('http://' + host.broker + ':50051')}
control_plane_api=${q('http://' + host.storage + ':1234/upcall/v1/')}
control_plane_api_token=${q(read('generations.jwt'))}
virtual_file_io_engine="std-fs"
page_cache_size=32768
remote_storage=${remote('pageserver')}
`);
}
async function RestoreTenantSecrets(tenant, dir) {

      const client = await api.optional('secrets', tenant.name + '-client');
      if (!client && await api.optional('secrets', tenant.name + '-roles')) throw Object.assign(Error('Existing verifier has no matching client credential; restore its client Secret'), {code: 'CREDENTIALS_INCOMPLETE'});
      for (const [secretName, files] of [[tenant.name + '-client', {password: 'password'}],
        [tenant.name + '-admin', {'admin.json': 'admin.json'}], [tenant.name + '-roles', {'roles.json': 'roles.json'}],
        [tenant.name + '-compute-spec', {'spec.json': 'spec.json'}],
        [tenant.name + '-compute-tls', {'tls.crt': 'tls.crt', 'tls.key': 'tls.key'}]]) {
        const previous = await api.optional('secrets', secretName);
        if (previous) for (const [key, file] of Object.entries(files)) write(dir + '/' + file, Buffer.from(previous.data[key], 'base64').toString());
      }
      if (fs.existsSync(path.join(state, dir, 'admin.json')))
        write(dir + '/admin-password', JSON.parse(read(dir + '/admin.json')).password);

}
async function InitializeTenantCredentials(tenant) {
const dir = 'tenants/' + tenant.endpointId;
if(api)await RestoreTenantSecrets(tenant,dir);
if (!fs.existsSync(path.join(state, dir, 'password'))) {
      write(dir + '/password', randomBytes(24).toString('hex'));
      write(dir + '/admin-password', randomBytes(24).toString('hex'));
    }
    if (!fs.existsSync(path.join(state, dir, 'tls.key')) || !fs.existsSync(path.join(state, dir, 'tls.crt'))) certificate(dir + '/tls', [host.compute(tenant.endpointId)]);
    const oauth = ComputeOAuth(config.identity, {name: tenant.name, database: tenant.database, namespace});
    if (oauth && api) {
      const previous = await api.optional('secrets', oauth.secret);
      if (previous) {
        write(dir + '/oauth-client.crt', secretText(previous, 'validator.crt'));
        write(dir + '/oauth-client.key', secretText(previous, 'validator.key'));
      } else certificate(dir + '/oauth-client', [host.compute(tenant.endpointId)], 'clientAuth');
      await secret(oauth.secret, {'pg_hba.conf': OAuthHba(oauth), 'validator.crt': read(dir + '/oauth-client.crt'),
        'validator.key': read(dir + '/oauth-client.key'), 'ca.crt': read('ca.crt')}, false);
    }
    write(dir + '/ca.crt', read('ca.crt'));
    const verifier = fs.existsSync(path.join(state, dir, 'roles.json')) ? JSON.parse(read(dir + '/roles.json'))[tenant.user] : scram(read(dir + '/password'));
    if (!verifier) throw Error('Changing an existing tenant role requires explicit credential migration');
const spec = TenantComputeSpec(tenant,dir,verifier);
write(dir + '/spec.json', spec);
    write(dir + '/admin.json', {user: 'neon_lifecycle', password: read(dir + '/admin-password')});
    write(dir + '/roles.json', {[tenant.user]: verifier});
    write(dir + '/config.json', {spec: renderSpec(spec, tenant), compute_ctl_config: {jwks: {keys: []}, tls: null}});
if(api)await PersistTenantSecrets(tenant,dir,spec);
}
function TenantComputeSpec(tenant, dir, verifier) {
const key=read('storage.key');
const previous = fs.existsSync(path.join(state, dir, 'spec.json')) ? JSON.parse(read(dir + '/spec.json')) : null;
    if (previous && (previous.tenant_id !== tenant.tenantId || previous.timeline_id !== tenant.timelineId)) throw Error('Existing tenant storage identity is immutable');
    const spec = {format_version: 1, mode: 'Primary', tenant_id: tenant.tenantId, timeline_id: tenant.timelineId,
      pageserver_connstring: `host=${host.pageserver} port=6400`, safekeeper_connstrings: host.safekeepers.map(host => host + ':5454'),
      storage_auth_token: jwt(key, 'tenant', tenant.tenantId), cluster: {
        roles: [{name: tenant.user, encrypted_password: verifier, options: []},
          {name: 'neon_lifecycle', encrypted_password: previous?.cluster.roles.find(role => role.name === 'neon_lifecycle')?.encrypted_password || scram(read(dir + '/admin-password')), options: [{name: 'SUPERUSER', value: null, vartype: 'string'}]}],
        databases: [{name: tenant.database, owner: tenant.user, options: []}], settings: [
          ...(tenant.settings || []).filter(option => option.name !== 'shared_preload_libraries'),
          {name: 'shared_preload_libraries', value: [...new Set(['neon', ...((tenant.settings || []).find(option => option.name === 'shared_preload_libraries')?.value || '').split(',').filter(Boolean)])].join(','), vartype: 'string'}]}};
    for (const key of ['pageserver_connstring', 'pageserver_connection_info', 'shard_stripe_size', 'safekeeper_connstrings', 'safekeepers_generation'])
      if (previous?.[key] !== undefined) spec[key] = previous[key];
return spec;
}
async function PersistTenantSecrets(tenant, dir, spec) {
// Persist matching client credentials before publishing any verifier.

      // Persist the matching client password before any verifier/spec Secrets.
      // A partial first run must not invent a password for an existing verifier.
      await secret(tenant.name + '-client', {password: read(dir + '/password'), user: tenant.user, database: tenant.database});
      await secret(tenant.name + '-compute-spec', {'spec.json': JSON.stringify(spec)}, false);
      await secret(tenant.name + '-admin', {'admin.json': read(dir + '/admin.json')});
      await secret(tenant.name + '-roles', {'roles.json': read(dir + '/roles.json')});
      await secret(tenant.name + '-compute-tls', {'tls.crt': read(dir + '/tls.crt'), 'tls.key': read(dir + '/tls.key')});

}
async function PersistServiceSecrets() {

    await secret('neon-service-ca', {'ca.crt': read('ca.crt')});
    await secret('neon-controller-tls', {'tls.crt': read('controller.crt'), 'tls.key': read('controller.key')});
    await secret('neon-proxy-tls', {'tls.crt': read('proxy.crt'), 'tls.key': read('proxy.key')});
    await secret('neon-controller-auth', {token: read('controller-token')});
    await secret('neon-management-auth', {token: read('management-token')});
    await secret('neon-keda-client-tls', {'ca.crt': read('ca.crt'), 'tls.crt': read('keda-client.crt'), 'tls.key': read('keda-client.key')});
    await secret('neon-metadata', {password: read('metadata-password')});
    await secret('neon-storage-config', {'admin.jwt': read('admin.jwt')}, false);
    for (const [name, files] of Object.entries(serviceFiles()))
      await secret('neon-' + name + '-config', Object.fromEntries(files.map(name => [name, read(name)])), false);
    const files = fs.readdirSync(state).filter(name => fs.statSync(path.join(state, name)).isFile() && !name.endsWith('.csr'));
    await secret('neon-bootstrap-state', Object.fromEntries(files.map(name => [name, read(name)])), false);

}
function FinalizeComposeFiles() {

    for (const [service, files] of Object.entries(serviceFiles())) for (const file of files) write(service + '/' + file, read(file));
    for (const file of ['ca.crt', 'controller-token', 'proxy.crt', 'proxy.key']) write('proxy/' + file, read(file));
    write('metadata/password', read('metadata-password'));
    // A new named volume starts root-owned. Only the init service runs as root.
    const own = dir => {fs.chmodSync(dir, 0o700); fs.chownSync(dir, 10001, 10001);
      for (const entry of fs.readdirSync(dir)) {const file = path.join(dir, entry);
        if (fs.statSync(file).isDirectory()) own(file); else {fs.chmodSync(file, 0o600); fs.chownSync(file, 10001, 10001);}}};
    own(state);

}


function serviceFiles() {
  return {'pageserver': ['storage.pub', 'safekeeper.jwt', 'pageserver.toml'],
    'safekeeper': ['storage.pub', 'safekeeper.jwt', 'remote.toml'],
    'storage-controller': ['storage.pub', 'pageserver.jwt', 'safekeeper.jwt', 'peer.jwt', 'controller-token']};
}

async function request(method, route, body, accepted = []) {
  requireLeader();
  const response = await fetch('http://' + host.storage + ':1234' + route, {method,
    headers: {Authorization: 'Bearer ' + read('admin.jwt'), 'Content-Type': 'application/json'},
    ...(body === undefined ? {} : {body: JSON.stringify(body)}), signal: AbortSignal.timeout(15000)});
  if (!response.ok && !accepted.includes(response.status)) throw Error('Storage API ' + route + ': HTTP ' + response.status);
  return response;
}
async function retry(operation) {
  const deadline = Date.now() + 240000;
  while (true) {try {return await operation();} catch (error) {if (Date.now() >= deadline) throw error; await new Promise(resolve => setTimeout(resolve, 1000));}}
}
async function provision() {
if (api) {
    const data = (await api.get('secrets', 'neon-storage-config')).data;
    for (const [name, value] of Object.entries(data)) write(name, Buffer.from(value, 'base64').toString());
  }
  await retry(() => request('GET', '/control/v1/node'));
  for (const node of config.storage.pageservers) {
    const hostname = node.host.includes('.') || platform === 'compose' ? node.host : node.host + `.${namespace}.svc.cluster.local`;
    await retry(() => request('POST', '/control/v1/node', {node_id: node.id, listen_pg_addr: hostname, listen_pg_port: 6400,
      listen_http_addr: hostname, listen_http_port: 9898, availability_zone_id: node.zone || 'zone-1'}));
  }
  for (const [index, hostname] of host.safekeepers.entries()) await retry(() => request('POST', '/control/v1/safekeeper/' + (index + 1), {
    id: index + 1, region_id: config.s3.region, version: 1, host: hostname, port: 5454, http_port: 7676,
    availability_zone_id: config.storage.safekeeperZones?.[index] || 'zone-' + (index + 1)}));
for(const tenant of config.tenants)await ProvisionTenant(tenant);
if (!api) write('provisioned', config.name);
}
async function ProvisionTenant(tenant) {
await EnsureStorageTenant(tenant);
await EnsureTimeline(tenant);
await ConfigureTenantRouting(tenant);
if(api&&!await PersistEndpointDefinition(tenant))return;
console.log('Provisioned ' + tenant.endpointId);
}
async function EnsureStorageTenant(tenant) {
let existing = await request('GET', '/control/v1/tenant/' + tenant.tenantId, undefined, [404]);
    if (tenant.storagePolicy.placement_policy.Attached >= config.storage.pageservers.length) throw Object.assign(Error('Tier requires more pageservers'), {code: 'INSUFFICIENT_STORAGE_CAPACITY'});
    if (existing.status === 404) await retry(async () => {
      const check = await request('GET', '/control/v1/tenant/' + tenant.tenantId, undefined, [404]);
      if (check.status === 404) await request('POST', '/v1/tenant', {new_tenant_id: tenant.tenantId,
        ...tenant.storagePolicy, shard_parameters: {count: tenant.shards === 1 ? 0 : tenant.shards, stripe_size: 2048}});
    });
    else {
      await request('PATCH', '/v1/tenant/config', {tenant_id: tenant.tenantId, checkpoint_timeout: tenant.storagePolicy.checkpoint_timeout,
        pitr_interval: tenant.storagePolicy.pitr_interval, timeline_get_throttle: tenant.storagePolicy.timeline_get_throttle});
      await request('PUT', '/control/v1/tenant/' + tenant.tenantId + '/policy', {placement: tenant.storagePolicy.placement_policy});
    }
}
async function EnsureTimeline(tenant) {
await retry(async () => {
      const timelines = await request('GET', '/v1/tenant/' + tenant.tenantId + '/timeline');
      const rows = await timelines.json();
      if (!Array.isArray(rows)) throw Error('Invalid timeline inventory');
      const existing = rows.find(row => row.timeline_id === tenant.timelineId);
      if (!existing) await request('POST', '/v1/tenant/' + tenant.tenantId + '/timeline', {new_timeline_id: tenant.timelineId, pg_version: 18,
        ...(tenant.ancestorTimelineId ? {ancestor_timeline_id: tenant.ancestorTimelineId, ancestor_start_lsn: tenant.ancestorLSN} : {})});
      else if (tenant.ancestorTimelineId && (existing.ancestor_timeline_id !== tenant.ancestorTimelineId ||
          existing.ancestor_lsn?.toUpperCase() !== tenant.ancestorLSN.toUpperCase())) throw Error('Existing branch ancestry differs');
    });
}
async function ConfigureTenantRouting(tenant) {
const locate = await (await request('GET', '/debug/v1/tenant/' + tenant.tenantId + '/locate')).json();
    const currentShards = locate.shard_params.count || 1;
    if (tenant.shards > currentShards) await request('PUT', '/control/v1/tenant/' + tenant.tenantId + '/shard_split', {new_shard_count: tenant.shards});
    const {SpecRouting: specRouting} = await import('../storage/StorageRouting.mjs');
    const actual = tenant.shards > currentShards ? await (await request('GET', '/debug/v1/tenant/' + tenant.tenantId + '/locate')).json() : locate;
    const dir = 'tenants/' + tenant.endpointId, spec = JSON.parse(api ? secretText(await api.get('secrets', tenant.name + '-compute-spec'), 'spec.json') : read(dir + '/spec.json'));
    Object.assign(spec, specRouting(actual));
    write(dir + '/spec.json', spec); write(dir + '/config.json', {spec: renderSpec(spec, tenant), compute_ctl_config: {jwks: {keys: []}, tls: null}});
    if (api) await secret(tenant.name + '-compute-spec', {'spec.json': JSON.stringify(spec)}, false);
}
async function PersistEndpointDefinition(tenant) {

      const endpoint = {endpointId: tenant.endpointId, projectId: config.name, branchId: tenant.name,
        nodeName: tenant.nodeName || config.computeNode, image: config.computeImage, profile: tenant.profile,
        computeSpecSecret: tenant.name + '-compute-spec', adminSecret: tenant.name + '-admin', rolesSecret: tenant.name + '-roles',
        tlsSecret: tenant.name + '-compute-tls', caSecret: 'neon-service-ca', allowedIps: tenant.allowedIps,
        suspend: tenant.suspend, databasePolicies: tenant.databasePolicies, resources: tenant.resources,
        databaseResource: tenant.databaseResource, tier: tenant.tier, size: tenant.size,
        oauth: ComputeOAuth(config.identity, {name: tenant.name, database: tenant.database, namespace}),
        specRevision: createHash('sha256').update(JSON.stringify([tenant.settings, tenant.profile])).digest('hex')};
      const name = 'neon-' + tenant.endpointId, current = await api.optional('configmaps', name);
      if (current && current.metadata.labels?.['neon.klustr.io/cluster'] !== config.name)
        throw Error('Endpoint belongs to a different deployment: ' + name);
      const data = {'endpoint.json': JSON.stringify(endpoint)};
      if (current && current.data['endpoint.json'] === data['endpoint.json']) return false;
      if (current) await api.patch('configmaps', name, {metadata: {resourceVersion: current.metadata.resourceVersion}, data});
      else await api.create('configmaps', {apiVersion: 'v1', kind: 'ConfigMap', metadata: {name,
        labels: {'neon.klustr.io/endpoint': 'true', 'neon.klustr.io/cluster': config.name}}, data});

return true;
}

  if (operation === 'init' || operation === 'reconcile') {requireLeader(); await initialize();}
  if (operation === 'provision' || operation === 'reconcile') {requireLeader(); await provision();}
  if (!['init', 'provision', 'reconcile'].includes(operation)) throw Error('Expected init or provision');
  requireLeader();
}

/**
 * Reconcile validated tenant configuration using the caller's Kubernetes adapter.
 * Importing this module performs no filesystem reads or client construction.
 * @param {ReturnType<import('../configuration/ConfigurationFile.mjs').ConfigurationFile>} next - Desired tenant configuration.
 * @param {() => void} guard - Lease assertion before every mutation boundary.
 * @param {import('../kubernetes/Kubernetes.mjs').Kubernetes} api - Namespace adapter owned by the caller.
 * @returns {Promise<void>} Resolves after credentials and storage are provisioned.
 * @throws {Error} On lease loss, identity changes or provider failures.
 */
export async function ReconcileTenants(next, guard, api) {
  if (!api) throw Error('Kubernetes provisioning adapter required');
  await ExecuteProvisioning('reconcile', {config: next, requireLeader: guard, api, platform: 'kubernetes',
    namespace: api.namespace, state: process.env.NEON_STATE || '/state'});
}
