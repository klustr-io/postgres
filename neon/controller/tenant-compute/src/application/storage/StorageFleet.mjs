// The shared storage fleet is a separate drain-aware KEDA target. Compute
// dormancy alone never grants permission to discard the last warm WAL copies.
import {SecretText as secretText} from '../../domain/compute/ComputeSpecification.mjs';
import {RemoteDurable as remoteDurable} from '../../domain/storage/WalDurability.mjs';
/**
 * @typedef {Object} StorageFleetMember
 * @property {'statefulsets' | 'deployments'} kind - Kubernetes workload collection.
 * @property {string} name - Provider-owned storage dependency name.
 */
/**
 * @typedef {Object} BackupTimelineFrontier
 * @property {string} tenantId - Managed native tenant containing the read-only backup.
 * @property {string} timelineId - Native backup timeline identity.
 * @property {string} lsn - Required durable WAL boundary for this backup.
 */
/**
 * @typedef {Object} StorageFleetStatus
 * @property {'Starting' | 'Active' | 'Draining' | 'Dormant' | 'WaitingForDurability'} [phase] - Observed storage lifecycle state.
 * @property {number} [replicas] - Observed fleet availability, zero or one.
 * @property {string} [selector] - Pod selector exposed through the scale subresource.
 * @property {string | null} [reason] - Stable blocking reason without provider secrets.
 * @property {string | null} [remoteDurabilityVerifiedAt] - UTC time of the completed whole-fleet drain proof.
 * @property {Record<string, string>} [frontiers] - Verified required WAL boundaries keyed by tenant and timeline.
 */
/**
 * @typedef {Object} StorageFleetDependencies
 * @property {import('../../infrastructure/kubernetes/Kubernetes.mjs').Kubernetes} api - Namespace storage workloads, endpoint Secrets and fleet status repository.
 * @property {import('../../infrastructure/kubernetes/Kubernetes.mjs').Leadership} leader - Active lease guard for storage mutations.
 * @property {Pick<import('../../infrastructure/storage/StorageRouting.mjs').StorageRouting, 'request'>} routing - Authenticated native storage inventory and registration port.
 * @property {() => Map<string, import('../../domain/compute/ComputeSpecification.mjs').ComputeEndpoint>} getEndpoints - Current managed compute inventory and drain frontiers.
 * @property {(event: string, fields: Record<string, unknown>) => void} emit - Bounded reconciliation failure audit sink.
 * @property {() => import('../../domain/configuration/ClusterConfiguration.mjs').ClusterStorageConfiguration} getStorageConfiguration - Current provider storage topology.
 * @property {() => Promise<boolean>} hasDatabaseDemand - Effective database demand including pending provisioning.
 * @property {(name: string) => boolean} isDatabaseDeleted - Observed permanent database retirement.
 * @property {() => Promise<BackupTimelineFrontier[]>} getBackupTimelines - Managed read-only backup inventory and required frontiers.
 * @property {() => boolean} hasPendingRecovery - Recovery commands currently using storage.
 * @property {(name: string, active: boolean) => void} publishDemand - Publish fleet demand to the KEDA scaler.
 */
/** Coordinate shared storage wake and drain; compute dormancy alone never authorizes stopping durable WAL services. */
export class StorageFleet {
  #pending = 0;
  #active = false;
  /** @param {StorageFleetDependencies} dependencies - Explicit storage inventory, demand, lease and Kubernetes persistence ports. */
  constructor({api, leader, routing, getEndpoints, emit, getStorageConfiguration, hasDatabaseDemand,
    isDatabaseDeleted, getBackupTimelines, hasPendingRecovery, publishDemand}) {
    Object.assign(this, {api, leader, routing, getEndpoints, emit, getStorageConfiguration, hasDatabaseDemand,
      isDatabaseDeleted, getBackupTimelines, hasPendingRecovery, publishDemand});
    this.busy = false;
  }
  /**
   * Enumerate managed storage dependencies, excluding an externally operated metadata service.
   * Internal reconciliation needs no additional caller permission; this read has no mutation side effects.
   * @returns {StorageFleetMember[]} Provider-owned workloads in startup dependency order.
   */
  members() {
    const storage = this.getStorageConfiguration();
    return [...(storage.externalMetadata ? [] : [{kind: 'statefulsets', name: 'metadata'}]), {kind: 'deployments', name: 'storage-broker'},
      {kind: 'deployments', name: 'storage-controller'},
      ...storage.pageservers.map(node => ({kind: 'statefulsets', name: node.resourceName || node.host.split('.')[0]})),
      ...[1, 2, 3].map(id => ({kind: 'statefulsets', name: 'safekeeper-' + id}))];
  }
  /**
   * Persist observed storage state and refresh the local active-state observation from the response.
   * Requires active lease authorization; side effects patch the fleet status with resource-version concurrency and a UTC update time.
   * @param {StorageFleetStatus} values - Observed fields to merge into current status.
   * @returns {Promise<void>} Resolves after the status write is accepted.
   * @throws {Error} On lost lease, missing resource, concurrency conflict or Kubernetes failure.
   */
  async status(values) {
    this.leader.require();
    const resource = await this.api.get('neonstoragefleets', 'storage');
    const result = await this.api.request('PATCH', this.api.path('neonstoragefleets', 'storage') + '/status', {
      metadata: {resourceVersion: resource.metadata.resourceVersion}, status: {...resource.status, ...values, updatedAt: new Date().toISOString()}});
    this.#active = result.status.phase === 'Active';
  }
  /**
   * Set a managed storage dependency's desired availability after the owning reconciliation boundary authorizes wake or drain.
   * Requires active lease authorization; side effects patch replicas using the observed resource version, skipping unchanged values.
   * @param {StorageFleetMember} member - Provider-owned storage workload.
   * @param {0 | 1} replicas - Desired stopped or running state.
   * @returns {Promise<void>} Resolves after the desired state is accepted, without waiting for readiness.
   * @throws {Error} On lost lease, missing workload, concurrency conflict or Kubernetes failure.
   */
  async scale(member, replicas) {
    this.leader.require(); const resource = await this.api.get(member.kind, member.name);
    if (resource.spec.replicas === replicas) return;
    await this.api.patch(member.kind, member.name, {metadata: {resourceVersion: resource.metadata.resourceVersion}, spec: {replicas}});
  }
  /**
   * Observe whether a storage dependency has one ready replica at its current desired generation.
   * Requires namespace read permission; this lookup has no mutation side effects.
   * @param {StorageFleetMember} member - Managed workload to inspect.
   * @returns {Promise<boolean>} True only when desired availability, readiness and observed generation agree.
   * @throws {Error} On missing workload or Kubernetes read failure.
   */
  async ready(member) {
    const resource = await this.api.get(member.kind, member.name);
    return resource.spec.replicas === 1 && (resource.status?.readyReplicas || 0) >= 1 &&
      resource.status.observedGeneration >= resource.metadata.generation;
  }
  /**
   * Combine pending wake/recovery requests, effective database policy and active compute phases into storage demand.
   * Requires active lease authorization; dependency reads have no storage scale mutation side effects.
   * @returns {Promise<boolean>} Whether any managed work currently requires storage to remain active.
   * @throws {Error} On lost lease or database-demand dependency failure.
   */
  async demand() {
    this.leader.require();
    if (this.#pending || this.hasPendingRecovery() || await this.hasDatabaseDemand()) return true;
    for (const endpoint of this.getEndpoints().values()) if (['Active', 'Waking', 'Draining'].includes(endpoint.status.phase)) return true;
    return false;
  }
  /**
   * Reserve wake demand and wait up to three minutes for reconciliation to observe active shared storage.
   * Requires active lease authorization; side effects publish KEDA demand and trigger guarded storage reconciliation.
   * Releases the local pending reservation on success or failure; KEDA publishes current demand on subsequent reconciliation.
   * @returns {Promise<void>} Resolves when the local observed fleet state is Active.
   * @throws {Error} On lost lease or STORAGE_WAKE_TIMEOUT; the caller must not wake compute after rejection.
   */
  async ensureActive() {
    this.leader.require(); this.#pending++; this.publishDemand('@fleet', true);
    const deadline = Date.now() + 180000;
    try {
      while (Date.now() < deadline) {
        this.leader.require();
        if (this.#active) return;
        void this.reconcile(); await new Promise(resolve => setTimeout(resolve, 250));
      }
      throw Object.assign(Error('Storage fleet wake deadline'), {code: 'STORAGE_WAKE_TIMEOUT'});
    } finally {this.#pending--;}
  }
  /**
   * Prove every inventoried managed compute/backup timeline has a generation-validated remotely durable drain frontier.
   * The owning reconciliation boundary must hold shutdown authorization; storage API reads require its active lease.
   * Side effects are limited to inventory reads; no workload is stopped and no database is woken.
   * Missing or unmanaged tenants/timelines and remaining compute Pods fail closed.
   * @returns {Promise<Record<string, string>>} Required WAL frontiers keyed by native tenant and timeline, safe to record as drain evidence.
   * @throws {Error} On remaining compute, incomplete inventory, unavailable storage state or REMOTE_DURABILITY_PENDING.
   */
  async proof() {
    const known = new Map(), frontiers = {};
    for (const endpoint of this.getEndpoints().values()) await this.#recordStoppedCompute(endpoint, known);
    // Backups are native read-only timelines without compute endpoints.
    for (const backup of await this.getBackupTimelines()) {
      const timelines = known.get(backup.tenantId) || new Map();
      timelines.set(backup.timelineId, backup.lsn); known.set(backup.tenantId, timelines);
    }
    const tenants = await this.routing.request('GET', '/control/v1/tenant');
    if (!Array.isArray(tenants)) throw Error('Unknown storage inventory');
    const present = new Set(tenants.map(tenant => tenant.tenant_id));
    if ([...known.keys()].some(tenantId => !present.has(tenantId))) throw Error('Missing managed storage tenant prevents fleet shutdown');
    for (const tenant of tenants) {
      await this.#proveTenant(tenant.tenant_id, known.get(tenant.tenant_id), frontiers);
    }
    return frontiers;
  }
  async #recordStoppedCompute(endpoint, known) {
    const deployment = await this.api.optional('deployments', endpoint.name);
    if (deployment?.spec.replicas) throw Error('Compute remains present');
    if ((await this.api.list('pods', 'neon.klustr.io/endpoint-uid=' + endpoint.uid)).length) throw Error('Compute Pod is still terminating');
    const spec = JSON.parse(secretText(await this.api.get('secrets', endpoint.computeSpecSecret), 'spec.json'));
    if (this.isDatabaseDeleted(endpoint.databaseResource)) return;
    const timelines = known.get(spec.tenant_id) || new Map();
    timelines.set(spec.timeline_id, endpoint.status.drainedLSN || '0/0'); known.set(spec.tenant_id, timelines);
  }
  async #proveTenant(tenantId, expected, frontiers) {
    if (!expected) throw Error('Unmanaged storage tenant prevents fleet shutdown');
    const timelines = await this.routing.request('GET', '/v1/tenant/' + tenantId + '/timeline');
    if (!Array.isArray(timelines) || timelines.some(timeline => !expected.has(timeline.timeline_id))) throw Error('Unmanaged timeline prevents fleet shutdown');
    const present = new Set(timelines.map(timeline => timeline.timeline_id));
    if ([...expected.keys()].some(timelineId => !present.has(timelineId))) throw Error('Missing managed storage timeline prevents fleet shutdown');
    for (const timeline of timelines) {
      const frontier = expected.get(timeline.timeline_id);
      const state = await this.routing.request('GET', `/control/v1/tenant/${tenantId}/timeline/${timeline.timeline_id}`);
      if (!state.shards?.length) throw Error('Missing storage durability state');
      if (state.shards.some(shard => !remoteDurable(shard, frontier))) throw Object.assign(Error('Waiting for S3 upload'), {code: 'REMOTE_DURABILITY_PENDING'});
      frontiers[tenantId + ':' + timeline.timeline_id] = frontier;
    }
  }
  /**
   * Register provider-configured pageserver addresses and zones with the native storage controller.
   * Requires active lease authorization through the storage port; side effects publish native node registrations.
   * @returns {Promise<void>} Resolves after every configured pageserver registration is accepted.
   * @throws {Error} On lost lease or native storage API failure.
   */
  async register() {
    const storage = this.getStorageConfiguration(), suffix = '.' + this.api.namespace + '.svc.cluster.local';
    for (const node of storage.pageservers) {
      const host = node.host.includes('.') ? node.host : node.host + suffix;
      await this.routing.request('POST', '/control/v1/node', {node_id: node.id, listen_pg_addr: host, listen_pg_port: 6400,
        listen_http_addr: host, listen_http_port: 9898, availability_zone_id: node.zone || 'zone-1'});
    }
  }
  /**
   * Reconcile KEDA's desired fleet availability with dependency readiness, demand and a whole-fleet remote-durability proof.
   * Requires active lease authorization and skips concurrent passes; side effects publish demand, persist status, register nodes and scale workloads.
   * Stops metadata last and aborts further stopping when demand returns. Failures emit deferred-work facts and retain storage rather than bypass drain checks.
   * @returns {Promise<void>} Resolves after one pass or a busy/nonleader skip; deferred work is retried by the scheduler.
   * @throws {Error} Only if an injected audit sink throws while reporting a reconciliation failure.
   */
  async reconcile() {
    if (this.busy || !this.leader.active) return; this.busy = true;
    try {
      const resource = await this.api.get('neonstoragefleets', 'storage');
      const demand = await this.demand(); this.publishDemand('@fleet', demand);
      const members = this.members();
      if (resource.spec.replicas === 1) await this.#start(resource, members);
      else if (!demand) await this.#stop(resource, members);
    } catch (error) {
      this.emit('storage_fleet_deferred', {reason: error.code || 'FLEET_NOT_QUIESCENT'});
      if (this.leader.active) {
        try {await this.status({phase: 'WaitingForDurability', reason: error.code || 'FLEET_NOT_QUIESCENT'});}
        catch (statusError) {this.emit('storage_fleet_status_deferred', {reason: statusError.code || 'KUBERNETES_UNAVAILABLE'});}
      }
    } finally {this.busy = false;}
  }
  async #start(resource, members) {
    if (this.#active && resource.status?.phase === 'Active') return;
    await this.status({phase: 'Starting', replicas: 1, selector: 'neon.klustr.io/storage-fleet=storage', reason: null, remoteDurabilityVerifiedAt: null});
    const metadata = members.find(member => member.name === 'metadata'), broker = members.find(member => member.name === 'storage-broker');
    if (metadata) await this.scale(metadata, 1); await this.scale(broker, 1);
    if (metadata && !await this.ready(metadata)) return;
    for (const member of members.filter(member => ![metadata, broker].includes(member))) await this.scale(member, 1);
    if (!await this.ready(members.find(member => member.name === 'storage-controller'))) return;
    await this.register();
    if (!(await Promise.all(members.map(member => this.ready(member)))).every(Boolean)) return;
    await this.status({phase: 'Active', replicas: 1});
  }
  async #stop(resource, members) {
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
      const priority = member => ({metadata: 2, 'storage-broker': 1})[member.name] || 0;
      for (const member of [...members].sort((a, b) => priority(a) - priority(b))) {
        if (await this.demand()) return;
        await this.scale(member, 0);
      }
  }
}
