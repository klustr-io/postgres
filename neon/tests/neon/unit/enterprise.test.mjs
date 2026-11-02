import test from 'node:test';
import assert from 'node:assert/strict';
import {generateKeyPairSync, sign} from 'node:crypto';
import {Identity} from '../../../controller/tenant-compute/deploy/identity.mjs';
import {DatabaseCredentials} from '../../../controller/tenant-compute/deploy/database-credentials.mjs';
import {fleetResources, validateFleet} from '../../../controller/tenant-compute/deploy/enterprise-fleet.mjs';
const keys = generateKeyPairSync('rsa', {modulusLength: 2048});
const jwk = {...keys.publicKey.export({format: 'jwk'}), kid: 'one', alg: 'RS256', use: 'sig'};
const config = {issuer: 'https://identity.example', jwksUrl: 'https://identity.example/keys', management: {audience: 'fleet-api', roleBindings: [{group: 'admins', role: 'fleet-admin'}, {group: 'viewers', role: 'viewer'}]},
  database: {audience: 'postgres', requireTenantProjectBinding: true, roleBindings: [{group: 'writers', postgresRole: 'app_writer'}]}};
const token = overrides => {
  const head = Buffer.from(JSON.stringify({alg: 'RS256', kid: 'one', typ: 'at+jwt'})).toString('base64url');
  const body = Buffer.from(JSON.stringify({iss: config.issuer, aud: 'fleet-api', exp: Math.floor(Date.now() / 1000) + 300, sub: 'user-123', groups: ['admins'], ...overrides})).toString('base64url');
  return head + '.' + body + '.' + sign('sha256', Buffer.from(head + '.' + body), keys.privateKey).toString('base64url');
};
const request = (claims, method = 'GET', url = '/v1/fleet') => ({method, url, headers: {authorization: 'Bearer ' + token(claims)}});
function identity() {return new Identity({configuration: () => config, fetchJSON: async () => ({keys: [jwk]})});}
test('Management OIDC verifies signatures, issuer, mandatory expiry and resource audience', async () => {
  const auth = identity(); assert.equal((await auth.management(request({}))).subject, 'user-123');
  for (const claims of [{iss: 'https://wrong.example'}, {aud: 'postgres'}, {exp: undefined}, {exp: 1}]) await assert.rejects(auth.management(request(claims)), {status: 401});
  const forged = request({}); forged.headers.authorization = forged.headers.authorization.slice(0, -10) + 'AAAAAAAAAA';
  await assert.rejects(auth.management(forged), {status: 401});
});
test('Management RBAC and database tenant/project/role bindings are distinct', async () => {
  const auth = identity();
  await assert.rejects(auth.management(request({groups: ['viewers']}, 'DELETE', '/v1/databases/main')), {status: 403});
  const db = {spec: {identity: {tenant: 'acme', project: 'billing'}}}, claims = {aud: 'postgres', groups: ['writers'], tenant: 'acme', project: 'billing'};
  assert.equal((await auth.database(request(claims), db, 'app_writer')).subject, 'user-123');
  await assert.rejects(auth.database(request({...claims, tenant: 'other'}), db, 'app_writer'), {status: 403});
  await assert.rejects(auth.database(request(claims), db, 'neon_lifecycle'), {status: 403});
  await assert.rejects(auth.database(request({groups: ['admins']}), db, 'app_writer'), {status: 401});
});
test('Unknown rotated signing keys refresh after the bounded refetch interval', async () => {
  let now = Date.now(), calls = 0;
  const auth = new Identity({configuration: () => config, clock: () => now, fetchJSON: async () => {calls++; return {keys: [calls === 1 ? {...jwk, kid: 'old'} : jwk]};}});
  await assert.rejects(auth.management(request({})), {status: 401}); assert.equal(calls, 1);
  now += 6000; await auth.management(request({})); assert.equal(calls, 2);
});
test('Rejected database identity cannot trigger compute or storage wake', async () => {
  let wakes = 0;
  const broker = new DatabaseCredentials({databases: {assertAvailable: async () => ({}), beginConnection: () => {wakes++;}},
    identity: {authenticate: async () => {throw Object.assign(Error('denied'), {status: 403});}}});
  await assert.rejects(broker.exchange({}, 'main', {role: 'app_writer'}), {status: 403}); assert.equal(wakes, 0);
});
function fleet() {
  return {apiVersion: 'neon.klustr.io/v1alpha1', kind: 'NeonFleet', metadata: {name: 'acme', namespace: 'enterprise', uid: '12345678-1234-1234-1234-123456789abc'},
    spec: {domain: 'db.example', identity: config, storage: {objectStoreSecretRef: 's3', storageClass: 'durable'},
      replication: {scope: 'availability-zones', mode: 'synchronous-quorum', safekeepers: 3, zones: ['a', 'b', 'c']}}};
}
function options() {
  return {templates: 'neon/packaging/kubernetes', controllerImage: 'ghcr.io/example/neon-tenant-controller@sha256:' + 'a'.repeat(64),
    nodes: ['a', 'b', 'c'].map(zone => ({metadata: {name: 'worker-' + zone, labels: {'topology.kubernetes.io/zone': zone}}, status: {conditions: [{type: 'Ready', status: 'True'}]}})),
    objectStore: {data: Object.fromEntries(Object.entries({AWS_ACCESS_KEY_ID: 'test-only', AWS_SECRET_ACCESS_KEY: 'test-only', AWS_REGION: 'region', NEON_S3_ENDPOINT: 'https://s3.example', NEON_S3_BUCKET: 'bucket', NEON_S3_PREFIX: 'fleets'}).map(([key, value]) => [key, Buffer.from(value).toString('base64')]))}};
}
test('Fleet plans enforce physical safekeeper zones, durable CSI, KEDA and explicit auth freshness', () => {
  const plan = fleetResources(fleet(), options());
  for (const [index, zone] of ['a', 'b', 'c'].entries()) {
    const row = plan.resources.find(row => row.kind === 'StatefulSet' && row.metadata.name === 'safekeeper-' + (index + 1));
    assert.deepEqual(row.spec.template.spec.affinity.nodeAffinity.requiredDuringSchedulingIgnoredDuringExecution.nodeSelectorTerms[0].matchExpressions[0].values, [zone]);
    assert.equal(row.spec.volumeClaimTemplates[0].spec.storageClassName, 'durable'); assert.equal(row.spec.replicas, undefined);
  }
  assert.equal(plan.config.s3.prefix, 'fleets/enterprise/12345678-1234-1234-1234-123456789abc');
  assert(plan.resources.some(row => row.kind === 'ScaledObject'));
  assert(!plan.resources.some(row => row.kind === 'Job' && row.metadata.name === 'neon-provision'));
  assert(plan.resources.find(row => row.metadata.name === 'neon-proxy' && row.kind === 'Deployment').spec.template.spec.containers[0].args.includes('--project-info-cache'));
  assert(plan.resources.every(row => row.metadata.namespace === 'enterprise'));
});
test('Missing physical zones and attempted storage identity changes fail before provisioning', () => {
  const resource = fleet(), opts = options();
  assert.throws(() => fleetResources(resource, {...opts, nodes: opts.nodes.slice(0, 1)}), /each configured physical zone/);
  const plan = fleetResources(resource, opts); resource.status = {storageIdentity: plan.storageIdentity}; resource.spec.domain = 'different.example';
  assert.throws(() => fleetResources(resource, opts), /explicit migration/);
  resource.spec.replication.zones = ['a', 'a', 'a']; assert.throws(() => validateFleet(resource), /distinct zones/);
});
test('External metadata plans remove the local database and use only the configured Secret DSN', () => {
  const resource = fleet(); resource.spec.storage.metadataDatabaseSecretRef = 'metadata-ha';
  const plan = fleetResources(resource, options());
  assert(!plan.resources.some(row => row.kind === 'StatefulSet' && row.metadata.name === 'metadata'));
  const row = plan.resources.find(row => row.kind === 'Deployment' && row.metadata.name === 'storage-controller');
  const command = row.spec.template.spec.containers[0].command.join(' ');
  assert(command.includes('--database-url "$(cat /run/external-metadata/url)" --public-key='));
  assert(!command.includes('@metadata:5432'));
});
