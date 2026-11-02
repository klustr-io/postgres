/** @typedef {Pick<import('./FleetSpecification.mjs').FleetResource, 'metadata' | 'status'>} FleetIdentity */
/**
 * @typedef {Object} FleetOwnershipSelection
 * @property {FleetIdentity | null} owner - Established owner or first eligible candidate, absent in standalone installations.
 * @property {FleetIdentity[]} conflicts - Other namespace fleets which must be rejected without stopping the owner.
 */

/**
 * Select the established namespace owner, isolating conflicting newcomers.
 * Multiple established storage owners require operator intervention; never guess.
 * @param {FleetIdentity[]} fleets - Namespace fleet resources.
 * @returns {FleetOwnershipSelection} Owner and rejected newcomers.
 * @throws {Error} FLEET_OWNERSHIP_CONFLICT when multiple storage identities exist.
 */
export function SelectFleetOwner(fleets) {
  const established = fleets.filter(fleet => fleet.status?.storageIdentity);
  if (established.length > 1) throw Object.assign(Error('Multiple established fleet owners'), {code: 'FLEET_OWNERSHIP_CONFLICT'});
  const candidates = established.length ? established : [...fleets].sort((left, right) => {
    const retained = fleet => Number(fleet.metadata.finalizers?.includes('neon.klustr.io/retain-fleet') || false);
    return retained(right) - retained(left) ||
      (left.metadata.creationTimestamp || '').localeCompare(right.metadata.creationTimestamp || '') ||
      left.metadata.name.localeCompare(right.metadata.name);
  });
  const owner = candidates[0] || null;
  return {owner, conflicts: fleets.filter(fleet => fleet !== owner)};
}

/**
 * Enforce the enclosing fleet lifecycle before any create or wake command.
 * A namespace without NeonFleet resources supports the standalone installation.
 * @param {FleetIdentity[]} fleets - Namespace fleet resources.
 * @returns {void}
 * @throws {Error} FLEET_RETIRED or FLEET_OWNERSHIP_CONFLICT; callers must fail closed.
 */
export function RequireServingFleet(fleets) {
  if (SelectFleetOwner(fleets).owner?.metadata.deletionTimestamp) {
    throw Object.assign(Error('Fleet is retiring'), {code: 'FLEET_RETIRED'});
  }
}
