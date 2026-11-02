import {randomUUID} from 'node:crypto';
import {IdentityError} from '../../domain/identity/IdentityPolicy.mjs';
/**
 * @typedef {Object} NativeRolePreparationDependencies
 * @property {import('../database/Databases.mjs').Databases['assertAvailable']} requireDatabase - Current database admission guard.
 * @property {import('../database/Databases.mjs').Databases['beginConnection']} beginConnection - Connection demand reservation.
 * @property {import('../database/Databases.mjs').Databases['event']} recordEvent - Fleet-aware activity command.
 * @property {() => Promise<void>} ensureStorageActive - Shared storage readiness command.
 * @property {(name: string) => ReturnType<import('../../domain/compute/ComputeSpecification.mjs').EndpointConfig> | undefined} findEndpoint - Database endpoint query.
 * @property {import('../../infrastructure/compute/Lifecycle.mjs').Lifecycle} lifecycle - Serialized compute administrative port.
 * @property {(client: import('pg').Client) => import('../../infrastructure/postgres/PostgresLoginRoles.mjs').PostgresLoginRoles} rolesForClient - Restricted role SQL adapter factory.
 * @property {() => void} requireLeader - Lease guard before SQL role mutations.
 */
/** Prepare a restricted SQL LOGIN after native OAuth authorization and before backend authentication. */
export class NativeRolePreparation {
  #requireDatabase; #beginConnection; #recordEvent; #ensureStorageActive; #findEndpoint; #lifecycle; #rolesForClient; #requireLeader;
  /** @param {NativeRolePreparationDependencies} dependencies - Explicit admission, wake and restricted-role ports. */
  constructor({requireDatabase, beginConnection, recordEvent, ensureStorageActive, findEndpoint, lifecycle, rolesForClient, requireLeader}) {
    this.#requireDatabase = requireDatabase; this.#beginConnection = beginConnection; this.#recordEvent = recordEvent;
    this.#ensureStorageActive = ensureStorageActive; this.#findEndpoint = findEndpoint; this.#lifecycle = lifecycle;
    this.#rolesForClient = rolesForClient; this.#requireLeader = requireLeader;
  }
  /**
   * Require already authorized native OAuth and prepare only the requested restricted role.
   * The owning application boundary authorizes before invoking this command; side effects wake compute and persist managed grants.
   * @param {string} name - Managed database name.
   * @param {string} role - Requested SQL role.
   * @param {(resource: import('../../domain/database/DatabaseContracts.mjs').DatabaseResource) => Promise<import('../../domain/identity/IdentityPolicy.mjs').IdentityActor>} reauthorize - Recheck current identity policy after wake.
   * @returns {Promise<void>} Resolves when the approved role can perform native LOGIN.
   * @throws {Error} On retirement, identity changes, lease loss or unsafe roles.
   */
  async Ensure(name, role, reauthorize) {
    const resource = await this.#requireDatabase(name), complete = this.#beginConnection(name);
    try {
      await this.#recordEvent(name, {id: 'oauth-' + randomUUID(), holdSeconds: 5});
      await this.#ensureStorageActive();
      const endpoint = this.#findEndpoint(name);
      if (!endpoint) throw IdentityError('DATABASE_NOT_READY', 503);
      await this.#lifecycle.wake(endpoint);
      await this.#lifecycle.serialized(endpoint, () => this.#prepareRole(resource, endpoint, role, reauthorize));
    } finally {complete();}
  }
  async #prepareRole(resource, endpoint, role, reauthorize) {
    this.#requireLeader(); const current = await this.#requireDatabase(resource.metadata.name);
    if (current.metadata.uid !== resource.metadata.uid) throw IdentityError('DATABASE_NOT_READY', 503);
    const actor = await reauthorize(current), pods = await this.#lifecycle.pods(endpoint);
    if (pods.length !== 1 || !this.#lifecycle.ready(pods[0])) throw IdentityError('DATABASE_NOT_READY', 503);
    const client = await this.#lifecycle.admin(endpoint, pods[0], current.spec.database || 'app');
    try {
      this.#requireLeader();
      await this.#rolesForClient(client).PrepareTarget({role, database: current.spec.database || 'app', owner: current.spec.user || 'app_user',
        managedRole: actor.config.database.managedRole || 'app_runtime', nativeLogin: true});
    } finally {await client.end();}
  }
}
