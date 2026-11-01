// Test the native ephemeral-compute durability contract in a new fixture only.
import {readFileSync,writeFileSync} from 'node:fs';
import {spawnSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import assert from 'node:assert/strict';
const root='neon/tests/reports/local',read=file=>JSON.parse(readFileSync(file,'utf8'));
const baseline=read(`${root}/neon-compression-zstd.json`),image=read(`${root}/neon-benchmark-index-build-fix-image.json`);
assert.equal(baseline.status,'PASS');assert.equal(baseline.image_id,image.image_id);
const manifest={status:'RUNNING',started_at:new Date().toISOString(),baseline,
  baseline_raw_sha256:createHash('sha256').update(readFileSync(baseline.benchmark_json)).digest('hex'),
  purpose:'Compute-local fsync off; quorum/safekeeper fsync, synchronous commit and full-page writes stay on. Includes SIGKILL/local-file exclusion and manual tenant compute zero/wake.'};
const imageRecord=`${root}/${manifest.started_at.replaceAll(/[^0-9]/g,'')}-native-commit-image.json`;
writeFileSync(imageRecord,JSON.stringify(image,null,2)+'\n');
const file=`${root}/neon-native-commit-experiment.json`,save=()=>writeFileSync(file,JSON.stringify(manifest,null,2)+'\n');save();
const args=['neon/dev/performance/neon/run-neon-benchmark.mjs','--report-prefix','neon-native-commit','--engine','neon',
  '--seconds','20','--warmup','5','--repeats','3','--wal-compression','zstd','--compute-local-fsync','off',
  '--verify-recovery','--probe-index-checkpoint','--verify-compute-storage-loss','--verify-scale-zero',
  '--scenarios','relational-write,jsonb-write'];
const child=spawnSync(process.execPath,args,{stdio:'inherit',env:{...process.env,NEON_BENCHMARK_IMAGE_RECORD:imageRecord}});
manifest.status=child.status===0?'PASS':'FAIL';manifest.completed_at=new Date().toISOString();
manifest.exit_code=child.status;manifest.result=`${root}/neon-native-commit.json`;save();
assert.equal(child.status,0,'Native commit qualification failed; retain its evidence');
