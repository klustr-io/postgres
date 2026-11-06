/**
 * @typedef {Object} KubernetesEndpointDefinitionsDependencies
 * @property {import('./Kubernetes.mjs').Kubernetes} api - Namespace endpoint-definition adapter.
 */
/** Kubernetes endpoint definition repository, also supported by the Compose adapter. */
export class KubernetesEndpointDefinitions {
  #api;
  /** @param {KubernetesEndpointDefinitionsDependencies} dependencies - Namespace infrastructure adapter. */
  constructor({api}) {this.#api = api;}
  /**
   * Read only controller-owned endpoint ConfigMaps.
   * Requires namespace ConfigMap read permission; side effects list provider definitions without changing endpoint or worker state.
   * @returns {Promise<import('../../application/compute/ComputeReconciliation.mjs').EndpointDefinition[]>} Current endpoint definitions.
   * @throws {Error} On provider authorization, transport or decoding failure.
   */
  List() {return this.#api.list('configmaps', 'neon.klustr.io/endpoint=true');}
}
