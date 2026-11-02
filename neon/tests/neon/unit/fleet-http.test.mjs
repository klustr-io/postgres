import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {once} from 'node:events';
import {FleetConfiguration} from '../../../controller/tenant-compute/src/application/fleet/FleetConfiguration.mjs';
import {KubernetesFleetRepository} from '../../../controller/tenant-compute/src/infrastructure/kubernetes/KubernetesFleetRepository.mjs';
import {FleetController} from '../../../controller/tenant-compute/src/api/fleet/FleetController.mjs';
import {FleetRoutes} from '../../../controller/tenant-compute/src/api/fleet/FleetRoutes.mjs';
import {ManagementAuthorization} from '../../../controller/tenant-compute/src/api/identity/ManagementAuthorization.mjs';
import {ControlPlaneRouter} from '../../../controller/tenant-compute/src/api/http/ControlPlaneRouter.mjs';

async function fixture(t) {
  const writes = [], audit = [];
  const spec = {domain: 'db.example', storage: {objectStoreSecretRef: 's3', storageClass: 'durable'},
    identity: {issuer: 'https://identity.example', management: {audience: 'api', roleBindings: [{group: 'admins', role: 'fleet-admin'}]},
      database: {audience: 'pg', requireTenantProjectBinding: true, roleBindings: [{group: 'writers', postgresRole: 'app_writer'}]}},
    replication: {scope: 'availability-zones', mode: 'synchronous-quorum', safekeepers: 3, zones: ['a', 'b', 'c']}};
  const owner = {metadata: {name: 'acme', uid: 'owner', namespace: 'test', resourceVersion: '42', generation: 1}, spec,
    status: {storageIdentity: 'established'}}, fleets = [owner];
  const api = {list: async () => structuredClone(fleets), path: (kind, name) => '/' + kind + '/' + name,
    request: async (method, path, body) => {writes.push({method, path, body}); return {...body, metadata: {...body.metadata, generation: 2}};}};
  const controller = new FleetController({configuration: new FleetConfiguration({repository: new KubernetesFleetRepository({api}), requireLeader() {}})});
  const routes = FleetRoutes(controller);
  let staticAccess = false;
  const authorization = new ManagementAuthorization({configuration: () => spec.identity,
    identity: {management: async request => {
      if (request.headers.authorization !== 'Bearer test-actor') throw Object.assign(Error('denied'), {status: 401});
      return {subject: 'operator-1', issuer: spec.identity.issuer};
    }}, authenticateStatic: () => staticAccess, emit: (event, fact) => audit.push({event, ...fact})});
  const router = new ControlPlaneRouter({routes, management: authorization, authorizeProxy() {throw Error('Unexpected proxy route');},
    requireLeader() {}, stopping: () => false, unavailable() {}});
  const server = http.createServer(router.Handle.bind(router));
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(() => new Promise(resolve => server.close(resolve)));
  const url = 'http://127.0.0.1:' + server.address().port + '/v1/fleet';
  const request = (method, body, authorization = 'Bearer test-actor') => fetch(url, {method,
    headers: {authorization, 'Content-Type': 'application/json'}, ...(body === undefined ? {} : {body: typeof body === 'string' ? body : JSON.stringify(body)})});
  return {spec, owner, fleets, writes, audit, request, allowStatic() {spec.identity.management.allowStaticToken = true; staticAccess = true;}};
}

test('Fleet HTTP route preserves optimistic concurrency and audits accepted OIDC commands', async t => {
  const {spec, fleets, writes, audit, request} = await fixture(t);
  fleets.push({metadata: {name: 'conflict', uid: 'new'}, spec});
  const read = await request('GET'); assert.equal(read.status, 200); assert.equal((await read.json()).name, 'acme');
  const reply = await request('PUT', {...spec, defaults: {size: 'medium'}});
  assert.equal(reply.status, 202); assert.deepEqual(await reply.json(), {name: 'acme', generation: 2});
  assert.equal(writes.length, 1); assert.equal(writes[0].body.metadata.resourceVersion, '42');
  assert.equal(writes[0].body.spec.defaults.size, 'medium');
  const accepted = audit.find(fact => fact.outcome === 'accepted');
  assert.equal(accepted.subject, 'operator-1'); assert.equal(accepted.issuer, spec.identity.issuer);
  assert.equal(accepted.authentication, 'oidc'); assert(accepted.operationId);
});

test('Fleet HTTP rejects invalid, oversized, unauthenticated and retiring updates before persistence', async t => {
  const {spec, owner, writes, request} = await fixture(t);
  for (const [body, status] of [['{', 422], [{...spec, domain: '..'}, 422], [' '.repeat(131073), 413]]) {
    const response = await request('PUT', body); assert.equal(response.status, status); await response.arrayBuffer();
  }
  const denied = await request('PUT', spec, 'Bearer wrong'); assert.equal(denied.status, 401); await denied.arrayBuffer();
  owner.metadata.deletionTimestamp = '2026-01-01T00:00:00Z';
  const retired = await request('PUT', spec); assert.equal(retired.status, 409); assert.equal((await retired.json()).error, 'FLEET_RETIRED');
  assert.equal(writes.length, 0);
});

test('Explicit break-glass authentication records its shared principal and actual result', async t => {
  const {audit, request, allowStatic} = await fixture(t); allowStatic();
  const response = await request('GET', undefined, 'Bearer static'); assert.equal(response.status, 200); await response.json();
  assert.equal(audit.length, 1); assert.equal(audit[0].subject, 'break-glass');
  assert.equal(audit[0].authentication, 'static-token'); assert.equal(audit[0].outcome, 'completed');
  assert(!JSON.stringify(audit).includes('Bearer'));
});
