import fs from 'node:fs';
import {ServiceHosts as hosts} from '../../domain/configuration/ClusterConfiguration.mjs';
import {RenderComputeSpec as renderSpec, SecretText as secretText} from '../../domain/compute/ComputeSpecification.mjs';

function connection(node) {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9.:-]*$/.test(node.listen_pg_addr || '') || !Number.isInteger(node.listen_pg_port) || node.listen_pg_port < 1 || node.listen_pg_port > 65535)
    throw Error('Invalid registered storage address');
  return `host=${node.listen_pg_addr} port=${node.listen_pg_port}`;
}
/**
 * @typedef {Object} RegisteredShardRoute
 * @property {string} listen_pg_addr - Registered internal pageserver PostgreSQL hostname or address.
 * @property {number} listen_pg_port - Registered PostgreSQL port, from one to 65535.
 * @property {string} shard_id - Native shard identity used for deterministic ordering.
 * @property {number} [shard_number] - Explicit zero-based shard number, otherwise decoded from shard_id.
 */
/**
 * @typedef {Object} ShardParameters
 * @property {number} count - Supported power-of-two shard count, one through 32.
 * @property {number} stripe_size - Positive native page stripe size.
 */
/**
 * @typedef {Object} LocatedTenantShards
 * @property {ShardParameters} shard_params - Native shard topology.
 * @property {RegisteredShardRoute[]} shards - Complete registered routing map.
 */
/**
 * @typedef {Object} NativePageRouting
 * @property {null} pageserver_connection_info - Legacy routing field cleared for explicit connection strings.
 * @property {string} pageserver_connstring - Ordered comma-separated pageserver connection strings.
 * @property {number} shard_stripe_size - Validated native stripe size.
 */
/**
 * Convert a complete contiguous native shard map into compute routing settings.
 * The owning application boundary authorizes the storage lookup; this pure transformation has no persistence side effects.
 * @param {LocatedTenantShards} locate - Registered pageserver addresses and native shard topology.
 * @returns {NativePageRouting} Deterministically ordered compute routing fields.
 * @throws {Error} When shards are incomplete, non-contiguous, unsupported or have invalid addresses/stripe size.
 */
export function SpecRouting(locate) {
  const count = locate.shard_params?.count || 1;
  if (![1, 2, 4, 8, 16, 32].includes(count) || locate.shards?.length !== count) throw Error('Incomplete storage shard map');
  const shards = [...locate.shards].sort((a, b) => a.shard_number - b.shard_number || a.shard_id.localeCompare(b.shard_id));
  for (const [index, node] of shards.entries()) {
    const number = node.shard_number ?? (node.shard_id.includes('-') ? parseInt(node.shard_id.slice(-4, -2), 16) : 0);
    if (number !== index) throw Error('Non-contiguous shard map');
  }
  const stripe = locate.shard_params.stripe_size;
  if (!Number.isSafeInteger(stripe) || stripe < 1 || stripe > 2147483647) throw Error('Invalid storage stripe size');
  return {pageserver_connection_info: null, pageserver_connstring: shards.map(connection).join(','), shard_stripe_size: stripe};
}
/**
 * @typedef {Object} AttachedShard
 * @property {number} node_id - Provider-configured pageserver identity.
 * @property {number} shard_number - Zero-based placement position.
 */
/**
 * @typedef {Object} AttachmentNotification
 * @property {string} tenant_id - Managed native tenant whose routing changed.
 * @property {AttachedShard[]} shards - Complete new placement map.
 * @property {number} [stripe_size] - New stripe size; defaults to 2048 when omitted.
 */
/**
 * @typedef {Object} SafekeeperMember
 * @property {number} id - Registered native WAL voter identity.
 */
/**
 * @typedef {Object} SafekeeperNotification
 * @property {string} tenant_id - Managed native tenant identity.
 * @property {string} timeline_id - Managed timeline whose quorum changed.
 * @property {number} generation - Positive monotonic membership generation.
 * @property {SafekeeperMember[]} safekeepers - At least three registered WAL members.
 */
/**
 * @typedef {Object} StorageRoutingDependencies
 * @property {import('../kubernetes/Kubernetes.mjs').Kubernetes | import('../compose/ComposeRuntime.mjs').ComposeRuntime['api']} api - Namespace or Compose state repository.
 * @property {import('../compute/Lifecycle.mjs').Lifecycle | import('../compose/ComposeRuntime.mjs').ComposeRuntime['lifecycle']} lifecycle - Endpoint serialization and active compute SQL access.
 * @property {Pick<import('../kubernetes/Kubernetes.mjs').Leadership, 'require'>} leader - Current lease mutation guard.
 * @property {() => Map<string, import('../../domain/compute/ComputeSpecification.mjs').ComputeEndpoint>} getEndpoints - Current endpoint routing inventory.
 * @property {() => Promise<import('../../domain/configuration/ClusterConfiguration.mjs').ClusterConfiguration>} getConfig - Current effective managed tenant and storage topology.
 * @property {boolean} [compose] - Read and persist private local files instead of Kubernetes Secrets.
 */
/** Apply trusted storage topology changes to persisted specifications and already-running computes. */
export class StorageRouting {
  /** @param {StorageRoutingDependencies} dependencies - Storage authority, topology and endpoint serialization ports. */
  constructor({api, lifecycle, leader, getEndpoints, getConfig, compose = false}) {
    Object.assign(this, {api, lifecycle, leader, getEndpoints, getConfig, compose});
  }
  /**
   * Call the fixed internal storage controller using its provider-owned administrative token.
   * Requires active lease authorization; side effects depend on the requested native control route.
   * Token material is loaded from the private Compose state file or namespace Secret and never returned in errors.
   * @param {'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE'} method - Native control API operation.
   * @param {string} route - Provider-selected internal route, never a caller-selected destination URL.
   * @param {unknown} [body] - Native API JSON payload, omitted for operations without a body.
   * @returns {Promise<unknown>} Untrusted native JSON response, or null for HTTP 204; callers validate the relevant shape.
   * @throws {Error} On lost lease, credential read, fifteen-second deadline, non-success HTTP status or invalid response JSON.
   */
  async request(method, route, body) {
    this.leader.require();
    const token = this.compose ? fs.readFileSync('/state/admin.jwt', 'utf8') : secretText(await this.api.get('secrets', 'neon-storage-config'), 'admin.jwt');
    const host = hosts(this.compose ? 'compose' : 'kubernetes', this.api.namespace).storage;
    const response = await fetch(`http://${host}:1234${route}`, {method, headers: {Authorization: 'Bearer ' + token, 'Content-Type': 'application/json'},
      ...(body === undefined ? {} : {body: JSON.stringify(body)}), signal: AbortSignal.timeout(15000)});
    if (!response.ok) throw Object.assign(Error('Storage API HTTP ' + response.status), {code: 'STORAGE_' + response.status});
    return response.status === 204 ? null : response.json();
  }
  /**
   * Reconcile trusted attachment or safekeeper membership notifications for managed tenants only.
   * Requires service authorization at the owning application boundary and an active lease here.
   * Side effects serialize per endpoint, persist new routing, and reload SQL settings only on active computes; sleeping computes remain asleep.
   * @param {'attach' | 'safekeepers'} type - Native notification family selected by the authenticated router.
   * @param {AttachmentNotification | SafekeeperNotification} value - Native tenant topology notification, validated before persistence.
   * @returns {Promise<void>} Resolves after matching tenant specifications and active computes are updated.
   * @throws {Error} On unknown tenant, unconfigured nodes, invalid/stale generation, invalid shard map, persistence failure or reload timeout.
   */
  async notify(type, value) {
    this.leader.require();
    const config = await this.getConfig();
    const tenants = config.tenants.filter(row => row.tenantId === value?.tenant_id && (type !== 'safekeepers' || row.timelineId === value.timeline_id));
    if (!tenants.length) throw Error('Notification for unknown tenant');
    const updates = type === 'attach' ? await this.#attachmentUpdates(value, config) : await this.#safekeeperUpdates(value);
    for (const tenant of tenants) await this.#applyTenantRouting(tenant, type, value, updates);
  }
  async #attachmentUpdates(value, config) {
      if (!Array.isArray(value.shards) || !value.shards.length || value.shards.length > 32) throw Error('Invalid placement notification');
      const registered = new Map();
      for (const shard of value.shards) {
        if (!Number.isSafeInteger(shard.node_id) || !config.storage.pageservers.some(node => node.id === shard.node_id)) throw Error('Unconfigured pageserver');
        if (!registered.has(shard.node_id)) registered.set(shard.node_id, await this.request('GET', '/control/v1/node/' + shard.node_id));
      }
      return SpecRouting({shard_params: {count: value.shards.length, stripe_size: value.stripe_size || 2048},
        shards: value.shards.map(shard => ({...registered.get(shard.node_id), shard_number: shard.shard_number, shard_id: String(shard.shard_number)}))});
  }
  async #safekeeperUpdates(value) {
      if (!Number.isSafeInteger(value.generation) || value.generation < 1 || !Array.isArray(value.safekeepers) || value.safekeepers.length < 3) throw Error('Invalid safekeeper membership');
      const nodes = await this.request('GET', '/control/v1/safekeeper');
      const safekeeper_connstrings = value.safekeepers.map(member => {
        const node = nodes.find(node => node.id === member.id);
        if (!node) throw Error('Unregistered safekeeper');
        connection({listen_pg_addr: node.host, listen_pg_port: node.port});
        return `${node.host}:${node.port}`;
      });
      return {safekeeper_connstrings, safekeepers_generation: value.generation};
  }
  async #applyTenantRouting(tenant, type, value, updates) {
    const endpoint = [...this.getEndpoints().values()].find(endpoint => endpoint.endpointId === tenant.endpointId);
    const apply = async () => {
      this.leader.require();
      let spec;
      if (this.compose) spec = JSON.parse(fs.readFileSync(`/state/tenants/${tenant.endpointId}/spec.json`));
      else spec = JSON.parse(secretText(await this.api.get('secrets', tenant.name + '-compute-spec'), 'spec.json'));
      if (type === 'safekeepers' && (spec.safekeepers_generation || 0) > value.generation) throw Error('Stale safekeeper generation');
      Object.assign(spec, updates);
      await this.#persistSpec(tenant, spec);
      if (endpoint) await this.#reconfigureEndpoint(endpoint, type, spec);
    };
    if (endpoint) await this.lifecycle.serialized(endpoint, apply);
    else await apply();
  }
  async #persistSpec(tenant, spec) {
      if (this.compose) {
        const dir = `/state/tenants/${tenant.endpointId}`;
        for (const [name, data] of Object.entries({'spec.json': spec, 'config.json': {spec: renderSpec(spec, tenant), compute_ctl_config: {jwks: {keys: []}, tls: null}}})) {
          fs.writeFileSync(dir + '/' + name + '.tmp', JSON.stringify(data), {mode: 0o600}); fs.renameSync(dir + '/' + name + '.tmp', dir + '/' + name);
        }
      } else {
        const name = tenant.name + '-compute-spec', current = await this.api.get('secrets', name);
        await this.api.patch('secrets', name, {metadata: {resourceVersion: current.metadata.resourceVersion}, data: {'spec.json': Buffer.from(JSON.stringify(spec)).toString('base64')}});
      }
  }
  async #activeClient(endpoint) {
      if (this.compose) {
        if (!(await this.lifecycle.container(endpoint))?.State.Running) return null;
        return this.lifecycle.client(endpoint);
      }
        const deployment = await this.api.optional('deployments', endpoint.name);
        if (!deployment || deployment.spec.replicas === 0) return;
        const pods = await this.lifecycle.pods(endpoint);
        if (pods.length !== 1 || !this.lifecycle.ready(pods[0])) throw Error('Compute is not ready for storage reconfiguration');
        return this.lifecycle.admin(endpoint, pods[0]);
  }
  async #reconfigureEndpoint(endpoint, type, spec) {
      const client = await this.#activeClient(endpoint);
      if (!client) return;
      try {
        const values = type === 'attach' ? {'neon.stripe_size': String(spec.shard_stripe_size), 'neon.pageserver_connstring': spec.pageserver_connstring}
          : {'neon.safekeepers': `g#${spec.safekeepers_generation}:` + spec.safekeeper_connstrings.join(',')};
        await this.#reloadSettings(client, values);
        this.lifecycle.invalidateReady(endpoint);
      } finally {await client.end();}
  }
  async #reloadSettings(client, values) {
    for (const [name, text] of Object.entries(values)) await client.query(`ALTER SYSTEM SET ${name} = '${text.replaceAll("'", "''")}'`);
    await client.query('SELECT pg_reload_conf()');
    for (let attempt = 0; attempt < 20; attempt++) {
      this.leader.require();
      const applied = (await client.query('SELECT current_setting($1) AS value', [Object.keys(values).at(-1)])).rows[0].value;
      if (applied === Object.values(values).at(-1)) return;
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    throw Error('Storage settings have not reloaded');
  }
}
