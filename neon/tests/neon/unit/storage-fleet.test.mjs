import {RemoteDurable as remoteDurable} from '../../../controller/tenant-compute/src/domain/storage/WalDurability.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {StorageFleet} from '../../../controller/tenant-compute/src/application/storage/StorageFleet.mjs';
test('Fleet shutdown requires a generation-validated remote frontier covering acknowledged and final WAL', () => {
  assert(remoteDurable({last_record_lsn: '0/200', remote_consistent_lsn: '0/0', remote_consistent_lsn_visible: '0/200'}, '0/180'));
  assert(!remoteDurable({last_record_lsn: '0/200', remote_consistent_lsn_visible: '0/190'}, '0/180'));
  assert(!remoteDurable({last_record_lsn: '0/200', remote_consistent_lsn_visible: '0/200'}, '0/210'));
  assert.throws(() => remoteDurable({last_record_lsn: '0/200'}, '0/180'), /frontier/);
});
test('Unverified remote durability never scales down a storage service', async () => {
  let scales=0;const phases=[];
  const fleet=new StorageFleet({api:{get:async()=>({spec:{replicas:0},status:{}})},leader:{active:true,require(){}},routing:{},getEndpoints:()=>new Map(),emit(){},
    getStorageConfiguration:()=>({pageservers:[]}),hasDatabaseDemand:async()=>false,isDatabaseDeleted:()=>false,
    getBackupTimelines:async()=>[],hasPendingRecovery:()=>false,publishDemand(){}});
  fleet.members=()=>[{kind:'statefulsets',name:'metadata'}];fleet.demand=async()=>false;
  fleet.api.get=async(kind)=>kind==='neonstoragefleets'?{spec:{replicas:0},status:{}}:{spec:{replicas:1}};
  fleet.status=async value=>phases.push(value.phase);fleet.scale=async()=>{scales++;};
  fleet.proof=async()=>{throw Object.assign(Error('Not uploaded'),{code:'REMOTE_DURABILITY_PENDING'});};
  await fleet.reconcile();assert.equal(scales,0);assert(phases.includes('WaitingForDurability'));
});

test('Storage shutdown requires every managed tenant and timeline in the native inventory', async () => {
  const tenantId='a'.repeat(32),timelineId='b'.repeat(32),lsn='0/200';
  let inventory=[],timelines=[];
  const fleet=new StorageFleet({getEndpoints:()=>new Map(),getBackupTimelines:async()=>[{tenantId,timelineId,lsn}],
    routing:{request:async(method,route)=>{
      if(route==='/control/v1/tenant')return inventory;
      if(route===`/v1/tenant/${tenantId}/timeline`)return timelines;
      if(route===`/control/v1/tenant/${tenantId}/timeline/${timelineId}`)return {shards:[{last_record_lsn:lsn,remote_consistent_lsn_visible:lsn}]};
      throw Error('Unexpected storage request');
    }}});
  await assert.rejects(fleet.proof(),/Missing managed storage tenant/);
  inventory=[{tenant_id:tenantId}];
  await assert.rejects(fleet.proof(),/Missing managed storage timeline/);
  timelines=[{timeline_id:timelineId}];
  assert.deepEqual(await fleet.proof(),{[tenantId+':'+timelineId]:lsn});
});
