import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {ConfigurationFile as configuration} from '../../../controller/tenant-compute/src/infrastructure/configuration/ConfigurationFile.mjs';
import {NormalizeClusterConfiguration as normalizeConfiguration} from '../../../controller/tenant-compute/src/domain/configuration/ClusterConfiguration.mjs';
import {SpecRouting as specRouting} from '../../../controller/tenant-compute/src/infrastructure/storage/StorageRouting.mjs';
import {EndpointConfig as endpointConfig, RenderComputeSpec} from '../../../controller/tenant-compute/src/domain/compute/ComputeSpecification.mjs';
import {Lifecycle} from '../../../controller/tenant-compute/src/infrastructure/compute/Lifecycle.mjs';

test('Managed compute always preloads statement telemetry while preserving optional libraries', () => {
  const native = {tenant_id: 'tenant', timeline_id: 'timeline', safekeeper_connstrings: ['storage:5454'],
    storage_auth_token: 'fixture', cluster: {roles: [], settings: [{name: 'shared_preload_libraries', value: 'neon,anon', vartype: 'string'}]}};
  const rendered = RenderComputeSpec(native, {profile: 'durable'});
  assert.equal(rendered.cluster.settings.find(option => option.name === 'shared_preload_libraries').value, 'neon,pg_stat_statements,anon');
  assert.equal(native.cluster.settings[0].value, 'neon,anon');
  assert.equal(rendered.cluster.settings.find(option => option.name === 'compute_query_id').value, 'on');
});

test('Commit profiles reach native compute without weakening safekeeper or planned-drain settings', () => {
  const native = {tenant_id:'tenant',timeline_id:'timeline',safekeeper_connstrings:['storage:5454'],
    storage_auth_token:'fixture',cluster:{roles:[],settings:[{name:'neon.best_effort_commit',value:'on'}]}};
  for (const profile of ['durable','bounded-async','best-effort']) {
    const rendered = RenderComputeSpec(native,{profile});
    const settings = Object.fromEntries(rendered.cluster.settings.map(option=>[option.name,option.value]));
    assert.equal(settings.fsync,profile==='durable'?'on':'off');
    assert.equal(settings.synchronous_commit,profile==='durable'?'on':'off');
    assert.equal(settings['neon.bounded_async_commit'],'on');
    assert.equal(settings['neon.best_effort_commit'],profile==='best-effort'?'on':'off');
    assert.equal(settings['neon.bounded_async_max_age'],'750ms');
    assert.equal(rendered.suspend_timeout_seconds,-1);
    assert.deepEqual(rendered.safekeeper_connstrings,native.safekeeper_connstrings);
  }
  assert.throws(()=>RenderComputeSpec(native,{profile:'fastest'}),/Invalid commit profile/);
});

test('Loss-tolerant databases require explicit fleet permission, including seeded tenants', () => {
  const base = configuration('neon/packaging/compose/config/cluster.yaml');
  for (const profile of ['bounded-async','best-effort']) {
    const input = {...base,replication:{mode:'synchronous-quorum'},tenants:[{name:'example',profile,allowedIps:base.clientCIDRs}]};
    assert.throws(()=>normalizeConfiguration(structuredClone(input)),/ZONE_QUORUM_REQUIRES_DURABLE/);
    assert.equal(normalizeConfiguration({...structuredClone(input),allowAsyncCommits:true}).tenants[0].profile,profile);
  }
});

test('Deployment config uses stable tenant identities and accepts normal SQL role names', () => {
  const base = configuration('neon/packaging/compose/config/cluster.yaml');
  const config = normalizeConfiguration({...base, tenants: [{name: 'example', allowedIps: base.clientCIDRs}]});
  assert.equal(config.tenants[0].user, 'app_user');
  assert.equal(config.tenants[0].tenantId, normalizeConfiguration({...base, tenants: [{name: 'example', allowedIps: base.clientCIDRs}]}).tenants[0].tenantId);
  const routing = specRouting({shard_params: {count: 2, stripe_size: 2048}, shards: [
    {shard_id: 'tenant-0102', listen_pg_addr: 'pageserver-2', listen_pg_port: 6400},
    {shard_id: 'tenant-0002', listen_pg_addr: 'pageserver', listen_pg_port: 6400}]});
  assert.equal(routing.pageserver_connstring, 'host=pageserver port=6400,host=pageserver-2 port=6400');
  assert.throws(() => specRouting({shard_params: {count: 2, stripe_size: 2048}, shards: []}), /Incomplete/);
});
test('Deployment rejects unsafe S3 transport before provisioning', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'neon-deploy-'));
  const file = path.join(dir, 'config.yaml');
  try {
    fs.writeFileSync(file, fs.readFileSync('neon/packaging/compose/config/cluster.yaml', 'utf8').replace('https://s3.example.com', 'http://s3.example.com'));
    assert.throws(() => configuration(file), /HTTPS S3/);
  } finally {fs.unlinkSync(file); fs.rmdirSync(dir);}
});
test('Endpoint resource sizing changes compute revision and reaches the generated Pod', () => {
  const config = {endpointId: 'ep-test', nodeName: 'worker', image: 'ghcr.io/example/compute@sha256:' + 'a'.repeat(64),
    profile: 'durable', projectId: 'p', branchId: 'b', computeSpecSecret: 'spec', adminSecret: 'admin', rolesSecret: 'roles', tlsSecret: 'tls', caSecret: 'ca', allowedIps: ['10.0.0.0/8']};
  const parse = value => endpointConfig({metadata: {name: 'neon-ep-test', uid: 'one'}, data: {'endpoint.json': JSON.stringify(value)}});
  const before = parse(config), after = parse({...config, resources: {limits: {cpu: '4', memory: '4Gi'}}});
  assert.notEqual(before.computeRevision, after.computeRevision);
  const pod = new Lifecycle({}, {}, () => {}).template(after);
  assert.equal(pod.spec.containers[0].resources.limits.cpu, '4');
  assert.equal(pod.spec.containers[0].resources.limits.memory, '4Gi');
  assert.throws(() => parse({...config, resources: {limits: {cpu: '-1'}}}), /resource quantity/);
});
