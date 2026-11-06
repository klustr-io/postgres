import test from 'node:test';
import assert from 'node:assert/strict';
import {ManagedDatabasesInit} from '../../../controller/tenant-compute/src/composition/ManagedDatabasesInit.mjs';
import {RecoveryPolicy as recoveryPolicy, BranchSource as branchSource} from '../../../controller/tenant-compute/src/domain/recovery/RecoveryPolicy.mjs';
import {ConfigurationFile as configuration} from '../../../controller/tenant-compute/src/infrastructure/configuration/ConfigurationFile.mjs';

async function fixture() {
  const rows = new Map(), base = configuration('neon/packaging/compose/config/cluster.yaml'); base.computeNode = 'worker';
  const api = {namespace: 'neon', get: async (_, name) => structuredClone(rows.get(name)), optional: async (_, name) => rows.get(name) || null,
    list: async kind => kind === 'neondatabases' ? [...rows.values()] : [], patch: async (_, name, patch) => {
      const row = rows.get(name); Object.assign(row.spec, patch.spec); return structuredClone(row);
    }};
  const {databases, recovery} = ManagedDatabasesInit({api, leader: {active: true, require() {}}, lifecycle: {}, getEndpoints: () => new Map(), emit() {},
    enableFleet: false, configFile: 'neon/packaging/compose/config/cluster.yaml', publishDemand() {}, provision: async () => {throw Error('Unexpected provisioning');}});
  databases.base = () => structuredClone(base);
  const root = {metadata: {name: 'main', uid: 'root'}, spec: {size: 'micro', tier: 'shared', suspend: {mode: 'never'}}, status: {provisioningRevision: 'ready'}};
  rows.set('main', root); await databases.load(); return {rows, databases, recovery, root};
}
test('Manual suspend overrides always-on and rejects wake/events until explicit resume', async () => {
  const {databases, root} = await fixture();
  await databases.operation('main', 'suspend');
  await assert.rejects(databases.assertAvailable('main'), {code: 'DATABASE_SUSPENDED'});
  assert.equal(await databases.demand('main'), false);
  const object = databases.scaledObject(root, databases.tenant(root, databases.base()));
  assert.equal(object.metadata.annotations['autoscaling.keda.sh/paused-replicas'], '0');
  assert.equal(object.spec.minReplicaCount, 0);
  await assert.rejects(databases.event('main', {id: 'test'}), {code: 'DATABASE_SUSPENDED'});
  await databases.operation('main', 'resume'); await databases.assertAvailable('main');
  assert.equal(root.spec.suspend.mode, 'never'); assert.equal(await databases.demand('main'), true);
});
test('Purge needs an exact confirmation and refuses dependent branches or backups', async () => {
  const {databases, rows} = await fixture();
  await assert.rejects(databases.operation('main', 'delete', {mode: 'purge'}), {code: 'PURGE_CONFIRMATION_REQUIRED'});
  rows.set('child', {metadata: {name: 'child'}, spec: {branchFrom: {database: 'main'}}});
  await assert.rejects(databases.operation('main', 'delete', {mode: 'purge', confirm: 'main'}), {code: 'DEPENDENT_BRANCHES_OR_BACKUPS'});
  rows.delete('child');
  await databases.operation('main', 'delete');
  assert.equal(rows.get('main').spec.deletionPolicy, 'Retain');
  await assert.rejects(databases.operation('main', 'resume'), {code: 'DATABASE_RETIRED'});
});
test('Branches share storage tenant and history policy but have distinct writer timelines', async () => {
  const {databases, rows, root} = await fixture(); root.spec.backup = {historySeconds: 604800};
  root.spec.preloadLibraries = ['timescaledb', 'anon', 'pg_textsearch'];
  const child = {metadata: {name: 'preview'}, spec: {size: 'small', tier: 'shared', branchFrom: {database: 'main'}}}; rows.set('preview', child);
  await databases.load();
  const parent = databases.tenant(root, databases.base()), branch = databases.tenant(child, databases.base());
  assert.equal(parent.tenantId, branch.tenantId); assert.notEqual(parent.timelineId, branch.timelineId);
  assert.equal(branch.storagePolicy.pitr_interval, '604800s'); assert.equal(branch.size, 'small');
  assert.deepEqual(branch.preloadLibraries, ['timescaledb', 'anon', 'pg_textsearch']);
  assert.equal(branch.settings.find(option => option.name === 'max_worker_processes').value, '32');
  assert.deepEqual(branch.settings.find(option => option.name === 'shared_preload_libraries'),
    parent.settings.find(option => option.name === 'shared_preload_libraries'));
  root.spec.branchFrom = {database: 'preview'};
  await databases.load();
  assert.throws(() => databases.tenant(child, databases.base()), {code: 'BRANCH_CYCLE'});
});
test('History and scheduled snapshot retention reject unbounded or contradictory policies', () => {
  assert.equal(recoveryPolicy().historySeconds, 604800);
  assert.throws(() => recoveryPolicy({historySeconds: -1}), {code: 'INVALID_SPEC'});
  assert.throws(() => recoveryPolicy({scheduleSeconds: 60}), {code: 'INVALID_SPEC'});
  assert.throws(() => recoveryPolicy({scheduleSeconds: 3600, retentionSeconds: 300}), {code: 'INVALID_SPEC'});
  assert.throws(() => branchSource({database: 'main', backup: 'saved', lsn: '0/100'}), {code: 'INVALID_SPEC'});
});
test('PITR refuses pruned/future timestamp boundaries and leases a present point across shards', async () => {
  const {recovery, root} = await fixture(), source = {resource: root, tenant: {tenantId: 'tenant', timelineId: 'timeline'}};
  const calls = []; let kind = 'past';
  recovery.routing = {request: async (method, route, body) => {calls.push({method, route, body}); return method === 'GET' ? {kind, lsn: '0/100'} : {};}};
  await assert.rejects(recovery.point(source, {timestamp: '2026-01-01T00:00:00Z'}), {code: 'RESTORE_POINT_UNAVAILABLE'});
  assert.equal(calls.length, 1); kind = 'present';
  assert.equal(await recovery.point(source, {timestamp: '2026-01-01T00:00:00Z'}), '0/100');
  assert.deepEqual(calls.at(-1), {method: 'POST', route: '/v1/tenant/tenant/timeline/timeline/lsn_lease', body: {lsn: '0/100'}});
});
