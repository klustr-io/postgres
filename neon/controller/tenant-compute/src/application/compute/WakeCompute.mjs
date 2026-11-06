import {randomUUID} from 'node:crypto';
/**
 * @typedef {Object} WakeComputeDependencies
 * @property {((name: string) => () => void) | null} beginConnection - Reserve managed database demand, absent for standalone endpoints.
 * @property {((name: string, activity: import('../../domain/database/DatabaseContracts.mjs').DatabaseEvent) => Promise<void>) | null} recordEvent - Fleet-aware activity command, absent for standalone endpoints.
 * @property {() => Promise<void>} ensureStorageActive - Shared storage availability command.
 * @property {(endpoint: ReturnType<import('../../domain/compute/ComputeSpecification.mjs').EndpointConfig>) => ReturnType<import('../../infrastructure/compute/Lifecycle.mjs').Lifecycle['wake']>} wake - Compute lifecycle command.
 * @property {() => void} requireLeader - Lease assertion after wake.
 * @property {(endpointId: string) => void} ready - Successful wake observation port.
 */
/** Coordinate connection demand, storage readiness and compute wake. */
export class WakeCompute {
  #beginConnection; #recordEvent; #ensureStorageActive; #wake; #requireLeader; #ready;
  /** @param {WakeComputeDependencies} dependencies - Explicit wake coordination ports. */
  constructor({beginConnection, recordEvent, ensureStorageActive, wake, requireLeader, ready}) {
    this.#beginConnection = beginConnection; this.#recordEvent = recordEvent; this.#ensureStorageActive = ensureStorageActive;
    this.#wake = wake; this.#requireLeader = requireLeader; this.#ready = ready;
  }
  /**
   * Wake an authenticated endpoint while retaining demand through the whole operation.
   * Requires client authorization at the proxy boundary and current leadership; side effects record activity, reserve demand and activate storage/compute.
   * @param {ReturnType<import('../../domain/compute/ComputeSpecification.mjs').EndpointConfig>} endpoint - Validated endpoint definition.
   * @returns {ReturnType<import('../../infrastructure/compute/Lifecycle.mjs').Lifecycle['wake']>} Ready compute routing information.
   * @throws {Error} On retirement, lease loss, storage unavailability or compute failure.
   */
  async Execute(endpoint) {
    // The activity command checks fleet/database admission before publishing demand.
    // Its short event hold covers the handoff to the longer connection reservation.
    if (this.#recordEvent && endpoint.databaseResource) await this.#recordEvent(endpoint.databaseResource, {id: 'connection-' + randomUUID(), holdSeconds: 3});
    const complete = this.#beginConnection && endpoint.databaseResource ? this.#beginConnection(endpoint.databaseResource) : () => {};
    try {
      await this.#ensureStorageActive();
      const result = await this.#wake(endpoint); this.#requireLeader(); this.#ready(endpoint.endpointId);
      return result;
    } finally {complete();}
  }
}
