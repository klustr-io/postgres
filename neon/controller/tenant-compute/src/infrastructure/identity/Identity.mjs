import https from 'node:https';
import fs from 'node:fs';
import {rootCertificates} from 'node:tls';

import {IdentityError as identityError, HttpsIdentityUrl as httpsURL, IdentityConfiguration as identityConfiguration, ManagementRoles as authorizationRole} from '../../domain/identity/IdentityPolicy.mjs';
import {ParseAccessToken, BearerAccessToken, VerifyAccessToken, ValidateAccessTokenClaims} from '../../domain/identity/AccessToken.mjs';
import {TokenValidationPolicy} from '../../domain/identity/TokenValidationPolicy.mjs';
import {CachedTokenIntrospection} from './CachedTokenIntrospection.mjs';
/**
 * @typedef {Object} IdentityDependencies
 * @property {() => import('../../domain/identity/IdentityPolicy.mjs').IdentityConfigurationValue | null | undefined} configuration - Current provider-owned issuer and audience policy.
 * @property {typeof GetIdentityJson} [fetchJSON] - Bounded verified-HTTPS discovery/JWKS read port.
 * @property {typeof import('./TokenIntrospection.mjs').IntrospectAccessToken} [introspect] - Optional validation port override; default is an instance-owned bounded introspection cache.
 * @property {() => number} [clock] - Trusted epoch milliseconds for token expiry and key-refresh bounds.
 */
/**
 * Read a fixed HTTPS identity document with certificate verification and response bounds.
 * Requires provider-configured URL authority; side effects perform one HTTPS read and optional private-CA file access without logging credentials.
 * @param {string} url - Configured issuer discovery or signing-key URL.
 * @param {string} [caFile] - Optional provider-selected private CA bundle path.
 * @returns {Promise<unknown>} Untrusted decoded provider JSON, validated by its consumer before use.
 * @throws {Error} On unsafe URLs, unavailable endpoints, timeout, response limits or malformed JSON.
 */
export function GetIdentityJson(url, caFile) {
  return new Promise((resolve, reject) => {
    const request = https.get(httpsURL(url, true), {timeout: 5000,
      ...(caFile ? {ca: [...rootCertificates, fs.readFileSync(caFile, 'utf8')]} : {})}, response => {
      if (response.statusCode !== 200) {response.resume(); return reject(identityError('OIDC_KEYS_UNAVAILABLE', 503));}
      const chunks = []; let size = 0;
      response.on('data', chunk => {size += chunk.length; if (size > 262144) response.destroy(Error('Identity response limit')); else chunks.push(chunk);});
      response.on('error', reject); response.on('end', () => {try {resolve(JSON.parse(Buffer.concat(chunks)));} catch {reject(identityError('OIDC_KEYS_UNAVAILABLE', 503));}});
    });
    request.on('timeout', () => request.destroy(Error('Identity request timeout'))); request.on('error', () => reject(identityError('OIDC_KEYS_UNAVAILABLE', 503)));
  });
}
/** Verify JWT/introspection identities against explicit issuer, audience, group and database-resource policy. */
export class Identity {
  /** @param {IdentityDependencies} dependencies - Fixed identity policy, provider ports and trusted epoch clock. */
  constructor({configuration, fetchJSON = GetIdentityJson, introspect, clock = () => Date.now()}) {
    const provider = new CachedTokenIntrospection({clock});
    Object.assign(this, {configuration, fetchJSON, introspect: introspect || provider.Resolve.bind(provider), clock}); this.cache = null; this.loading = null;
  }
  /**
   * Resolve public signing keys for a configured issuer with bounded refresh.
   * Requires provider configuration authorization at the owning boundary; side effects fetch/validate discovery and update only the signing-key cache.
   * @param {import('../../domain/identity/IdentityPolicy.mjs').IdentityConfigurationValue} config - Validated provider identity policy.
   * @param {boolean} [force] - Permit unknown-key refresh after the minimum refetch interval.
   * @returns {Promise<import('node:crypto').JsonWebKey[]>} Candidate public verification keys; this read does not authorize an actor.
   * @throws {Error} On unsafe discovery, issuer mismatch, invalid JWKS or provider failure.
   */
  async keys(config, force = false) {
    const key = JSON.stringify([config.issuer, config.jwksUrl, config.caSecretRef]);
    if (this.cache?.key === key && this.clock() - this.cache.at < (force ? 5000 : 300000)) return this.cache.keys;
    if (this.loading) {await this.loading; if (this.cache?.key === key) return this.cache.keys;}
    const task = (async () => {
      let url = config.jwksUrl;
      const ca = config.caSecretRef ? '/run/oidc-ca/ca.crt' : undefined;
      if (!url) {
        const discovery = await this.fetchJSON(config.issuer.replace(/\/$/, '') + '/.well-known/openid-configuration', ca);
        if (discovery.issuer !== config.issuer) throw identityError('OIDC_ISSUER_MISMATCH');
        url = discovery.jwks_uri; httpsURL(url, true);
      }
      const body = await this.fetchJSON(url, ca);
      if (!Array.isArray(body.keys) || body.keys.length > 100 || !body.keys.length) throw identityError('OIDC_KEYS_UNAVAILABLE', 503);
      const keys = body.keys.filter(jwk => ['RSA', 'EC', 'OKP'].includes(jwk.kty) && (!jwk.use || jwk.use === 'sig') && (!jwk.key_ops || jwk.key_ops.includes('verify')));
      this.cache = {key, keys, at: this.clock()}; return keys;
    })();
    this.loading = task;
    try {return await task;} finally {if (this.loading === task) this.loading = null;}
  }
  /**
   * Verify an access token for one explicit audience and resolve granted group bindings.
   * This is authentication, not complete resource authorization; side effects may refresh public keys or perform authenticated introspection, never wake databases.
   * @param {import('node:http').IncomingMessage} request - Bearer-bearing request at the intended audience boundary.
   * @param {'management' | 'database'} kind - Intended resource audience, selected by the owning API/application.
   * @returns {Promise<import('../../domain/identity/IdentityPolicy.mjs').IdentityActor>} Verified identity, token metadata and explicit candidate bindings.
   * @throws {Error} On missing configuration, invalid/inactive tokens, unavailable validation or absent group bindings.
   */
  async authenticate(request, kind) {
    const config = identityConfiguration(this.configuration());
    if (!config) throw identityError('OIDC_NOT_CONFIGURED');
    const claims = await this.#claims(request, config, kind);
    ValidateAccessTokenClaims({valid: true, claims, config, kind, now: Math.floor(this.clock() / 1000)});
    const groups = claims[config.groupsClaim || 'groups'];
    const bindings = config[kind].roleBindings.filter(binding => Array.isArray(groups) && groups.includes(binding.group));
    if (!bindings.length) throw identityError('OIDC_ACCESS_DENIED', 403);
    return {subject: claims.sub, issuer: claims.iss, expires: claims.exp, claims, config, bindings};
  }
  async #claims(request, config, kind) {
    if (TokenValidationPolicy(config[kind].tokenValidation).mode === 'introspection') {
      const claims = await this.introspect(BearerAccessToken(request.headers.authorization), config, kind);
      if (claims?.active !== true || claims.token_type !== undefined && !/^Bearer$/i.test(claims.token_type)) throw identityError('OIDC_TOKEN_INACTIVE');
      // A trusted fixed introspection endpoint supplies issuer authority when its
      // RFC-optional iss field is absent. A conflicting iss is never overwritten.
      return {...claims, iss: claims.iss === undefined ? config.issuer : claims.iss};
    }
    const token = ParseAccessToken(request.headers.authorization, config), jwk = await this.#signingKey(token.header, config);
    if (!VerifyAccessToken(token, jwk)) throw identityError('OIDC_TOKEN_INVALID');
    return token.claims;
  }
  async #signingKey(header, config) {
    let keys = await this.keys(config);
    if (!keys.some(key => key.kid === header.kid)) keys = await this.keys(config, true);
    const matches = keys.filter(key => key.kid === header.kid && (!key.alg || key.alg === header.alg));
    if (matches.length !== 1) throw identityError('OIDC_TOKEN_INVALID');
    return matches[0];
  }
  /**
   * Authorize a management identity for the declared HTTP method and resource path.
   * Requires a valid management-audience token and matching fleet role; side effects are limited to authentication provider calls and signing-key cache updates.
   * @param {import('node:http').IncomingMessage} request - Management request carrying its fixed route and bearer header.
   * @returns {Promise<import('../../domain/identity/IdentityPolicy.mjs').IdentityActor>} Verified management actor allowed to invoke this route.
   * @throws {Error} On token/provider failure or insufficient fleet-management authorization.
   */
  async management(request) {
    const actor = await this.authenticate(request, 'management');
    if (!actor.bindings.some(binding => authorizationRole(request.method, request.url).includes(binding.role))) throw identityError('OIDC_ACCESS_DENIED', 403);
    return actor;
  }
  /**
   * Authorize a database token for the exact tenant/project binding and mapped SQL role.
   * Requires valid database-audience authentication; side effects perform configured validation only, without database wake or role mutation.
   * @param {import('node:http').IncomingMessage} request - Database bearer-token request.
   * @param {import('../../domain/database/DatabaseContracts.mjs').DatabaseResource} resource - Current database ownership binding.
   * @param {string} role - Requested restricted PostgreSQL role.
   * @returns {Promise<import('../../domain/identity/IdentityPolicy.mjs').IdentityActor>} Actor authorized for this database binding and SQL role.
   * @throws {Error} On token/provider failure, mismatched tenant/project or ungranted roles.
   */
  async database(request, resource, role) {
    const actor = await this.authenticate(request, 'database'), binding = resource.spec.identity;
    if (!binding || actor.claims[actor.config.tenantClaim || 'tenant'] !== binding.tenant || actor.claims[actor.config.projectClaim || 'project'] !== binding.project ||
        !actor.bindings.some(binding => binding.postgresRole === role)) throw identityError('OIDC_ACCESS_DENIED', 403);
    return actor;
  }
}
