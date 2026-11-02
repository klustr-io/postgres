import {createHash} from 'node:crypto';
import {NormalizeClusterConfiguration as normalizeConfiguration} from '../../domain/configuration/ClusterConfiguration.mjs';
import {AlwaysOn as alwaysOn} from '../../domain/compute/Activity.mjs';
import {BranchSource as branchSource, DomainProblem as problem, ResourceName as resourceName} from '../../domain/recovery/RecoveryPolicy.mjs';
import {DatabaseDefinition, DatabaseFields as allowed} from '../../domain/database/DatabaseDefinition.mjs';
import {RequireServingFleet} from '../../domain/fleet/FleetPolicy.mjs';
import {NativeOAuthRevision} from '../../domain/identity/NativeOAuthPolicy.mjs';

const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
/** @typedef {import('../../domain/database/DatabaseContracts.mjs').DatabaseResource} DatabaseResource */
/** @typedef {import('../../domain/configuration/ClusterConfiguration.mjs').ClusterConfiguration} ClusterConfiguration */
/** @typedef {import('../../domain/configuration/ClusterConfiguration.mjs').ClusterTenant} ClusterTenant */
/** @typedef {import('../../domain/compute/ComputeSpecification.mjs').ComputeEndpoint} ComputeEndpoint */
/**
 * @typedef {Object} DatabaseConnectionPolicy
 * @property {string} domain - Provider-owned endpoint DNS suffix.
 * @property {import('../../domain/identity/IdentityPolicy.mjs').IdentityConfigurationValue} [identity] - Current OIDC audiences, bindings and validation configuration.
 */
/**
 * @typedef {Object} DatabaseDependencies
 * @property {import('../../infrastructure/kubernetes/Kubernetes.mjs').Kubernetes} api - Namespace database definitions, scale objects and observed workload persistence.
 * @property {import('../../infrastructure/kubernetes/Kubernetes.mjs').Leadership} leader - Active controller lease guard.
 * @property {import('../../infrastructure/compute/Lifecycle.mjs').Lifecycle} lifecycle - Serialized compute sampling, durable stop and verified wake.
 * @property {() => Map<string, ComputeEndpoint>} getEndpoints - Copied current compute endpoint inventory.
 * @property {() => ClusterConfiguration} readConfiguration - Provider-owned current validated configuration snapshot port.
 * @property {(event: string, fields?: Record<string, unknown>) => void} emit - Bounded token-free reconciliation audit sink.
 * @property {() => Promise<void>} ensureStorageActive - Wait for shared storage before provisioning or wake.
 * @property {import('../recovery/Recovery.mjs').Recovery['prepareBranch']} prepareBranch - Lease and persist immutable source ancestry for branch provisioning.
 * @property {import('../recovery/Recovery.mjs').Recovery['backupReferences']} listBackupReferences - Retained recovery dependencies protecting deletion.
 * @property {import('../recovery/Recovery.mjs').Recovery['storage']} withStorage - Reserve shared-storage demand around a guarded native command.
 * @property {import('../../infrastructure/storage/StorageRouting.mjs').StorageRouting['request']} storageRequest - Authenticated native inventory and deletion port.
 * @property {(desired: ClusterConfiguration) => Promise<void>} provision - Reconcile invocation-owned provider specifications and tenant resources.
 * @property {(name: string, active: boolean) => void} publishDemand - Publish KEDA database activation changes.
 */
/** Own managed database definitions, inherited policy, KEDA demand and dependency-guarded retirement. */
export class Databases {
  #resources = new Map();
  #applied = new Map();
  #samples = new Map();
  #pendingConnections = new Map();
  #backendWork = false;
  /** @param {DatabaseDependencies} dependencies - Explicit provider configuration, persistence, storage, recovery and compute ports. */
  constructor({api, leader, lifecycle, getEndpoints, readConfiguration, emit, ensureStorageActive, prepareBranch,
    listBackupReferences, withStorage, storageRequest, provision, publishDemand}) {
    Object.assign(this, {api, leader, lifecycle, getEndpoints, readConfiguration, emit, ensureStorageActive, prepareBranch,
      listBackupReferences, withStorage, storageRequest, provision, publishDemand});
    this.busy = false;
  }
  /**
   * Read current provider configuration without exposing its adapter's mutable authority.
   * Requires internal provider configuration authorization; side effects invoke the configuration query port, which owns any file/cache access.
   * @returns {ClusterConfiguration} Independent configuration snapshot, safe for invocation-owned provisioning changes.
   * @throws {Error} On missing, unreadable or invalid provider configuration.
   */
  base() {
    return structuredClone(this.readConfiguration());
  }
  /**
   * Refresh the owned managed database inventory from Kubernetes.
   * Requires namespace database read permission; side effects replace the private copied inventory without changing provider resources.
   * @returns {Promise<void>} Resolves after the complete resource list is loaded.
   * @throws {Error} On Kubernetes inventory failure.
   */
  async load() {
    const rows = await this.api.list('neondatabases', '');
    this.#resources = new Map(rows.map(resource => [resource.metadata.name, structuredClone(resource)]));
  }
  /**
   * Read database definitions without exposing mutable cached authority.
   * Internal application consumers need no additional permission; copying has no persistence side effects.
   * @returns {DatabaseResource[]} Independent inventory snapshot at the last refresh/watch event.
   */
  definitions() {return structuredClone([...this.#resources.values()]);}
  /**
   * Read one cached source definition without permitting mutation of the owned inventory.
   * Source authorization belongs to the owning application boundary; this copied lookup has no persistence side effects.
   * @param {string} name - Managed resource name.
   * @returns {DatabaseResource | undefined} Independent resource snapshot or undefined when not known.
   */
  definition(name) {return structuredClone(this.#resources.get(name));}
  /**
   * Resolve effective database and inherited branch policy against current provider configuration.
   * Authorization belongs to the owning command/query boundary; side effects read provider configuration and may refresh its private cache only.
   * @param {DatabaseResource} resource - Desired managed database definition.
   * @returns {ClusterTenant} Validated invocation-owned tenant policy and native identities.
   * @throws {Error} On invalid policy, branch ancestry, unavailable source or insufficient storage placement capacity.
   */
  resolve(resource) {return this.tenant(resource, this.base());}
  /**
   * Observe permanent retirement from the current database inventory.
   * Internal storage verification needs no additional permission; this read has no mutation side effects.
   * @param {string} name - Managed resource name.
   * @returns {boolean} True only when the observed phase is Deleted.
   */
  isDeleted(name) {return this.#resources.get(name)?.status?.phase === 'Deleted';}
  /**
   * Read current proxy DNS and OIDC policy without exposing mutable provider configuration.
   * Requires internal connection-policy authorization; side effects read provider configuration and refresh its local cache if changed.
   * @returns {DatabaseConnectionPolicy} Independent connection policy snapshot.
   * @throws {Error} On provider configuration read or validation failure.
   */
  connectionPolicy() {const {domain, identity} = this.base(); return structuredClone({domain, identity});}
  /**
   * Observe provisioning/deletion work and pending connections that must keep shared storage available.
   * Internal reconciliation needs no additional permission; this read has no mutation side effects.
   * @returns {boolean} Whether application work currently holds implicit storage demand.
   */
  hasPendingWork() {return this.#backendWork || this.#pendingConnections.size > 0;}
  /**
   * Combine effective always-on policy, pending provisioning, event holds and lifecycle into shared-storage demand.
   * Requires namespace fleet read permission; side effects read current fleet/provider configuration without scaling workloads.
   * @returns {Promise<boolean>} Whether managed work requires storage; retirement excludes new ordinary database demand.
   * @throws {Error} On ownership conflict, provider inventory/configuration failure or invalid effective database policy.
   */
  async storageDemand() {
    if (this.hasPendingWork()) return true;
    const retiring = await this.isFleetRetiring(), base = this.base();
    return this.definitions().some(resource => this.#databaseStorageDemand(resource, base, retiring));
  }
  #databaseStorageDemand(resource, base, retiring) {
    if (resource.status?.phase === 'Deleted') return false;
    if (resource.metadata.deletionTimestamp) return Boolean(resource.status?.replicas);
    if (retiring) return false;
    if (['suspended', 'retired'].includes(resource.spec.lifecycle)) return resource.spec.deletionPolicy === 'Delete';
    if (resource.spec.replicas === 1 || Date.parse(resource.status?.event?.until || '') > Date.now()) return true;
    const tenant = this.tenant(resource, base);
    return alwaysOn(tenant) || this.revision(resource, tenant, base) !== resource.status?.provisioningRevision;
  }
  /**
   * Keep the private definition inventory current and notify reconciliation of desired-state changes.
   * Requires namespace database watch permission; side effects maintain a provider watch, replace copied snapshots and emit resync observations.
   * @param {() => void} changed - Schedule reconciliation after membership, generation or retirement changes.
   * @returns {() => void} Stop callback closing the watch and reconnect timer.
   * @throws {Error} On initial watch setup or credential failure; streaming failures emit bounded resync observations.
   */
  watch(changed){
    return this.api.watch('neondatabases',event=>{
      const resource=event.object,name=resource.metadata.name,previous=this.#resources.get(name);
      if(event.type==='DELETED')this.#resources.delete(name);else this.#resources.set(name,structuredClone(resource));
      if(event.type==='ADDED'||event.type==='DELETED'||previous?.metadata.generation!==resource.metadata.generation||
        Boolean(previous?.metadata.deletionTimestamp)!==Boolean(resource.metadata.deletionTimestamp))changed();
    },()=>this.emit('database_watch_resync'));
  }
  /**
   * Resolve one database's inherited policy, stable writer placement and branch storage ancestry.
   * Requires authorized provider/database input at the owning application boundary; side effects mutate only the supplied recursion set and invocation-owned normalized tenant.
   * @param {DatabaseResource} resource - Validated desired definition with explicit overrides.
   * @param {ClusterConfiguration} base - Current provider defaults, physical storage and release authority.
   * @param {Set<string>} [seen] - Branch ancestry recursion guard, extended during this resolution.
   * @returns {ClusterTenant} Effective tenant with one deterministic writer timeline and sufficient secondary placement capacity.
   * @throws {Error} On branch cycles, source/identity mismatch, forbidden independent branch storage policy, invalid sizing or unsupported durability.
   */
  tenant(resource, base, seen = new Set()) {
    if (seen.has(resource.metadata.name)) throw problem('BRANCH_CYCLE');
    seen.add(resource.metadata.name);
    new DatabaseDefinition({name: resource.metadata.name, resource}).Validate();
    if (base.replication?.mode === 'synchronous-quorum' && resource.spec.profile && resource.spec.profile !== 'durable') throw problem('ZONE_QUORUM_REQUIRES_DURABLE');
    const seed = base.tenants.find(tenant => tenant.name === resource.metadata.name);
    const seedPolicy = Object.fromEntries(Object.entries(seed || {}).filter(([key]) => !['resources', 'settings', 'storagePolicy'].includes(key)));
    const tenant = normalizeConfiguration({...base, tenants: [{...seedPolicy, ...resource.spec, name: resource.metadata.name,
      allowedIps: resource.spec.allowedIps || base.clientCIDRs, nodeName: this.#computePlacement(resource, base),
      databaseResource: resource.metadata.name}]}).tenants[0];
    if (resource.spec.branchFrom) this.#inheritBranch(resource, tenant, base, seen);
    if (tenant.storagePolicy.placement_policy.Attached >= base.storage.pageservers.length) throw Error('Tier needs additional storage capacity');
    return tenant;
  }
  #computePlacement(resource, base) {
    const nodes = base.computeNodes || (base.computeNode ? [base.computeNode] : []);
    const existing = [...this.getEndpoints().values()].find(endpoint => endpoint.databaseResource === resource.metadata.name);
    const selected = nodes.length ? nodes[parseInt(hash(resource.metadata.name).slice(0, 8), 16) % nodes.length] : undefined;
    return existing?.nodeName || selected;
  }
  #inheritBranch(resource, tenant, base, seen) {
      const source = branchSource(resource.spec.branchFrom), parent = this.#resources.get(source.database);
      if (!parent || parent.metadata.deletionTimestamp || parent.spec.deletionPolicy === 'Delete' || parent.status?.phase === 'Deleted') throw problem('SOURCE_NOT_READY');
      const ancestor = this.tenant(parent, base, seen);
      if (tenant.database !== ancestor.database || tenant.user !== ancestor.user) throw problem('BRANCH_DATABASE_ROLE_MISMATCH');
      if (resource.spec.backup !== undefined) throw problem('BRANCH_STORAGE_POLICY_INHERITED');
      tenant.tenantId = ancestor.tenantId;
      tenant.tier = ancestor.tier; tenant.shards = ancestor.shards;
      tenant.backup = ancestor.backup;
      tenant.storagePolicy = ancestor.storagePolicy;
  }
  /**
   * Build effective managed deployment input while preserving standalone provider tenants.
   * Requires internal provisioning authorization; side effects read provider configuration and emit bounded rejection facts for invalid managed definitions.
   * @returns {Promise<ClusterConfiguration>} Independent provider configuration with valid nondeleted managed tenants merged in.
   * @throws {Error} On provider configuration failure or an injected audit sink failure.
   */
  async desired() {
    const base = this.base(), tenants = base.tenants.filter(tenant => !this.#resources.has(tenant.name));
    for (const resource of this.#resources.values()) {
      if (resource.status?.phase === 'Deleted') continue;
      try {tenants.push(this.tenant(resource, base));}
      catch (error) {this.emit('database_definition_rejected', {database: resource.metadata.name, reason: error.code || 'INVALID_SPEC'});}
    }
    return {...base, tenants};
  }
  /**
   * Persist observed database progress through the status subresource using optimistic concurrency.
   * Requires active lease authorization; side effects merge observations, selector and UTC update time without changing desired policy.
   * @param {string} name - Managed resource to observe.
   * @param {Partial<import('../../domain/database/DatabaseContracts.mjs').DatabaseStatus>} values - Current lifecycle/provisioning/drain observations.
   * @returns {Promise<void>} Resolves after the status patch is accepted.
   * @throws {Error} On lost lease, missing resource, resource-version conflict or provider failure.
   */
  async status(name, values) {
    this.leader.require();
    const resource = await this.api.get('neondatabases', name);
    await this.api.request('PATCH', this.api.path('neondatabases', name) + '/status', {metadata: {resourceVersion: resource.metadata.resourceVersion},
      status: {replicas: 0, selector: 'neon.klustr.io/endpoint=ep-' + name, ...resource.status, ...values, updatedAt: new Date().toISOString()}});
  }
  /**
   * Hash effective provisioning inputs independently of lifecycle, replica intent and backup scheduling overrides.
   * Internal reconciliation authorization suffices; side effects read provider configuration only when no snapshot was supplied.
   * @param {DatabaseResource} resource - Resource attribution retained in the provisioning contract.
   * @param {ClusterTenant} tenant - Effective invocation-owned tenant settings and storage policy.
   * @param {ClusterConfiguration} [base] - Provider storage/release/authentication authority; defaults to current configuration.
   * @returns {string} Deterministic SHA-256 provisioning revision.
   * @throws {Error} On provider configuration failure or invalid native authentication policy.
   */
  revision(resource, tenant, base=this.base()) {
    const provisioning = Object.fromEntries(Object.entries(tenant).filter(([key]) => !['replicas', 'lifecycle', 'deletionPolicy', 'backup'].includes(key)));
    return hash([provisioning, base.storage, base.computeImage, NativeOAuthRevision(base.identity)]);
  }
  /**
   * Render KEDA's drain-aware zero-or-one writer target from effective database idle policy.
   * Provider scaling authorization belongs to the owning boundary; rendering has no persistence side effects.
   * @param {DatabaseResource} resource - Desired lifecycle and immutable resource ownership.
   * @param {ClusterTenant} tenant - Effective never/idle policy including shared-compute database overrides.
   * @returns {import('../../infrastructure/kubernetes/Kubernetes.mjs').KubernetesResource} Owned external-push ScaledObject; retired/suspended resources are paused at zero.
   */
  scaledObject(resource, tenant) {
    const paused = resource.metadata.deletionTimestamp || ['suspended', 'retired'].includes(resource.spec.lifecycle);
    return {apiVersion: 'keda.sh/v1alpha1', kind: 'ScaledObject', metadata: {name: 'neon-' + resource.metadata.name,
      annotations: {'autoscaling.keda.sh/paused-replicas': paused ? '0' : null},
      labels: {'neon.klustr.io/database-uid': resource.metadata.uid}, ownerReferences: [{apiVersion: resource.apiVersion, kind: resource.kind,
        name: resource.metadata.name, uid: resource.metadata.uid, controller: true, blockOwnerDeletion: false}]}, spec: {
      scaleTargetRef: {apiVersion: 'neon.klustr.io/v1alpha1', kind: 'NeonDatabase', name: resource.metadata.name},
      pollingInterval: 5, cooldownPeriod: alwaysOn(tenant) ? 300 : Math.max(tenant.suspend.idleSeconds, ...Object.values(tenant.databasePolicies || {}).map(value => value.idleSeconds || 0)),
      minReplicaCount: !paused && alwaysOn(tenant) ? 1 : 0, maxReplicaCount: 1,
      triggers: [{type: 'external-push', metadata: {scalerAddress: 'neon-controller.' + this.api.namespace + '.svc.cluster.local:9091',
        database: resource.metadata.name, enableTLS: 'true'}, authenticationRef: {name: 'neon-keda-tls'}}]}};
  }
  /**
   * Reconcile definitions, effective policy, provisioning revisions and KEDA pause/resume state.
   * Requires active lease authorization and skips concurrent passes; side effects create definitions, prepare branches, provision native storage/compute inputs and persist status/scale objects.
   * Fleet retirement blocks new provisioning; deferred failures emit bounded facts for retry rather than bypassing lifecycle or durability checks.
   * @returns {Promise<void>} Resolves after one pass or a busy/nonleader skip.
   * @throws {Error} Only if the injected audit sink throws while reporting deferred work.
   */
  async reconcile() {
    if (this.busy || !this.leader.active) return; this.busy = true;
    try {
      await this.load(); const base = this.base(), fleetRetiring = await this.isFleetRetiring();
      for (const tenant of base.tenants) if (!fleetRetiring && !this.#resources.has(tenant.name)) {
        const spec = Object.fromEntries(allowed.filter(key => key !== 'replicas' && tenant[key] !== undefined).map(key => [key, tenant[key]]));
        await this.api.create('neondatabases', {apiVersion: 'neon.klustr.io/v1alpha1', kind: 'NeonDatabase', metadata: {name: tenant.name}, spec});
      }
      await this.load();
      for (const resource of this.#resources.values()) {
        this.leader.require();
        try {
          await this.#reconcileResource(resource, base, fleetRetiring);
        } catch (error) {
          this.emit('database_reconcile_deferred', {database: resource.metadata.name, reason: error.code || 'INVALID_OR_UNAVAILABLE'});
          await this.status(resource.metadata.name, {phase: 'Pending', reason: error.code || 'INVALID_OR_UNAVAILABLE'});
        } finally {this.#backendWork = false;}
      }
    } catch (error) {this.emit('database_reconcile_unavailable', {reason: error.code || 'API_UNAVAILABLE'});} finally {this.busy = false;}
  }
  async #reconcileResource(resource, base, fleetRetiring) {
    const name = resource.metadata.name;
    if (resource.status?.phase === 'Deleted' || resource.metadata.deletionTimestamp) return;
    if (!resource.metadata.finalizers?.includes('neon.klustr.io/retain-data')) {
      await this.api.patch('neondatabases', name, {metadata: {resourceVersion: resource.metadata.resourceVersion,
        finalizers: [...(resource.metadata.finalizers || []), 'neon.klustr.io/retain-data']}});
    }
    const tenant = this.tenant(resource, base);
    if (fleetRetiring || ['retired', 'suspended'].includes(resource.spec.lifecycle)) {
      await this.#pauseScaling(name);
      if (!fleetRetiring && resource.spec.deletionPolicy === 'Delete') await this.purge(resource, tenant);
      return;
    }
    const revision = this.revision(resource, tenant);
    if ((this.#applied.get(name) || resource.status?.provisioningRevision) !== revision) {
      await this.#provisionResource(resource, tenant, base, revision);
    }
    // Lifecycle changes resume KEDA without reprovisioning storage.
    await this.#resumeScaling(name);
  }
  async #resumeScaling(name) {
    const scaled = await this.api.optional('scaledobjects', 'neon-' + name);
    if (scaled?.metadata.annotations?.['autoscaling.keda.sh/paused-replicas'] !== undefined) {
      await this.api.patch('scaledobjects', scaled.metadata.name, {metadata: {resourceVersion: scaled.metadata.resourceVersion,
        annotations: {'autoscaling.keda.sh/paused-replicas': null}}});
    }
  }
  async #pauseScaling(name) {
    const old = await this.api.optional('scaledobjects', 'neon-' + name);
    if (old) await this.api.patch('scaledobjects', old.metadata.name, {metadata: {resourceVersion: old.metadata.resourceVersion,
      annotations: {'autoscaling.keda.sh/paused-replicas': '0'}}});
  }
  async #provisionResource(resource, tenant, base, revision) {
    const name = resource.metadata.name;
    this.#backendWork = true;
    await this.status(name, {phase: 'WaitingForStorage'}); await this.ensureStorageActive();
    if (resource.spec.branchFrom) await this.prepareBranch(resource, tenant);
    await this.status(name, {phase: 'Provisioning', observedGeneration: resource.metadata.generation});
    await this.provision({...structuredClone(base), tenants: [tenant]});
    const scaled = this.scaledObject(resource, tenant), old = await this.api.optional('scaledobjects', scaled.metadata.name);
    if (old && old.metadata.labels?.['neon.klustr.io/database-uid'] !== resource.metadata.uid) throw Error('ScaledObject has a different owner');
    if (old) await this.api.patch('scaledobjects', scaled.metadata.name, {metadata: {resourceVersion: old.metadata.resourceVersion, annotations: scaled.metadata.annotations}, spec: scaled.spec});
    else await this.api.create('scaledobjects', scaled);
    await this.status(name, {phase: 'Provisioned', observedGeneration: resource.metadata.generation,
      endpoint: tenant.endpointId + '.' + base.domain, credentialsSecret: name + '-client', tier: tenant.tier, size: tenant.size,
      provisioningRevision: revision, reason: null});
    this.#applied.set(name, revision);
  }
  /**
   * Accept an idempotent external demand hold without allowing retired/suspended databases to wake.
   * Requires database-operator or fleet-admin authorization at the API boundary, serving-fleet admission and an active lease.
   * Side effects persist a new hold only when its id differs and publish positive KEDA demand.
   * @param {string} name - Managed database to activate.
   * @param {import('../../domain/database/DatabaseContracts.mjs').DatabaseEvent} [input] - Bounded idempotency key and hold duration, default thirty seconds.
   * @returns {Promise<void>} Resolves after the hold and demand publication are accepted.
   * @throws {Error} On invalid event, retirement, suspended lifecycle, lost lease or provider failure.
   */
  async event(name, {id, holdSeconds = 30} = {}) {
    this.leader.require();
    await this.requireServingFleet();
    if (typeof id !== 'string' || !/^[a-zA-Z0-9_.:-]{1,128}$/.test(id) || !Number.isInteger(holdSeconds) || holdSeconds < 1 || holdSeconds > 86400) throw problem('INVALID_SPEC');
    const resource = await this.api.get('neondatabases', name);
    this.available(resource);
    if (resource.status?.event?.id !== id) await this.status(name, {event: {id, until: new Date(Date.now() + holdSeconds * 1000).toISOString()}});
    this.publishDemand(name, true);
  }
  /**
   * Resolve KEDA demand from current lifecycle, pending connections, policy, holds and recent SQL observations.
   * Requires active lease authorization; side effects read fleet/database configuration without waking workloads.
   * @param {string} name - Managed database resource name.
   * @returns {Promise<boolean>} Whether the database should remain active; retiring fleets and suspended/retired resources return false.
   * @throws {Error} On stale active-compute samples, ownership conflict, invalid policy, lost lease or provider failure; uncertainty must not imply safe scale-down.
   */
  async demand(name) {
    this.leader.require();
    if (await this.isFleetRetiring()) return false;
    const resource = await this.api.get('neondatabases', name), tenant = this.tenant(resource, this.base());
    if (resource.metadata.deletionTimestamp || ['suspended', 'retired'].includes(resource.spec.lifecycle)) return false;
    if (this.#pendingConnections.get(name) || alwaysOn(tenant) || Date.parse(resource.status?.event?.until || '') > Date.now()) return true;
    const endpoint = [...this.getEndpoints().values()].find(endpoint => endpoint.databaseResource === name);
    return this.#sampledDemand(name, endpoint);
  }
  #sampledDemand(name, endpoint) {
    if(endpoint?.status.phase==='Waking')return true;
    const sample = this.#samples.get(name);
    if (sample && Date.now() - sample.at < 15000) return sample.active;
    if (endpoint && ['Active', 'Waking', 'Draining'].includes(endpoint.status.phase)) throw Error('Demand sample stale; refuse scale-down');
    return false;
  }
  /**
   * Reserve database demand while an already-authorized connection or role-preparation operation is pending.
   * The owning application boundary must perform resource authorization first; side effects increment local demand and publish activation to KEDA.
   * @param {string} name - Managed database with a connection in flight.
   * @returns {() => void} Release callback that the caller must invoke exactly once in its finally block.
   */
  beginConnection(name) {
    this.#pendingConnections.set(name,(this.#pendingConnections.get(name)||0)+1);this.publishDemand(name,true);
    return ()=>{const remaining=this.#pendingConnections.get(name)-1;if(remaining)this.#pendingConnections.set(name,remaining);else this.#pendingConnections.delete(name);};
  }
  /**
   * Reconcile a managed compute against observed database lifecycle, sizing and KEDA replica intent.
   * Requires internal worker authorization; active lease checks occur through lifecycle/status mutations.
   * Side effects sample SQL demand, publish KEDA observations, drain retired/manual-suspended computes and perform safe resize/wake transitions before recording status.
   * @param {ComputeEndpoint} endpoint - Current copied endpoint specification and lifecycle observation.
   * @returns {Promise<void>} Resolves after one bounded endpoint reconciliation or a deferred sizing observation.
   * @throws {Error} On ownership/lease loss, stale demand, unsafe drain, invalid policy or SQL/provider failure.
   */
  async endpoint(endpoint) {
    const name = endpoint.databaseResource, resource = await this.api.get('neondatabases', name);
    const fleetRetired = await this.isFleetRetiring();
    if (fleetRetired || resource.metadata.deletionTimestamp || ['suspended', 'retired'].includes(resource.spec.lifecycle)) {
      return this.#stopEndpoint(resource, endpoint);
    }
    if (resource.spec.replicas === 1) await this.ensureStorageActive();
    const sample = await this.lifecycle.sampleDemand(endpoint);
    this.#samples.set(name, {active: sample, at: Date.now()}); this.publishDemand(name, await this.demand(name));
    const deployment = await this.api.optional('deployments', endpoint.name);
    const desiredTenant = this.tenant(resource, this.base());
    if (endpoint.size !== desiredTenant.size || endpoint.tier !== desiredTenant.tier) {
      await this.status(name, {phase: 'Updating', replicas: deployment?.spec.replicas || 0}); return;
    }
    if (deployment?.spec.replicas === 1 && deployment.spec.template.metadata.annotations?.['neon.klustr.io/config-revision'] !== endpoint.computeRevision) {
      if (!await this.#resizeEndpoint(endpoint)) return;
    } else await this.#syncReplicaIntent(resource, endpoint, deployment);
    await this.#recordEndpointStatus(resource, endpoint);
  }
  async #stopEndpoint(resource, endpoint) {
    if (resource.status?.phase === 'Deleted') return;
    await this.lifecycle.maintenanceSuspend(endpoint);
    const remaining = await this.api.optional('deployments', endpoint.name), pods = await this.lifecycle.pods(endpoint);
    const stopped = !remaining?.spec.replicas && !pods.length;
    let phase = 'Stopping';
    if (stopped) phase = resource.spec.lifecycle === 'suspended' ? 'Suspended' : 'Retained';
    await this.status(resource.metadata.name, {phase, reason: stopped ? null : 'ACTIVE_WORK', replicas: remaining?.spec.replicas || 0,
      drainedLSN: endpoint.status.drainedLSN || resource.status?.drainedLSN || null});
  }
  async #resizeEndpoint(endpoint) {
    const name = endpoint.databaseResource;
    await this.status(name, {phase: 'Resizing'});
    await this.lifecycle.maintenanceSuspend(endpoint);
    const after = await this.api.get('deployments', endpoint.name);
    if (after.spec.replicas !== 0) {await this.status(name, {phase: 'PendingResize', reason: 'ACTIVE_WORK'}); return false;}
    await this.lifecycle.wake(endpoint); return true;
  }
  async #syncReplicaIntent(resource, endpoint, deployment) {
    const name = resource.metadata.name;
    if (resource.spec.replicas === 1 && (!deployment || deployment.spec.replicas === 0 || endpoint.status.phase !== 'Active')) {
      await this.status(name, {phase: 'Waking'}); await this.lifecycle.wake(endpoint);
    }
    else if (resource.spec.replicas === 0 && !await this.demand(name)) await this.lifecycle.suspend(endpoint);
  }
  async #recordEndpointStatus(resource, endpoint) {
    const current = await this.api.optional('deployments', endpoint.name);
    await this.status(resource.metadata.name, {replicas: current?.spec.replicas || 0, selector: 'neon.klustr.io/endpoint=' + endpoint.endpointId,
      observedGeneration: resource.metadata.generation, phase: endpoint.status.phase || 'Dormant', reason: null, drainedLSN: endpoint.status.drainedLSN || null});
  }
  /**
   * Validate and persist explicit database overrides while retaining omitted existing top-level fields.
   * Requires database-operator or fleet-admin authorization at the API boundary, serving-fleet admission and an active lease.
   * Side effects read current provider policy and create or resource-version-patch the desired definition; provisioning remains asynchronous.
   * @param {string} name - DNS-safe managed database resource name.
   * @param {import('../../domain/database/DatabaseContracts.mjs').DatabaseSpecification} spec - Untrusted explicit desired overrides, excluding lifecycle commands.
   * @returns {Promise<DatabaseResource>} Accepted new or revised definition.
   * @throws {Error} On invalid policy/identity change, retirement, lost lease, concurrency conflict or provider failure.
   */
  async put(name, spec) {
    this.leader.require();
    await this.requireServingFleet();
    if (!resourceName(name)) throw problem('INVALID_SPEC');
    const old = await this.api.optional('neondatabases', name);
    const candidate = new DatabaseDefinition({name, resource: old}).Revise(spec);
    try {this.tenant(candidate, this.base());} catch (error) {throw Object.assign(error, {code: 'INVALID_SPEC'});}
    if (old) return this.api.patch('neondatabases', name, {metadata: {resourceVersion: old.metadata.resourceVersion}, spec: candidate.spec});
    return this.api.create('neondatabases', {apiVersion: 'neon.klustr.io/v1alpha1', kind: 'NeonDatabase', metadata: {name}, spec: candidate.spec});
  }
  /**
   * Reject connection/event access to a deleting, suspended or retired database definition.
   * Resource authorization still belongs to the owning boundary; this lifecycle check has no mutation side effects.
   * @param {DatabaseResource} resource - Current desired lifecycle and immutable identity.
   * @returns {void} Returns only while database lifecycle permits availability.
   * @throws {Error} On unavailable or invalid database state.
   */
  available(resource) {
    new DatabaseDefinition({name: resource.metadata.name, resource}).AssertAvailable();
  }
  /**
   * Reject new work when the established namespace fleet retires or ownership is ambiguous.
   * Requires namespace fleet read permission; side effects perform an inventory read without adopting a conflicting newcomer.
   * @returns {Promise<void>} Resolves for a serving owner or standalone namespace without a fleet.
   * @throws {Error} FLEET_RETIRED, FLEET_OWNERSHIP_CONFLICT or provider failure.
   */
  async requireServingFleet() {RequireServingFleet(await this.api.list('neonfleets', ''));}
  /**
   * Observe established fleet retirement while preserving fail-closed ownership conflicts.
   * Requires namespace fleet read permission; side effects read fleet inventory only.
   * @returns {Promise<boolean>} True only for FLEET_RETIRED, false for a serving/standalone namespace.
   * @throws {Error} On ambiguous ownership or provider failure rather than interpreting uncertainty as serving.
   */
  async isFleetRetiring() {
    try {await this.requireServingFleet(); return false;}
    catch (error) {if (error.code === 'FLEET_RETIRED') return true; throw error;}
  }
  /**
   * Require current enclosing-fleet and database admission before authentication-driven wake or role preparation.
   * Token/resource authorization belongs to the owning application boundary; side effects read current fleet and database definitions without publishing demand.
   * @param {string} name - Managed database to admit.
   * @returns {Promise<DatabaseResource>} Current resource identity and policy for subsequent authorization/rechecks.
   * @throws {Error} On retirement, suspended/deleting database, ownership conflict, missing resource or provider failure.
   */
  async assertAvailable(name) {await this.requireServingFleet(); const resource = await this.api.get('neondatabases', name); this.available(resource); return resource;}
  /**
   * Accept an explicit lifecycle command, with dependency protection before permanent purge.
   * Requires database-operator/fleet-admin authorization for suspend/resume and fleet-admin authorization for delete at the API boundary; all writes require an active lease.
   * Side effects patch desired lifecycle with concurrency protection, refresh the owned snapshot and publish demand; resume additionally requires a serving fleet.
   * @param {string} name - Managed database resource name.
   * @param {'suspend' | 'resume' | 'delete'} action - Explicit lifecycle operation.
   * @param {import('../../domain/database/DatabaseContracts.mjs').DatabaseRetirement} [input] - Delete retention intent and exact purge confirmation.
   * @returns {Promise<DatabaseResource>} Accepted desired lifecycle, not proof that compute/storage cleanup is complete.
   * @throws {Error} On retirement, invalid transition/confirmation, dependent data, lost lease, concurrency conflict or provider failure.
   */
  async operation(name, action, input = {}) {
    this.leader.require();
    if (action === 'resume') await this.requireServingFleet();
    const resource = await this.api.get('neondatabases', name);
    const spec = new DatabaseDefinition({name, resource}).Transition(action, input);
    if (spec.deletionPolicy === 'Delete') await this.dependencies(resource);
    const updated = await this.api.patch('neondatabases', name, {metadata: {resourceVersion: resource.metadata.resourceVersion}, spec});
    this.#resources.set(name, updated); this.publishDemand(name, action === 'resume');
    return updated;
  }
  /**
   * Refuse source purge while any live branch or retained recovery point still depends on it.
   * Requires deletion authorization at the owning command boundary and namespace inventory read permission.
   * Side effects refresh database/backup inventories without deleting data.
   * @param {DatabaseResource} resource - Source whose dependent data must remain protected.
   * @returns {Promise<void>} Resolves only when no managed live dependency remains.
   * @throws {Error} DEPENDENT_BRANCHES_OR_BACKUPS or provider inventory failure.
   */
  async dependencies(resource) {
    await this.load(); const backups = await this.listBackupReferences();
    const name = resource.metadata.name;
    if ([...this.#resources.values()].some(row => row.status?.phase !== 'Deleted' && row.spec.branchFrom?.database === name) ||
        backups.some(row => row.phase !== 'Deleted' && row.database === name)) throw problem('DEPENDENT_BRANCHES_OR_BACKUPS');
  }
  /**
   * Permanently remove native storage for an explicitly purge-authorized, dependency-free database.
   * Requires reviewed Delete policy from reconciliation and active lease authorization through storage/persistence ports.
   * Side effects durably stop compute, recheck dependencies, delete only the branch timeline or whole root tenant, verify root deletion, mark Deleted and release the owned retention finalizer.
   * @param {DatabaseResource} resource - Explicitly retired/purge-authorized resource and immutable identity.
   * @param {ClusterTenant} tenant - Resolved native storage identity and branch ancestry.
   * @returns {Promise<void>} Resolves after permanent cleanup, or early while compute remains/when already Deleted.
   * @throws {Error} On dependencies, unsafe drain, pending native deletion, lost lease, concurrency or provider failure; non-404 storage errors retain evidence.
   */
  async purge(resource, tenant) {
    if (resource.status?.phase === 'Deleted') return;
    const endpoint = [...this.getEndpoints().values()].find(row => row.databaseResource === resource.metadata.name);
    if (endpoint) {
      await this.lifecycle.maintenanceSuspend(endpoint);
      const deployment = await this.api.optional('deployments', endpoint.name);
      if (deployment?.spec.replicas || (await this.lifecycle.pods(endpoint)).length) return;
    }
    await this.dependencies(resource);
    this.#backendWork = true;
    await this.withStorage(async () => {
      const route = tenant.branchFrom ? `/v1/tenant/${tenant.tenantId}/timeline/${tenant.timelineId}` : `/v1/tenant/${tenant.tenantId}`;
      if (!tenant.branchFrom) {
        try {
          const timelines = await this.storageRequest('GET', route + '/timeline');
          if (!Array.isArray(timelines) || timelines.some(row => row.timeline_id !== tenant.timelineId)) throw problem('DEPENDENT_BRANCHES_OR_BACKUPS');
        } catch (error) {if (error.code !== 'STORAGE_404') throw error;}
      }
      try {await this.storageRequest('DELETE', route);} catch (error) {if (error.code !== 'STORAGE_404') throw error;}
      if (!tenant.branchFrom) {
        try {await this.storageRequest('GET', '/control/v1/tenant/' + tenant.tenantId); throw problem('DELETION_PENDING');}
        catch (error) {if (error.code !== 'STORAGE_404') throw error;}
      }
      await this.status(resource.metadata.name, {phase: 'Deleted', replicas: 0, deletedAt: new Date().toISOString(), reason: null});
      const current = await this.api.get('neondatabases', resource.metadata.name);
      await this.api.patch('neondatabases', resource.metadata.name, {metadata: {resourceVersion: current.metadata.resourceVersion,
        finalizers: (current.metadata.finalizers || []).filter(value => value !== 'neon.klustr.io/retain-data')}});
    });
  }
}
