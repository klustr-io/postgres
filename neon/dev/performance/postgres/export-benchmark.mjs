// Preserve the actual samples used by this qualification and audit percentiles.
import {spawnSync} from 'node:child_process';
import {readFileSync,writeFileSync} from 'node:fs';
import assert from 'node:assert/strict';
const reports=process.env.REPORT_DIR || 'neon/tests/reports/local';
function docker(args) {
  const r=spawnSync(process.env.DOCKER || 'docker',args,{encoding:'utf8',maxBuffer:128*1024*1024});
  assert.equal(r.status,0,r.stderr);
  return r.stdout.trim();
}
const container=docker(['compose','--env-file','neon/dev/.env','-f','neon/dev/operations/docker/compose.yaml','ps','-q','postgres']);
const metrics=JSON.parse(readFileSync(`${reports}/pgbench.json`,'utf8'));
assert.deepEqual(metrics.map(row=>row.scenario),['A','B','C','D'],'Wait for the complete full benchmark before exporting its sample audit.');
const histograms=[];
for(const run of metrics) {
  assert(/^[ABCD]$/.test(run.scenario));
  const samples=docker(['exec',container,'sh','-c',`cat /tmp/qualification_pgbench_${run.scenario}_*.*`]);
  writeFileSync(`${reports}/pgbench-${run.scenario}-sampled.log`,samples+'\n');
  const values=samples.split('\n').filter(Boolean).map(line=>Number(line.trim().split(/\s+/)[2])/1000).sort((a,b)=>a-b);
  assert.equal(values.length,run.sampled_transactions,'Multiple retained runs? Export only the sample prefix recorded by the intended run.');
  for(const [p,key] of [[.5,'sampled_p50_ms'],[.95,'sampled_p95_ms'],[.99,'sampled_p99_ms']]) {
    assert.equal(values[Math.min(values.length-1,Math.ceil(values.length*p)-1)],run[key]);
  }
  const bounds=[.1,.25,.5,1,2,5,10,20,50,100,250,500,1000,Infinity];
  let previous=0;
  const buckets=bounds.map(bound=>{
    const cumulative=bound===Infinity ? values.length : values.filter(v=>v<=bound).length;
    const count=cumulative-previous;
    previous=cumulative;
    return {upper_ms:bound===Infinity ? 'infinity' : bound,count};
  });
  histograms.push({scenario:run.scenario,samples:values.length,buckets});
}
writeFileSync(`${reports}/pgbench-histograms.json`,JSON.stringify(histograms,null,2)+'\n');
const resources=readFileSync(`${reports}/pgbench-resources.jsonl`,'utf8').trim().split('\n').map(JSON.parse);
assert(resources.length>10);
assert(resources.every(row=>row.exit_code===0));
console.log(`Exported and verified ${metrics.length} scenarios, their raw samples, percentiles and histograms; ${resources.length} successful resource samples.`);
