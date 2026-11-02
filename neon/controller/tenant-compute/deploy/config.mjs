import fs from 'node:fs';
import {createHash} from 'node:crypto';
import {parse} from 'yaml';
import {policy} from '../activity.mjs';
import {endpointConfig} from '../config.mjs';
import {applyCatalog} from './catalog.mjs';
import {identityConfiguration} from './identity.mjs';

const name = value => typeof value === 'string' && /^[a-z][a-z0-9-]{0,38}$/.test(value);
export function configuration(file = process.env.NEON_CONFIG || '/etc/neon/cluster.yaml') {
  const config = parse(fs.readFileSync(file, 'utf8'), {uniqueKeys: true, maxAliasCount: 0});
  return normalizeConfiguration(config);
}
export function normalizeConfiguration(config) {
  identityConfiguration(config?.identity);
  if (!config || !name(config.name)) throw Error('A DNS-safe cluster name is required');
  if (!config.s3 || !/^https:\/\//.test(config.s3.endpoint) || !config.s3.bucket || !config.s3.region ||
      !/^[a-zA-Z0-9][a-zA-Z0-9/_-]*$/.test(config.s3.prefix || '')) throw Error('Explicit HTTPS S3 configuration and isolated prefix required');
  if (!config.domain || !/^[a-z0-9.-]+$/.test(config.domain)) throw Error('Client DNS domain required');
  const s3url = new URL(config.s3.endpoint);
  if (s3url.username || s3url.password || s3url.search || s3url.hash) throw Error('S3 endpoint must not embed credentials or query parameters');
  config.tenants ??= [];
  if (!Array.isArray(config.tenants)) throw Error('tenants must be a list');
  const names = new Set();
  const writers = new Set();
  config.storage ??= {};
  config.storage.pageservers ??= [{id: 1, host: 'pageserver', zone: 'zone-1'}];
  const nodeIds = new Set();
  for (const node of config.storage.pageservers) {
    if (!Number.isSafeInteger(node.id) || node.id < 1 || nodeIds.has(node.id) || !/^[a-z0-9][a-z0-9.-]*$/.test(node.host || '')) throw Error('Invalid pageserver fleet');
    nodeIds.add(node.id);
  }
  for (const tenant of config.tenants) {
    applyCatalog(tenant, config);
    if (!name(tenant.name) || names.has(tenant.name)) throw Error('Unique DNS-safe tenant names required');
    names.add(tenant.name);
    tenant.endpointId = 'ep-' + tenant.name;
    tenant.database ??= 'app'; tenant.user ??= 'app_user';
    if (![tenant.database, tenant.user].every(value => typeof value === 'string' && /^[a-z][a-z0-9_]{0,62}$/.test(value))) throw Error('Simple PostgreSQL database and user names required');
    tenant.profile ??= 'durable';
    if (!['durable', 'bounded-async'].includes(tenant.profile)) throw Error('Unknown commit profile');
    tenant.suspend = policy(tenant.suspend);
    tenant.databasePolicies ??= {};
    for (const value of Object.values(tenant.databasePolicies)) policy(value);
    tenant.allowedIps ??= config.clientCIDRs;
    if (!Array.isArray(tenant.allowedIps) || !tenant.allowedIps.length) throw Error('Each tenant needs allowedIps or provider clientCIDRs');
    const hash = part => createHash('sha256').update(config.name + ':' + tenant.name + ':' + part).digest('hex').slice(0, 32);
    tenant.tenantId ??= hash('tenant'); tenant.timelineId ??= hash('timeline');
    if (![tenant.tenantId, tenant.timelineId].every(id => /^[a-f0-9]{32}$/.test(id))) throw Error('Invalid storage IDs');
    const writer = tenant.tenantId + ':' + tenant.timelineId;
    if (writers.has(writer)) throw Error('A storage timeline cannot have multiple writer endpoints');
    writers.add(writer);
    endpointConfig({metadata: {name: 'neon-' + tenant.endpointId}, data: {'endpoint.json': JSON.stringify({...tenant,
      image: config.computeImage, nodeName: tenant.nodeName || config.computeNode || 'docker', projectId: config.name, branchId: tenant.name,
      computeSpecSecret: 'spec', adminSecret: 'admin', rolesSecret: 'roles', tlsSecret: 'tls', caSecret: 'ca'})}});
  }
  return config;
}

export function hosts(platform, namespace = 'neon') {
  const suffix = platform === 'kubernetes' ? `.${namespace}.svc.cluster.local` : '';
  return {controller: 'neon-controller' + suffix, storage: 'storage-controller' + suffix,
    pageserver: 'pageserver' + suffix, broker: 'storage-broker' + suffix,
    safekeepers: [1, 2, 3].map(id => `safekeeper-${id}` + suffix),
    compute: id => 'neon-' + id + suffix};
}
