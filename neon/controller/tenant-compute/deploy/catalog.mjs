// Provider-owned defaults. Tenants select a size/tier; storage credentials and
// physical node placement are never accepted from the tenant webhook.
export const sizes = {
  micro: {cpu: '250m', memory: '512Mi', sharedBuffers: '128MB', maxConnections: 50},
  small: {cpu: '1', memory: '2Gi', sharedBuffers: '512MB', maxConnections: 100},
  medium: {cpu: '2', memory: '4Gi', sharedBuffers: '1GB', maxConnections: 200},
  large: {cpu: '4', memory: '8Gi', sharedBuffers: '2GB', maxConnections: 300}
};
export const tiers = {
  shared: {pageRequestsPerSecondPerShard: 2000, pageBurstPerShard: 4000, secondaries: 0},
  standard: {pageRequestsPerSecondPerShard: 10000, pageBurstPerShard: 20000, secondaries: 1},
  performance: {pageRequestsPerSecondPerShard: 40000, pageBurstPerShard: 80000, secondaries: 1}
};
export function applyCatalog(tenant, config) {
  tenant.size ??= 'small'; tenant.tier ??= 'shared'; tenant.shards ??= 1;
  const size = {...sizes, ...config.sizes}[tenant.size], tier = {...tiers, ...config.tiers}[tenant.tier];
  if (!size || !tier) throw Error('Unknown database size or tier');
  if (!/^(?:[1-9][0-9]*|[1-9][0-9]*m)$/.test(size.cpu) || !/^[1-9][0-9]*(?:Mi|Gi)$/.test(size.memory)) throw Error('Invalid provider size');
  if (!Number.isInteger(size.maxConnections) || size.maxConnections < 10 || !/^[1-9][0-9]*(?:MB|GB)$/.test(size.sharedBuffers)) throw Error('Invalid provider PostgreSQL sizing');
  for (const key of ['pageRequestsPerSecondPerShard', 'pageBurstPerShard']) if (!Number.isInteger(tier[key]) || tier[key] < 1) throw Error('Invalid provider storage limits');
  if (![0, 1, 2].includes(tier.secondaries) || ![1, 2, 4, 8, 16, 32].includes(tenant.shards)) throw Error('Invalid storage placement policy');
  const bytes = Number(size.memory.slice(0, -2)) * (size.memory.endsWith('Gi') ? 2 ** 30 : 2 ** 20);
  tenant.resources ??= {requests: {cpu: size.cpu, memory: size.memory}, limits: {cpu: size.cpu, memory: size.memory},
    dockerCpus: size.cpu.endsWith('m') ? Number(size.cpu.slice(0, -1)) / 1000 : Number(size.cpu), dockerMemoryBytes: bytes};
  const defaults = [{name: 'shared_buffers', value: size.sharedBuffers, vartype: 'string'},
    {name: 'max_connections', value: String(size.maxConnections), vartype: 'string'}];
  tenant.settings = [...defaults.filter(option => !(tenant.settings || []).some(value => value.name === option.name)), ...(tenant.settings || [])];
  tenant.storagePolicy = {checkpoint_timeout: config.storage?.checkpointTimeout || '30s',
    placement_policy: {Attached: tier.secondaries}, timeline_get_throttle: {
    task_kinds: ['PageRequestHandler'], initial: tier.pageBurstPerShard, refill_interval: '1s',
    refill_amount: tier.pageRequestsPerSecondPerShard, max: tier.pageBurstPerShard}};
  return tenant;
}
