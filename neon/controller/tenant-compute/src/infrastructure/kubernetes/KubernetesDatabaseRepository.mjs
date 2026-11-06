/**
 * @typedef {Object} KubernetesDatabaseRepositoryDependencies
 * @property {import('./Kubernetes.mjs').Kubernetes} api - Namespace Kubernetes adapter.
 */
/** Kubernetes database definition read adapter. */
export class KubernetesDatabaseRepository {
  #api;
  /** @param {KubernetesDatabaseRepositoryDependencies} dependencies - Namespace infrastructure adapter. */
  constructor({api}) {this.#api = api;}
  /**
   * Read a database definition by namespace resource name.
   * Requires namespace database read permission and management authorization at its caller; side effects perform one provider read without mutation.
   * @param {string} name - Database resource name.
   * @returns {Promise<import('../../domain/database/DatabaseContracts.mjs').DatabaseResource>} Current definition.
   * @throws {Error} Provider rejection when the resource is missing or Kubernetes is unavailable.
   */
  Read(name) {return this.#api.get('neondatabases', name);}
}
