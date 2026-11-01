// The shared storage fleet is a separate drain-aware KEDA target. Compute
// dormancy alone never grants permission to discard the last warm WAL copies.
import {secretText} from '../config.mjs';
export function lsn(value) {
  if (typeof value !== 'string' || !/^[0-9A-F]{1,8}\/[0-9A-F]{1,8}$/i.test(value)) throw Error('Missing durability frontier');
  const [high, low] = value.split('/'); return (BigInt('0x' + high) << 32n) + BigInt('0x' + low);
}
export function remoteDurable(shard, frontier) {
  const required=lsn(frontier)>lsn(shard.last_record_lsn)?lsn(frontier):lsn(shard.last_record_lsn);
  // "visible" has survived storage-controller generation validation. The
  // current generation's projected frontier may be zero after a reattach even
  // when the previous generation already uploaded all of these pages.
  return lsn(shard.remote_consistent_lsn_visible)>=required;
}
export class StorageFleet {
  constructor({api, leader, databases, routing, getEndpoints, emit}) {
    Object.assign(this, {api, leader, databases, routing, getEndpoints, emit});
    this.busy = false; this.pending = 0; this.active = false; this.current = null; this.scaler = null;
  }
  members() {
    const base = this.databases.base();
    return [{kind: 'statefulsets', name: 'metadata'}, {kind: 'deployments', name: 'storage-broker'},
      {kind: 'deployments', name: 'storage-controller'},
      ...base.storage.pageservers.map(node => ({kind: 'statefulsets', name: node.resourceName || node.host.split('.')[0]})),
      ...[1, 2, 3].map(id => ({kind: 'statefulsets', name: 'safekeeper-' + id}))];
  }
  async status(values) {
    this.leader.require();
    const resource = await this.api.get('neonstoragefleets', 'storage');
    const result = await this.api.request('PATCH', this.api.path('neonstoragefleets', 'storage') + '/status', {
      metadata: {resourceVersion: resource.metadata.resourceVersion}, status: {...resource.status, ...values, updatedAt: new Date().toISOString()}});
    this.current = result; this.active = result.status.phase === 'Active';
  }
  async scale(member, replicas) {
    this.leader.require(); const resource = await this.api.get(member.kind, member.name);
    if (resource.spec.replicas === replicas) return;
    await this.api.patch(member.kind, member.name, {metadata: {resourceVersion: resource.metadata.resourceVersion}, spec: {replicas}});
  }
  async ready(member) {
    const resource = await this.api.get(member.kind, member.name);
    return resource.spec.replicas === 1 && (resource.status?.readyReplicas || 0) >= 1 &&
      resource.status.observedGeneration >= resource.metadata.generation;
  }
  async demand() {
    this.leader.require();
    if (this.pending || this.databases.backendWork || this.databases.recovery?.pending || this.databases.pendingConnections?.size) return true;
    const base=this.databases.base();
    for (const resource of this.databases.resources.values()) {
      if (resource.status?.phase === 'Deleted') continue;
      if (['suspended', 'retired'].includes(resource.spec.lifecycle)) {
        if (resource.spec.deletionPolicy === 'Delete') return true;
        continue;
      }
      if (resource.metadata.deletionTimestamp) {if (resource.status?.replicas) return true; continue;}
      if (resource.spec.replicas === 1 || Date.parse(resource.status?.event?.until || '') > Date.now()) return true;
      let tenant; try {tenant = this.databases.tenant(resource, base);} catch {continue;}
      if (tenant.suspend.mode === 'never' || Object.values(tenant.databasePolicies).some(policy => policy.mode === 'never')) return true;
      if (this.databases.revision(resource, tenant, base) !== resource.status?.provisioningRevision) return true;
    }
    for (const endpoint of this.getEndpoints().values()) if (['Active', 'Waking', 'Draining'].includes(endpoint.status.phase)) return true;
    return false;
  }
  async ensureActive() {
    this.leader.require(); this.pending++; this.scaler?.publish('@fleet', true);
    const deadline = Date.now() + 180000;
    try {
      while (Date.now() < deadline) {
        this.leader.require();
        if (this.active) return;
        void this.reconcile(); await new Promise(resolve => setTimeout(resolve, 250));
      }
      throw Object.assign(Error('Storage fleet wake deadline'), {code: 'STORAGE_WAKE_TIMEOUT'});
    } finally {this.pending--;}
  }
  async proof() {
    const known = new Map(), frontiers = {};
    for (const endpoint of this.getEndpoints().values()) {
      const deployment = await this.api.optional('deployments', endpoint.name);
      if (deployment?.spec.replicas) throw Error('Compute remains present');
      if ((await this.api.list('pods', 'neon.klustr.io/endpoint-uid=' + endpoint.uid)).length) throw Error('Compute Pod is still terminating');
      const spec = JSON.parse(secretText(await this.api.get('secrets', endpoint.computeSpecSecret), 'spec.json'));
      const timelines = known.get(spec.tenant_id) || new Map();
      if (this.databases.resources.get(endpoint.databaseResource)?.status?.phase === 'Deleted') continue;
      timelines.set(spec.timeline_id, endpoint.status.drainedLSN || '0/0'); known.set(spec.tenant_id, timelines);
    }
    // Backups are native read-only timelines without compute endpoints.
    if (this.databases.recovery) {
      await this.databases.recovery.load();
      for (const backup of this.databases.recovery.resources.values()) if (backup.status?.timelineId && backup.status.phase !== 'Deleted') {
        const timelines = known.get(backup.status.tenantId) || new Map();
        timelines.set(backup.status.timelineId, backup.status.lsn); known.set(backup.status.tenantId, timelines);
      }
    }
    const tenants = await this.routing.request('GET', '/control/v1/tenant');
    if (!Array.isArray(tenants)) throw Error('Unknown storage inventory');
    for (const tenant of tenants) {
      const expected = known.get(tenant.tenant_id);
      if (!expected) throw Error('Unmanaged storage tenant prevents fleet shutdown');
      const timelines = await this.routing.request('GET', '/v1/tenant/' + tenant.tenant_id + '/timeline');
      if (!Array.isArray(timelines) || timelines.some(timeline => !expected.has(timeline.timeline_id))) throw Error('Unmanaged timeline prevents fleet shutdown');
      for (const timeline of timelines) {
        const frontier = expected.get(timeline.timeline_id);
        const state = await this.routing.request('GET', `/control/v1/tenant/${tenant.tenant_id}/timeline/${timeline.timeline_id}`);
        if (!state.shards?.length) throw Error('Missing storage durability state');
        for (const shard of state.shards) {
          if (!remoteDurable(shard,frontier)) throw Object.assign(Error('Waiting for S3 upload'), {code: 'REMOTE_DURABILITY_PENDING'});
        }
        frontiers[tenant.tenant_id + ':' + timeline.timeline_id] = frontier;
      }
    }
    return frontiers;
  }
  async register() {
    const base = this.databases.base(), suffix = '.' + this.api.namespace + '.svc.cluster.local';
    for (const node of base.storage.pageservers) {
      const host = node.host.includes('.') ? node.host : node.host + suffix;
      await this.routing.request('POST', '/control/v1/node', {node_id: node.id, listen_pg_addr: host, listen_pg_port: 6400,
        listen_http_addr: host, listen_http_port: 9898, availability_zone_id: node.zone || 'zone-1'});
    }
  }
  async reconcile() {
    if (this.busy || !this.leader.active) return; this.busy = true;
    try {
      const resource = await this.api.get('neonstoragefleets', 'storage'); this.current = resource;
      const demand = await this.demand(); this.scaler?.publish('@fleet', demand);
      const members = this.members();
      if (resource.spec.replicas === 1) {
        if (this.active && resource.status?.phase === 'Active') return;
        await this.status({phase: 'Starting', replicas: 1, selector: 'neon.klustr.io/storage-fleet=storage', reason: null, remoteDurabilityVerifiedAt: null});
        await this.scale(members[0], 1); await this.scale(members[1], 1);
        if (!await this.ready(members[0])) return;
        for (const member of members.slice(2)) await this.scale(member, 1);
        if (!await this.ready(members[2])) return;
        await this.register();
        if (!(await Promise.all(members.map(member => this.ready(member)))).every(Boolean)) return;
        await this.status({phase: 'Active', replicas: 1});
        return;
      }
      if(demand)return; // KEDA owns the requested 0/1 state; never stop pending work.
      const objects = await Promise.all(members.map(member => this.api.get(member.kind, member.name)));
      if (objects.every(object => object.spec.replicas === 0)) {
        const remaining = await this.api.list('pods', 'app in ('+members.map(member=>member.name).join(',')+')');
        if (!remaining.length) await this.status({phase: 'Dormant', replicas: 0, reason: null});
        return;
      }
      await this.status({phase: 'Draining', replicas: 1});
      if (!resource.status?.remoteDurabilityVerifiedAt) {
        const frontiers = await this.proof();
        await this.status({phase: 'Draining', remoteDurabilityVerifiedAt: new Date().toISOString(), frontiers, reason: null});
      }
      // Stop the metadata database last. A new request aborts the remaining stop
      // sequence; the next pass brings the full dependency chain back up.
      for (const member of [...members.slice(2), members[1], members[0]]) {
        if (await this.demand()) return;
        await this.scale(member, 0);
      }
    } catch (error) {
      this.emit('storage_fleet_deferred', {reason: error.code || 'FLEET_NOT_QUIESCENT'});
      if (this.leader.active) try {await this.status({phase: 'WaitingForDurability', reason: error.code || 'FLEET_NOT_QUIESCENT'});} catch {}
    } finally {this.busy = false;}
  }
}
