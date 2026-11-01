import test from 'node:test';
import assert from 'node:assert/strict';
import {sampleStorageHealth,benchmarkStorageHealth} from '../../../dev/shared/neon-benchmark-storage-health.mjs';
const sample=(failed,ok=0)=>({engine:'neon',s3:{native_operation_delta:{
  '9898:remote_storage_s3_request_seconds_count{request_type="put_object",result="err"}':failed,
  '9898:remote_storage_s3_request_seconds_count{request_type="put_object",result="ok"}':ok}}});
test('SQL-successful intervals with remote errors cannot pass comparison eligibility',()=>{
  const health=benchmarkStorageHealth([sample(0,5),sample(1,0)]);
  assert.equal(health.status,'DEGRADED-S3-ERRORS');
  assert.equal(health.healthy_comparison_eligible,false);
  assert.equal(health.failed_operations,1);
});
test('missing counters are unknown rather than evidence of healthy S3',()=>{
  assert.equal(benchmarkStorageHealth([{engine:'neon',s3:{native_operation_delta:{}}}]).healthy_comparison_eligible,false);
  assert.equal(sampleStorageHealth({engine:'neon'}).status,'UNOBSERVED');
});
test('raw PostgreSQL needs no S3 and successful remote operations remain visible',()=>{
  assert.equal(benchmarkStorageHealth([{engine:'upstream'}]).status,'NOT-APPLICABLE');
  const health=sampleStorageHealth(sample(0,7));
  assert.equal(health.successful_put_operations,7);
  assert.equal(benchmarkStorageHealth([sample(0,7)]).healthy_comparison_eligible,true);
});
