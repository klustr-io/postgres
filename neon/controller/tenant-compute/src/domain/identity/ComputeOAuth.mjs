import {NativeOAuthPolicy} from './NativeOAuthPolicy.mjs';
/**
 * @typedef {Object} ComputeOAuthInput
 * @property {string} name - Managed database resource name.
 * @property {string} database - Primary SQL database name.
 * @property {string} namespace - Provider Kubernetes namespace.
 */
/**
 * @typedef {Object} ComputeOAuthSettings
 * @property {string} issuer - Exact trusted OAuth issuer.
 * @property {string} scope - Required native database scopes.
 * @property {string[]} roles - Explicit native-login roles.
 * @property {boolean} allowPasswordAuth - Whether other roles may use SCRAM.
 * @property {string} validatorUrl - Provider-owned compute validation endpoint.
 * @property {string} secret - Endpoint-specific mTLS identity and HBA Secret.
 * @property {string} database - Allowed primary SQL database.
 */
/**
 * Derive compute authentication from fleet policy; tenants cannot choose validator URLs or libraries.
 * @param {import('./IdentityPolicy.mjs').IdentityConfigurationValue} identity - Validated provider policy.
 * @param {ComputeOAuthInput} input - Provider endpoint identity.
 * @returns {ComputeOAuthSettings | null} Native compute settings or null when disabled.
 */
export function ComputeOAuth(identity, {name, database, namespace}) {
  const policy = NativeOAuthPolicy(identity?.database.oauth);
  if (!policy) return null;
  if (!/^[a-z][a-z0-9-]{0,38}$/.test(name) || !/^[a-z0-9][a-z0-9-]{0,62}$/.test(namespace)) throw Error('Invalid native OAuth endpoint identity');
  return {issuer: identity.issuer, scope: policy.scope, roles: [...new Set(identity.database.roleBindings.map(binding => binding.postgresRole))].sort(),
    allowPasswordAuth: identity.database.allowPasswordAuth === true, database,
    validatorUrl: `https://neon-controller.${namespace}.svc.cluster.local:8080/v1/databases/${name}/oauth/validate`, secret: name + '-oauth'};
}
/**
 * Produce an OAuth HBA with narrow SCRAM exceptions for lifecycle and expiring broker logins.
 * Authorization belongs to the validator and owning application boundary; no SQL or files are mutated here.
 * @param {ComputeOAuthSettings} settings - Derived provider-owned compute policy.
 * @returns {string} Complete HBA text with explicit non-TLS rejection.
 * @throws {Error} On unsafe role, database or HBA option values.
 */
export function OAuthHba(settings) {
  if (!/^[a-z][a-z0-9_]{0,62}$/.test(settings.database) || !settings.roles.length ||
      settings.roles.some(role => !/^[a-z][a-z0-9_]{0,62}$/.test(role))) throw Error('Invalid native OAuth SQL identity');
  const quote = value => {if (/[\r\n\0]/.test(value)) throw Error('Invalid OAuth HBA value'); return '"' + value.replaceAll('"', '""') + '"';};
  const lines = ['local all all trust', 'hostssl all neon_lifecycle all scram-sha-256',
    `hostssl ${settings.database} ${settings.roles.join(',')} all oauth issuer=${quote(settings.issuer)} scope=${quote(settings.scope)} validator=klustr_oauth delegate_ident_mapping=1`,
    `hostssl ${settings.database} /^oidc_[a-f0-9]{24}$/ all scram-sha-256`];
  if (settings.allowPasswordAuth) lines.push('hostssl all all all scram-sha-256');
  lines.push('host all all all reject');
  return lines.join('\n') + '\n';
}
