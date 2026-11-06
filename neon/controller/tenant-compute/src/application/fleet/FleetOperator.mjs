import {createHash} from 'node:crypto';
import {SelectFleetOwner} from '../../domain/fleet/FleetPolicy.mjs';
const Kinds = {ConfigMap: 'configmaps', ServiceAccount: 'serviceaccounts', Role: 'roles', RoleBinding: 'rolebindings',
  Service: 'services', StatefulSet: 'statefulsets', Deployment: 'deployments', Job: 'jobs', NetworkPolicy: 'networkpolicies',
  NeonStorageFleet: 'neonstoragefleets', ScaledObject: 'scaledobjects', TriggerAuthentication: 'triggerauthentications'};
/**
 * @typedef {Object} FleetPlanningInputs
 * @property {import('../../infrastructure/kubernetes/Kubernetes.mjs').KubernetesResource} objectStore - Configured S3 Secret, confined to provider planning.
 * @property {import('../../infrastructure/kubernetes/Kubernetes.mjs').KubernetesResource[]} nodes - Actual cluster node placement observations.
 * @property {string | null} metadataIdentity - Stable external metadata host/database identity, excluding credentials.
 */
/**
 * @typedef {Object} FleetOperatorDependencies
 * @property {import('../../infrastructure/kubernetes/Kubernetes.mjs').Kubernetes} api - Namespace deployment repository.
 * @property {import('../../infrastructure/kubernetes/Kubernetes.mjs').Leadership} leader - Operator lease guard.
 * @property {(fleet: import('../../domain/fleet/FleetSpecification.mjs').FleetResource, inputs: FleetPlanningInputs) => ReturnType<import('../../infrastructure/provisioning/FleetResources.mjs').FleetResources>} planFleet - Immutable packaged fleet planning port.
 * @property {(event: string, fields: Record<string, unknown>) => void} emit - Bounded reconciliation event sink.
 */
/** Reconcile the established namespace fleet without adopting foreign storage resources. */
export class FleetOperator {
  #busy = false;
  /** @param {FleetOperatorDependencies} dependencies - Namespace deployment and planning ports. */
  constructor({api, leader, planFleet, emit}) {Object.assign(this, {api, leader, planFleet, emit});}
  /**
   * Persist observed fleet state using optimistic concurrency and current leadership.
   * Requires active lease authorization and fleet status-update permission; side effects persist observed fields under the current resource version.
   * @param {import('../../domain/fleet/FleetSpecification.mjs').FleetResource} resource - Observed fleet identity.
   * @param {Record<string, unknown>} values - Bounded reconciliation status fields.
   * @returns {Promise<void>} Resolves after status persistence.
   * @throws {Error} On lease loss, missing fleets, provider rejection or conflicting status versions.
   */
  async status(resource, values) {
    this.leader.require(); const current = await this.api.get('neonfleets', resource.metadata.name);
    await this.api.request('PATCH', this.api.path('neonfleets', current.metadata.name) + '/status', {metadata: {resourceVersion: current.metadata.resourceVersion},
      status: {...current.status, ...values, updatedAt: new Date().toISOString()}});
  }
  /**
   * Reconcile one established owner while rejecting conflicting newcomers independently.
   * Requires active operator lease authorization; side effects apply owned resources, retain retiring fleets and emit bounded retry facts.
   * @returns {Promise<void>} Provider failures are reported and retried by the host worker.
   * @throws {Error} If the injected event sink fails while reporting a deferred operation.
   */
  async reconcile() {
    if (this.#busy || !this.leader.active) return; this.#busy = true;
    try {
      const {owner, conflicts} = SelectFleetOwner(await this.api.list('neonfleets', ''));
      await this.#rejectConflicts(conflicts);
      if (owner) await this.#reconcileOwner(owner);
    } catch (error) {this.emit('fleet_reconcile_deferred', {reason: error.code || 'KUBERNETES_UNAVAILABLE'});}
    finally {this.#busy = false;}
  }
  async #rejectConflicts(conflicts) {
    for (const conflict of conflicts) {
      try {await this.status(conflict, {phase: 'Rejected', reason: 'ONE_FLEET_PER_NAMESPACE_REQUIRED'});}
      catch (error) {this.emit('fleet_conflict_status_deferred', {fleet: conflict.metadata.name, reason: error.code || 'KUBERNETES_UNAVAILABLE'});}
    }
  }
  async #reconcileOwner(fleet) {
    try {
      if (fleet.metadata.deletionTimestamp) {await this.#retainFleet(fleet); return;}
      if (!fleet.metadata.finalizers?.includes('neon.klustr.io/retain-fleet')) {
        await this.api.patch('neonfleets', fleet.metadata.name, {metadata: {resourceVersion: fleet.metadata.resourceVersion,
          finalizers: [...(fleet.metadata.finalizers || []), 'neon.klustr.io/retain-fleet']}}); return;
      }
      const objectStore = await this.api.get('secrets', fleet.spec.storage.objectStoreSecretRef);
      const nodes = (await this.api.request('GET', '/api/v1/nodes?limit=500')).items;
      const plan = this.planFleet(fleet, {objectStore, nodes, metadataIdentity: await this.#metadataIdentity(fleet)});
      const revision = createHash('sha256').update(JSON.stringify(plan.resources)).digest('hex');
      if (fleet.status?.appliedRevision !== revision) await this.#applyPlan(fleet, plan);
      await this.#recordPlacement(fleet, nodes, plan.storageIdentity, revision);
    } catch (error) {
      this.emit('fleet_reconcile_deferred', {reason: error.code || 'PREREQUISITE_OR_RESOURCE_CONFLICT'});
      await this.status(fleet, {phase: 'Pending', reason: error.code || 'PREREQUISITE_OR_RESOURCE_CONFLICT', message: error.code ? undefined : error.message});
    }
  }
  async #retainFleet(fleet) {
    for (const database of await this.api.list('neondatabases', '')) {
      if (database.spec.lifecycle === 'retired') continue;
      this.leader.require();
      await this.api.patch('neondatabases', database.metadata.name, {metadata: {resourceVersion: database.metadata.resourceVersion}, spec: {lifecycle: 'suspended', replicas: 0}});
    }
    await this.status(fleet, {phase: 'Retaining', reason: 'DATA_RETAINED_REMOVE_FINALIZER_ONLY_AFTER_REVIEW'});
  }
  async #metadataIdentity(fleet) {
    if (!fleet.spec.storage.metadataDatabaseSecretRef) return null;
    const secret = await this.api.get('secrets', fleet.spec.storage.metadataDatabaseSecretRef);
    const url = new URL(Buffer.from(secret.data.url || '', 'base64').toString());
    if (!['postgres:', 'postgresql:'].includes(url.protocol) || url.searchParams.get('sslmode') !== 'verify-full') throw Error('External metadata must use TLS verify-full');
    return url.host + url.pathname;
  }
  async #applyPlan(fleet, plan) {
    for (const object of plan.resources) {
      this.leader.require(); const kind = Kinds[object.kind]; if (!kind) throw Error('Unsupported packaged resource');
      const existing = await this.api.optional(kind, object.metadata.name);
      if (existing && existing.metadata.labels?.['neon.klustr.io/fleet-uid'] !== fleet.metadata.uid) throw Error('Existing resource belongs to a different deployment');
    }
    // Persist storage identity before starting bootstrap; never force adoption or migrate PVCs.
    await this.status(fleet, {phase: 'Provisioning', storageIdentity: plan.storageIdentity, reason: null});
    for (const object of plan.resources) await this.#applyResource(object);
  }
  async #applyResource(object) {
    this.leader.require(); const kind = Kinds[object.kind];
    const existing = await this.api.optional(kind, object.metadata.name);
    if (object.kind === 'Job' && existing) return;
    if (!existing) await this.api.request('POST', this.api.path(kind) + '?fieldManager=neon-fleet-operator', object);
    else await this.api.request('PATCH', this.api.path(kind, object.metadata.name) + '?fieldManager=neon-fleet-operator', object, 'application/apply-patch+yaml');
  }
  async #recordPlacement(fleet, nodes, storageIdentity, revision) {
    const pods = await this.api.list('pods', ''), zones = new Map(nodes.map(node => [node.metadata.name, node.metadata.labels?.['topology.kubernetes.io/zone']]));
    const placementObserved = [1, 2, 3].every(id => pods.some(pod => pod.metadata.labels?.app === 'safekeeper-' + id &&
      zones.get(pod.spec.nodeName) === fleet.spec.replication.zones[id - 1] && !pod.metadata.deletionTimestamp &&
      pod.status?.conditions?.some(condition => condition.type === 'Ready' && condition.status === 'True')));
    await this.status(fleet, {phase: 'Provisioned', observedGeneration: fleet.metadata.generation, storageIdentity,
      appliedRevision: revision, zonePlacementConfigured: true, ...(placementObserved ? {lastVerifiedZonePlacementAt: new Date().toISOString()} : {}),
      automaticFailoverReady: false, reason: 'AUTOMATIC_WRITER_FENCING_AND_ZONE_FAILURE_QUALIFICATION_REQUIRED'});
  }
}
