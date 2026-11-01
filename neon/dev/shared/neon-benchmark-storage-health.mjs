// Performance eligibility is separate from SQL correctness and fault probes.
export function sampleStorageHealth(sample) {
  if(sample.engine!=='neon')return {status:'NOT-APPLICABLE',failed_operations:0};
  const metrics=sample.s3?.native_operation_delta;
  if(!metrics)return {status:'UNOBSERVED',failed_operations:null};
  const counters=Object.entries(metrics).filter(([key])=>key.includes('remote_storage_s3_request_seconds_count{'));
  if(!counters.length)return {status:'UNOBSERVED',failed_operations:null};
  const select=result=>Object.fromEntries(counters.filter(([key,value])=>key.includes(`result="${result}"`)&&value>0));
  const failed=select('err'),cancelled=select('cancelled'),successful=select('ok');
  const total=value=>Object.values(value).reduce((sum,n)=>sum+n,0);
  return {status:total(failed)>0?'DEGRADED-S3-ERRORS':'NO-S3-ERRORS-OBSERVED',
    failed_operations:total(failed),successful_operations:total(successful),
    successful_put_operations:counters.filter(([key])=>key.includes('request_type="put_object",result="ok"')).reduce((sum,[,n])=>sum+n,0),
    failed_counters:failed,cancelled_counters:cancelled,
    coverage:'Measured interval only. Absence of errors does not establish sustained upload capacity or production qualification.'};
}
export function benchmarkStorageHealth(samples) {
  const neon=samples.filter(row=>row.engine==='neon'),health=neon.map(sampleStorageHealth);
  return {status:!neon.length?'NOT-APPLICABLE':health.some(row=>row.status==='DEGRADED-S3-ERRORS')?'DEGRADED-S3-ERRORS':
    health.some(row=>row.status==='UNOBSERVED')?'UNOBSERVED':'NO-S3-ERRORS-OBSERVED',
    healthy_comparison_eligible:health.every(row=>row.status==='NO-S3-ERRORS-OBSERVED'),
    failed_operations:health.reduce((sum,row)=>sum+(row.failed_operations||0),0)};
}
