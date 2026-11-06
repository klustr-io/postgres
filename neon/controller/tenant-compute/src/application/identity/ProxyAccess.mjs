import {NativeOAuthPolicy} from '../../domain/identity/NativeOAuthPolicy.mjs';
/**
 * @typedef {Object} ProxyAccessDependencies
 * @property {() => ReturnType<import('../../domain/identity/IdentityPolicy.mjs').IdentityConfiguration>} identityConfiguration - Current database identity policy.
 * @property {(endpoint: ReturnType<import('../../domain/compute/ComputeSpecification.mjs').EndpointConfig>) => Promise<Record<string, string>>} loadRoleVerifiers - Restricted Secret read port.
 * @property {(endpoint: ReturnType<import('../../domain/compute/ComputeSpecification.mjs').EndpointConfig>, role: string) => Promise<string | null>} oidcVerifier - Expiring OIDC credential query.
 */
/**
 * @typedef {Object} ProxyAccessView
 * @property {string} role_secret - Approved SCRAM verifier.
 * @property {import('../../domain/identity/ComputeOAuth.mjs').ComputeOAuthSettings} [oauth] - Native OAuth issuer/scope advertisement; no bearer credentials.
 * @property {string[]} allowed_ips - Explicit client allowlist.
 * @property {string[]} allowed_vpc_endpoint_ids - Allowed private endpoint identifiers.
 * @property {boolean} block_public_connections - Whether public clients are rejected.
 * @property {boolean} block_vpc_connections - Whether private endpoint clients are rejected.
 * @property {string} project_id - Project metric identity.
 * @property {string} account_id - Hosting account label.
 */
const RoleUnavailable = message => Object.assign(Error(message), {status: 404, publicMessage: message});
/** Query role access policy before any database wake is permitted. */
export class ProxyAccess {
  #identityConfiguration; #loadRoleVerifiers; #oidcVerifier;
  /** @param {ProxyAccessDependencies} dependencies - Identity policy and verifier read ports. */
  constructor({identityConfiguration, loadRoleVerifiers, oidcVerifier}) {
    this.#identityConfiguration = identityConfiguration; this.#loadRoleVerifiers = loadRoleVerifiers; this.#oidcVerifier = oidcVerifier;
  }
  /**
   * Resolve an authorized proxy verifier and network policy without waking compute.
   * Requires proxy service authorization at the owning API boundary; side effects read current policy and approved Secret verifiers without creating demand.
   * @param {ReturnType<import('../../domain/compute/ComputeSpecification.mjs').EndpointConfig>} endpoint - Validated endpoint definition.
   * @param {string} role - Requested SQL role.
   * @returns {Promise<ProxyAccessView>} Proxy access contract.
   * @throws {Error} On unavailable role, expired identity or provider failure.
   */
  async Get(endpoint, role) {
    if (typeof role !== 'string' || !role || Buffer.byteLength(role) > 63) throw RoleUnavailable('Role not found');
    const identity = this.#identityConfiguration();
    const oauth = NativeOAuthPolicy(identity?.database.oauth);
    if (oauth && identity.database.roleBindings.some(binding => binding.postgresRole === role)) {
      return {...this.#network(endpoint), role_secret: '', oauth: {issuer: identity.issuer, scope: oauth.scope}};
    }
    if (identity && !identity.database.allowPasswordAuth && !/^oidc_[a-f0-9]{24}$/.test(role)) throw RoleUnavailable('OIDC credential exchange required');
    const roles = await this.#loadRoleVerifiers(endpoint);
    const verifier = Object.hasOwn(roles, role) ? roles[role] : await this.#oidcVerifier(endpoint, role);
    this.#validateVerifier(verifier);
    return {...this.#network(endpoint), role_secret: verifier};
  }
  #network(endpoint) {return {allowed_ips: endpoint.allowedIps, allowed_vpc_endpoint_ids: [],
    block_public_connections: false, block_vpc_connections: true, project_id: endpoint.projectId, account_id: 'self-hosted'};}
  #validateVerifier(verifier) {
    if (typeof verifier !== 'string' || !/^SCRAM-SHA-256\$[0-9]+:/.test(verifier)) throw RoleUnavailable('Role not found');
    const iterations = Number(verifier.match(/^SCRAM-SHA-256\$([0-9]+):/)[1]);
    if (!Number.isSafeInteger(iterations) || iterations < 1 || iterations > 100000) throw RoleUnavailable('Role verifier is outside supported bounds');
  }
}
