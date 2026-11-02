/** @typedef {import('../../domain/database/DatabaseContracts.mjs').DatabaseSpecification} DatabaseSpecification */
/** @typedef {import('../../domain/database/DatabaseContracts.mjs').DatabaseResource} DatabaseResource */
/**
 * @typedef {Object} BranchRequest
 * @property {string} name - New database resource name.
 * @property {string} [backup] - Retained backup name.
 * @property {string} [lsn] - Explicit WAL boundary.
 * @property {string} [timestamp] - Explicit recovery timestamp.
 * @property {string} [size] - Compute size override.
 * @property {DatabaseSpecification['suspend']} [suspend] - Idle policy override.
 * @property {DatabaseSpecification['profile']} [profile] - Commit profile override.
 * @property {string[]} [allowedIps] - Client allowlist override.
 */
/**
 * @typedef {Object} BranchDatabaseDependencies
 * @property {(name: string) => Promise<ReturnType<import('../recovery/Recovery.mjs').Recovery['source']>>} readSource - Load validated parent configuration and identity.
 * @property {(name: string, spec: DatabaseSpecification) => Promise<DatabaseResource>} putDatabase - Persist a validated child definition.
 * @property {() => void} requestReconcile - Schedule asynchronous provisioning.
 */

/** Create a copy-on-write branch while preserving parent storage and identity invariants. */
export class BranchDatabase {
  #readSource;
  #putDatabase;
  #requestReconcile;
  /** @param {BranchDatabaseDependencies} dependencies - Parent query and child command ports. */
  constructor({readSource, putDatabase, requestReconcile}) {
    this.#readSource = readSource; this.#putDatabase = putDatabase; this.#requestReconcile = requestReconcile;
  }

  /**
   * Create a branch using the parent database's storage identity and policy.
   * Requires fleet-admin or database-operator authorization at the owning API boundary; side effects persist the child and request reconciliation.
   * @param {string} name - Parent resource name.
   * @param {BranchRequest} input - Untrusted branch selection and compute overrides.
   * @returns {Promise<import('../../domain/database/DatabaseContracts.mjs').AcceptedDatabase>} Accepted child resource.
   * @throws {Error} On invalid input, unavailable source or immutable ancestry conflict.
   */
  async Execute(name, input) {
    const fields = ['name', 'backup', 'lsn', 'timestamp', 'size', 'suspend', 'profile', 'allowedIps'];
    if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).some(key => !fields.includes(key))) {
      throw Object.assign(Error('Invalid branch specification'), {code: 'INVALID_SPEC', status: 422});
    }
    const source = await this.#readSource(name), parent = source.tenant;
    const spec = {database: parent.database, user: parent.user, size: parent.size, tier: parent.tier, shards: parent.shards,
      profile: parent.profile, suspend: parent.suspend, allowedIps: parent.allowedIps,
      branchFrom: {database: name, ...Object.fromEntries(['backup', 'lsn', 'timestamp'].filter(key => input[key] !== undefined).map(key => [key, input[key]]))}};
    if (source.resource.spec.identity) spec.identity = source.resource.spec.identity;
    for (const key of ['size', 'suspend', 'profile', 'allowedIps']) if (input[key] !== undefined) spec[key] = input[key];
    const resource = await this.#putDatabase(input.name, spec);
    this.#requestReconcile();
    return {name: resource.metadata.name, accepted: true};
  }
}
