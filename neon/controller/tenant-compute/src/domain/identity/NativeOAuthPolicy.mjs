/**
 * @typedef {Object} NativeOAuthSettings
 * @property {boolean} enabled - Explicit native OAUTHBEARER opt-in.
 * @property {string} [scope] - Space-separated scopes required for database access.
 * @property {string} [scopeClaim] - Trusted access-token scope claim, default scope.
 */
/**
 * Validate native database OAuth independently of management identity settings.
 * @param {NativeOAuthSettings} [value] - Explicit native OAuth policy.
 * @returns {NativeOAuthSettings | null} Validated enabled policy, or null when disabled.
 * @throws {Error} On malformed scopes or unsupported policy fields.
 */
export function NativeOAuthPolicy(value) {
  if (value === undefined) return null;
  if (!value || typeof value !== 'object' || Array.isArray(value) || typeof value.enabled !== 'boolean' ||
      Object.keys(value).some(key => !['enabled', 'scope', 'scopeClaim'].includes(key))) throw Error('Invalid native OAuth settings');
  if (value.scopeClaim !== undefined && !/^[a-zA-Z][a-zA-Z0-9_]{0,63}$/.test(value.scopeClaim)) throw Error('Invalid OAuth scope claim');
  if (value.scope !== undefined) ValidateScope(value.scope);
  if (!value.enabled) return null;
  if (!value.scope) throw Error('An explicit OAuth scope is required');
  return {...value, scopeClaim: value.scopeClaim || 'scope'};
}
function ValidateScope(scope) {
  if (typeof scope !== 'string' || scope.length > 1024 || !/^[\x21\x23-\x5B\x5D-\x7E]+(?: [\x21\x23-\x5B\x5D-\x7E]+)*$/.test(scope)) throw Error('Invalid OAuth scope');
}
/**
 * Require all configured scopes in a verified access token.
 * Authorization belongs to the owning application boundary; this check has no side effects.
 * @param {Record<string, unknown>} claims - Cryptographically verified token claims.
 * @param {NativeOAuthSettings} policy - Enabled native OAuth policy.
 * @returns {boolean} Whether the token grants every required database scope.
 */
export function HasDatabaseOAuthScopes(claims, policy) {
  const value = claims[policy.scopeClaim || 'scope'];
  if (typeof value !== 'string') return false;
  const scopes = new Set(value.split(' ').filter(Boolean));
  return policy.scope.split(' ').every(scope => scopes.has(scope));
}
/**
 * Select native authentication policy fields that require compute reprovisioning.
 * @param {import('./IdentityPolicy.mjs').IdentityConfigurationValue} [identity] - Provider identity policy.
 * @returns {string | null} Stable native policy fingerprint input, or null when disabled.
 */
export function NativeOAuthRevision(identity) {
  const oauth = NativeOAuthPolicy(identity?.database.oauth);
  if (!oauth) return null;
  return JSON.stringify({issuer: identity.issuer, scope: oauth.scope,
    roles: [...new Set(identity.database.roleBindings.map(binding => binding.postgresRole))].sort(),
    allowPasswordAuth: identity.database.allowPasswordAuth === true});
}
