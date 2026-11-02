import {createPublicKey, verify} from 'node:crypto';
import {IdentityError} from './IdentityPolicy.mjs';
/**
 * @typedef {Object} AccessTokenHeader
 * @property {string} [typ] - JWT access-token type.
 * @property {string} kid - Provider signing-key identifier.
 * @property {string} alg - Explicitly allowed signature algorithm.
 * @property {unknown} [crit] - Unsupported critical extensions.
 */
/**
 * @typedef {Object} AccessTokenClaims
 * @property {string} iss - Exact token issuer.
 * @property {string | string[]} aud - Token resource audience.
 * @property {number} exp - Mandatory expiry, seconds since epoch.
 * @property {number} [nbf] - Optional not-before timestamp.
 * @property {string} sub - Mandatory authenticated subject.
 */
/**
 * @typedef {Object} ParsedAccessToken
 * @property {string[]} parts - Original signed JWT segments.
 * @property {AccessTokenHeader} header - Parsed untrusted protected header.
 * @property {AccessTokenClaims & Record<string, unknown>} claims - Parsed untrusted claims.
 */
/**
 * Decode a bounded bearer token without trusting its unverified claims.
 * @param {string} authorization - Untrusted HTTP authorization header.
 * @param {import('./IdentityPolicy.mjs').IdentityConfigurationValue} config - Explicit signing policy.
 * @returns {ParsedAccessToken} Token segments and unverified fields.
 * @throws {Error} OIDC_TOKEN_REQUIRED or OIDC_TOKEN_INVALID.
 */
export function ParseAccessToken(authorization, config) {
  const token = BearerAccessToken(authorization);
  const parts = token.split('.');
  if (parts.length !== 3 || parts.some(part => !/^[A-Za-z0-9_-]+$/.test(part))) throw IdentityError('OIDC_TOKEN_INVALID');
  let header, claims;
  try {header = JSON.parse(Buffer.from(parts[0], 'base64url')); claims = JSON.parse(Buffer.from(parts[1], 'base64url'));}
  catch {throw IdentityError('OIDC_TOKEN_INVALID');}
  if (!header || !claims || !['JWT', 'at+jwt', undefined].includes(header.typ) || header.crit || !header.kid || !(config.algorithms || ['RS256']).includes(header.alg)) throw IdentityError('OIDC_TOKEN_INVALID');
  return {parts, header, claims};
}
/**
 * Extract a bounded RFC 6750 bearer value without decoding it; authorization belongs to the owning application boundary.
 * No side effects, introspection or protocol fallback occur.
 * @param {string} authorization - Untrusted HTTP Authorization header.
 * @returns {string} Opaque bearer contents.
 * @throws {Error} OIDC_TOKEN_REQUIRED for malformed or oversized bearer input.
 */
export function BearerAccessToken(authorization) {
  const token = /^Bearer ([A-Za-z0-9._~+/-]+=*)$/i.exec(authorization || '')?.[1];
  if (!token || token.length > 12288) throw IdentityError('OIDC_TOKEN_REQUIRED');
  return token;
}
/**
 * Verify a JWT with its uniquely selected, algorithm-compatible provider key.
 * @param {ParsedAccessToken} token - Original signed segments and protected header.
 * @param {import('node:crypto').JsonWebKey} jwk - Selected provider signing key.
 * @returns {boolean} Whether the cryptographic signature verifies.
 * @throws {Error} OIDC_TOKEN_INVALID for incompatible or weak signing keys.
 */
export function VerifyAccessToken(token, jwk) {
  const {parts, header} = token;
  ValidateSigningAlgorithm(header.alg, jwk);
  try {
    const key = createPublicKey({key: jwk, format: 'jwk'});
    if (key.asymmetricKeyType === 'rsa' && key.asymmetricKeyDetails.modulusLength < 2048) throw Error('Weak RSA key');
    return verify(header.alg === 'EdDSA' ? null : 'sha256', Buffer.from(parts[0] + '.' + parts[1]),
      {key, ...(header.alg === 'ES256' ? {dsaEncoding: 'ieee-p1363'} : {})}, Buffer.from(parts[2], 'base64url'));
  } catch {throw IdentityError('OIDC_TOKEN_INVALID');}
}
function ValidateSigningAlgorithm(algorithm, jwk) {
  if (algorithm === 'RS256' && jwk.kty !== 'RSA' || algorithm === 'ES256' && (jwk.kty !== 'EC' || jwk.crv !== 'P-256') || algorithm === 'EdDSA' && (jwk.kty !== 'OKP' || jwk.crv !== 'Ed25519')) throw IdentityError('OIDC_TOKEN_INVALID');
}
/**
 * @typedef {Object} AccessTokenValidation
 * @property {boolean} valid - Cryptographic verification result.
 * @property {ParsedAccessToken['claims']} claims - Parsed claims, not yet authorized.
 * @property {import('./IdentityPolicy.mjs').IdentityConfigurationValue} config - Intended issuer and audience policy.
 * @property {'management' | 'database'} kind - Intended resource boundary.
 * @property {number} now - Trusted current epoch seconds.
 */
/**
 * Require exact issuer/audience and valid mandatory expiry and subject claims.
 * @param {AccessTokenValidation} input - Verification result and intended resource policy.
 * @returns {void}
 * @throws {Error} OIDC_TOKEN_INVALID when claims cannot be accepted.
 */
export function ValidateAccessTokenClaims({valid, claims, config, kind, now}) {
  const audiences = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
  if (!valid || claims.iss !== config.issuer || !audiences.includes(config[kind].audience) || !Number.isSafeInteger(claims.exp) || claims.exp <= now) throw IdentityError('OIDC_TOKEN_INVALID');
  if (claims.nbf !== undefined && (!Number.isSafeInteger(claims.nbf) || claims.nbf > now + 30)) throw IdentityError('OIDC_TOKEN_INVALID');
  if (typeof claims.sub !== 'string' || !claims.sub || claims.sub.length > 256) throw IdentityError('OIDC_TOKEN_INVALID');
}
