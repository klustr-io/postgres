import {SelectFleetOwner} from '../../domain/fleet/FleetPolicy.mjs';
import {ValidateFleet} from '../../domain/fleet/FleetSpecification.mjs';

/** @typedef {import('../../domain/fleet/FleetSpecification.mjs').FleetResource} FleetResource */
/** @typedef {import('../../domain/fleet/FleetSpecification.mjs').FleetSpecification} FleetSpecification */
/**
 * @typedef {Object} FleetRepository
 * @property {() => Promise<FleetResource[]>} List - Load namespace fleet identities.
 * @property {(current: FleetResource, spec: FleetSpecification) => Promise<FleetResource>} Replace - Replace spec using the observed resource version.
 */
/**
 * @typedef {Object} FleetConfigurationDependencies
 * @property {FleetRepository} repository - Namespace fleet persistence port.
 * @property {() => void} requireLeader - Lease assertion before commands.
 */
/**
 * @typedef {Object} FleetConfigurationView
 * @property {string} name - Fleet name.
 * @property {FleetSpecification} spec - Desired fleet policy.
 * @property {FleetResource['status']} status - Observed reconciliation state.
 */
/**
 * @typedef {Object} AcceptedFleetRevision
 * @property {string} name - Established fleet resource name.
 * @property {number} generation - Accepted desired-state generation, not observed completion.
 */
/**
 * Fleet configuration commands and queries enforce ownership and lifecycle.
 * Persistence and HTTP response handling are owned by separate adapters.
 */
export class FleetConfiguration {
  #repository;
  #requireLeader;
  /**
   * @param {FleetConfigurationDependencies} dependencies - Explicit persistence and lease ports.
   */
  constructor({repository, requireLeader}) {this.#repository = repository; this.#requireLeader = requireLeader;}

  /** @returns {Promise<FleetResource>} Established namespace owner, or a typed conflict error. */
  async #owner() {
    this.#requireLeader();
    const {owner} = SelectFleetOwner(await this.#repository.List());
    if (!owner) throw Object.assign(Error('Expected a fleet in this namespace'), {code: 'FLEET_NOT_CONFIGURED', status: 409});
    return owner;
  }

  /**
   * Read the established fleet, ignoring rejected newcomers.
   * Requires management read authorization at the owning application boundary; side effects read the owner repository under its namespace lease.
   * @returns {Promise<FleetConfigurationView>} Public desired and observed configuration.
   * @throws {Error} On lease loss, ownership conflict or provider failure.
   */
  async Get() {
    const resource = await this.#owner();
    return {name: resource.metadata.name, spec: resource.spec, status: resource.status};
  }

  /**
   * Validate and replace desired policy using optimistic concurrency.
   * Requires fleet-admin authorization at the owning application boundary; side effects persist the validated complete spec with the current resource version.
   * @param {FleetSpecification} spec - Untrusted replacement policy.
   * @returns {Promise<AcceptedFleetRevision>} Accepted fleet generation.
   * @throws {Error} On retirement, invalid policy, ownership conflict or stale version.
   */
  async Revise(spec) {
    const resource = await this.#owner();
    if (resource.metadata.deletionTimestamp) throw Object.assign(Error('Fleet is retiring'), {code: 'FLEET_RETIRED', status: 409});
    try {ValidateFleet({...resource, spec});}
    catch {throw Object.assign(Error('Invalid fleet policy'), {code: 'INVALID_FLEET_SPEC', status: 422});}
    this.#requireLeader();
    const updated = await this.#repository.Replace(resource, spec);
    return {name: updated.metadata.name, generation: updated.metadata.generation};
  }
}
