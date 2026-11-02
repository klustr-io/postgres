import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {once} from 'node:events';
import {ManagedDatabasesInit} from '../../../controller/tenant-compute/src/composition/ManagedDatabasesInit.mjs';
import {ConfigurationFile as configuration} from '../../../controller/tenant-compute/src/infrastructure/configuration/ConfigurationFile.mjs';
import {DatabaseQuery} from '../../../controller/tenant-compute/src/application/database/DatabaseQuery.mjs';
import {BranchDatabase} from '../../../controller/tenant-compute/src/application/database/BranchDatabase.mjs';
import {KubernetesDatabaseRepository} from '../../../controller/tenant-compute/src/infrastructure/kubernetes/KubernetesDatabaseRepository.mjs';
import {DatabaseController} from '../../../controller/tenant-compute/src/api/database/DatabaseController.mjs';
import {RecoveryController} from '../../../controller/tenant-compute/src/api/recovery/RecoveryController.mjs';
import {BranchController} from '../../../controller/tenant-compute/src/api/database/BranchController.mjs';
import {DatabaseRoutes} from '../../../controller/tenant-compute/src/api/database/DatabaseRoutes.mjs';
import {ControlPlaneRouter} from '../../../controller/tenant-compute/src/api/http/ControlPlaneRouter.mjs';

async function fixture(t) {
  const databases = new Map(), backups = new Map(), fleets = [], collections = {neondatabases: databases, neonbackups: backups};
  const api = {
    list: async kind => kind === 'neonfleets' ? fleets : structuredClone([...collections[kind].values()]),
    get: async (kind, name) => {
      if (!collections[kind].has(name)) throw Object.assign(Error('not found'), {status: 404});
      return structuredClone(collections[kind].get(name));
    },
    optional: async (kind, name) => structuredClone(collections[kind].get(name) || null),
    create: async (kind, row) => {
      const value = structuredClone({...row, metadata: {...row.metadata, uid: row.metadata.name, generation: 1, resourceVersion: '1'}});
      collections[kind].set(row.metadata.name, value); return value;
    },
    patch: async (kind, name, patch) => {
      const row = collections[kind].get(name); Object.assign(row.spec, patch.spec); row.metadata.generation++;
      return structuredClone(row);
    },
    path: (kind, name) => '/' + kind + '/' + name,
    request: async (method, path, body) => {
      const [, kind, name] = path.split('/');
      assert.equal(method, 'DELETE'); assert.equal(body.preconditions.uid, collections[kind].get(name).metadata.uid);
      collections[kind].delete(name);
    }
  };
  const leader = {active: true, require() {}};
  const {databases: service, recovery} = ManagedDatabasesInit({api, leader, lifecycle: {}, getEndpoints: () => new Map(), emit() {},
    enableFleet: false, configFile: 'neon/packaging/compose/config/cluster.yaml', publishDemand() {}, provision: async () => {throw Error('Unexpected provisioning');}});
  service.base = () => configuration('neon/packaging/compose/config/cluster.yaml');
  const repository = new KubernetesDatabaseRepository({api}), query = new DatabaseQuery({readDatabase: repository.Read.bind(repository)});
  const routes = DatabaseRoutes(
    new DatabaseController({getDatabase: query.Get.bind(query), putDatabase: service.put.bind(service), recordEvent: service.event.bind(service),
      changeLifecycle: service.operation.bind(service), requestReconcile() {}, requestPoll() {}}),
    new RecoveryController({readBackup: recovery.get.bind(recovery), listBackups: recovery.list.bind(recovery), createBackup: recovery.create.bind(recovery),
      deleteBackup: recovery.delete.bind(recovery), history: recovery.history.bind(recovery), requestReconcile() {}}),
    new BranchController({branch: new BranchDatabase({readSource: recovery.readSource.bind(recovery), putDatabase: service.put.bind(service), requestReconcile() {}})}));
  const router = new ControlPlaneRouter({routes, management: {Require: async () => {}}, authorizeProxy() {throw Error('Unexpected proxy route');},
    requireLeader() {}, stopping: () => false, unavailable() {}});
  const server = http.createServer(router.Handle.bind(router));
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(() => new Promise(resolve => server.close(resolve)));
  const request = (method, path, body) => fetch('http://127.0.0.1:' + server.address().port + path,
    {method, headers: {'Content-Type': 'application/json'}, ...(body === undefined ? {} : {body: JSON.stringify(body)})});
  return {request, databases, backups, fleets};
}

test('Database routes persist definitions, branch ancestry and lifecycle commands through application boundaries', async t => {
  const {request, databases, fleets} = await fixture(t);
  let reply = await request('PUT', '/v1/databases/main', {size: 'small', tier: 'shared', identity: {tenant: 'acme', project: 'billing'}});
  assert.equal(reply.status, 202); assert.equal((await reply.json()).generation, 1);
  databases.get('main').status = {provisioningRevision: 'ready'};
  reply = await request('POST', '/v1/databases/main/branches', {name: 'preview', size: 'micro', lsn: '0/100'});
  assert.equal(reply.status, 202); await reply.json();
  assert.deepEqual(databases.get('preview').spec.branchFrom, {database: 'main', lsn: '0/100'});
  assert.deepEqual(databases.get('preview').spec.identity, {tenant: 'acme', project: 'billing'});
  assert.equal(databases.get('preview').spec.size, 'micro');
  reply = await request('POST', '/v1/databases/main/suspend'); assert.equal(reply.status, 202); await reply.json();
  assert.equal(databases.get('main').spec.lifecycle, 'suspended');
  fleets.push({metadata: {name: 'owner', deletionTimestamp: '2026-01-01T00:00:00Z'}});
  reply = await request('POST', '/v1/databases/main/resume'); assert.equal(reply.status, 409); assert.equal((await reply.json()).error, 'FLEET_RETIRED');
  assert.equal(databases.get('main').spec.lifecycle, 'suspended');
  reply = await request('GET', '/v1/databases/main'); assert.equal(reply.status, 200); assert.equal((await reply.json()).name, 'main');
});

test('Recovery routes validate input and persist retained recovery point commands', async t => {
  const {request, databases, backups} = await fixture(t);
  await (await request('PUT', '/v1/databases/main', {size: 'small', tier: 'shared'})).json();
  databases.get('main').status = {provisioningRevision: 'ready'};
  let reply = await request('POST', '/v1/databases/main/backups', {name: 'saved', retentionSeconds: 86400});
  assert.equal(reply.status, 202); await reply.json(); assert.equal(backups.get('saved').spec.databaseUID, 'main');
  reply = await request('GET', '/v1/databases/main/backups'); assert.equal((await reply.json()).backups[0].name, 'saved');
  reply = await request('POST', '/v1/databases/main/backups', null); assert.equal(reply.status, 422); await reply.json();
  reply = await request('POST', '/v1/databases/main/branches', {name: 'bad', unexpected: true}); assert.equal(reply.status, 422); await reply.json();
  assert(!databases.has('bad'));
  reply = await request('DELETE', '/v1/backups/saved'); assert.equal(reply.status, 202); await reply.json(); assert(!backups.has('saved'));
});
