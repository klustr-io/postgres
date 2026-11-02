import {EndpointConfig as endpointConfig} from '../../domain/compute/ComputeSpecification.mjs';
import {AlwaysOn as alwaysOn} from '../../domain/compute/Activity.mjs';
/** @typedef {import('../../domain/compute/ComputeSpecification.mjs').EndpointDefinition} EndpointDefinition */
/**
 * @typedef {Object} BackgroundReconciler
 * @property {string} name - Bounded capability name for failure attribution.
 * @property {() => Promise<void>} Reconcile - Capability reconciliation callback.
 */
/**
 * @typedef {Object} ComputeReconciliationDependencies
 * @property {() => Promise<EndpointDefinition[]>} listDefinitions - Endpoint repository query.
 * @property {() => string[]} activeMonitorIds - Active SQL activity monitor identities.
 * @property {(identity: Pick<import('../../domain/database/DatabaseContracts.mjs').ResourceIdentity, 'uid'>) => Promise<void>} closeMonitor - Close a stale SQL monitor.
 * @property {((endpoint: ReturnType<typeof endpointConfig>) => Promise<void>) | null} reconcileManaged - Managed database lifecycle command, absent for standalone endpoints.
 * @property {(endpoint: ReturnType<typeof endpointConfig>) => Promise<unknown>} wake - Unmanaged compute wake command.
 * @property {(endpoint: ReturnType<typeof endpointConfig>) => Promise<unknown>} idle - Unmanaged compute idle command.
 * @property {() => boolean} isLeader - Current lease observation.
 * @property {() => boolean} stopping - Process shutdown observation.
 * @property {BackgroundReconciler[]} background - Independent bounded reconcilers.
 * @property {(endpointId: string) => void} suspended - Successful suspension observation.
 * @property {(event: string, fields: Record<string, unknown>) => void} deferred - Bounded failure observation.
 */

/** Own endpoint snapshots and reconcile compute without embedding worker logic in composition. */
export class ComputeReconciliation {
  #endpoints = new Map(); #busy = false; #listDefinitions; #activeMonitorIds; #closeMonitor; #reconcileManaged;
  #wake; #idle; #isLeader; #stopping; #background; #suspended; #deferred;
  /** @param {ComputeReconciliationDependencies} dependencies - Explicit worker commands and observation ports. */
  constructor({listDefinitions, activeMonitorIds, closeMonitor, reconcileManaged, wake, idle, isLeader, stopping, background, suspended, deferred}) {
    this.#listDefinitions = listDefinitions; this.#activeMonitorIds = activeMonitorIds; this.#closeMonitor = closeMonitor;
    this.#reconcileManaged = reconcileManaged; this.#wake = wake; this.#idle = idle; this.#isLeader = isLeader;
    this.#stopping = stopping; this.#background = background; this.#suspended = suspended; this.#deferred = deferred;
  }
  /**
   * Read a copied endpoint snapshot for a connection request.
   * The owning proxy boundary authorizes connection lookups; this read has no side effects and cannot expose the mutable cache.
   * @param {string} id - Endpoint identifier.
   * @returns {ReturnType<typeof endpointConfig> | undefined} Current validated definition.
   */
  Find(id) {return structuredClone(this.#endpoints.get(id));}
  /**
   * Read endpoint definitions without exposing the worker's mutable map.
   * Internal runtime consumers need no additional management permission; this copied read has no mutation side effects.
   * @returns {Map<string, ReturnType<typeof endpointConfig>>} Copied endpoint snapshot.
   */
  Endpoints() {return structuredClone(this.#endpoints);}
  /**
   * Count known validated endpoint definitions.
   * Internal health telemetry needs no management permission; this count has no mutation side effects.
   * @returns {number} Current endpoint count.
   */
  Count() {return this.#endpoints.size;}
  /**
   * Refresh the validated endpoint snapshot from the configured repository.
   * Requires namespace read permission on the repository; side effects replace the owned snapshot and emit invalid-definition observations.
   * @returns {Promise<void>} Invalid definitions are reported and excluded.
   * @throws {Error} On repository failure or an observation sink that cannot record a rejected definition.
   */
  async Refresh() {
    const next = new Map();
    for (const resource of await this.#listDefinitions()) {
      try {const endpoint = endpointConfig(resource); next.set(endpoint.endpointId, endpoint);}
      catch {this.#deferred('invalid_endpoint_definition', {resource: resource.metadata.name});}
    }
    this.#endpoints = next;
  }
  /**
   * Reconcile independent capabilities and compute using a current endpoint snapshot.
   * Each mutating command enforces lease authorization; side effects close stale SQL monitors and invoke demand/compute reconciliation.
   * @returns {Promise<void>} Lease loss or provider failures defer work without mutating another owner's compute.
   * @throws {Error} If the injected failure sink itself fails; ordinary provider failures are recorded for retry.
   */
  async Reconcile() {
    if (this.#busy || this.#stopping()) return; this.#busy = true;
    try {
      for (const worker of this.#background) void worker.Reconcile().catch(error => this.#deferred('background_reconcile_deferred', {capability: worker.name, reason: error.code || 'OPERATION_FAILED'}));
      await this.Refresh(); await this.#closeStaleMonitors();
      for (const endpoint of this.#endpoints.values()) {
        if (this.#stopping() || !this.#isLeader()) break;
        await this.#reconcileEndpoint(endpoint);
      }
    } catch (error) {this.#deferred('reconcile_unavailable', {reason: error.code || 'OPERATION_FAILED'});}
    finally {this.#busy = false;}
  }
  async #closeStaleMonitors() {
    const known = new Set([...this.#endpoints.values()].map(endpoint => endpoint.uid));
    for (const uid of this.#activeMonitorIds()) if (!this.#isLeader() || !known.has(uid)) await this.#closeMonitor({uid});
  }
  async #reconcileEndpoint(endpoint) {
    try {
      const before = endpoint.status.phase;
      if (this.#reconcileManaged && endpoint.databaseResource) await this.#reconcileManaged(endpoint);
      else if (alwaysOn(endpoint)) await this.#wake(endpoint);
      else await this.#idle(endpoint);
      if (before !== 'Dormant' && endpoint.status.phase === 'Dormant') this.#suspended(endpoint.endpointId);
    } catch (error) {this.#deferred('lifecycle_deferred', {endpoint: endpoint.endpointId, reason: error.code || 'OPERATION_FAILED'});}
  }
}
