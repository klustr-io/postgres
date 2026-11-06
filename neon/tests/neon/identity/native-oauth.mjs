// Disposable native authentication check. Existing volumes, databases and S3 are untouched.
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {execFileSync, spawn, spawnSync} from 'node:child_process';
import {generateKeyPairSync, randomUUID, sign} from 'node:crypto';
import {once} from 'node:events';
import https from 'node:https';
import assert from 'node:assert/strict';
import pg from '../../../controller/tenant-compute/node_modules/pg/lib/index.js';
import {Identity, GetIdentityJson} from '../../../controller/tenant-compute/src/infrastructure/identity/Identity.mjs';
import {CachedTokenIntrospection} from '../../../controller/tenant-compute/src/infrastructure/identity/CachedTokenIntrospection.mjs';
import {ComputePeerIdentity} from '../../../controller/tenant-compute/src/infrastructure/identity/ComputePeerIdentity.mjs';
import {PostgresLoginRoles} from '../../../controller/tenant-compute/src/infrastructure/postgres/PostgresLoginRoles.mjs';
import {NativeOAuth} from '../../../controller/tenant-compute/src/application/identity/NativeOAuth.mjs';
import {NativeRolePreparation} from '../../../controller/tenant-compute/src/application/identity/NativeRolePreparation.mjs';
import {ProxyAccess} from '../../../controller/tenant-compute/src/application/identity/ProxyAccess.mjs';
import {NativeOAuthController, NativeOAuthRoutes} from '../../../controller/tenant-compute/src/api/identity/NativeOAuthController.mjs';
import {ControlPlaneRouter} from '../../../controller/tenant-compute/src/api/http/ControlPlaneRouter.mjs';
import {HttpServersInit} from '../../../controller/tenant-compute/src/composition/HttpServersInit.mjs';
import {TokenFileAuthorization} from '../../../controller/tenant-compute/src/infrastructure/identity/TokenFileAuthorization.mjs';
import {OAuthHba} from '../../../controller/tenant-compute/src/domain/identity/ComputeOAuth.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..'); process.chdir(root);
const artifact = process.env.NEON_OAUTH_ARTIFACT_IMAGE || 'klustr-neon-artifacts:oauth-local';
const id = 'neon-oauth-' + randomUUID(), containers = [], facts = [];
const directory = path.join(root, 'build', id); fs.mkdirSync(directory, {recursive: true, mode: 0o700});
const fixture = fs.realpathSync(directory), file = name => path.join(fixture, name);
const write = (name, value) => fs.writeFileSync(file(name), value, {mode: name.endsWith('.conf') ? 0o644 : 0o600});
const docker = args => execFileSync('docker', args, {encoding: 'utf8', maxBuffer: 4*1024*1024});
const containerLogs = name => {const output = spawnSync('docker', ['logs', name], {encoding: 'utf8'}); return output.stdout+output.stderr;};
const mount = ['--mount', `type=bind,source=${fixture},target=/fixture,readonly`];
const hostGateway = process.platform === 'win32' ? [] : ['--add-host', 'host.docker.internal:host-gateway'];
const computeHost = 'neon-ep-native.neon-test.svc.cluster.local', proxyHost = 'ep-native.db.oauth.test';
const keys = generateKeyPairSync('rsa', {modulusLength: 2048});
const resource = {metadata: {name: 'main', uid: 'native-db'}, spec: {database: 'app', user: 'app_owner', identity: {tenant: 'acme', project: 'billing'}}};
const endpoint = {name: 'neon-ep-native', endpointId: 'ep-native', uid: 'native-endpoint', databaseResource: 'main', projectId: 'billing', allowedIps: ['0.0.0.0/0']};
const emit = (event, fields) => facts.push({event, ...fields});
let server, health, config, adminPort, wakes = 0, unavailable = false, networkCreated = false;
let opaqueActive = true, introspectionUnavailable = false, providerSecret = 'test-only:secret+value';
const opaqueToken = 'opaque-native-token_123~+/=', managementToken = 'opaque-management-token_123';
async function introspectRequest(request, response) {
  if (introspectionUnavailable) {response.writeHead(503); response.end(); return;}
  assert.equal(request.method, 'POST');
  assert.equal(request.headers['content-type'], 'application/x-www-form-urlencoded');
  const chunks = []; for await (const chunk of request) chunks.push(chunk);
  const body = new URLSearchParams(Buffer.concat(chunks).toString());
  const form = value => new URLSearchParams({value}).toString().slice(6);
  const basic = 'Basic '+Buffer.from(form('resource-server')+':'+form(providerSecret)).toString('base64');
  if (config.database.tokenValidation?.authMethod === 'client_secret_post') assert.equal(request.headers.authorization, undefined);
  else assert.equal(request.headers.authorization, basic);
  if (request.headers.authorization !== basic && !(body.get('client_id') === 'resource-server' && body.get('client_secret') === providerSecret)) {
    response.writeHead(401); response.end(); return;
  }
  assert.equal(body.get('token_type_hint'), 'access_token');
  const management = body.get('token') === managementToken;
  const active = opaqueActive && (management || body.get('token') === opaqueToken);
  response.setHeader('Content-Type', 'application/json');
  response.end(JSON.stringify(active ? {active: true, aud: management ? 'fleet' : 'postgres', sub: 'opaque-customer',
    exp: Math.floor(Date.now()/1000)+120, groups: management ? ['admins'] : ['writers'], tenant: 'acme', project: 'billing', scope: 'postgres:connect'} : {active: false}));
}
async function connect() {
  const client = new pg.Client({host: '127.0.0.1', port: adminPort, database: 'app', user: 'neon_lifecycle', password: 'disposable-admin-only',
    ssl: {ca: fs.readFileSync(file('ca.crt')), servername: computeHost, rejectUnauthorized: true}, connectionTimeoutMillis: 3000});
  await client.connect(); return client;
}
function token(overrides = {}) {
  const head = Buffer.from(JSON.stringify({alg: 'RS256', kid: 'native'})).toString('base64url');
  const body = Buffer.from(JSON.stringify({iss: config.issuer, aud: 'postgres', sub: 'customer', exp: Math.floor(Date.now()/1000)+120,
    groups: ['writers'], tenant: 'acme', project: 'billing', scope: 'postgres:connect', padding: 'x'.repeat(768), ...overrides})).toString('base64url');
  return head+'.'+body+'.'+sign('sha256', Buffer.from(head+'.'+body), keys.privateKey).toString('base64url');
}
async function runClient(host, expected = true) {
  const child = spawn('docker', ['run', '--rm', '--network', id, ...mount, '--entrypoint', '/tmp/oauth-client',
    '-e', 'PGHOST='+host, '-e', 'PGPORT=5432', '-e', 'PGUSER=app_runtime', '-e', 'PGDATABASE=app', '-e', 'PGSSLMODE=verify-full',
    '-e', 'PGSSLROOTCERT=/fixture/ca.crt', '-e', 'PGCONNECT_TIMEOUT=10', '-e', 'OAUTH_ISSUER='+config.issuer,
    '--mount', `type=bind,source=${file('oauth-client')},target=/tmp/oauth-client,readonly`, artifact], {stdio: ['ignore', 'pipe', 'pipe']});
  let output = ''; for (const stream of [child.stdout, child.stderr]) stream.on('data', bytes => {output += bytes;});
  const [status] = await once(child, 'exit'); assert.equal(status === 0, expected, output);
}
try {
  docker(['network', 'create', id]);
  networkCreated = true;
  const cert = (name, dns, usage) => [
    `openssl req -new -newkey rsa:2048 -nodes -keyout ${name}.key -out ${name}.csr -subj /CN=OAuth-smoke 2>/dev/null`,
    `printf 'subjectAltName=DNS:${dns}\\nextendedKeyUsage=${usage}\\nbasicConstraints=CA:FALSE\\n' > ${name}.ext`,
    `openssl x509 -req -in ${name}.csr -CA ca.crt -CAkey ca.key -CAcreateserial -out ${name}.crt -days 1 -extfile ${name}.ext 2>/dev/null`
  ].join('\n');
  write('certificates.sh', ['set -eu', 'cd /fixture',
    'openssl req -x509 -newkey rsa:2048 -nodes -days 1 -keyout ca.key -out ca.crt -subj /CN=OAuth-smoke-CA -addext basicConstraints=critical,CA:TRUE -addext keyUsage=critical,keyCertSign,cRLSign 2>/dev/null',
    cert('server', 'host.docker.internal,DNS:localhost,IP:127.0.0.1', 'serverAuth'), cert('backend', computeHost, 'serverAuth'), cert('client', computeHost, 'clientAuth'),
    cert('imposter', 'other.neon-test.svc.cluster.local', 'clientAuth'), cert('proxy', '*.db.oauth.test', 'serverAuth'),
    `chown -R ${process.getuid?.() ?? 0}:10002 /fixture`, 'chmod 750 /fixture', 'chmod 640 /fixture/*'].join('\n'));
  docker(['run', '--rm', '--network', 'none', '--mount', `type=bind,source=${fixture},target=/fixture`, '--entrypoint', '/bin/sh', artifact, '/fixture/certificates.sh']);
  write('token', ''); write('controller-token', 'test-only-proxy-authority-long-enough');
  const authority = new TokenFileAuthorization({file: file('controller-token')}), peer = new ComputePeerIdentity('neon-test');
  let cacheElapsed = 0;
  const introspectionCache = new CachedTokenIntrospection({elapsed: () => cacheElapsed,
    readSecret: () => fs.readFileSync(file('introspection-secret'), 'utf8'), caForConfig: () => file('ca.crt')});
  const identity = new Identity({configuration: () => config, fetchJSON: url => GetIdentityJson(url, file('ca.crt')),
    introspect: introspectionCache.Resolve.bind(introspectionCache)});
  const roles = new NativeRolePreparation({requireDatabase: async () => resource, beginConnection: () => () => {}, recordEvent: async () => {},
    ensureStorageActive: async () => {}, findEndpoint: () => endpoint, requireLeader() {}, rolesForClient: client => new PostgresLoginRoles({client, emit}),
    lifecycle: {wake: async () => {wakes++;}, serialized: async (_, action) => action(), pods: async () => [{}], ready: () => true, admin: connect}});
  const native = new NativeOAuth({identity, roles, requireDatabase: async () => resource, requireComputeIdentity: peer.Require.bind(peer), emit});
  const access = new ProxyAccess({identityConfiguration: () => config, loadRoleVerifiers: async () => ({}), oidcVerifier: async () => null});
  const send = (response, value) => {response.setHeader('Content-Type', 'application/json'); response.end(JSON.stringify(value));};
  const routes = [...NativeOAuthRoutes(new NativeOAuthController(native, name => ['main', 'ep-native'].includes(name) ? endpoint : undefined)),
    {pattern: /^\/get_endpoint_access_control$/, query: true, authentication: 'proxy', methods: {GET: async (request, response) => {
      send(response, await access.Get(endpoint, new URL(request.url, 'https://test').searchParams.get('role')));
    }}}, {pattern: /^\/wake_compute$/, query: true, authentication: 'proxy', methods: {GET: async (_, response) => {
      send(response, {address: computeHost+':5432', server_name: computeHost,
        aux: {endpoint_id: 'ep-native', project_id: 'billing', branch_id: 'main', compute_id: 'native-smoke', cold_start_info: 'unknown'}});
    }}}];
  const router = new ControlPlaneRouter({routes, authorizeProxy: authority.Require.bind(authority), management: null, requireLeader() {}, stopping: () => false, unavailable() {}});
  ({server, health} = HttpServersInit({tls: {keyFile: file('server.key'), certFile: file('server.crt'), caFile: file('ca.crt')},
    handleHealth: async (_, response) => response.end(), handleController: async (request, response) => {
      if (request.url === '/keys') send(response, {keys: [{...keys.publicKey.export({format: 'jwk'}), kid: 'native', alg: 'RS256', use: 'sig'}]});
      else if (request.url === '/introspect') await introspectRequest(request, response);
      else if (unavailable && request.url.endsWith('/oauth/validate')) {response.writeHead(503); response.end();}
      else await router.Handle(request, response);
    }}));
  server.listen(0, '0.0.0.0'); await once(server, 'listening');
  const base = 'https://host.docker.internal:'+server.address().port;
  config = {issuer: base+'/issuer', jwksUrl: 'https://127.0.0.1:'+server.address().port+'/keys', management: {audience: 'fleet', roleBindings: [{group: 'admins', role: 'fleet-admin'}]},
    database: {audience: 'postgres', requireTenantProjectBinding: true, oauth: {enabled: true, scope: 'postgres:connect'}, roleBindings: [{group: 'writers', postgresRole: 'app_runtime'}]}};
  write('pg_hba.conf', OAuthHba({issuer: config.issuer, scope: 'postgres:connect', roles: ['app_runtime'], database: 'app', allowPasswordAuth: false}));
  write('postgresql.conf', ["listen_addresses='*'", 'ssl=on', "ssl_cert_file='/var/lib/oauth/backend.crt'", "ssl_key_file='/var/lib/oauth/backend.key'",
    "hba_file='/fixture/pg_hba.conf'", "oauth_validator_libraries='klustr_oauth'", `klustr_oauth.validator_url='${base}/v1/databases/main/oauth/validate'`,
    "klustr_oauth.ca_file='/fixture/ca.crt'", "klustr_oauth.cert_file='/fixture/client.crt'", "klustr_oauth.key_file='/fixture/client.key'", "log_connections='authorization'", ''].join('\n'));
  const backend = id+'-postgres'; containers.push(backend);
  docker(['run', '-d', '--name', backend, '--network', id, '--network-alias', computeHost, '-p', '127.0.0.1::5432', ...mount, ...hostGateway,
    '--tmpfs', '/var/lib/oauth:rw,uid=10002,gid=10002,mode=0700', '--user', '10002:10002', '--entrypoint', '/bin/sh', artifact, '-ec',
    '/opt/postgres/v18/bin/initdb -D /var/lib/oauth/data -U neon_lifecycle --auth-local=trust --auth-host=reject >/dev/null; cp /fixture/backend.crt /fixture/backend.key /var/lib/oauth/; chmod 600 /var/lib/oauth/backend.key; cat /fixture/postgresql.conf >> /var/lib/oauth/data/postgresql.conf; exec /opt/postgres/v18/bin/postgres -D /var/lib/oauth/data']);
  adminPort = Number(docker(['port', backend, '5432/tcp']).trim().split(':').at(-1));
  for (let attempt=0;;attempt++) {
    try {docker(['exec', backend, '/opt/postgres/v18/bin/pg_isready', '-U', 'neon_lifecycle', '-d', 'postgres']); break;}
    catch (error) {if (attempt >= 30) throw error; await new Promise(resolve => setTimeout(resolve, 250));}
  }
  const sql = statement => docker(['exec', backend, '/opt/postgres/v18/bin/psql', '-U', 'neon_lifecycle', '-d', 'postgres', '-v', 'ON_ERROR_STOP=1', '-c', statement]);
  sql("ALTER ROLE neon_lifecycle PASSWORD 'disposable-admin-only'; CREATE ROLE app_owner NOLOGIN;"); sql('CREATE DATABASE app OWNER app_owner');
  docker(['run', '--rm', '--network', 'none', '--mount', `type=bind,source=${fixture},target=/fixture`,
    '--mount', `type=bind,source=${path.join(root, 'neon/tests/neon/identity/OAuthClient.c')},target=/client.c,readonly`, '--entrypoint', '/bin/sh', artifact, '-ec',
    'gcc /client.c -I/opt/postgres/v18/include -L/opt/postgres/v18/lib -Wl,-rpath,/opt/postgres/v18/lib -lpq -o /fixture/oauth-client']);
  const proxy = id+'-proxy'; containers.push(proxy);
  docker(['run', '-d', '--name', proxy, '--network', id, '--network-alias', proxyHost, ...mount, ...hostGateway,
    '-e', 'SSL_CERT_FILE=/fixture/ca.crt', '-e', 'NEON_INTERNAL_CA_FILE=/fixture/ca.crt', '-e', 'NEON_PROXY_TO_CONTROLPLANE_TOKEN=test-only-proxy-authority-long-enough',
    '-e', 'OTEL_SDK_DISABLED=true', '--entrypoint', '/out/bin/proxy', artifact, '--proxy', '0.0.0.0:5432', '--http', '0.0.0.0:7001',
    '--auth-backend', 'control-plane', '--auth-endpoint', base+'/', '--tls-key', '/fixture/proxy.key', '--tls-cert', '/fixture/proxy.crt',
    '--wake-compute-cache', 'size=0', '--project-info-cache', 'size=0,max_roles=10,gc_interval=60s']);
  await new Promise(resolve => setTimeout(resolve, 750));
  const valid = token(); write('token', valid); await runClient(proxyHost); await runClient(computeHost); assert(wakes > 0);
  const before = wakes;
  for (const claims of [{aud: 'fleet'}, {tenant: 'other'}, {scope: 'postgres:read'}, {exp: 1}, {groups: ['admins']}]) {
    write('token', token(claims)); await runClient(proxyHost, false);
  }
  assert.equal(wakes, before, 'rejected tokens must not wake compute');
  write('token', valid.slice(0, -16)+'A'.repeat(16)); await runClient(proxyHost, false);
  assert.equal(wakes, before, 'forged tokens must not wake compute');
  write('token', token({scope: 'postgres:read'})); await runClient(computeHost, false);
  unavailable = true; write('token', valid); await runClient(computeHost, false); unavailable = false;
  const status = await new Promise((resolve, reject) => {
    const request = https.request({host: '127.0.0.1', port: server.address().port, servername: 'host.docker.internal',
      path: '/v1/databases/main/oauth/validate', method: 'POST', ca: fs.readFileSync(file('ca.crt')),
      cert: fs.readFileSync(file('imposter.crt')), key: fs.readFileSync(file('imposter.key'))}, response => {response.resume(); resolve(response.statusCode);});
    request.on('error', reject); request.end(JSON.stringify({token: valid, role: 'app_runtime', database: 'app', issuer: config.issuer, scope: 'postgres:connect'}));
  });
  assert.equal(status, 403);
  const introspection = {mode: 'introspection', endpoint: 'https://127.0.0.1:'+server.address().port+'/introspect',
    clientId: 'resource-server', clientSecretRef: 'test-only-introspection'};
  config.database.tokenValidation = introspection; config.management.tokenValidation = introspection;
  write('introspection-secret', providerSecret); write('token', opaqueToken);
  await runClient(proxyHost); await runClient(computeHost);
  assert.equal((await identity.management({method: 'GET', url: '/v1/fleet', headers: {authorization: 'Bearer '+managementToken}})).subject, 'opaque-customer');
  const beforeRevocation = wakes; opaqueActive = false;
  await runClient(computeHost); // Revocation is deliberately bounded by the positive-result cache lifetime.
  cacheElapsed += 30000;
  await runClient(proxyHost, false); await runClient(computeHost, false);
  assert.equal(wakes, beforeRevocation, 'revoked opaque tokens must not wake compute'); opaqueActive = true;
  introspectionUnavailable = true; await runClient(proxyHost, false); await runClient(computeHost, false); introspectionUnavailable = false;
  // Explicit introspection never falls back to local JWT validation.
  write('token', valid); await runClient(proxyHost, false); write('token', opaqueToken);
  introspection.authMethod = 'client_secret_post'; await runClient(proxyHost);
  providerSecret = 'rotated-test-only-credential'; write('introspection-secret', providerSecret); await runClient(proxyHost);
  // The proxy must reject a backend which silently downgrades OAuth to trust.
  write('pg_hba.conf', OAuthHba({issuer: config.issuer, scope: 'postgres:connect', roles: ['app_runtime'], database: 'app', allowPasswordAuth: false})
    .replace(/^hostssl app app_runtime .*$/m, 'hostssl app app_runtime all trust'));
  sql('SELECT pg_reload_conf()'); await new Promise(resolve => setTimeout(resolve, 150));
  await runClient(proxyHost, false);
  for (const name of containers) for (const secret of [valid, opaqueToken, providerSecret]) assert(!containerLogs(name).includes(secret), 'credential leaked to container logs');
  for (const secret of [valid, opaqueToken, providerSecret]) assert(!JSON.stringify(facts).includes(secret));
  const result = JSON.stringify({passed: true, image: artifact, imageId: docker(['image', 'inspect', '--format', '{{.Id}}', artifact]).trim(),
    nativeProxyAndDirectLogin: true, jsonbReadWrite: true, invalidTokensRejectedBeforeWake: true,
    validatorOutageDenied: true, crossEndpointCertificateDenied: true, backendDowngradeDenied: true,
    opaqueIntrospection: true, managementIntrospection: true, opaqueRevocationAndOutageDenied: true, introspectionSecretRotation: true}, null, 2);
  write('result.json', result);
  if (process.env.NEON_OAUTH_REPORT_FILE) fs.writeFileSync(process.env.NEON_OAUTH_REPORT_FILE, result+'\n');
  console.log('PASS: native libpq discovery, proxy/backend OAUTHBEARER, JWT and opaque introspection, JSONB SQL, revocation/outages and mTLS');
} catch (error) {
  for (const name of containers) {
    try {write(name+'.log', containerLogs(name).replace(/[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}/g, '[REDACTED JWT]'));} catch {}
  }
  throw error;
} finally {
  if (server) {server.closeAllConnections(); await new Promise(resolve => server.close(resolve));} health?.close();
  for (const name of containers.reverse()) docker(['rm', '-f', name]);
  if (networkCreated) docker(['network', 'rm', id]);
  for (const name of fs.readdirSync(fixture)) if (name !== 'result.json' && !name.endsWith('.log')) fs.unlinkSync(file(name));
}
