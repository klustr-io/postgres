import test from 'node:test';
import assert from 'node:assert/strict';
import grpc from '../../../controller/tenant-compute/node_modules/@grpc/grpc-js/build/src/index.js';
import {KedaProtocol as protocol, KedaScalerInit as startScaler} from '../../../controller/tenant-compute/src/infrastructure/keda/KedaScaler.mjs';
import {ManagedDatabasesInit} from '../../../controller/tenant-compute/src/composition/ManagedDatabasesInit.mjs';
import {ConfigurationFile as configuration} from '../../../controller/tenant-compute/src/infrastructure/configuration/ConfigurationFile.mjs';

function manager() {
  const base = configuration('neon/packaging/compose/config/cluster.yaml'); base.computeNode = 'worker';
  const {databases} = ManagedDatabasesInit({api: {namespace: 'test', optional: async () => null, list: async () => []}, leader: {active: true, require() {}},
    lifecycle: {}, getEndpoints: () => new Map(), emit() {}, enableFleet: false, configFile: 'neon/packaging/compose/config/cluster.yaml',
    publishDemand() {}, provision: async () => {throw Error('Unexpected provisioning');}});
  databases.base = () => structuredClone(base);
  return databases;
}
test('KEDA targets the drain-aware database scale subresource and permits only one writer', () => {
  const databases = manager(), resource = {apiVersion: 'neon.klustr.io/v1alpha1', kind: 'NeonDatabase', metadata: {name: 'events', uid: 'one'},
    spec: {size: 'small', tier: 'standard', suspend: {mode: 'idle', idleSeconds: 300}}};
  const tenant = databases.tenant(resource, databases.base()), object = databases.scaledObject(resource, tenant);
  assert.equal(object.spec.scaleTargetRef.kind, 'NeonDatabase'); assert.equal(object.spec.maxReplicaCount, 1);
  assert.equal(object.spec.cooldownPeriod, 300); assert.equal(object.spec.triggers[0].type, 'external-push');
  assert.equal(tenant.storagePolicy.placement_policy.Attached, 1);
  assert.equal(tenant.storagePolicy.timeline_get_throttle.refill_amount, 10000);
});
test('Selecting a larger size updates CPU, memory and PostgreSQL buffers together', () => {
  const databases = manager(), resource = {metadata: {name: 'events'}, spec: {size: 'medium', tier: 'shared'}};
  const tenant = databases.tenant(resource, databases.base());
  assert.equal(tenant.resources.limits.cpu, '2'); assert.equal(tenant.resources.limits.memory, '4Gi');
  assert.equal(tenant.settings.find(option => option.name === 'shared_buffers').value, '1GB');
  assert.throws(() => databases.tenant({...resource, spec: {...resource.spec, nodeName: 'attacker'}}, databases.base()), /Unsupported tenant field/);
});
test('Quiet SQL does not bypass the KEDA cooldown or repeatedly stop a desired running database', async () => {
  const databases = manager(); let stops = 0;
  databases.api.get = async () => ({metadata: {name: 'events', generation: 1}, spec: {replicas: 1, size: 'small', tier: 'shared'}});
  databases.api.optional = async () => ({spec: {replicas: 1, template: {metadata: {annotations: {'neon.klustr.io/config-revision': 'current'}}}}});
  databases.lifecycle.sampleDemand = async () => false; databases.lifecycle.suspend = async () => {stops++;};
  databases.demand = async () => false; databases.status = async () => {};
  const endpoint = {databaseResource: 'events', name: 'neon-ep-events', size: 'small', tier: 'shared', computeRevision: 'current', status: {phase: 'Active'}};
  await databases.endpoint(endpoint); assert.equal(stops, 0);
  databases.api.get = async () => ({metadata: {name: 'events', generation: 2}, spec: {replicas: 0, size: 'small', tier: 'shared'}});
  await databases.endpoint(endpoint); assert.equal(stops, 1);
});
test('External scaler speaks the KEDA gRPC protocol and pushes demand changes', async t => {
  const original = process.env.NODE_ENV; process.env.NODE_ENV = 'test';
  const server = await startScaler({namespace: 'test', port: 0, leader: {active: true, require() {}}, demand: async () => true});
  const client = new protocol.ExternalScaler('127.0.0.1:' + server.port, grpc.credentials.createInsecure());
  t.after(() => {client.close(); server.close(); if (original === undefined) delete process.env.NODE_ENV; else process.env.NODE_ENV = original;});
  const ref = {name: 'neon-events', namespace: 'test', scalerMetadata: {database: 'events'}};
  assert.equal((await new Promise((resolve, reject) => client.IsActive(ref, (error, result) => error ? reject(error) : resolve(result)))).result, true);
  const stream = client.StreamIsActive(ref); stream.on('error', () => {});
  assert.equal((await new Promise(resolve => stream.once('data', resolve))).result, true);
  const changed = new Promise(resolve => stream.once('data', resolve)); server.publish('events', false);
  assert.equal((await changed).result, false); stream.cancel();
  await assert.rejects(new Promise((resolve, reject) => client.IsActive({...ref, namespace: 'other'}, (error, result) => error ? reject(error) : resolve(result))));
});
