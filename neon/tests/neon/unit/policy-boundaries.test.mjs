import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {ManagedDatabasesInit} from '../../../controller/tenant-compute/src/composition/ManagedDatabasesInit.mjs';
import {FleetOperator} from '../../../controller/tenant-compute/src/application/fleet/FleetOperator.mjs';
import {ConfigurationFile as configuration} from '../../../controller/tenant-compute/src/infrastructure/configuration/ConfigurationFile.mjs';
import {parse} from '../../../controller/tenant-compute/node_modules/yaml/dist/index.js';
import {ReconcileTenants as reconcileTenants} from '../../../controller/tenant-compute/src/infrastructure/provisioning/TenantProvisioning.mjs';
import {SelectFleetOwner} from '../../../controller/tenant-compute/src/domain/fleet/FleetPolicy.mjs';

function fixture() {
  const base = configuration('neon/packaging/compose/config/cluster.yaml');
  base.defaults = {size: 'micro', tier: 'shared', suspend: {mode: 'idle', idleSeconds: 60},
    backup: {historySeconds: 86400, scheduleSeconds: 3600, retentionSeconds: 604800}};
  const rows = new Map(), fleets = [], backups = new Map();
  const collections = {neondatabases: rows, neonbackups: backups};
  const api = {
    list: async kind => kind === 'neonfleets' ? fleets : [...collections[kind].values()],
    get: async (kind, name) => structuredClone(collections[kind].get(name)),
    optional: async (kind, name) => structuredClone(collections[kind].get(name) || null),
    create: async (kind, row) => {collections[kind].set(row.metadata.name, structuredClone(row)); return row;},
    patch: async (kind, name, patch) => {const row = collections[kind].get(name); Object.assign(row.spec, patch.spec); return row;}
  };
  const leader = {active: true, require() {}};
  const {databases, recovery} = ManagedDatabasesInit({api, leader, lifecycle: {}, getEndpoints: () => new Map(), emit() {}, enableFleet: false,
    configFile: 'neon/packaging/compose/config/cluster.yaml', publishDemand() {}, provision: async () => {throw Error('Unexpected provisioning');}});
  databases.base = () => structuredClone(base);
  return {base, api, leader, rows, fleets, backups, databases, recovery};
}

test('REST and YAML inherit identical policies; scheduling consumes the effective policy', async () => {
  const {databases, recovery, api, rows, backups} = fixture();
  const rest = await databases.put('rest', {});
  const yaml = {metadata: {name: 'yaml', uid: 'yaml'}, spec: {}, status: {provisioningRevision: 'ready'}};
  rows.set('yaml', yaml); await databases.load();
  const first = databases.tenant(rest, databases.base()), second = databases.tenant(yaml, databases.base());
  assert.deepEqual(first.backup, second.backup);
  assert.deepEqual(first.suspend, second.suspend);
  assert.equal(second.size, 'micro'); assert.equal(second.backup.scheduleSeconds, 3600);
  // Only exercise scheduling; ready existing backups require no storage work.
  api.create = async (kind, row) => {row.status = {phase: 'Ready'}; backups.set(row.metadata.name, row); return row;};
  await recovery.reconcile();
  assert.equal(backups.size, 1);
  assert.equal([...backups.values()][0].spec.retentionSeconds, 604800);
});

test('Explicit partial overrides inherit other values and follow later fleet default changes', async () => {
  const {base, databases, rows} = fixture();
  const resource = await databases.put('main', {backup: {scheduleSeconds: 0}, suspend: {idleSeconds: 120}});
  rows.set('main', resource);
  let tenant = databases.tenant(resource, databases.base());
  assert.equal(tenant.backup.historySeconds, 86400); assert.equal(tenant.backup.scheduleSeconds, 0);
  assert.deepEqual(tenant.suspend, {mode: 'idle', idleSeconds: 120});
  base.defaults.backup.historySeconds = 172800;
  tenant = databases.tenant(resource, databases.base());
  assert.equal(tenant.backup.historySeconds, 172800); assert.equal(tenant.backup.scheduleSeconds, 0);
});

test('Kubernetes schema preserves omission of inheritable defaults', () => {
  const crd = parse(fs.readFileSync('neon/packaging/kubernetes/keda/database-crd.yaml', 'utf8'));
  const spec = crd.spec.versions[0].schema.openAPIV3Schema.properties.spec;
  assert(!spec.required?.includes('size')); assert(!spec.required?.includes('tier'));
  for (const name of ['suspend', 'backup']) {
    assert.equal(spec.properties[name].default, undefined);
    for (const field of Object.values(spec.properties[name].properties)) assert.equal(field.default, undefined);
  }
});

test('Retiring fleet blocks create, resume, events, availability and demand while allowing suspend', async () => {
  const {databases, rows, fleets} = fixture();
  rows.set('main', {metadata: {name: 'main'}, spec: {}});
  fleets.push({metadata: {name: 'fleet', deletionTimestamp: '2026-01-01T00:00:00Z'}, spec: {}});
  for (const action of [() => databases.put('new', {}), () => databases.operation('main', 'resume'),
    () => databases.event('main', {id: 'test'}), () => databases.assertAvailable('main')]) {
    await assert.rejects(action(), {code: 'FLEET_RETIRED'});
  }
  assert.equal(await databases.demand('main'), false);
  await databases.operation('main', 'suspend');
  assert.equal(rows.get('main').spec.lifecycle, 'suspended');
});

test('Conflicting fleet is rejected while established fleet retirement continues', async () => {
  const calls = [], owner = {metadata: {name: 'owner', uid: 'owner', deletionTimestamp: '2026-01-01T00:00:00Z', finalizers: ['neon.klustr.io/retain-fleet']}, status: {storageIdentity: 'established'}},
    extra = {metadata: {name: 'extra', uid: 'extra'}};
  const api = {list: async kind => kind === 'neonfleets' ? [extra, owner] : [{metadata: {name: 'main'}, spec: {}}],
    patch: async (kind, name, patch) => calls.push({kind, name, patch})};
  const operator = new FleetOperator({api, leader: {active: true, require() {}}, emit() {}, planFleet() {throw Error('Unexpected provisioning');}});
  operator.status = async (row, status) => calls.push({kind: 'status', name: row.metadata.name, status});
  await operator.reconcile();
  assert(calls.some(call => call.name === 'extra' && call.status?.phase === 'Rejected'));
  assert(calls.some(call => call.name === 'owner' && call.status?.phase === 'Retaining'));
  assert(calls.some(call => call.name === 'main' && call.patch.spec.lifecycle === 'suspended'));
});

test('Multiple established owners fail closed rather than selecting an arbitrary storage identity', () => {
  assert.throws(() => SelectFleetOwner(['first', 'second'].map(name => ({metadata: {name}, status: {storageIdentity: name}}))), {code: 'FLEET_OWNERSHIP_CONFLICT'});
});

test('Provisioning rejects lease loss before provider access without loading ambient configuration', async () => {
  const failure = Object.assign(Error('Lease lost'), {code: 'NOT_LEADER'});
  await assert.rejects(reconcileTenants({}, () => {throw failure;}, {namespace: 'test'}), failure);
});

test('Database observations cannot mutate cached authority or provider records', async () => {
  const {databases, rows} = fixture();
  rows.set('main', {metadata: {name: 'main'}, spec: {lifecycle: 'active'}});
  await databases.load();
  const snapshot = databases.definitions(); snapshot[0].spec.lifecycle = 'retired';
  const definition = databases.definition('main'); definition.spec.lifecycle = 'suspended';
  assert.equal(databases.definition('main').spec.lifecycle, 'active');
  rows.get('main').spec.lifecycle = 'retired';
  assert.equal(databases.definition('main').spec.lifecycle, 'active');
  await databases.load(); assert.equal(databases.definition('main').spec.lifecycle, 'retired');
});
