import test from 'node:test';
import assert from 'node:assert/strict';

test('Observing dormant compute cannot connect to SQL or publish wake demand',async()=>{
  let connections=0;
  const api={optional:async()=>({spec:{replicas:0}})};
  const lifecycle=new Lifecycle(api,{require(){}},async()=>{connections++;throw Error('Dormant SQL must not be contacted');});
  const endpoint={uid:'dormant',name:'neon-ep-dormant',suspend:{mode:'idle',idleSeconds:300},status:{phase:'Dormant'}};
  assert.equal(await lifecycle.sampleDemand(endpoint),false);
  await lifecycle.idle(endpoint);
  assert.equal(connections,0);
  assert.deepEqual(lifecycle.activityIds(),[]);
});
import {Lifecycle} from '../../../controller/tenant-compute/src/infrastructure/compute/Lifecycle.mjs';
import {Leadership} from '../../../controller/tenant-compute/src/infrastructure/kubernetes/Kubernetes.mjs';
const OWNER='neon.klustr.io/endpoint-uid',ADMISSION='neon.klustr.io/admission';
function fixture({clients=0,drainError=false}={}){
  const endpoint={name:'neon-ep-test',uid:'owner-one',endpointId:'ep-test',status:{phase:'Active'},profile:'durable'};
  const labels={[OWNER]:endpoint.uid};
  const resources={configmaps:{metadata:{name:endpoint.name,uid:endpoint.uid,resourceVersion:'1'},
    data:{'status.json':'{"phase":"Active"}'}},
    deployments:{metadata:{labels,resourceVersion:'1'},spec:{replicas:1}},
    services:{metadata:{labels,resourceVersion:'1'},spec:{selector:{...labels,[ADMISSION]:'open'}}}};
  let pods=[{metadata:{uid:'compute-one'},spec:{nodeName:'worker'},status:{phase:'Running',podIP:'10.0.0.1',
    conditions:[{type:'Ready',status:'True'}]}}],ended=false;
  const mutations=[],client={query:async sql=>{
    if(sql.includes('pg_stat_activity'))return {rows:[{n:clients}]};
    if(sql.includes('bounded_commit_guard_drain')){
      if(drainError)throw Object.assign(Error('quorum unavailable'),{code:'DRAIN_TIMEOUT'});
      return {rows:[{lsn:'0/1234'}]};
    }
    if(sql.includes('pg_terminate_backend'))return {rows:[]};
    throw Error('Unexpected database query');
  },end:async()=>{ended=true;}};
  const api={namespace:'test',get:async(kind)=>structuredClone(resources[kind]),
    list:async kind=>kind==='pods'?structuredClone(pods):[],patch:async(kind,name,change)=>{
      mutations.push({kind,change});
      if(kind==='configmaps')resources[kind].data={...resources[kind].data,...change.data};
      if(change.spec)resources[kind].spec={...resources[kind].spec,...change.spec};
      if(kind==='deployments'&&change.spec?.replicas===0){
        assert.equal(JSON.parse(resources.configmaps.data['status.json']).drainedLSN,'0/1234');
        assert(ended,'Administrative connection must close before graceful PostgreSQL shutdown');pods=[];
      }
      return structuredClone(resources[kind]);
    }};
  const leader={active:true,identity:'leader-one',require(){if(!this.active)throw Object.assign(Error('No lease'),{code:'NOT_LEADER'});}};
  const lifecycle=new Lifecycle(api,leader,async()=>client);lifecycle.admin=async()=>client;
  return {lifecycle,endpoint,resources,mutations,leader};
}
test('Drain frontier persists and admin connection closes before compute reaches zero',async()=>{
  const f=fixture();assert.equal(await f.lifecycle.suspendLocked(f.endpoint),true);
  assert.equal(f.resources.deployments.spec.replicas,0);
  assert.equal(f.endpoint.status.phase,'Dormant');assert.equal(f.endpoint.status.drainedLSN,'0/1234');
});
test('An application connection that raced admission closure aborts suspension',async()=>{
  const f=fixture({clients:1});assert.equal(await f.lifecycle.suspendLocked(f.endpoint),false);
  assert.equal(f.resources.deployments.spec.replicas,1);
  assert.equal(f.resources.services.spec.selector[ADMISSION],'open');
});
test('Failed native quorum drain preserves compute and closes admission',async()=>{
  const f=fixture({drainError:true});await assert.rejects(f.lifecycle.suspendLocked(f.endpoint));
  assert.equal(f.resources.deployments.spec.replicas,1);
  assert.equal(f.resources.services.spec.selector[ADMISSION],'closed');assert.equal(f.endpoint.status.phase,'Draining');
});
test('A controller without a live ownership lease cannot mutate compute',async()=>{
  const f=fixture();f.leader.active=false;
  await assert.rejects(f.lifecycle.serialized(f.endpoint,()=>f.lifecycle.suspendLocked(f.endpoint)),{code:'NOT_LEADER'});
  assert.equal(f.mutations.length,0);
});
test('Never-suspend policy prevents a direct or resumed suspension',async()=>{
  const f=fixture();f.endpoint.suspend={mode:'never'};
  assert.equal(await f.lifecycle.suspendLocked(f.endpoint,true),false);
  assert.equal(f.resources.deployments.spec.replicas,1);
  assert(!f.mutations.some(m=>m.kind==='deployments'&&m.change.spec?.replicas===0));
});
test('An unrelated Deployment cannot be treated as this endpoint compute',async()=>{
  const f=fixture();f.resources.deployments.metadata.labels={[OWNER]:'someone-else'};
  f.lifecycle.api.optional=f.lifecycle.api.get;
  await assert.rejects(f.lifecycle.idle(f.endpoint),/ownership/);assert.equal(f.mutations.length,0);
});
test('Takeover requires a full monotonic lease interval despite an expired wall-clock timestamp',async()=>{
  let now=0,claims=0;const lease={metadata:{resourceVersion:'5'},spec:{holderIdentity:'old',leaseDurationSeconds:15,renewTime:'1970-01-01T00:00:00Z'}};
  const api={optional:async()=>structuredClone(lease),patch:async(_kind,_name,change)=>{
    claims++;lease.spec=change.spec;return structuredClone(lease);
  }};
  const leader=new Leadership(api,{podName:'new',clock:()=>now});
  await leader.tick();now=16000;await leader.tick();assert.equal(claims,0);
  now=18000;await leader.tick();assert.equal(claims,1);assert(leader.active);
  now=31000;assert(!leader.active,'Expired local ownership fails closed without API access');
});
