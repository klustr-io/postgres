import test from 'node:test';
import assert from 'node:assert/strict';
import {generateKeyPairSync, sign} from 'node:crypto';
import {NativeOAuth} from '../../../controller/tenant-compute/src/application/identity/NativeOAuth.mjs';
import {ProxyAccess} from '../../../controller/tenant-compute/src/application/identity/ProxyAccess.mjs';
import {Identity} from '../../../controller/tenant-compute/src/infrastructure/identity/Identity.mjs';
import {ComputeOAuth, OAuthHba} from '../../../controller/tenant-compute/src/domain/identity/ComputeOAuth.mjs';
import {RenderComputeSpec} from '../../../controller/tenant-compute/src/domain/compute/ComputeSpecification.mjs';
import {PostgresLoginRoles} from '../../../controller/tenant-compute/src/infrastructure/postgres/PostgresLoginRoles.mjs';

const key = generateKeyPairSync('rsa', {modulusLength: 2048});
const config = {issuer: 'https://identity.example', jwksUrl: 'https://identity.example/keys',
  management: {audience: 'fleet', roleBindings: [{group: 'admins', role: 'fleet-admin'}]},
  database: {audience: 'postgres', requireTenantProjectBinding: true, oauth: {enabled: true, scope: 'postgres:connect'},
    roleBindings: [{group: 'writers', postgresRole: 'app_runtime'}]}};
const resource = {metadata: {name: 'main', uid: 'database-uid'}, spec: {database: 'app', identity: {tenant: 'acme', project: 'billing'}}};
const endpoint = {name: 'neon-ep-main', uid: 'endpoint-uid', databaseResource: 'main', allowedIps: ['10.0.0.0/8'], projectId: 'billing'};
function token(overrides = {}) {
  const head = Buffer.from(JSON.stringify({alg: 'RS256', kid: 'test'})).toString('base64url');
  const body = Buffer.from(JSON.stringify({iss: config.issuer, aud: 'postgres', sub: 'customer', exp: Math.floor(Date.now()/1000)+300,
    groups: ['writers'], scope: 'postgres:connect', tenant: 'acme', project: 'billing', ...overrides})).toString('base64url');
  return head+'.'+body+'.'+sign('sha256', Buffer.from(head+'.'+body), key.privateKey).toString('base64url');
}
test('Native OAuth cryptographically authorizes resource, scope and role before wake and revalidates PostgreSQL HBA policy', async () => {
  let preparations = 0, peers = 0;
  const events = [], identity = new Identity({configuration: () => config, fetchJSON: async () => ({keys: [
    {...key.publicKey.export({format: 'jwk'}), kid: 'test', alg: 'RS256', use: 'sig'}]})});
  const native = new NativeOAuth({requireDatabase: async () => resource, identity,
    roles: {Ensure: async (name, role, reauthorize) => {await reauthorize(resource); preparations++;}},
    requireComputeIdentity: request => {peers++; if (!request.authorizedPeer) throw Object.assign(Error('peer'), {status: 403});},
    emit: (event, fields) => events.push({event, ...fields})});
  for (const claims of [{scope: ''}, {scope: 'postgres:read'}, {tenant: 'other'}, {project: 'other'}, {aud: 'fleet'}, {exp: 1}, {groups: ['admins']}]) {
    await assert.rejects(native.Authorize(endpoint, {token: token(claims), role: 'app_runtime'}));
  }
  await assert.rejects(native.Authorize(endpoint, {token: token(), role: 'neon_lifecycle'}));
  assert.equal(preparations, 0);
  const bearer = token(), result = await native.Authorize(endpoint, {token: bearer, role: 'app_runtime'});
  assert.equal(preparations, 1); assert.deepEqual(JSON.parse(result.authn_id), {iss: config.issuer, sub: 'customer'});
  const input = {token: bearer, role: 'app_runtime', database: 'app', issuer: config.issuer, scope: 'postgres:connect'};
  await assert.rejects(native.Validate({}, endpoint, input), {status: 403});
  for (const overrides of [{database: 'postgres'}, {issuer: 'https://other.example'}, {scope: 'postgres:read'}]) {
    await assert.rejects(native.Validate({authorizedPeer: true}, endpoint, {...input, ...overrides}), {status: 403});
  }
  assert.equal((await native.Validate({authorizedPeer: true}, endpoint, input)).authorized, true);
  assert.equal(preparations, 1); assert.equal(peers, 5);
  assert(!JSON.stringify(events).includes(bearer));
});

test('Native policy advertises OAUTHBEARER without reading SCRAM secrets and reaches provider-owned HBA and validator settings', async () => {
  const access = new ProxyAccess({identityConfiguration: () => config,
    loadRoleVerifiers: () => {throw Error('native path must not fetch SCRAM');}, oidcVerifier: () => null});
  assert.deepEqual((await access.Get(endpoint, 'app_runtime')).oauth, {issuer: config.issuer, scope: 'postgres:connect'});
  const oauth = ComputeOAuth(config, {name: 'main', database: 'app', namespace: 'enterprise'}), hba = OAuthHba(oauth);
  assert(hba.includes('validator=klustr_oauth delegate_ident_mapping=1'));
  assert(!hba.includes('hostssl all all all scram-sha-256'));
  assert(hba.endsWith('host all all all reject\n'));
  const spec = RenderComputeSpec({mode: 'Primary', tenant_id: 'tenant', timeline_id: 'timeline',
    safekeeper_connstrings: ['sk:5454'], storage_auth_token: 'internal', cluster: {roles: []}}, {profile: 'durable', oauth});
  const settings = Object.fromEntries(spec.cluster.settings.map(row => [row.name, row.value]));
  assert.equal(settings.oauth_validator_libraries, 'klustr_oauth');
  assert.equal(settings.hba_file, '/run/oauth/pg_hba.conf');
  assert.equal(settings['klustr_oauth.validator_url'], 'https://neon-controller.enterprise.svc.cluster.local:8080/v1/databases/main/oauth/validate');
});

test('Native managed LOGIN never alters a customer-owned or privileged role', async () => {
  const statements = [];
  const client = {query: async (sql) => {statements.push(sql); return {rows: [sql.includes('AS marker') ? {marker: 'customer-owned'} :
    sql.includes('AS unsafe') ? {unsafe: false} : {rolname: 'app_runtime', rolcanlogin: false}]};}};
  const roles = new PostgresLoginRoles({client, emit() {}});
  await assert.rejects(roles.PrepareTarget({role: 'app_runtime', managedRole: 'app_runtime', database: 'app', owner: 'app_user', nativeLogin: true}), {status: 403});
  assert(!statements.some(sql => /^(ALTER|GRANT|CREATE)/.test(sql)));
});
