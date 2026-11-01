import test from 'node:test';
import assert from 'node:assert/strict';
import {StorageFleet, remoteDurable} from '../../../controller/tenant-compute/deploy/fleet.mjs';
test('Fleet shutdown requires a generation-validated remote frontier covering acknowledged and final WAL', () => {
  assert(remoteDurable({last_record_lsn: '0/200', remote_consistent_lsn: '0/0', remote_consistent_lsn_visible: '0/200'}, '0/180'));
  assert(!remoteDurable({last_record_lsn: '0/200', remote_consistent_lsn_visible: '0/190'}, '0/180'));
  assert(!remoteDurable({last_record_lsn: '0/200', remote_consistent_lsn_visible: '0/200'}, '0/210'));
  assert.throws(() => remoteDurable({last_record_lsn: '0/200'}, '0/180'), /frontier/);
});
test('Unverified remote durability never scales down a storage service', async () => {
  let scales=0;const phases=[];
  const fleet=new StorageFleet({api:{get:async()=>({spec:{replicas:0},status:{}})},leader:{active:true,require(){}},databases:{},routing:{},getEndpoints:()=>new Map(),emit(){}});
  fleet.members=()=>[{kind:'statefulsets',name:'metadata'}];fleet.demand=async()=>false;
  fleet.api.get=async(kind)=>kind==='neonstoragefleets'?{spec:{replicas:0},status:{}}:{spec:{replicas:1}};
  fleet.status=async value=>phases.push(value.phase);fleet.scale=async()=>{scales++;};
  fleet.proof=async()=>{throw Object.assign(Error('Not uploaded'),{code:'REMOTE_DURABILITY_PENDING'});};
  await fleet.reconcile();assert.equal(scales,0);assert(phases.includes('WaitingForDurability'));
});
