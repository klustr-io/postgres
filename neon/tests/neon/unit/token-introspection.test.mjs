import test from 'node:test';
import assert from 'node:assert/strict';
import {Identity} from '../../../controller/tenant-compute/src/infrastructure/identity/Identity.mjs';
import {IdentityConfiguration} from '../../../controller/tenant-compute/src/domain/identity/IdentityPolicy.mjs';
import {TokenValidationPolicy} from '../../../controller/tenant-compute/src/domain/identity/TokenValidationPolicy.mjs';
import {CachedTokenIntrospection} from '../../../controller/tenant-compute/src/infrastructure/identity/CachedTokenIntrospection.mjs';
const policy = {mode: 'introspection', endpoint: 'https://identity.example/introspect', clientId: 'resource-server', clientSecretRef: 'idp-resource-server'};
const config = {issuer: 'https://identity.example', management: {audience: 'fleet', tokenValidation: policy,
  roleBindings: [{group: 'admins', role: 'fleet-admin'}]}, database: {audience: 'postgres', tokenValidation: policy,
  requireTenantProjectBinding: true, roleBindings: [{group: 'writers', postgresRole: 'app_runtime'}]}};
const claims = {active: true, sub: 'customer', exp: Math.floor(Date.now()/1000)+120, aud: 'postgres',
  groups: ['writers'], tenant: 'acme', project: 'billing', scope: 'postgres:connect'};
const request = {headers: {authorization: 'Bearer opaque-token_123+/='}, method: 'GET', url: '/v1/fleet'};
test('Explicit introspection accepts opaque tokens for database and management without JWT decoding or fallback', async () => {
  let response = claims, calls = 0;
  const identity = new Identity({configuration: () => config, fetchJSON: () => {throw Error('JWT key lookup must not run');},
    introspect: async token => {calls++; assert.equal(token, 'opaque-token_123+/='); return response;}});
  const resource = {spec: {identity: {tenant: 'acme', project: 'billing'}}};
  const actor = await identity.database(request, resource, 'app_runtime');
  assert.equal(actor.subject, 'customer'); assert.equal(actor.issuer, config.issuer);
  for (const invalid of [{active: false}, {active: 'true'}, {aud: 'fleet'}, {exp: undefined}, {sub: undefined},
    {iss: 'https://other.example'}, {exp: 1}, {nbf: Math.floor(Date.now()/1000)+300}, {token_type: 'refresh_token'}, {tenant: 'other'}]) {
    response = {...claims, ...invalid}; await assert.rejects(identity.database(request, resource, 'app_runtime'));
  }
  response = {...claims, aud: 'fleet', groups: ['admins']};
  assert.equal((await identity.management(request)).subject, 'customer');
  assert.equal(calls, 12);
});
test('Introspection settings require a fixed HTTPS endpoint and Secret reference rather than inline credentials', () => {
  assert.equal(IdentityConfiguration(config).database.tokenValidation.mode, 'introspection');
  for (const invalid of [{endpoint: 'http://identity.example/introspect'}, {clientSecretRef: undefined},
    {clientSecret: 'never-inline'}, {authMethod: 'none'}, {mode: 'auto'}, {endpoint: 'https://user:secret@identity.example/introspect'},
    {cacheSeconds: -1}, {cacheSeconds: 61}, {cacheSeconds: 1.5}, {cacheSeconds: '30'}]) {
    assert.throws(() => IdentityConfiguration({...config, database: {...config.database, tokenValidation: {...policy, ...invalid}}}));
  }
  assert.equal(TokenValidationPolicy(policy).cacheSeconds,30);
  for(const cacheSeconds of [0,30,60])assert.equal(TokenValidationPolicy({...policy,cacheSeconds}).cacheSeconds,cacheSeconds);
});

function cachedFixture(cacheSeconds=30) {
  const configuration=structuredClone(config);configuration.database.tokenValidation.cacheSeconds=cacheSeconds;
  let now=1_800_000_000_000,elapsed=0,calls=0,secret='credential-one',response={...claims,exp:1_800_000_120};
  const provider=new CachedTokenIntrospection({clock:()=>now,elapsed:()=>elapsed,readSecret:()=>secret,request:async(token,policy,kind,dependencies)=>{
    calls++;assert.equal(dependencies.readSecret(kind),secret);
    if(response instanceof Error)throw response;
    return {...response,aud:policy[kind].audience};
  }});
  return {configuration,provider,resolve:()=>provider.Resolve('opaque-cache-token',configuration,'database'),
    calls:()=>calls,advance(ms){now+=ms;elapsed+=ms;},rotate(){secret='credential-two';},respond(value){response=value;}};
}

test('Introspection caches concurrent successful checks, expires at TTL/token expiry and never serves stale outage results',async()=>{
  const fixture=cachedFixture();
  const results=await Promise.all(Array.from({length:8},()=>fixture.resolve()));assert.equal(fixture.calls(),1);
  results[0].groups.push('admins');assert(!results[1].groups.includes('admins'));assert(!(await fixture.resolve()).groups.includes('admins'));
  fixture.advance(29999);await fixture.resolve();assert.equal(fixture.calls(),1);
  fixture.respond(Error('provider unavailable'));fixture.advance(1);
  await assert.rejects(fixture.resolve(),/provider unavailable/);await assert.rejects(fixture.resolve(),/provider unavailable/);assert.equal(fixture.calls(),3);
  const short=cachedFixture(60);short.respond({...claims,exp:1_800_000_001});await short.resolve();short.advance(1000);
  await assert.rejects(short.resolve(),/OIDC_TOKEN_INVALID/);assert.equal(short.calls(),2);
  const minute=cachedFixture(60);await minute.resolve();minute.advance(59999);await minute.resolve();assert.equal(minute.calls(),1);
  minute.advance(1);await minute.resolve();assert.equal(minute.calls(),2);
});

test('Introspection cache isolates policy/audience/credentials and keeps resource authorization current',async()=>{
  const fixture=cachedFixture(),identity=new Identity({configuration:()=>fixture.configuration,clock:()=>1_800_000_000_000,
    introspect:fixture.provider.Resolve.bind(fixture.provider)});
  const resource={spec:{identity:{tenant:'acme',project:'billing'}}};
  await identity.database(request,resource,'app_runtime');await identity.database(request,resource,'app_runtime');assert.equal(fixture.calls(),1);
  resource.spec.identity.project='other';await assert.rejects(identity.database(request,resource,'app_runtime'),/OIDC_ACCESS_DENIED/);assert.equal(fixture.calls(),1);
  fixture.rotate();await fixture.resolve();assert.equal(fixture.calls(),2);
  fixture.configuration.database.audience='other-audience';await fixture.resolve();assert.equal(fixture.calls(),3);
  await fixture.provider.Resolve('opaque-cache-token',fixture.configuration,'management');assert.equal(fixture.calls(),4);
  fixture.configuration.database.roleBindings=[];await assert.rejects(identity.database(request,resource,'app_runtime'),/OIDC_ACCESS_DENIED/);assert.equal(fixture.calls(),5);
});

test('Inactive introspection results are not cached and zero disables positive-result reuse',async()=>{
  const fixture=cachedFixture();fixture.respond({active:false});
  await assert.rejects(fixture.resolve(),/OIDC_TOKEN_INACTIVE/);await assert.rejects(fixture.resolve(),/OIDC_TOKEN_INACTIVE/);assert.equal(fixture.calls(),2);
  const disabled=cachedFixture(0);await disabled.resolve();await disabled.resolve();assert.equal(disabled.calls(),2);
});
