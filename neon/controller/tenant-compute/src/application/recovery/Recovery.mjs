// Native timelines provide copy-on-write branches and retained recovery points.
// They share the primary object store: this is not an independent DR copy.
import {createHash} from 'node:crypto';
import {WalLsn as lsn, RemoteDurable as remoteDurable} from '../../domain/storage/WalDurability.mjs';
import {ResourceName as resourceName, DomainProblem as problem, BranchSource as branchSource} from '../../domain/recovery/RecoveryPolicy.mjs';
const id = text => createHash('sha256').update(text).digest('hex').slice(0, 32);
/**
 * @typedef {Object} RecoverySource
 * @property {import('../../domain/database/DatabaseContracts.mjs').DatabaseResource} resource - Validated provisioned source database identity.
 * @property {import('../../domain/configuration/ClusterConfiguration.mjs').ClusterTenant} tenant - Resolved native tenant, timeline and retention policy.
 */
/**
 * @typedef {Object} RecoverySelection
 * @property {string} [timestamp] - Exact retained timestamp to resolve and lease.
 * @property {string} [lsn] - Explicit retained WAL frontier; omission captures the current source boundary.
 */
/**
 * @typedef {Object} BackupReference
 * @property {string} database - Source managed database name.
 * @property {string} [phase] - Observed backup lifecycle phase, absent before reconciliation.
 */
/**
 * @typedef {Object} RecoveryHistory
 * @property {number} historySeconds - Effective source retention interval.
 * @property {Record<string, unknown>[]} [shards] - Native per-shard history and frontier observations, not an HA guarantee.
 */
/**
 * @typedef {Object} RecoveryDependencies
 * @property {import('../database/Databases.mjs').Databases['load']} reloadDatabases - Refresh source identities before user commands and deletion checks.
 * @property {import('../database/Databases.mjs').Databases['definitions']} databaseDefinitions - Copied managed database inventory for scheduling and dependency protection.
 * @property {import('../database/Databases.mjs').Databases['definition']} findDatabase - Copied source definition lookup.
 * @property {import('../database/Databases.mjs').Databases['resolve']} resolveTenant - Resolve inherited storage and retention policy.
 * @property {import('../database/Databases.mjs').Databases['status']} recordDatabaseStatus - Persist immutable branch ancestry before native provisioning.
 * @property {() => Promise<void>} requireServingFleet - Reject new recovery work while the enclosing fleet retires.
 * @property {() => Promise<void>} ensureStorageActive - Wake and wait for shared storage.
 * @property {Pick<import('../../infrastructure/storage/StorageRouting.mjs').StorageRouting, 'request'>} routing - Authenticated native timeline operations.
 * @property {import('../../infrastructure/kubernetes/Kubernetes.mjs').Kubernetes} api - Namespace backup repository and workload observations.
 * @property {import('../../infrastructure/kubernetes/Kubernetes.mjs').Leadership} leader - Current controller lease guard.
 * @property {import('../../infrastructure/compute/Lifecycle.mjs').Lifecycle} lifecycle - Serialized source SQL inspection without an implicit compute wake.
 * @property {() => Map<string, import('../../domain/compute/ComputeSpecification.mjs').ComputeEndpoint>} getEndpoints - Source compute inventory and persisted drain boundaries.
 * @property {(event: string, fields: Record<string, unknown>) => void} emit - Bounded recovery audit sink without credentials.
 */
/** Own native copy-on-write recovery points, branch preparation and retention; snapshots share the primary object store. */
export class Recovery {
  #resources = new Map();
  #pending = 0;
  /** @param {RecoveryDependencies} dependencies - Source admission, storage, SQL observation and backup persistence ports. */
  constructor({reloadDatabases, databaseDefinitions, findDatabase, resolveTenant, recordDatabaseStatus,
    requireServingFleet, ensureStorageActive, routing, api, leader, lifecycle, getEndpoints, emit}) {
    Object.assign(this, {reloadDatabases, databaseDefinitions, findDatabase, resolveTenant, recordDatabaseStatus,
      requireServingFleet, ensureStorageActive, routing, api, leader, lifecycle, getEndpoints, emit});
    this.busy = false;
  }
  /**
   * Refresh managed recovery points for reconciliation and dependency checks.
   * Requires namespace backup read permission; side effects replace the private inventory without changing provider resources.
   * @returns {Promise<void>} Resolves after the complete backup list is read.
   * @throws {Error} On Kubernetes inventory failure.
   */
  async load() {this.#resources = new Map((await this.api.list('neonbackups', '')).map(resource => [resource.metadata.name, resource]));}
  /**
   * Reload source definitions before resolving an eligible branch or backup source.
   * The owning application boundary authorizes source access; side effects refresh the source inventory without waking compute.
   * @param {string} name - Managed source database name.
   * @returns {Promise<RecoverySource>} Provisioned source identity and effective storage policy.
   * @throws {Error} On inventory failure or SOURCE_NOT_READY.
   */
  async readSource(name) {await this.reloadDatabases(); return this.source(name);}
  /**
   * Read one retained recovery point's desired and observed state.
   * Requires management read authorization at the owning API boundary; side effects perform a namespace backup read only.
   * @param {string} name - Recovery point resource name.
   * @returns {Promise<import('../../domain/recovery/BackupContracts.mjs').BackupView>} Current recovery point, Pending before its first observation.
   * @throws {Error} On missing resource or Kubernetes failure.
   */
  async get(name) {const resource = await this.api.get('neonbackups', name); return {name, spec: resource.spec, status: resource.status || {phase: 'Pending'}};}
  /**
   * List recovery point observations belonging to a managed database.
   * Requires management read authorization at the owning API boundary; side effects refresh the backup inventory only.
   * @param {string} database - Source managed database name.
   * @returns {Promise<import('../../domain/recovery/BackupContracts.mjs').BackupView[]>} Matching desired and observed recovery points.
   * @throws {Error} On Kubernetes inventory failure.
   */
  async list(database) {
    await this.load();
    return [...this.#resources.values()].filter(row => row.spec.database === database).map(row => ({name: row.metadata.name, spec: row.spec, status: row.status || {phase: 'Pending'}}));
  }
  /**
   * Observe whether recovery commands currently hold shared storage demand.
   * Internal reconciliation needs no additional permission; this read has no mutation side effects.
   * @returns {boolean} True while at least one storage-scoped operation is in flight.
   */
  hasPendingWork() {return this.#pending > 0;}
  /**
   * Load backup dependencies that prevent purging source databases.
   * Requires namespace backup read permission; side effects refresh the private backup inventory.
   * @returns {Promise<BackupReference[]>} Source names and phases, including pending recovery points.
   * @throws {Error} On Kubernetes inventory failure.
   */
  async backupReferences() {
    await this.load();
    return [...this.#resources.values()].map(resource => ({database: resource.spec.database, phase: resource.status?.phase}));
  }
  /**
   * Enumerate materialized nondeleted backup timelines for whole-storage drain verification.
   * Requires namespace backup read permission; side effects refresh inventory without modifying native storage.
   * @returns {Promise<import('../storage/StorageFleet.mjs').BackupTimelineFrontier[]>} Required remote-durability boundaries, including unfinished captures with timeline identities.
   * @throws {Error} On Kubernetes inventory failure.
   */
  async timelineReferences() {
    await this.load();
    return [...this.#resources.values()].filter(resource => resource.status?.timelineId && resource.status.phase !== 'Deleted')
      .map(resource => ({tenantId: resource.status.tenantId, timelineId: resource.status.timelineId, lsn: resource.status.lsn}));
  }
  /**
   * Request recovery point retirement while preserving its native cleanup finalizer.
   * Requires backup-operator or fleet-admin authorization at the API boundary and an active lease here.
   * Side effects issue a UID-preconditioned Kubernetes deletion; native data removal is asynchronous and dependency guarded.
   * @param {string} name - Recovery point resource name.
   * @returns {Promise<void>} Resolves when Kubernetes accepts the deletion request.
   * @throws {Error} On lost lease, missing backup, UID conflict or provider failure.
   */
  async delete(name) {
    this.leader.require(); const resource = await this.api.get('neonbackups', name);
    await this.api.request('DELETE', this.api.path('neonbackups', name), {preconditions: {uid: resource.metadata.uid}});
  }
  /**
   * Merge observed recovery progress without changing the requested retention or source identity.
   * Requires active lease authorization; side effects patch the status subresource using its current resource version.
   * @param {string} name - Backup resource to observe.
   * @param {Partial<import('../../domain/recovery/BackupContracts.mjs').BackupStatus>} values - Observed capture, durability, expiry or cleanup fields.
   * @returns {Promise<void>} Resolves after the status patch is accepted.
   * @throws {Error} On lost lease, missing resource, concurrency conflict or Kubernetes failure.
   */
  async status(name, values) {
    this.leader.require(); const current = await this.api.get('neonbackups', name);
    await this.api.request('PATCH', this.api.path('neonbackups', name) + '/status', {metadata: {resourceVersion: current.metadata.resourceVersion}, status: {...current.status, ...values}});
  }
  /**
   * Hold shared-storage demand around a recovery operation, rejecting work for retiring fleets.
   * Requires serving-fleet authorization and an active lease before invoking the callback.
   * Side effects reserve demand, wake shared storage and always release the reservation; callback effects belong to the supplied command.
   * @template T
   * @param {() => Promise<T>} operation - Recovery operation to run only with available storage.
   * @returns {Promise<T>} Callback result after storage admission succeeds.
   * @throws {Error} On retirement, storage wake failure, lost lease or callback rejection.
   */
  async storage(operation) {
    this.#pending++;
    try {await this.requireServingFleet(); await this.ensureStorageActive(); this.leader.require(); return await operation();}
    finally {this.#pending--;}
  }
  /**
   * Resolve a provisioned nonretiring source from the current database inventory.
   * Source access authorization belongs to the owning application boundary; resolution has no persistence or wake side effects.
   * @param {string} name - Managed source database name.
   * @returns {RecoverySource} Source identity and inherited native storage policy.
   * @throws {Error} SOURCE_NOT_READY for absent, deleting, purged or unprovisioned sources, or policy resolution errors.
   */
  source(name) {
    const resource = this.findDatabase(name);
    if (!resource || resource.metadata.deletionTimestamp || resource.spec.deletionPolicy === 'Delete' || resource.status?.phase === 'Deleted' || !resource.status?.provisioningRevision) throw problem('SOURCE_NOT_READY');
    return {resource, tenant: this.resolveTenant(resource)};
  }
  /**
   * Resolve and lease an exact retained WAL boundary, refusing pruned or future timestamp substitutions.
   * Requires authorized source access and active lease authorization through the storage port.
   * Side effects read existing source SQL when active and acquire a native all-shard LSN lease; sleeping compute is not woken.
   * @param {RecoverySource} source - Validated source database and timeline.
   * @param {RecoverySelection} [selection] - Explicit timestamp/LSN or current-frontier selection.
   * @returns {Promise<string>} Validated retained WAL LSN protected against the lookup/GC race.
   * @throws {Error} On unavailable history, unready source, shard catch-up, invalid LSN or lease failure.
   */
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
  /**
   * Pin branch ancestry to the immutable source UID and a leased retained recovery boundary.
   * Requires an authorized branch definition and active lease authorization through persistence/storage ports.
   * Side effects persist source ancestry before provisioning and mutate the invocation-owned tenant's ancestor fields; this does not create the branch timeline.
   * @param {import('../../domain/database/DatabaseContracts.mjs').DatabaseResource} resource - Branch database definition and any previously recorded ancestry.
   * @param {import('../../domain/configuration/ClusterConfiguration.mjs').ClusterTenant} tenant - Resolved branch tenant enriched in place.
   * @returns {Promise<void>} Resolves with stable ancestorTimelineId and ancestorLSN on the tenant.
   * @throws {Error} On changed source UID, unavailable backup/history, native lookup or status persistence failure.
   */
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
      const backup = await this.#selectedBackup(selection, source);
      ancestor = backup.status.timelineId; point = backup.status.lsn;
    }
    if (!point) point = await this.point(source, selection);
    else await this.routing.request('POST', `/v1/tenant/${source.tenant.tenantId}/timeline/${ancestor}/lsn_lease`, {lsn: point});
    const descriptor = {database: selection.database, databaseUID: source.resource.metadata.uid, tenantId: source.tenant.tenantId, timelineId: ancestor, lsn: point};
    await this.recordDatabaseStatus(resource.metadata.name, {source: descriptor});
    tenant.ancestorTimelineId = ancestor; tenant.ancestorLSN = point;
  }
  async #selectedBackup(selection, source) {
    const backup = await this.api.get('neonbackups', selection.backup);
    if (backup.spec.database !== selection.database || backup.metadata.deletionTimestamp || backup.status?.phase !== 'Ready' || backup.status.databaseUID !== source.resource.metadata.uid) throw problem('BACKUP_NOT_READY');
    return backup;
  }
  /**
   * Accept an idempotent recovery point definition for a provisioned source.
   * Requires backup-operator or fleet-admin authorization at the API boundary, serving-fleet admission and an active lease.
   * Side effects refresh source inventory and create a backup resource; actual native capture happens during reconciliation.
   * @param {string} database - Managed source database name.
   * @param {string} name - Unique DNS-safe recovery point resource name.
   * @param {Pick<import('../../domain/recovery/BackupContracts.mjs').BackupRequest, 'retentionSeconds'>} [input] - Retention override; omission uses effective source policy.
   * @returns {Promise<import('../../domain/recovery/BackupContracts.mjs').BackupResource>} Existing identical definition or newly accepted backup resource.
   * @throws {Error} On retirement, invalid retention/name, source not ready, name conflict, lost lease or provider failure.
   */
  async create(database, name, {retentionSeconds} = {}) {
    this.leader.require();
    await this.requireServingFleet();
    if (!resourceName(name)) throw problem('INVALID_SPEC');
    await this.reloadDatabases(); const source = this.source(database);
    const retention = retentionSeconds ?? source.tenant.backup.retentionSeconds;
    if (!Number.isInteger(retention) || retention < 300 || retention > 31536000) throw problem('INVALID_SPEC');
    const existing = await this.api.optional('neonbackups', name);
    if (existing) {
      if (existing.spec.database !== database || existing.spec.databaseUID !== source.resource.metadata.uid || existing.spec.retentionSeconds !== retention) throw problem('BACKUP_NAME_CONFLICT');
      return existing;
    }
    return this.api.create('neonbackups', {apiVersion: 'neon.klustr.io/v1alpha1', kind: 'NeonBackup', metadata: {name},
      spec: {database, databaseUID: source.resource.metadata.uid, retentionSeconds: retention}});
  }
  /**
   * Read effective retention and native per-shard history/frontier observations.
   * Requires management read authorization at the API boundary and serving-fleet admission.
   * Side effects refresh sources and may wake shared storage while holding recovery demand; compute stays asleep.
   * @param {string} name - Managed source database name.
   * @returns {Promise<RecoveryHistory>} Effective history window with native storage observations.
   * @throws {Error} On unready source, retirement, storage wake/lease failure or native history lookup failure.
   */
  async history(name) {
    await this.reloadDatabases(); const source = this.source(name);
    return this.storage(async () => ({historySeconds: Number.parseInt(source.tenant.storagePolicy.pitr_interval),
      ...(await this.routing.request('GET', `/control/v1/tenant/${source.tenant.tenantId}/timeline/${source.tenant.timelineId}`))}));
  }
  /**
   * Schedule current-slot snapshots and advance native capture, expiry and dependency-guarded retirement.
   * Requires active lease authorization and skips concurrent passes; side effects persist backup resources/status/finalizers and perform native timeline operations.
   * Missed schedule slots coalesce rather than inventing historical recovery points. Deferred failures retain evidence and emit bounded facts for retry.
   * @returns {Promise<void>} Resolves after a single pass or a busy/nonleader skip.
   * @throws {Error} Only if the injected audit sink throws while reporting deferred work.
   */
  async reconcile() {
    if (this.busy || !this.leader.active) return; this.busy = true;
    try {
      await this.load();
      for (const resource of this.databaseDefinitions()) {
        try {await this.#scheduleDatabase(resource);}
        catch (error) {this.emit('backup_schedule_deferred', {database: resource.metadata.name, reason: error.code || 'SCHEDULE_UNAVAILABLE'});}
      }
      await this.load();
      for (const resource of this.#resources.values()) try {
        await this.#reconcileBackup(resource);
      } catch (error) {await this.status(resource.metadata.name, {phase: resource.status?.phase || 'Pending', reason: error.code || 'RECOVERY_PENDING'});}
    } catch (error) {this.emit('recovery_deferred', {reason: error.code || 'RECOVERY_UNAVAILABLE'});} finally {this.busy = false;}
  }
  async #scheduleDatabase(resource) {
    if (resource.metadata.deletionTimestamp || resource.spec.lifecycle === 'retired' || resource.spec.branchFrom || !resource.status?.provisioningRevision) return;
    const policy = this.resolveTenant(resource).backup;
    if (!policy.scheduleSeconds) return;
    const bucket = Math.floor(Date.now() / (policy.scheduleSeconds * 1000));
    const name = 'auto-' + id(resource.metadata.uid).slice(0, 12) + '-' + bucket;
    // Missed slots coalesce into the current slot, never synthetic historical backups.
    if (!this.#resources.has(name)) await this.create(resource.metadata.name, name);
  }
  async #reconcileBackup(resource) {
    const name = resource.metadata.name;
    if (resource.status?.phase === 'Deleted') return;
    if (!resource.metadata.finalizers?.includes('neon.klustr.io/backup')) {
      await this.api.patch('neonbackups', name, {metadata: {resourceVersion: resource.metadata.resourceVersion, finalizers: [...(resource.metadata.finalizers || []), 'neon.klustr.io/backup']}});
      return;
    }
    const expiresAt = new Date(Date.parse(resource.metadata.creationTimestamp) + resource.spec.retentionSeconds * 1000).toISOString();
    if (resource.metadata.deletionTimestamp || Date.parse(expiresAt) <= Date.now()) {await this.remove(resource); return;}
    if (resource.status?.phase !== 'Ready') await this.storage(() => this.#captureBackup(resource, expiresAt));
  }
  async #captureBackup(resource, expiresAt) {
    const name = resource.metadata.name, source = this.source(resource.spec.database);
    if (source.resource.metadata.uid !== resource.spec.databaseUID) throw problem('SOURCE_IDENTITY_CHANGED');
    const timelineId = id('backup:' + resource.metadata.uid), point = resource.status?.lsn || await this.point(source);
    await this.status(name, {phase: 'Creating', tenantId: source.tenant.tenantId, timelineId, lsn: point, databaseUID: resource.spec.databaseUID, expiresAt});
    await this.#ensureBackupTimeline(source, timelineId, point);
    const state = await this.routing.request('GET', `/control/v1/tenant/${source.tenant.tenantId}/timeline/${timelineId}`);
    if (!state.shards?.length || state.shards.some(shard => !remoteDurable(shard, point))) throw problem('RECOVERY_UPLOAD_PENDING');
    await this.status(name, {phase: 'Ready', readyAt: new Date().toISOString(), reason: null});
  }
  async #ensureBackupTimeline(source, timelineId, point) {
    const route = `/v1/tenant/${source.tenant.tenantId}/timeline`, rows = await this.routing.request('GET', route);
    const existing = rows.find(row => row.timeline_id === timelineId);
    if (!existing) {
      await this.routing.request('POST', route + '/' + source.tenant.timelineId + '/lsn_lease', {lsn: point});
      await this.routing.request('POST', route, {new_timeline_id: timelineId, ancestor_timeline_id: source.tenant.timelineId, ancestor_start_lsn: point, read_only: true, pg_version: 18});
    } else if (existing.ancestor_timeline_id !== source.tenant.timelineId || lsn(existing.ancestor_lsn) !== lsn(point)) throw problem('BACKUP_IDENTITY_CHANGED');
  }
  /**
   * Remove an expired or explicitly retired recovery point only when no live branch references it.
   * Requires retention/deletion authorization from reconciliation and active lease authorization through its persistence/storage ports.
   * Side effects may wake storage, delete the native snapshot timeline, record Deleted and release only the owned backup finalizer; dependent snapshots remain retained.
   * @param {import('../../domain/recovery/BackupContracts.mjs').BackupResource} resource - Current backup identity and materialized native timeline.
   * @returns {Promise<void>} Resolves after cleanup or after recording a dependent-branch block.
   * @throws {Error} On source inventory, storage, lease, concurrency or finalizer persistence failure.
   */
  async remove(resource) {
    const name = resource.metadata.name;
    await this.reloadDatabases();
    if (this.databaseDefinitions().some(row => row.status?.phase !== 'Deleted' && row.spec.branchFrom?.backup === name)) {
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
