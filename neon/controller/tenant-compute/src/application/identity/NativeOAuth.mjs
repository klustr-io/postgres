import {IdentityError} from '../../domain/identity/IdentityPolicy.mjs';
import {NativeOAuthPolicy, HasDatabaseOAuthScopes} from '../../domain/identity/NativeOAuthPolicy.mjs';
/**
 * @typedef {Object} NativeOAuthRequest
 * @property {string} token - Opaque bearer token, never logged or persisted.
 * @property {string} role - Requested SQL login role.
 * @property {string} [database] - SQL database checked by the native validator.
 * @property {string} [issuer] - Exact issuer in PostgreSQL's matched HBA rule.
 * @property {string} [scope] - Required scope in PostgreSQL's matched HBA rule.
 */
/**
 * @typedef {Object} NativeOAuthResult
 * @property {boolean} authorized - Whether the token authorizes this precise database and role.
 * @property {string} authn_id - JSON issuer/subject identity for PostgreSQL system_user.
 */
/**
 * @typedef {Object} NativeOAuthDependencies
 * @property {import('../database/Databases.mjs').Databases['assertAvailable']} requireDatabase - Fleet-aware admission guard.
 * @property {import('../../infrastructure/identity/Identity.mjs').Identity} identity - Cryptographic database-audience and resource authorization.
 * @property {import('./NativeRolePreparation.mjs').NativeRolePreparation} roles - Restricted role preparation after authorization.
 * @property {(request: import('node:http').IncomingMessage, endpoint: ReturnType<import('../../domain/compute/ComputeSpecification.mjs').EndpointConfig>) => void} requireComputeIdentity - Endpoint-bound mTLS guard.
 * @property {(event: string, fact: Record<string, unknown>) => void} emit - Token-free identity audit sink.
 */
/** Native OAUTHBEARER authorization shared by the proxy and PostgreSQL validator. */
export class NativeOAuth {
  #requireDatabase; #identity; #roles; #requireComputeIdentity; #emit;
  /** @param {NativeOAuthDependencies} dependencies - Explicit resource, identity and role ports. */
  constructor({requireDatabase, identity, roles, requireComputeIdentity, emit}) {
    this.#requireDatabase = requireDatabase; this.#identity = identity; this.#roles = roles;
    this.#requireComputeIdentity = requireComputeIdentity; this.#emit = emit;
  }
  async #actor(input, resource) {
    if (!input || typeof input.token !== 'string' || input.token.length > 12288 || !/^[a-z][a-z0-9_]{0,62}$/.test(input.role || '')) throw IdentityError('INVALID_OAUTH_REQUEST', 422);
    const request = {headers: {authorization: 'Bearer ' + input.token}};
    const actor = await this.#identity.database(request, resource, input.role), policy = NativeOAuthPolicy(actor.config.database.oauth);
    if (!policy) throw IdentityError('NATIVE_OAUTH_DISABLED', 403);
    if (!HasDatabaseOAuthScopes(actor.claims, policy)) throw IdentityError('OAUTH_SCOPE_REQUIRED', 403);
    return actor;
  }
  #result(actor) {return {authorized: true, authn_id: JSON.stringify({iss: actor.issuer, sub: actor.subject})};}
  /**
   * Authorize the proxy's native token before waking compute or persisting managed role grants.
   * Requires authenticated proxy authority; side effects prepare only the approved role and emit token-free audit facts.
   * @param {ReturnType<import('../../domain/compute/ComputeSpecification.mjs').EndpointConfig>} endpoint - Managed endpoint.
   * @param {NativeOAuthRequest} input - Untrusted native bearer request.
   * @returns {Promise<NativeOAuthResult>} Native authorization result; no replacement password is minted.
   * @throws {Error} On invalid token, scope, resource binding, retirement or unsafe role.
   */
  async Authorize(endpoint, input) {
    const resource = await this.#requireDatabase(endpoint.databaseResource), actor = await this.#actor(input, resource);
    await this.#roles.Ensure(resource.metadata.name, input.role, current => this.#actor(input, current));
    this.#emit('oauth_database_login_authorized', {database: resource.metadata.name, databaseUID: resource.metadata.uid,
      endpointUID: endpoint.uid, issuer: actor.issuer, subject: actor.subject, role: input.role});
    return this.#result(actor);
  }
  /**
   * Validate a native PostgreSQL token without waking compute or running administrative SQL.
   * Requires endpoint-bound mTLS authorization; side effects emit an immutable token-free validation audit fact.
   * @param {import('node:http').IncomingMessage} request - Compute validator HTTPS request.
   * @param {ReturnType<import('../../domain/compute/ComputeSpecification.mjs').EndpointConfig>} endpoint - Managed endpoint.
   * @param {NativeOAuthRequest} input - Native token and requested SQL identity.
   * @returns {Promise<NativeOAuthResult>} Result consumed by the installed PG18 validator.
   * @throws {Error} On invalid peer, issuer, audience, scope, role, database or tenant/project.
   */
  async Validate(request, endpoint, input) {
    this.#requireComputeIdentity(request, endpoint);
    const resource = await this.#requireDatabase(endpoint.databaseResource), actor = await this.#actor(input, resource);
    if (input.database !== (resource.spec.database || 'app')) throw IdentityError('OIDC_ACCESS_DENIED', 403);
    if (input.issuer !== actor.config.issuer || input.scope !== NativeOAuthPolicy(actor.config.database.oauth).scope) throw IdentityError('OAUTH_POLICY_CHANGED', 403);
    this.#emit('oauth_database_token_validated', {database: resource.metadata.name, databaseUID: resource.metadata.uid,
      endpointUID: endpoint.uid, issuer: actor.issuer, subject: actor.subject, role: input.role});
    return this.#result(actor);
  }
}
