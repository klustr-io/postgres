import test from 'node:test';
import assert from 'node:assert/strict';
import {generateKeyPairSync, sign} from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {Identity} from '../../../controller/tenant-compute/src/infrastructure/identity/Identity.mjs';
import {DatabaseCredentials} from '../../../controller/tenant-compute/src/application/identity/DatabaseCredentials.mjs';
import {PostgresLoginRoles} from '../../../controller/tenant-compute/src/infrastructure/postgres/PostgresLoginRoles.mjs';
import {FleetResources as fleetResources} from '../../../controller/tenant-compute/src/infrastructure/provisioning/FleetResources.mjs';
import {ValidateFleet} from '../../../controller/tenant-compute/src/domain/fleet/FleetSpecification.mjs';
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
  const broker = new DatabaseCredentials({requireDatabase: async () => ({}), beginConnection: () => {wakes++;},
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

test('Fleet loss-tolerant opt-in preserves physical storage identity and synchronous safekeeper flushing', () => {
  const resource = fleet(), opts = options(), strict = fleetResources(resource,opts);
  resource.status = {storageIdentity:strict.storageIdentity};
  resource.spec.allowAsyncCommits = true;
  const permissive = fleetResources(resource,opts);
  assert.equal(permissive.config.allowAsyncCommits,true);
  assert.equal(permissive.storageIdentity,strict.storageIdentity);
  const safekeepers = permissive.resources.filter(row=>row.kind==='StatefulSet'&&row.metadata.name.startsWith('safekeeper-'));
  assert.equal(safekeepers.length,3);
  assert(safekeepers.every(row=>!JSON.stringify(row.spec.template.spec.containers).includes('--no-sync')));
  resource.spec.allowAsyncCommits = 'true';
  assert.throws(()=>ValidateFleet(resource),/must be boolean/);
});
test('Missing physical zones and attempted storage identity changes fail before provisioning', () => {
  const resource = fleet(), opts = options();
  assert.throws(() => fleetResources(resource, {...opts, nodes: opts.nodes.slice(0, 1)}), /each configured physical zone/);
  const plan = fleetResources(resource, opts); resource.status = {storageIdentity: plan.storageIdentity}; resource.spec.domain = 'different.example';
  assert.throws(() => fleetResources(resource, opts), /explicit migration/);
  resource.spec.replication.zones = ['a', 'a', 'a']; assert.throws(() => ValidateFleet(resource), /distinct zones/);
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

test('Fleet introspection projects separate management and database Secret credentials into the controller', () => {
  const resource = fleet(); resource.spec.identity = structuredClone(config);
  for (const kind of ['management', 'database']) resource.spec.identity[kind].tokenValidation = {
    mode: 'introspection', endpoint: 'https://identity.example/introspect', clientId: kind+'-resource', clientSecretRef: kind+'-introspection', clientSecretKey: 'credential'};
  const plan = fleetResources(resource, options()), pod = plan.resources.find(row => row.kind === 'Deployment' && row.metadata.name === 'neon-tenant-controller').spec.template.spec;
  for (const kind of ['management', 'database']) {
    const volume = pod.volumes.find(row => row.name === 'oidc-introspection-'+kind);
    assert.equal(volume.secret.secretName, kind+'-introspection'); assert.equal(volume.secret.defaultMode, 288);
    assert.deepEqual(volume.secret.items, [{key: 'credential', path: 'client-secret'}]);
    assert(pod.containers[0].volumeMounts.some(row => row.name === volume.name && row.mountPath === '/run/oidc-introspection/'+kind && row.readOnly));
  }
});

test('Fleet and cluster boundaries reject malformed DNS domains before provisioning', () => {
  for (const domain of ['..', '.db.example', 'db..example', 'db.example.', '-db.example', 'db-.example', 'a'.repeat(64) + '.example', 'https://db.example']) {
    const resource = fleet(); resource.spec.domain = domain;
    assert.throws(() => fleetResources(resource, options()), /identity\/domain/);
  }
});

test('Fleet runtime consumes the packaged compute image and rejects inconsistent release inputs', t => {
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'neon-release-contract-'));
  t.after(() => {
    assert(path.dirname(folder) === os.tmpdir() && path.basename(folder).startsWith('neon-release-contract-'));
    fs.rmSync(folder, {recursive: true});
  });
  const bundle = path.join(folder, 'fleet-stack.json');
  const stack = JSON.parse(fs.readFileSync(path.join(options().templates, 'fleet-stack.json'), 'utf8'));
  const previous = fleetResources(fleet(), options()).config.computeImage;
  const next = 'ghcr.io/klustr-io/neon-compute@sha256:' + 'b'.repeat(64);
  const cluster = stack.resources.find(row => row.kind === 'ConfigMap' && row.metadata.name === 'neon-cluster');
  cluster.data['cluster.yaml'] = cluster.data['cluster.yaml'].replaceAll(previous, next);
  fs.writeFileSync(bundle, JSON.stringify(stack));
  assert.throws(() => fleetResources(fleet(), {...options(), templates: folder}), /images disagree/);
  const metadata = stack.resources.find(row => row.kind === 'StatefulSet' && row.metadata.name === 'metadata');
  metadata.spec.template.spec.containers[0].image = next;
  fs.writeFileSync(bundle, JSON.stringify(stack));
  assert.equal(fleetResources(fleet(), {...options(), templates: folder}).config.computeImage, next);
});

test('OIDC credential issuance preserves issuer/subject and SQL login correlation without logging secrets', async () => {
  const db = {metadata: {name: 'main', uid: 'db-uid'}, spec: {identity: {tenant: 'acme', project: 'billing'}}};
  const endpoint = {databaseResource: 'main', uid: 'endpoint-uid', endpointId: 'ep-main'};
  const actor = {issuer: config.issuer, subject: 'customer-actor', expires: Math.floor(Date.now() / 1000) + 300, config};
  let secret, event;
  const client = {query: async sql => ({rows: [sql.includes('AS unsafe') ? {unsafe: false} : {rolname: 'app_writer'}]}), end: async () => {}};
  const broker = new DatabaseCredentials({
    api: {get: async () => db, list: async () => [], create: async (_, value) => {secret = value;}}, leader: {require() {}},
    requireDatabase: async () => db, beginConnection: () => () => {}, recordEvent: async () => {}, connectionPolicy: () => ({domain: 'db.example'}),
    ensureStorageActive: async () => {}, rolesForClient: client => new PostgresLoginRoles({client, emit() {}}),
    identity: {authenticate: async () => actor, database: async () => actor},
    lifecycle: {wake: async () => {}, serialized: async (_, run) => run(), pods: async () => [{}], ready: () => true, admin: async () => client},
    getEndpoints: () => new Map([['main', endpoint]]), emit: (name, fields) => {event = {name, ...fields};}
  });
  const login = await broker.exchange({}, 'main', {role: 'app_writer'}), stored = JSON.parse(secret.stringData.login);
  assert.equal(stored.issuer, config.issuer); assert.equal(stored.subject, actor.subject);
  assert.equal(stored.user, login.user); assert.equal(event.user, login.user);
  assert.equal(event.credentialId, stored.credentialId); assert.equal(event.issuer, stored.issuer);
  assert.equal(event.databaseUID, db.metadata.uid);
  assert(!JSON.stringify(event).includes(login.password)); assert(!JSON.stringify(event).includes(stored.verifier));
});

test('Fleet settings accept explicit native OAuth and reject malformed database scopes', () => {
  const resource = fleet();
  resource.spec.identity = structuredClone(config);
  resource.spec.identity.database.oauth = {enabled: true, scope: 'postgres:connect', scopeClaim: 'scope'};
  const plan = fleetResources(resource, options());
  assert.equal(plan.config.identity.database.oauth.enabled, true);
  assert.equal(plan.config.identity.database.oauth.scope, 'postgres:connect');
  resource.spec.identity.database.oauth.scope = 'postgres:connect\ninvalid';
  assert.throws(() => ValidateFleet(resource), /OAuth scope/);
});
