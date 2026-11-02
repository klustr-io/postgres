import {IsDnsDomain} from '../configuration/DnsDomain.mjs';
/**
 * @typedef {Object} TokenValidationSettings
 * @property {'jwt' | 'introspection'} mode - Explicit validation protocol; JWT is the default when omitted.
 * @property {string} [endpoint] - Fixed HTTPS RFC 7662 endpoint, never taken from a token.
 * @property {string} [clientId] - Introspection resource-server client identity.
 * @property {string} [clientSecretRef] - Kubernetes Secret name; credentials never belong in fleet settings.
 * @property {string} [clientSecretKey] - Secret key, default clientSecret.
 * @property {'client_secret_basic' | 'client_secret_post'} [authMethod] - Resource-server authentication, default Basic.
 * @property {number} [cacheSeconds] - Positive-result cache lifetime, zero to disable, default 30 and maximum 60 seconds.
 */
/**
 * Validate the provider's token protocol and credential references; authorization remains at the owning application boundary.
 * No side effects or token-based protocol fallback occur.
 * @param {TokenValidationSettings} [value] - Provider-owned validation settings.
 * @returns {TokenValidationSettings} Validated explicit protocol and credential references.
 * @throws {Error} For unsafe transport, inline credentials, unknown modes or missing introspection authority.
 */
export function TokenValidationPolicy(value) {
  if (value === undefined) return {mode: 'jwt'};
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw Error('Invalid token validation settings');
  if (value.mode === 'jwt') {
    if (Object.keys(value).length !== 1) throw Error('JWT validation accepts only its mode');
    return value;
  }
  if (value.mode !== 'introspection') throw Error('Unsupported token validation mode');
  ValidateIntrospection(value);
  return {...value, clientSecretKey: value.clientSecretKey || 'clientSecret', authMethod: value.authMethod || 'client_secret_basic', cacheSeconds: value.cacheSeconds ?? 30};
}
function ValidateIntrospection(value) {
  const keys = ['mode', 'endpoint', 'clientId', 'clientSecretRef', 'clientSecretKey', 'authMethod', 'cacheSeconds'];
  if (Object.keys(value).some(key => !keys.includes(key))) throw Error('Unsupported introspection setting; use a Secret reference');
  const url = new URL(value.endpoint);
  if (url.protocol !== 'https:' || url.username || url.password || url.hash || url.search || url.href.length > 2048) throw Error('A fixed HTTPS introspection endpoint is required');
  ValidateCredentials(value);
  if (value.cacheSeconds !== undefined && (!Number.isInteger(value.cacheSeconds) || value.cacheSeconds < 0 || value.cacheSeconds > 60)) throw Error('Introspection cacheSeconds must be an integer from zero to 60');
}
function ValidateCredentials(value) {
  if (typeof value.clientId !== 'string' || !value.clientId || value.clientId.length > 512 || /[\r\n\0]/.test(value.clientId)) throw Error('Introspection clientId is required');
  if (!IsDnsDomain(value.clientSecretRef)) throw Error('Introspection clientSecretRef is required');
  if (value.clientSecretKey !== undefined && !/^[a-zA-Z0-9._-]{1,253}$/.test(value.clientSecretKey)) throw Error('Invalid introspection Secret key');
  if (value.authMethod !== undefined && !['client_secret_basic', 'client_secret_post'].includes(value.authMethod)) throw Error('Invalid introspection authentication method');
}
