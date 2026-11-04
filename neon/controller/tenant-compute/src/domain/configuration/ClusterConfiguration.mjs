import {createHash} from 'node:crypto';
import {SuspendPolicy as policy} from '../compute/Activity.mjs';
import {EndpointConfig as endpointConfig} from '../compute/ComputeSpecification.mjs';
import {ApplyDatabaseCatalog as applyCatalog} from '../database/DatabaseCatalog.mjs';
import {IdentityConfiguration as identityConfiguration} from '../identity/IdentityPolicy.mjs';
import {ResolveDatabasePolicy} from '../database/DatabasePolicy.mjs';
import {IsDnsDomain} from './DnsDomain.mjs';

const name = value => typeof value === 'string' && /^[a-z][a-z0-9-]{0,38}$/.test(value);
/**
 * @typedef {Object} ObjectStoreConfiguration
 * @property {string} endpoint - Fixed HTTPS S3-compatible service URL without credentials or query.
 * @property {string} bucket - Provider-owned bucket name.
 * @property {string} region - Signing region for the S3 client.
 * @property {string} prefix - Isolated fleet object prefix.
 */
/**
 * @typedef {Object} PageserverPlacement
 * @property {number} id - Unique positive native storage node identity.
 * @property {string} host - Internal storage node hostname.
 * @property {string} [zone] - Physical failure domain when configured.
 * @property {string} [resourceName] - Kubernetes StatefulSet identity when managed.
 */
/**
 * @typedef {Object} ClusterStorageConfiguration
 * @property {PageserverPlacement[]} [pageservers] - Provider physical storage inventory; defaults to one local pageserver.
 * @property {string} [checkpointTimeout] - Native checkpoint interval.
 * @property {boolean} [externalMetadata] - Whether metadata is externally operated.
 * @property {string[]} [safekeeperZones] - Physical placement of the three WAL voters.
 */
/**
 * @typedef {Object} TenantRuntimeIdentity
 * @property {string} name - Unique DNS-safe tenant endpoint name.
 * @property {string} [endpointId] - Derived ep-prefixed proxy endpoint identity.
 * @property {string} [tenantId] - Native 32-hex tenant ID, derived deterministically when absent.
 * @property {string} [timelineId] - Native 32-hex writable timeline ID, derived when absent.
 * @property {string} [database] - Primary SQL database; defaults to app.
 * @property {string} [user] - Primary SQL owner; defaults to app_user.
 * @property {string} [nodeName] - Explicit worker placement overriding the cluster default.
 * @property {string} [databaseResource] - Managed NeonDatabase resource identity.
 * @property {string} [ancestorTimelineId] - Native parent timeline pinned during branch preparation.
 * @property {string} [ancestorLSN] - Retained and leased branch boundary within the ancestor timeline.
 * @property {Record<string, import('../compute/Activity.mjs').ComputeSuspendPolicy>} [databasePolicies] - Idle policy overrides for SQL databases sharing this compute.
 */
/** @typedef {import('../database/DatabaseContracts.mjs').DatabaseSpecification & import('../database/DatabaseCatalog.mjs').CatalogTenant & TenantRuntimeIdentity} ClusterTenant */
/**
 * @typedef {Object} ClusterConfiguration
 * @property {string} name - DNS-safe fleet identity used in deterministic storage IDs.
 * @property {string} domain - Client endpoint DNS suffix.
 * @property {string} computeImage - Digest-pinned provider compute image.
 * @property {ObjectStoreConfiguration} s3 - Isolated authenticated object-store destination; credentials are supplied separately.
 * @property {ClusterStorageConfiguration} [storage] - Physical page and WAL storage configuration.
 * @property {ClusterTenant[]} [tenants] - Tenant definitions normalized in place; defaults to an empty list.
 * @property {import('../database/DatabasePolicy.mjs').DatabaseDefaults} [defaults] - Inherited database sizing, suspension and recovery defaults.
 * @property {Record<string, import('../database/DatabaseCatalog.mjs').ComputeSize>} [sizes] - Provider size catalog overrides.
 * @property {Record<string, import('../database/DatabaseCatalog.mjs').StorageTier>} [tiers] - Provider storage catalog overrides.
 * @property {string} [computeNode] - Default compute worker; standalone validation falls back to docker.
 * @property {string[]} [computeNodes] - Provider worker inventory for managed placement.
 * @property {string[]} [clientCIDRs] - Default client network allowlist when a tenant omits one.
 * @property {import('../identity/IdentityPolicy.mjs').IdentityConfigurationValue} [identity] - Enterprise OIDC policy; absent in static-credential deployments.
 * @property {import('../fleet/FleetSpecification.mjs').FleetReplicationSpecification} [replication] - Enterprise zone quorum policy when present.
 * @property {boolean} [allowAsyncCommits] - Explicit enterprise permission for loss-tolerant database profiles.
 */
/**
 * Normalize provider configuration and enforce a single writer endpoint per native timeline.
 * Requires provider authorization at the owning application boundary; tenant input must not select provider credentials or placement.
 * Mutates config and its tenant rows to resolve defaults, storage identities and resource budgets; performs no network or persistence side effects.
 * @param {ClusterConfiguration} config - Provider cluster configuration to normalize in place.
 * @returns {ClusterConfiguration} The same configuration reference after validation and default resolution.
 * @throws {Error} When identity, S3 destination, DNS, tenant policy, storage placement or endpoint validation fails.
 */
export function NormalizeClusterConfiguration(config) {
  if (config.allowAsyncCommits !== undefined && typeof config.allowAsyncCommits !== 'boolean') throw Error('allowAsyncCommits must be boolean');
  ValidateClusterIdentity(config);
  NormalizeStorage(config);
  config.tenants ??= [];
  if (!Array.isArray(config.tenants)) throw Error('tenants must be a list');
  const names = new Set(), writers = new Set();
  for (const tenant of config.tenants) {
    if (!name(tenant.name) || names.has(tenant.name)) throw Error('Unique DNS-safe tenant names required');
    names.add(tenant.name);
    NormalizeTenantPolicy(tenant, config);
    AssignStorageIdentity(tenant, config);
    const writer = tenant.tenantId + ':' + tenant.timelineId;
    if (writers.has(writer)) throw Error('A storage timeline cannot have multiple writer endpoints');
    writers.add(writer);
    ValidateTenantEndpoint(tenant, config);
  }
  return config;
}
function ValidateClusterIdentity(config) {
  identityConfiguration(config?.identity);
  if (!config || !name(config.name)) throw Error('A DNS-safe cluster name is required');
  if (!config.s3 || !/^https:\/\//.test(config.s3.endpoint) || !config.s3.bucket || !config.s3.region ||
      !/^[a-zA-Z0-9][a-zA-Z0-9/_-]*$/.test(config.s3.prefix || '')) throw Error('Explicit HTTPS S3 configuration and isolated prefix required');
  if (!IsDnsDomain(config.domain)) throw Error('Client DNS domain required');
  const s3url = new URL(config.s3.endpoint);
  if (s3url.username || s3url.password || s3url.search || s3url.hash) throw Error('S3 endpoint must not embed credentials or query parameters');
}
function NormalizeStorage(config) {
  config.storage ??= {};
  config.storage.pageservers ??= [{id: 1, host: 'pageserver', zone: 'zone-1'}];
  const nodeIds = new Set();
  for (const node of config.storage.pageservers) {
    if (!Number.isSafeInteger(node.id) || node.id < 1 || nodeIds.has(node.id) || !/^[a-z0-9][a-z0-9.-]*$/.test(node.host || '')) throw Error('Invalid pageserver fleet');
    nodeIds.add(node.id);
  }
}
function NormalizeTenantPolicy(tenant, config) {
  Object.assign(tenant, ResolveDatabasePolicy(config.defaults, tenant));
  applyCatalog(tenant, config);
  tenant.endpointId = 'ep-' + tenant.name;
  tenant.database ??= 'app'; tenant.user ??= 'app_user';
  if (![tenant.database, tenant.user].every(value => typeof value === 'string' && /^[a-z][a-z0-9_]{0,62}$/.test(value))) throw Error('Simple PostgreSQL database and user names required');
  tenant.profile ??= 'durable';
  if (!['durable', 'bounded-async', 'best-effort'].includes(tenant.profile)) throw Error('Unknown commit profile');
  if (config.replication?.mode === 'synchronous-quorum' && config.allowAsyncCommits !== true && tenant.profile !== 'durable') throw Error('ZONE_QUORUM_REQUIRES_DURABLE');
  tenant.suspend = policy(tenant.suspend);
  tenant.databasePolicies ??= {};
  for (const value of Object.values(tenant.databasePolicies)) policy(value);
  tenant.allowedIps ??= config.clientCIDRs;
  if (!Array.isArray(tenant.allowedIps) || !tenant.allowedIps.length) throw Error('Each tenant needs allowedIps or provider clientCIDRs');
}
function AssignStorageIdentity(tenant, config) {
  const hash = part => createHash('sha256').update(config.name + ':' + tenant.name + ':' + part).digest('hex').slice(0, 32);
  tenant.tenantId ??= hash('tenant'); tenant.timelineId ??= hash('timeline');
  if (![tenant.tenantId, tenant.timelineId].every(id => /^[a-f0-9]{32}$/.test(id))) throw Error('Invalid storage IDs');
}
function ValidateTenantEndpoint(tenant, config) {
  endpointConfig({metadata: {name: 'neon-' + tenant.endpointId}, data: {'endpoint.json': JSON.stringify({...tenant,
    image: config.computeImage, nodeName: tenant.nodeName || config.computeNode || 'docker', projectId: config.name, branchId: tenant.name,
    computeSpecSecret: 'spec', adminSecret: 'admin', rolesSecret: 'roles', tlsSecret: 'tls', caSecret: 'ca'})}});
}

/**
 * @typedef {Object} ClusterServiceHosts
 * @property {string} controller - Tenant controller service hostname.
 * @property {string} storage - Storage controller service hostname.
 * @property {string} pageserver - Default pageserver service hostname.
 * @property {string} broker - WAL broker service hostname.
 * @property {string[]} safekeepers - Three ordered WAL voter hostnames.
 * @property {(id: string) => string} compute - Resolve a compute service hostname from its endpoint ID.
 */
/**
 * Resolve packaged internal service names for Compose or Kubernetes DNS.
 * The owning application boundary selects platform and namespace; this pure mapping has no authorization or mutation side effects.
 * @param {'compose' | 'kubernetes'} platform - Deployment network model.
 * @param {string} [namespace] - Provider Kubernetes namespace; ignored for Compose DNS suffixes.
 * @returns {ClusterServiceHosts} Internal service names, without probing readiness or creating resources.
 */
export function ServiceHosts(platform, namespace = 'neon') {
  const suffix = platform === 'kubernetes' ? `.${namespace}.svc.cluster.local` : '';
  return {controller: 'neon-controller' + suffix, storage: 'storage-controller' + suffix,
    pageserver: 'pageserver' + suffix, broker: 'storage-broker' + suffix,
    safekeepers: [1, 2, 3].map(id => `safekeeper-${id}` + suffix),
    compute: id => 'neon-' + id + suffix};
}
