import {SecretText as secretText} from '../../domain/compute/ComputeSpecification.mjs';
/**
 * @typedef {Object} EndpointRoleVerifiersDependencies
 * @property {import('../kubernetes/Kubernetes.mjs').Kubernetes} api - Namespace Secret adapter.
 */
/** Read endpoint role verifiers from the configured Secret provider. */
export class EndpointRoleVerifiers {
  #api;
  /** @param {EndpointRoleVerifiersDependencies} dependencies - Namespace infrastructure adapter. */
  constructor({api}) {this.#api = api;}
  /**
   * Load SCRAM verifiers without exposing other endpoint Secrets.
   * Requires authorized proxy lookup and namespace Secret read permission; side effects read only the referenced verifier Secret, without logging it.
   * @param {ReturnType<import('../../domain/compute/ComputeSpecification.mjs').EndpointConfig>} endpoint - Validated endpoint definition.
   * @returns {Promise<Record<string, string>>} Role-to-verifier mapping.
   * @throws {Error} On missing Secrets, invalid verifier documents or Kubernetes failure.
   */
  async Load(endpoint) {
    const roles = JSON.parse(secretText(await this.#api.get('secrets', endpoint.rolesSecret), 'roles.json'));
    if (!roles || typeof roles !== 'object' || Array.isArray(roles)) throw Error('Invalid endpoint role verifiers');
    return roles;
  }
}
