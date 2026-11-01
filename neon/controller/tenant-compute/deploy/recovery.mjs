// Native timelines provide copy-on-write branches and retained recovery points.
// They share the primary object store: this is not an independent DR copy.
import {createHash} from 'node:crypto';
import {secretText} from '../config.mjs';
import {lsn, remoteDurable} from './fleet.mjs';

export const resourceName = value => typeof value === 'string' && /^[a-z][a-z0-9-]{0,38}$/.test(value);
export const problem = (code, message = code) => Object.assign(Error(message), {code});
export function recoveryPolicy(value = {}) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(key => !['historySeconds', 'scheduleSeconds', 'retentionSeconds'].includes(key))) throw problem('INVALID_SPEC');
  const policy = {historySeconds: 604800, scheduleSeconds: 0, retentionSeconds: 604800, ...value};
  for (const [key, min, max] of [['historySeconds', 0, 2592000], ['scheduleSeconds', 0, 2592000], ['retentionSeconds', 300, 31536000]])
    if (!Number.isInteger(policy[key]) || policy[key] < min || policy[key] > max) throw problem('INVALID_SPEC');
  if (policy.scheduleSeconds && (policy.scheduleSeconds < 300 || policy.retentionSeconds < policy.scheduleSeconds)) throw problem('INVALID_SPEC');
  return policy;
}
export function branchSource(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(key => !['database', 'backup', 'lsn', 'timestamp'].includes(key)) || !resourceName(value.database)) throw problem('INVALID_SPEC');
  if (value.backup !== undefined && !resourceName(value.backup)) throw problem('INVALID_SPEC');
  if ([value.backup, value.lsn, value.timestamp].filter(value => value !== undefined).length > 1) throw problem('INVALID_SPEC');
  if (value.lsn !== undefined) try {lsn(value.lsn);} catch {throw problem('INVALID_SPEC');}
  if (value.timestamp !== undefined && (typeof value.timestamp !== 'string' || !/^\d{4}-\d\d-\d\dT.*(?:Z|[+-]\d\d:\d\d)$/.test(value.timestamp) || !Number.isFinite(Date.parse(value.timestamp)) || Date.parse(value.timestamp) > Date.now())) throw problem('INVALID_SPEC');
  return value;
}
const id = text => createHash('sha256').update(text).digest('hex').slice(0, 32);
export class Recovery {
  constructor({databases, routing, api, leader, lifecycle, getEndpoints, emit}) {
    Object.assign(this, {databases, routing, api, leader, lifecycle, getEndpoints, emit});
    this.resources = new Map(); this.busy = false; this.pending = 0;
  }
  async load() {this.resources = new Map((await this.api.list('neonbackups', '')).map(resource => [resource.metadata.name, resource]));}
  async status(name, values) {
    this.leader.require(); const current = await this.api.get('neonbackups', name);
    await this.api.request('PATCH', this.api.path('neonbackups', name) + '/status', {metadata: {resourceVersion: current.metadata.resourceVersion}, status: {...current.status, ...values}});
  }
  async storage(operation) {
    this.pending++;
    try {if (this.databases.fleet) await this.databases.fleet.ensureActive(); this.leader.require(); return await operation();}
    finally {this.pending--;}
  }
  source(name) {
    const resource = this.databases.resources.get(name);
    if (!resource || resource.metadata.deletionTimestamp || resource.spec.deletionPolicy === 'Delete' || resource.status?.phase === 'Deleted' || !resource.status?.provisioningRevision) throw problem('SOURCE_NOT_READY');
    return {resource, tenant: this.databases.tenant(resource, this.databases.base())};
  }
  async point(source, selection = {}) {
    const route = `/v1/tenant/${source.tenant.tenantId}/timeline/${source.tenant.timelineId}`;
    if (selection.timestamp) {
      const result = await this.routing.request('GET', route + '/get_lsn_by_timestamp?' + new URLSearchParams({timestamp: selection.timestamp}));
      // Never silently substitute a future/past boundary for a requested time.
      if (result.kind !== 'present') throw problem('RESTORE_POINT_UNAVAILABLE');
      selection = {lsn: result.lsn};
    }
    let frontier = selection.lsn;
    if (!frontier) {
      const endpoint = [...this.getEndpoints().values()].find(endpoint => endpoint.databaseResource === source.resource.metadata.name);
      if (!endpoint) throw problem('SOURCE_NOT_READY');
      frontier = endpoint.status.drainedLSN || '0/0';
      const deployment = await this.api.optional('deployments', endpoint.name);
      if (deployment?.spec.replicas) await this.lifecycle.serialized(endpoint, async () => {
        const pods = await this.lifecycle.pods(endpoint);
        if (pods.length !== 1 || !this.lifecycle.ready(pods[0])) throw problem('SOURCE_NOT_READY');
        const client = await this.lifecycle.admin(endpoint, pods[0]);
        try {frontier = (await client.query('SELECT pg_current_wal_insert_lsn()::text AS lsn')).rows[0].lsn;} finally {await client.end();}
      });
      const state = await this.routing.request('GET', `/control/v1/tenant/${source.tenant.tenantId}/timeline/${source.tenant.timelineId}`);
      if (!state.shards?.length) throw problem('SOURCE_NOT_READY');
      // Capture the current shard-zero record boundary when a compute never ran.
      if (lsn(frontier) === 0n) frontier = state.shards[0].last_record_lsn;
      if (state.shards.some(shard => lsn(shard.last_record_lsn) < lsn(frontier))) throw problem('RECOVERY_CATCHUP_PENDING');
    }
    lsn(frontier);
    // Explicit all-shard lease closes the timestamp lookup/GC race. Expired or
    // pruned history fails here rather than returning an incomplete clone.
    await this.routing.request('POST', route + '/lsn_lease', {lsn: frontier});
    return frontier;
  }
  async prepareBranch(resource, tenant) {
    const selection = branchSource(resource.spec.branchFrom), source = this.source(selection.database);
    if (resource.status?.source && resource.status.source.databaseUID !== source.resource.metadata.uid) throw problem('SOURCE_IDENTITY_CHANGED');
    let ancestor = source.tenant.timelineId, point = resource.status?.source?.lsn;
    if (resource.status?.source) {
      const rows = await this.routing.request('GET', `/v1/tenant/${tenant.tenantId}/timeline`);
      if (rows.some(row => row.timeline_id === tenant.timelineId)) {
        tenant.ancestorTimelineId = resource.status.source.timelineId; tenant.ancestorLSN = point; return;
      }
    }
    if (selection.backup) {
      const backup = await this.api.get('neonbackups', selection.backup);
      if (backup.spec.database !== selection.database || backup.metadata.deletionTimestamp || backup.status?.phase !== 'Ready' || backup.status.databaseUID !== source.resource.metadata.uid) throw problem('BACKUP_NOT_READY');
      ancestor = backup.status.timelineId; point = backup.status.lsn;
    }
    if (!point) point = await this.point(source, selection);
    else await this.routing.request('POST', `/v1/tenant/${source.tenant.tenantId}/timeline/${ancestor}/lsn_lease`, {lsn: point});
    const descriptor = {database: selection.database, databaseUID: source.resource.metadata.uid, tenantId: source.tenant.tenantId, timelineId: ancestor, lsn: point};
    await this.databases.status(resource.metadata.name, {source: descriptor});
    tenant.ancestorTimelineId = ancestor; tenant.ancestorLSN = point;
  }
  async create(database, name, {retentionSeconds} = {}) {
    this.leader.require();
    if (!resourceName(name)) throw problem('INVALID_SPEC');
    await this.databases.load(); const source = this.source(database);
    const retention = retentionSeconds ?? recoveryPolicy(source.resource.spec.backup).retentionSeconds;
    if (!Number.isInteger(retention) || retention < 300 || retention > 31536000) throw problem('INVALID_SPEC');
    const existing = await this.api.optional('neonbackups', name);
    if (existing) {
      if (existing.spec.database !== database || existing.spec.databaseUID !== source.resource.metadata.uid || existing.spec.retentionSeconds !== retention) throw problem('BACKUP_NAME_CONFLICT');
      return existing;
    }
    return this.api.create('neonbackups', {apiVersion: 'neon.klustr.io/v1alpha1', kind: 'NeonBackup', metadata: {name},
      spec: {database, databaseUID: source.resource.metadata.uid, retentionSeconds: retention}});
  }
  async history(name) {
    await this.databases.load(); const source = this.source(name);
    return this.storage(async () => ({historySeconds: Number.parseInt(source.tenant.storagePolicy.pitr_interval),
      ...(await this.routing.request('GET', `/control/v1/tenant/${source.tenant.tenantId}/timeline/${source.tenant.timelineId}`))}));
  }
  async reconcile() {
    if (this.busy || !this.leader.active) return; this.busy = true;
    try {
      await this.load();
      for (const resource of this.databases.resources.values()) {
        try {
        if (resource.metadata.deletionTimestamp || resource.spec.lifecycle === 'retired' || resource.spec.branchFrom || !resource.status?.provisioningRevision) continue;
        const policy = recoveryPolicy(resource.spec.backup);
        if (!policy.scheduleSeconds) continue;
        const bucket = Math.floor(Date.now() / (policy.scheduleSeconds * 1000));
        const name = 'auto-' + id(resource.metadata.uid).slice(0, 12) + '-' + bucket;
        // Missed slots are coalesced: no retrospective synthetic backups.
        if (!this.resources.has(name)) await this.create(resource.metadata.name, name);
        } catch (error) {this.emit('backup_schedule_deferred', {database: resource.metadata.name, reason: error.code || 'SCHEDULE_UNAVAILABLE'});}
      }
      await this.load();
      for (const resource of this.resources.values()) try {
        const name = resource.metadata.name;
        if (resource.status?.phase === 'Deleted') continue;
        if (!resource.metadata.finalizers?.includes('neon.klustr.io/backup')) {
          await this.api.patch('neonbackups', name, {metadata: {resourceVersion: resource.metadata.resourceVersion, finalizers: [...(resource.metadata.finalizers || []), 'neon.klustr.io/backup']}});
          continue;
        }
        const expiresAt = new Date(Date.parse(resource.metadata.creationTimestamp) + resource.spec.retentionSeconds * 1000).toISOString();
        if (resource.metadata.deletionTimestamp || Date.parse(expiresAt) <= Date.now()) {
          await this.remove(resource); continue;
        }
        if (resource.status?.phase === 'Ready') continue;
        await this.storage(async () => {
          const source = this.source(resource.spec.database);
          if (source.resource.metadata.uid !== resource.spec.databaseUID) throw problem('SOURCE_IDENTITY_CHANGED');
          const timelineId = id('backup:' + resource.metadata.uid), point = resource.status?.lsn || await this.point(source);
          await this.status(name, {phase: 'Creating', tenantId: source.tenant.tenantId, timelineId, lsn: point, databaseUID: resource.spec.databaseUID, expiresAt});
          const route = `/v1/tenant/${source.tenant.tenantId}/timeline`;
          const rows = await this.routing.request('GET', route);
          const existing = rows.find(row => row.timeline_id === timelineId);
          if (!existing) {
            await this.routing.request('POST', route + '/' + source.tenant.timelineId + '/lsn_lease', {lsn: point});
            await this.routing.request('POST', route, {new_timeline_id: timelineId, ancestor_timeline_id: source.tenant.timelineId, ancestor_start_lsn: point, read_only: true, pg_version: 18});
          } else if (existing.ancestor_timeline_id !== source.tenant.timelineId || lsn(existing.ancestor_lsn) !== lsn(point)) throw problem('BACKUP_IDENTITY_CHANGED');
          const state = await this.routing.request('GET', `/control/v1/tenant/${source.tenant.tenantId}/timeline/${timelineId}`);
          if (!state.shards?.length || state.shards.some(shard => !remoteDurable(shard, point))) throw problem('RECOVERY_UPLOAD_PENDING');
          await this.status(name, {phase: 'Ready', readyAt: new Date().toISOString(), reason: null});
        });
      } catch (error) {await this.status(resource.metadata.name, {phase: resource.status?.phase || 'Pending', reason: error.code || 'RECOVERY_PENDING'});}
    } catch (error) {this.emit('recovery_deferred', {reason: error.code || 'RECOVERY_UNAVAILABLE'});} finally {this.busy = false;}
  }
  async remove(resource) {
    const name = resource.metadata.name;
    if ([...this.databases.resources.values()].some(row => row.status?.phase !== 'Deleted' && row.spec.branchFrom?.backup === name)) {
      await this.status(name, {reason: 'DEPENDENT_BRANCHES'}); return;
    }
    if (resource.status?.timelineId) await this.storage(async () => {
      try {await this.routing.request('DELETE', `/v1/tenant/${resource.status.tenantId}/timeline/${resource.status.timelineId}`);} catch (error) {if (error.code !== 'STORAGE_404') throw error;}
    });
    await this.status(name, {phase: 'Deleted', reason: null});
    const current = await this.api.get('neonbackups', name);
    await this.api.patch('neonbackups', name, {metadata: {resourceVersion: current.metadata.resourceVersion, finalizers: (current.metadata.finalizers || []).filter(value => value !== 'neon.klustr.io/backup')}});
    if (!current.metadata.deletionTimestamp) await this.api.request('DELETE', this.api.path('neonbackups', name), {preconditions: {uid: current.metadata.uid}});
  }
}
