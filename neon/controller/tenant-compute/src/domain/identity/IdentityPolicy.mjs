import {NativeOAuthPolicy} from './NativeOAuthPolicy.mjs';
import {TokenValidationPolicy} from './TokenValidationPolicy.mjs';
/**
 * @typedef {Object} IdentityActor
 * @property {string} subject - Verified token subject within its issuer namespace.
 * @property {string} issuer - Exact verified issuer.
 * @property {number} expires - Token expiry as Unix seconds.
 * @property {Record<string, unknown>} claims - Verified access-token claims.
 * @property {IdentityConfigurationValue} config - Current provider-owned identity policy.
 * @property {IdentityRoleBinding[]} bindings - Explicit group bindings granted to this actor.
 */
/**
 * @typedef {Object} IdentityRoleBinding
 * @property {string} group - Explicit provider group.
 * @property {string} [role] - Fleet management role.
 * @property {string} [postgresRole] - Restricted SQL role.
 */
/**
 * @typedef {Object} IdentityAudiencePolicy
 * @property {string} audience - Intended access-token resource audience.
 * @property {IdentityRoleBinding[]} roleBindings - Explicit group-to-role mapping.
 * @property {boolean} [allowStaticToken] - Explicit management break-glass permission.
 * @property {boolean} [allowPasswordAuth] - Explicit database password permission.
 * @property {boolean} [requireTenantProjectBinding] - Mandatory tenant/project claim binding.
 * @property {string} [managedRole] - Provider-managed restricted SQL role.
 * @property {import('./NativeOAuthPolicy.mjs').NativeOAuthSettings} [oauth] - Explicit native PostgreSQL OAuth policy.
 * @property {import('./TokenValidationPolicy.mjs').TokenValidationSettings} [tokenValidation] - JWT or authenticated opaque-token introspection.
 */
/**
 * @typedef {Object} IdentityConfigurationValue
 * @property {string} issuer - Exact HTTPS issuer.
 * @property {string} [jwksUrl] - Fixed HTTPS signing-key endpoint.
 * @property {string} [caSecretRef] - Private issuer CA Secret.
 * @property {string[]} [algorithms] - Explicit signing-algorithm allowlist.
 * @property {string} [groupsClaim] - Provider group claim name.
 * @property {string} [tenantClaim] - Provider tenant claim name.
 * @property {string} [projectClaim] - Provider project claim name.
 * @property {IdentityAudiencePolicy} management - Fleet management audience policy.
 * @property {IdentityAudiencePolicy} database - Database audience policy.
 */
/**
 * Construct a bounded identity error for HTTP presentation.
 * @param {string} code - Stable rejection reason.
 * @param {number} [status] - HTTP rejection status, default 401.
 * @returns {Error & {code: string, status: number}} Identity rejection.
 */
export const IdentityError = (code, status = 401) => Object.assign(Error(code), {code, status});
/**
 * Validate issuer and signing-key URL transport authority.
 * @param {string} value - Untrusted identity URL.
 * @param {boolean} [allowQuery] - Whether a fixed JWKS URL may include a query.
 * @returns {URL} Validated HTTPS URL.
 * @throws {Error} When transport, embedded credentials or fragments are unsafe.
 */
export function HttpsIdentityUrl(value, allowQuery = false) {
  const url = new URL(value);
  if (url.protocol !== 'https:' || url.username || url.password || url.hash || !allowQuery && url.search) throw Error('An HTTPS identity URL without credentials or fragment is required');
  return url;
}
const Roles = ['fleet-admin', 'database-operator', 'backup-operator', 'viewer'];
/**
 * Validate distinct management/database audiences and explicit resource bindings.
 * @param {IdentityConfigurationValue} [value] - Untrusted provider identity policy.
 * @returns {IdentityConfigurationValue | null} Validated policy, or null when absent.
 * @throws {Error} On unsupported or ambiguous identity configuration.
 */
export function IdentityConfiguration(value) {
  if (value === undefined) return null;
  if (!value || typeof value !== 'object') throw Error('Invalid identity configuration');
  if (Object.keys(value).some(key => !['issuer', 'jwksUrl', 'caSecretRef', 'algorithms', 'groupsClaim', 'tenantClaim', 'projectClaim', 'management', 'database'].includes(key))) throw Error('Unsupported identity field');
  HttpsIdentityUrl(value.issuer); if (value.jwksUrl) HttpsIdentityUrl(value.jwksUrl, true);
  for (const kind of ['management', 'database']) ValidateAudiencePolicy(value[kind], kind);
  if (NativeOAuthPolicy(value.database.oauth) && !value.database.roleBindings.length) throw Error('Native OAuth requires explicit database role bindings');
  if (value.management.audience === value.database.audience) throw Error('Management and database audiences must differ');
  if (value.database.requireTenantProjectBinding !== true) throw Error('Database identity requires tenant/project binding');
  ValidateClaimConfiguration(value);
  return value;
}
function ValidateAudiencePolicy(config, kind) {
  if (!config || typeof config.audience !== 'string' || !config.audience || !Array.isArray(config.roleBindings) || config.roleBindings.length > 100) throw Error('Identity audience and role bindings are required');
  for (const binding of config.roleBindings) ValidateRoleBinding(binding, kind);
  const flags = kind === 'management' ? ['allowStaticToken'] : ['allowPasswordAuth', 'requireTenantProjectBinding'];
  if (Object.keys(config).some(key => !['audience', 'roleBindings', 'tokenValidation', ...(kind === 'database' ? ['managedRole', 'oauth'] : []), ...flags].includes(key)) || flags.some(key => config[key] !== undefined && typeof config[key] !== 'boolean')) throw Error('Invalid identity access policy');
  TokenValidationPolicy(config.tokenValidation);
  if (config.managedRole !== undefined && !/^[a-z][a-z0-9_]{0,62}$/.test(config.managedRole)) throw Error('Invalid managed data role');
}
function ValidateRoleBinding(binding, kind) {
  if (Object.keys(binding).some(key => !['group', kind === 'management' ? 'role' : 'postgresRole'].includes(key))) throw Error('Unsupported role binding field');
  if (typeof binding.group !== 'string' || !binding.group || binding.group.length > 200) throw Error('Explicit identity group required');
  if (kind === 'management') {
    if (!Roles.includes(binding.role)) throw Error('Invalid identity role binding');
  } else if (!/^[a-z][a-z0-9_]{0,62}$/.test(binding.postgresRole || '') || ['postgres', 'cloud_admin', 'neon_lifecycle'].includes(binding.postgresRole)) throw Error('Invalid identity role binding');
}
function ValidateClaimConfiguration(config) {
  for (const key of ['groupsClaim', 'tenantClaim', 'projectClaim']) if (config[key] !== undefined && !/^[a-zA-Z][a-zA-Z0-9_]{0,63}$/.test(config[key])) throw Error('Invalid claim name');
  if (config.algorithms && (!Array.isArray(config.algorithms) || !config.algorithms.length || config.algorithms.some(alg => !['RS256', 'ES256', 'EdDSA'].includes(alg)))) throw Error('Unsupported signing algorithms');
}
/**
 * Select allowed management roles for a fixed method/resource path.
 * @param {string} method - HTTP operation.
 * @param {string} path - Exact declared resource path.
 * @returns {string[]} Allowed fleet roles.
 */
export function ManagementRoles(method, path) {
  if (method === 'GET') return [...Roles];
  if (path === '/v1/fleet' || method === 'DELETE' && !path.startsWith('/v1/backups/')) return ['fleet-admin'];
  if (path.startsWith('/v1/backups/') || path.endsWith('/backups')) return ['fleet-admin', 'backup-operator'];
  return ['fleet-admin', 'database-operator'];
}
