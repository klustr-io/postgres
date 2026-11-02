// Provider-owned defaults. Tenants select a size/tier; storage credentials and
// physical node placement are never accepted from the tenant webhook.
import {RecoveryPolicy as recoveryPolicy} from '../recovery/RecoveryPolicy.mjs';
/**
 * @typedef {Object} ComputeSize
 * @property {string} cpu - Kubernetes CPU quantity, also converted to a Docker CPU limit.
 * @property {string} memory - Positive Mi or Gi memory quantity.
 * @property {string} sharedBuffers - PostgreSQL shared_buffers value in MB or GB.
 * @property {number} maxConnections - PostgreSQL connection budget, at least ten.
 */
/**
 * @typedef {Object} StorageTier
 * @property {number} pageRequestsPerSecondPerShard - Sustained pageserver request allowance per shard.
 * @property {number} pageBurstPerShard - Initial and maximum request tokens per shard.
 * @property {number} secondaries - Requested secondary page copies, from zero to two.
 */
/**
 * @typedef {Object} ComputeResourceBudget
 * @property {Record<string, string>} requests - Kubernetes scheduler resource reservations.
 * @property {Record<string, string>} limits - Kubernetes enforced resource ceilings.
 * @property {number} dockerCpus - Equivalent Docker CPU ceiling.
 * @property {number} dockerMemoryBytes - Equivalent Docker memory ceiling in bytes.
 */
/**
 * @typedef {Object} PostgresSetting
 * @property {string} name - PostgreSQL configuration parameter name.
 * @property {string} value - Parameter text passed to compute_ctl.
 * @property {string} vartype - Native compute setting representation, normally string.
 */
/**
 * @typedef {Object} PageRequestThrottle
 * @property {string[]} task_kinds - Native pageserver task classes to throttle.
 * @property {number} initial - Tokens available when the throttle starts.
 * @property {string} refill_interval - Native duration between token refills.
 * @property {number} refill_amount - Tokens restored per interval.
 * @property {number} max - Maximum accumulated request tokens.
 */
/**
 * @typedef {Object} PagePlacement
 * @property {number} Attached - Secondary copies requested by storage placement.
 */
/**
 * @typedef {Object} TenantStoragePolicy
 * @property {string} checkpoint_timeout - Native checkpoint interval.
 * @property {string} pitr_interval - Retained history interval derived from backup policy.
 * @property {PagePlacement} placement_policy - Secondary placement request.
 * @property {PageRequestThrottle} timeline_get_throttle - Per-shard page request budget.
 */
/**
 * @typedef {Object} CatalogTenantOptions
 * @property {number} [shards] - Supported power-of-two storage shard count.
 * @property {ComputeResourceBudget} [resources] - Explicit provider budget preserved when supplied.
 * @property {PostgresSetting[]} [settings] - Explicit settings override catalog defaults by name.
 * @property {TenantStoragePolicy} [storagePolicy] - Derived storage policy replaced during catalog resolution.
 */
/** @typedef {import('./DatabasePolicy.mjs').DatabaseDefaults & CatalogTenantOptions} CatalogTenant */
/**
 * @typedef {Object} CatalogStorageOptions
 * @property {string} [checkpointTimeout] - Provider checkpoint interval; defaults to 30s.
 */
/**
 * @typedef {Object} DatabaseCatalogConfiguration
 * @property {Record<string, ComputeSize>} [sizes] - Provider size overrides keyed by catalog name.
 * @property {Record<string, StorageTier>} [tiers] - Provider storage overrides keyed by catalog name.
 * @property {CatalogStorageOptions} [storage] - Provider checkpoint settings.
 */
/** Built-in compute budgets; provider configuration can override or extend these named entries. */
export const ComputeSizes = {
  micro: {cpu: '250m', memory: '512Mi', sharedBuffers: '128MB', maxConnections: 50},
  small: {cpu: '1', memory: '2Gi', sharedBuffers: '512MB', maxConnections: 100},
  medium: {cpu: '2', memory: '4Gi', sharedBuffers: '1GB', maxConnections: 200},
  large: {cpu: '4', memory: '8Gi', sharedBuffers: '2GB', maxConnections: 300}
};
/** Built-in per-shard page request and secondary-copy budgets, independent of SQL writer count. */
export const StorageTiers = {
  shared: {pageRequestsPerSecondPerShard: 2000, pageBurstPerShard: 4000, secondaries: 0},
  standard: {pageRequestsPerSecondPerShard: 10000, pageBurstPerShard: 20000, secondaries: 1},
  performance: {pageRequestsPerSecondPerShard: 40000, pageBurstPerShard: 80000, secondaries: 1}
};
/**
 * Resolve provider size and tier defaults into a tenant's compute and page-storage budgets.
 * The owning application boundary authorizes provider configuration; this function grants no tenant permission.
 * Mutates and returns the supplied tenant, preserving explicit compute resources and settings while replacing storagePolicy.
 * No infrastructure is provisioned and no external side effects occur.
 * @param {CatalogTenant} tenant - Tenant policy to enrich in place.
 * @param {DatabaseCatalogConfiguration} config - Provider-controlled catalogs and checkpoint settings.
 * @returns {CatalogTenant} The same tenant reference with resolved budgets and native settings.
 * @throws {Error} When the selected size, tier, resource quantity or shard count is invalid.
 */
export function ApplyDatabaseCatalog(tenant, config) {
  tenant.size ??= 'small'; tenant.tier ??= 'shared'; tenant.shards ??= 1;
  const size = {...ComputeSizes, ...config.sizes}[tenant.size], tier = {...StorageTiers, ...config.tiers}[tenant.tier];
  if (!size || !tier) throw Error('Unknown database size or tier');
  ValidateSize(size);
  ValidateTier(tier, tenant.shards);
  const bytes = Number(size.memory.slice(0, -2)) * (size.memory.endsWith('Gi') ? 2 ** 30 : 2 ** 20);
  tenant.resources ??= {requests: {cpu: size.cpu, memory: size.memory}, limits: {cpu: size.cpu, memory: size.memory},
    dockerCpus: size.cpu.endsWith('m') ? Number(size.cpu.slice(0, -1)) / 1000 : Number(size.cpu), dockerMemoryBytes: bytes};
  const defaults = [{name: 'shared_buffers', value: size.sharedBuffers, vartype: 'string'},
    {name: 'max_connections', value: String(size.maxConnections), vartype: 'string'}];
  tenant.settings = [...defaults.filter(option => !(tenant.settings || []).some(value => value.name === option.name)), ...(tenant.settings || [])];
  tenant.storagePolicy = {checkpoint_timeout: config.storage?.checkpointTimeout || '30s', pitr_interval: recoveryPolicy(tenant.backup).historySeconds + 's',
    placement_policy: {Attached: tier.secondaries}, timeline_get_throttle: {
    task_kinds: ['PageRequestHandler'], initial: tier.pageBurstPerShard, refill_interval: '1s',
    refill_amount: tier.pageRequestsPerSecondPerShard, max: tier.pageBurstPerShard}};
  return tenant;
}
function ValidateSize(size) {
  if (!/^(?:[1-9][0-9]*|[1-9][0-9]*m)$/.test(size.cpu) || !/^[1-9][0-9]*(?:Mi|Gi)$/.test(size.memory)) throw Error('Invalid provider size');
  if (!Number.isInteger(size.maxConnections) || size.maxConnections < 10 || !/^[1-9][0-9]*(?:MB|GB)$/.test(size.sharedBuffers)) throw Error('Invalid provider PostgreSQL sizing');
}
function ValidateTier(tier, shards) {
  for (const key of ['pageRequestsPerSecondPerShard', 'pageBurstPerShard']) if (!Number.isInteger(tier[key]) || tier[key] < 1) throw Error('Invalid provider storage limits');
  if (![0, 1, 2].includes(tier.secondaries) || ![1, 2, 4, 8, 16, 32].includes(shards)) throw Error('Invalid storage placement policy');
}
