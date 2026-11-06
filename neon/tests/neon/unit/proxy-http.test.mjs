import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {once} from 'node:events';
import {ProxyAccess} from '../../../controller/tenant-compute/src/application/identity/ProxyAccess.mjs';
import {WakeCompute} from '../../../controller/tenant-compute/src/application/compute/WakeCompute.mjs';
import {ProxyController} from '../../../controller/tenant-compute/src/api/proxy/ProxyController.mjs';
import {ProxyRoutes} from '../../../controller/tenant-compute/src/api/proxy/ProxyRoutes.mjs';
import {ControlPlaneRouter} from '../../../controller/tenant-compute/src/api/http/ControlPlaneRouter.mjs';
import {TokenFileAuthorization} from '../../../controller/tenant-compute/src/infrastructure/identity/TokenFileAuthorization.mjs';

async function fixture(t) {
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'neon-proxy-auth-')), file = path.join(folder, 'token');
  fs.writeFileSync(file, 'test-only-controller-token-long-enough');
  t.after(() => {fs.unlinkSync(file); fs.rmdirSync(folder);});
  const order = [], endpoint = {endpointId: 'ep-main', databaseResource: 'main', projectId: 'acme', allowedIps: ['10.0.0.0/8']};
  const verifier = 'SCRAM-SHA-256$4096:placeholder$placeholder:placeholder';
  const access = new ProxyAccess({identityConfiguration: () => null, loadRoleVerifiers: async () => ({app_user: verifier}), oidcVerifier: async () => null});
  let retired = false;
  const wake = new WakeCompute({beginConnection: () => {order.push('reserve'); return () => order.push('release');},
    recordEvent: async () => {if (retired) throw Object.assign(Error('retired'), {code: 'FLEET_RETIRED'}); order.push('activity');},
    ensureStorageActive: async () => {order.push('storage');}, wake: async () => {order.push('compute'); return {address: 'compute:5432'};},
    requireLeader() {}, ready: () => {order.push('ready');}});
  const authorization = new TokenFileAuthorization({file});
  const router = new ControlPlaneRouter({routes: ProxyRoutes(new ProxyController({findEndpoint: id => id === 'ep-main' ? endpoint : undefined, access, wake})),
    management: null, authorizeProxy: authorization.Require.bind(authorization), requireLeader() {}, stopping: () => false, unavailable() {}});
  const server = http.createServer(router.Handle.bind(router)); server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(() => new Promise(resolve => server.close(resolve)));
  const request = (route, options = {}) => fetch('http://127.0.0.1:' + server.address().port + route,
    {headers: {authorization: 'Bearer test-only-controller-token-long-enough'}, ...options});
  return {request, order, verifier, file, retire() {retired = true;}};
}

test('Proxy authentication and role lookup precede wake; retired fleets publish no wake demand', async t => {
  const {request, order, verifier, retire} = await fixture(t);
  let response = await request('/wake_compute?endpointish=ep-main', {headers: {authorization: 'Bearer wrong'}});
  assert.equal(response.status, 401); await response.json(); assert.deepEqual(order, []);
  response = await request('/get_endpoint_access_control?endpointish=ep-main&role=app_user');
  assert.equal(response.status, 200); assert.equal((await response.json()).role_secret, verifier); assert.deepEqual(order, []);
  response = await request('/wake_compute?endpointish=ep-main-pooler'); assert.equal(response.status, 200); await response.json();
  assert.deepEqual(order, ['activity', 'reserve', 'storage', 'compute', 'ready', 'release']);
  order.length = 0; retire();
  response = await request('/wake_compute?endpointish=ep-main'); assert.equal(response.status, 409); await response.json();
  assert.deepEqual(order, []);
});

test('Projected proxy token rotation is immediate and body-bearing wake requests are rejected', async t => {
  const {request, file, order} = await fixture(t);
  fs.writeFileSync(file, 'rotated-controller-token-long-enough');
  let response = await request('/wake_compute?endpointish=ep-main'); assert.equal(response.status, 401); await response.json();
  response = await request('/wake_compute?endpointish=ep-main', {headers: {authorization: 'Bearer rotated-controller-token-long-enough'}});
  assert.equal(response.status, 200); await response.json(); order.length = 0;
  response = await request('/wake_compute?endpointish=ep-main', {method: 'POST', body: '{}'});
  assert.equal(response.status, 405); await response.json(); assert.deepEqual(order, []);
});
