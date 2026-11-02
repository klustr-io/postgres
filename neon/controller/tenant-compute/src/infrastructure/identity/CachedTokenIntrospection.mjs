import fs from 'node:fs';
import {createHmac, randomBytes} from 'node:crypto';
import {IdentityError} from '../../domain/identity/IdentityPolicy.mjs';
import {ValidateAccessTokenClaims} from '../../domain/identity/AccessToken.mjs';
import {TokenValidationPolicy} from '../../domain/identity/TokenValidationPolicy.mjs';
import {IntrospectAccessToken} from './TokenIntrospection.mjs';

/**
 * @typedef {Object} CachedIntrospectionDependencies
 * @property {typeof IntrospectAccessToken} [request] - Fixed-endpoint HTTPS validation port; called only on misses.
 * @property {() => number} [clock] - Epoch milliseconds used for absolute token expiry.
 * @property {() => number} [elapsed] - Monotonic milliseconds used for cache lifetime.
 * @property {import('./TokenIntrospection.mjs').IntrospectionDependencies['readSecret']} [readSecret] - Fresh projected credential read on every lookup, including hits.
 * @property {import('./TokenIntrospection.mjs').IntrospectionDependencies['caForConfig']} [caForConfig] - Private CA path resolver; file contents participate in cache isolation.
 */
/**
 * Cache active, claim-valid introspection metadata within one identity provider instance.
 * Raw tokens and client credentials are never cache keys. The bounded cache does not store authorization decisions.
 */
export class CachedTokenIntrospection {
  #entries = new Map(); #pending = new Map(); #bytes = 0; #key = randomBytes(32);
  #request; #clock; #elapsed; #readSecret; #caForConfig;
  /** @param {CachedIntrospectionDependencies} [dependencies] - Validation, credential, trust and clock ports owned by this provider instance. */
  constructor({request = IntrospectAccessToken, clock = () => Date.now(), elapsed = () => performance.now(),
    readSecret = kind => fs.readFileSync(`/run/oidc-introspection/${kind}/client-secret`, 'utf8'),
    caForConfig = config => config.caSecretRef ? '/run/oidc-ca/ca.crt' : undefined} = {}) {
    this.#request = request; this.#clock = clock; this.#elapsed = elapsed;
    this.#readSecret = readSecret; this.#caForConfig = caForConfig;
  }
  /**
   * Resolve active token metadata for the configured audience with bounded reuse and concurrent-miss coalescing.
   * Requires provider configuration authorization; side effects read current credentials/trust, update private cache state and contact the IdP on misses.
   * Every caller still requires current group, scope and database-resource authorization. Expired results and provider errors are never reused.
   * @param {string} token - Bounded opaque bearer token; never retained as a cache key or logged.
   * @param {import('../../domain/identity/IdentityPolicy.mjs').IdentityConfigurationValue} config - Current complete identity policy, included in cache isolation.
   * @param {'management' | 'database'} kind - Audience boundary; entries cannot cross management and database access.
   * @returns {Promise<Record<string, unknown>>} Independent copy of active, claim-valid metadata.
   * @throws {Error} On invalid/inactive tokens, unavailable credentials/trust, validation failure or excess concurrent misses.
   */
  async Resolve(token, config, kind) {
    let secret, caFile, key;
    const policy = TokenValidationPolicy(config[kind].tokenValidation);
    try {
      secret = this.#readSecret(kind); caFile = this.#caForConfig(config);
      if (policy.mode !== 'introspection' || typeof secret !== 'string' || !secret || secret.length > 4096) throw Error('Invalid introspection authority');
      key = createHmac('sha256', this.#key).update(JSON.stringify([kind, config, secret,
        caFile ? fs.readFileSync(caFile, 'utf8') : null, token])).digest('hex');
    } catch {throw IdentityError('OIDC_INTROSPECTION_UNAVAILABLE', 503);}
    const cached = this.#entries.get(key);
    if (cached && cached.until > this.#elapsed() && cached.expires > this.#clock()) {
      this.#entries.delete(key); this.#entries.set(key, cached);
      return structuredClone(cached.claims);
    }
    if (cached) this.#remove(key);
    if (!this.#pending.has(key)) {
      if (this.#pending.size >= 128) throw IdentityError('OIDC_INTROSPECTION_UNAVAILABLE', 503);
      const work = this.#load(token, config, kind, secret, caFile, key);
      this.#pending.set(key, work);
      // Attach both completion handlers so rejected work is removed without an unhandled finally promise.
      void work.then(() => this.#pending.delete(key), () => this.#pending.delete(key));
    }
    return structuredClone(await this.#pending.get(key));
  }
  async #load(token, config, kind, secret, caFile, key) {
    const policy = TokenValidationPolicy(config[kind].tokenValidation), started = this.#elapsed();
    const claims = await this.#request(token, config, kind, {readSecret: () => secret, caForConfig: () => caFile});
    if (claims?.active !== true || claims.token_type !== undefined && !/^Bearer$/i.test(claims.token_type)) throw IdentityError('OIDC_TOKEN_INACTIVE');
    ValidateAccessTokenClaims({valid: true, claims: {...claims, iss: claims.iss === undefined ? config.issuer : claims.iss}, config, kind, now: Math.floor(this.#clock() / 1000)});
    const bytes = Buffer.byteLength(JSON.stringify(claims)), until = started + policy.cacheSeconds * 1000, expires = claims.exp * 1000;
    if (policy.cacheSeconds && until > this.#elapsed() && expires > this.#clock() && bytes <= 262144) {
      for (const [entryKey, entry] of this.#entries) if (entry.until <= this.#elapsed() || entry.expires <= this.#clock()) this.#remove(entryKey);
      while (this.#entries.size >= 1024 || this.#bytes + bytes > 16 * 1024 * 1024) this.#remove(this.#entries.keys().next().value);
      this.#entries.set(key, {claims: structuredClone(claims), until, expires, bytes}); this.#bytes += bytes;
    }
    return claims;
  }
  #remove(key) {const entry = this.#entries.get(key); if (entry) this.#bytes -= entry.bytes; this.#entries.delete(key);}
}
