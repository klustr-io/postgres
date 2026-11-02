/**
 * @typedef {Object} KubernetesFleetRepositoryDependencies
 * @property {import('./Kubernetes.mjs').Kubernetes} api - Namespace Kubernetes adapter.
 */

/** Kubernetes implementation of the application-owned FleetRepository port. */
export class KubernetesFleetRepository {
  #api;
  /** @param {KubernetesFleetRepositoryDependencies} dependencies - Namespace infrastructure adapter. */
  constructor({api}) {this.#api = api;}

  /**
   * Load namespace fleet identities for ownership selection.
   * Requires namespace fleet read permission; side effects read provider resources without selecting or mutating an owner here.
   * @returns {Promise<import('../../domain/fleet/FleetSpecification.mjs').FleetResource[]>} Current resources.
   */
  List() {return this.#api.list('neonfleets', '');}

  /**
   * Replace desired policy without discarding Kubernetes identity or concurrency metadata.
   * Requires fleet-admin authorization at the application boundary and namespace update permission; side effects replace the current resource using its version.
   * @param {import('../../domain/fleet/FleetSpecification.mjs').FleetResource} current - Observed resource.
   * @param {import('../../domain/fleet/FleetSpecification.mjs').FleetSpecification} spec - Validated desired policy.
   * @returns {Promise<import('../../domain/fleet/FleetSpecification.mjs').FleetResource>} Updated resource.
   */
  Replace(current, spec) {return this.#api.request('PUT', this.#api.path('neonfleets', current.metadata.name), {...current, spec});}
}
