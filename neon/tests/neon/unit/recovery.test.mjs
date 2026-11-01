import test from 'node:test';
import assert from 'node:assert/strict';
import {Databases} from '../../../controller/tenant-compute/deploy/databases.mjs';
import {Recovery, recoveryPolicy, branchSource} from '../../../controller/tenant-compute/deploy/recovery.mjs';
import {configuration} from '../../../controller/tenant-compute/deploy/config.mjs';

function fixture() {
  const rows = new Map(), base = configuration('neon/packaging/compose/config/cluster.yaml'); base.computeNode = 'worker';
  const api = {namespace: 'neon', get: async (_, name) => structuredClone(rows.get(name)), optional: async (_, name) => rows.get(name) || null,
    list: async kind => kind === 'neondatabases' ? [...rows.values()] : [], patch: async (_, name, patch) => {
      const row = rows.get(name); Object.assign(row.spec, patch.spec); return structuredClone(row);
    }};
  const databases = new Databases({api, leader: {active: true, require() {}}, lifecycle: {}, getEndpoints: () => new Map(), emit() {}});
  databases.base = () => structuredClone(base); databases.resources = rows;
  const recovery = new Recovery({databases, api, leader: databases.leader, lifecycle: databases.lifecycle, getEndpoints: databases.getEndpoints, emit() {}});
  databases.recovery = recovery;
  const root = {metadata: {name: 'main', uid: 'root'}, spec: {size: 'micro', tier: 'shared', suspend: {mode: 'never'}}, status: {provisioningRevision: 'ready'}};
  rows.set('main', root); return {rows, databases, recovery, root};
}
test('Manual suspend overrides always-on and rejects wake/events until explicit resume', async () => {
  const {databases, root} = fixture();
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
  const {databases, rows} = fixture();
  await assert.rejects(databases.operation('main', 'delete', {mode: 'purge'}), {code: 'PURGE_CONFIRMATION_REQUIRED'});
  rows.set('child', {metadata: {name: 'child'}, spec: {branchFrom: {database: 'main'}}});
  await assert.rejects(databases.operation('main', 'delete', {mode: 'purge', confirm: 'main'}), {code: 'DEPENDENT_BRANCHES_OR_BACKUPS'});
  rows.delete('child');
  await databases.operation('main', 'delete');
  assert.equal(rows.get('main').spec.deletionPolicy, 'Retain');
  await assert.rejects(databases.operation('main', 'resume'), {code: 'DATABASE_RETIRED'});
});
test('Branches share storage tenant and history policy but have distinct writer timelines', () => {
  const {databases, rows, root} = fixture(); root.spec.backup = {historySeconds: 604800};
  const child = {metadata: {name: 'preview'}, spec: {size: 'small', tier: 'shared', branchFrom: {database: 'main'}}}; rows.set('preview', child);
  const parent = databases.tenant(root, databases.base()), branch = databases.tenant(child, databases.base());
  assert.equal(parent.tenantId, branch.tenantId); assert.notEqual(parent.timelineId, branch.timelineId);
  assert.equal(branch.storagePolicy.pitr_interval, '604800s'); assert.equal(branch.size, 'small');
  root.spec.branchFrom = {database: 'preview'};
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
  const {recovery, root} = fixture(), source = {resource: root, tenant: {tenantId: 'tenant', timelineId: 'timeline'}};
  const calls = []; let kind = 'past';
  recovery.routing = {request: async (method, route, body) => {calls.push({method, route, body}); return method === 'GET' ? {kind, lsn: '0/100'} : {};}};
  await assert.rejects(recovery.point(source, {timestamp: '2026-01-01T00:00:00Z'}), {code: 'RESTORE_POINT_UNAVAILABLE'});
  assert.equal(calls.length, 1); kind = 'present';
  assert.equal(await recovery.point(source, {timestamp: '2026-01-01T00:00:00Z'}), '0/100');
  assert.deepEqual(calls.at(-1), {method: 'POST', route: '/v1/tenant/tenant/timeline/timeline/lsn_lease', body: {lsn: '0/100'}});
});
