import fs from 'node:fs';
import {hosts} from './config.mjs';
import {renderSpec, secretText} from '../config.mjs';

function connection(node) {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9.:-]*$/.test(node.listen_pg_addr || '') || !Number.isInteger(node.listen_pg_port) || node.listen_pg_port < 1 || node.listen_pg_port > 65535)
    throw Error('Invalid registered storage address');
  return `host=${node.listen_pg_addr} port=${node.listen_pg_port}`;
}
export function specRouting(locate) {
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
export class StorageRouting {
  constructor({api, lifecycle, leader, getEndpoints, getConfig, compose = false}) {
    Object.assign(this, {api, lifecycle, leader, getEndpoints, getConfig, compose});
  }
  async request(method, route, body) {
    this.leader.require();
    const token = this.compose ? fs.readFileSync('/state/admin.jwt', 'utf8') : secretText(await this.api.get('secrets', 'neon-storage-config'), 'admin.jwt');
    const host = hosts(this.compose ? 'compose' : 'kubernetes', this.api.namespace).storage;
    const response = await fetch(`http://${host}:1234${route}`, {method, headers: {Authorization: 'Bearer ' + token, 'Content-Type': 'application/json'},
      ...(body === undefined ? {} : {body: JSON.stringify(body)}), signal: AbortSignal.timeout(15000)});
    if (!response.ok) throw Object.assign(Error('Storage API HTTP ' + response.status), {code: 'STORAGE_' + response.status});
    return response.status === 204 ? null : response.json();
  }
  async notify(type, value) {
    this.leader.require();
    const config = await this.getConfig();
    const tenants = config.tenants.filter(row => row.tenantId === value?.tenant_id && (type !== 'safekeepers' || row.timelineId === value.timeline_id));
    if (!tenants.length) throw Error('Notification for unknown tenant');
    const updates = {};
    if (type === 'attach') {
      if (!Array.isArray(value.shards) || !value.shards.length || value.shards.length > 32) throw Error('Invalid placement notification');
      const registered = new Map();
      for (const shard of value.shards) {
        if (!Number.isSafeInteger(shard.node_id) || !config.storage.pageservers.some(node => node.id === shard.node_id)) throw Error('Unconfigured pageserver');
        if (!registered.has(shard.node_id)) registered.set(shard.node_id, await this.request('GET', '/control/v1/node/' + shard.node_id));
      }
      Object.assign(updates, specRouting({shard_params: {count: value.shards.length, stripe_size: value.stripe_size || 2048},
        shards: value.shards.map(shard => ({...registered.get(shard.node_id), shard_number: shard.shard_number, shard_id: String(shard.shard_number)}))}));
    } else {
      if (!Number.isSafeInteger(value.generation) || value.generation < 1 || !Array.isArray(value.safekeepers) || value.safekeepers.length < 3) throw Error('Invalid safekeeper membership');
      const nodes = await this.request('GET', '/control/v1/safekeeper');
      updates.safekeeper_connstrings = value.safekeepers.map(member => {
        const node = nodes.find(node => node.id === member.id);
        if (!node) throw Error('Unregistered safekeeper');
        connection({listen_pg_addr: node.host, listen_pg_port: node.port});
        return `${node.host}:${node.port}`;
      });
      updates.safekeepers_generation = value.generation;
    }
    for (const tenant of tenants) {
    const endpoint = [...this.getEndpoints().values()].find(endpoint => endpoint.endpointId === tenant.endpointId);
    const apply = async () => {
      this.leader.require();
      let spec;
      if (this.compose) spec = JSON.parse(fs.readFileSync(`/state/tenants/${tenant.endpointId}/spec.json`));
      else spec = JSON.parse(secretText(await this.api.get('secrets', tenant.name + '-compute-spec'), 'spec.json'));
      if (type === 'safekeepers' && (spec.safekeepers_generation || 0) > value.generation) throw Error('Stale safekeeper generation');
      Object.assign(spec, updates);
      if (this.compose) {
        const dir = `/state/tenants/${tenant.endpointId}`;
        for (const [name, data] of Object.entries({'spec.json': spec, 'config.json': {spec: renderSpec(spec, tenant), compute_ctl_config: {jwks: {keys: []}, tls: null}}})) {
          fs.writeFileSync(dir + '/' + name + '.tmp', JSON.stringify(data), {mode: 0o600}); fs.renameSync(dir + '/' + name + '.tmp', dir + '/' + name);
        }
      } else {
        const name = tenant.name + '-compute-spec', current = await this.api.get('secrets', name);
        await this.api.patch('secrets', name, {metadata: {resourceVersion: current.metadata.resourceVersion}, data: {'spec.json': Buffer.from(JSON.stringify(spec)).toString('base64')}});
      }
      if (!endpoint) return; // Persisted before its first compute is created.
      let client;
      if (this.compose) {if (!(await this.lifecycle.container(endpoint))?.State.Running) return; client = await this.lifecycle.client(endpoint);}
      else {
        const deployment = await this.api.optional('deployments', endpoint.name);
        if (!deployment || deployment.spec.replicas === 0) return;
        const pods = await this.lifecycle.pods(endpoint);
        if (pods.length !== 1 || !this.lifecycle.ready(pods[0])) throw Error('Compute is not ready for storage reconfiguration');
        client = await this.lifecycle.admin(endpoint, pods[0]);
      }
      try {
        const values = type === 'attach' ? {'neon.stripe_size': String(spec.shard_stripe_size), 'neon.pageserver_connstring': spec.pageserver_connstring}
          : {'neon.safekeepers': `g#${spec.safekeepers_generation}:` + spec.safekeeper_connstrings.join(',')};
        for (const [name, text] of Object.entries(values)) await client.query(`ALTER SYSTEM SET ${name} = '${text.replaceAll("'", "''")}'`);
        await client.query('SELECT pg_reload_conf()');
        for (let attempt = 0; attempt < 20; attempt++) {
          this.leader.require();
          const applied = (await client.query('SELECT current_setting($1) AS value', [Object.keys(values).at(-1)])).rows[0].value;
          if (applied === Object.values(values).at(-1)) {this.lifecycle.readyCache.delete(endpoint.uid); return;}
          await new Promise(resolve => setTimeout(resolve, 100));
        }
        throw Error('Storage settings have not reloaded');
      } finally {await client.end();}
    };
    if (endpoint) await this.lifecycle.serialized(endpoint, apply);
    else await apply();
    }
  }
}
