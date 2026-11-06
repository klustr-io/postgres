/**
 * @typedef {Object} DatabaseQueryDependencies
 * @property {(name: string) => Promise<import('../../domain/database/DatabaseContracts.mjs').DatabaseResource>} readDatabase - Namespace database repository read port.
 */
/** Present public database state without exposing Kubernetes persistence metadata. */
export class DatabaseQuery {
  #readDatabase;
  /** @param {DatabaseQueryDependencies} dependencies - Explicit database read port. */
  constructor({readDatabase}) {this.#readDatabase = readDatabase;}
  /**
   * Read explicit policy and observed state.
   * Requires management read authorization at the owning API boundary; side effects read the namespace repository without changing policy.
   * @param {string} name - Resource name.
   * @returns {Promise<import('../../domain/database/DatabaseContracts.mjs').DatabaseView>} Public database view.
   * @throws {Error} On missing definitions, provider authorization or repository failure.
   */
  async Get(name) {const resource = await this.#readDatabase(name); return {name, spec: resource.spec, status: resource.status || {phase: 'Pending'}};}
}
