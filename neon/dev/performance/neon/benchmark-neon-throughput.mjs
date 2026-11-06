// Isolated throughput/latency sensitivity tests; retain every fixture and report.
import {readFileSync,writeFileSync,existsSync,mkdirSync} from 'node:fs';
import {spawnSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import assert from 'node:assert/strict';
import path from 'node:path';
import {neonTestPath} from '../../shared/neon-test-paths.mjs';
const root='neon/tests/reports/local',read=file=>JSON.parse(readFileSync(file,'utf8'));
const options=Object.fromEntries(process.argv.slice(2).reduce((pairs,value,index,all)=>{
  if(index%2===0){assert(value.startsWith('--')&&all[index+1],value);pairs.push([value.slice(2),all[index+1]]);}return pairs;
},[]));
const phase=options.phase||'screen';assert(['screen','qualify','wake','arrival','diagnose','checkpoint','release','ram','slo'].includes(phase));
const clients=Number(options.clients||16);assert(Number.isInteger(clients)&&clients>=1&&clients<=80);
const rates=(options.rates||'250,500,1000').split(',').map(Number);
assert(rates.length>0&&rates.every(rate=>Number.isFinite(rate)&&rate>0));
const image=read(process.env.NEON_BENCHMARK_IMAGE_RECORD||`${root}/neon-benchmark-index-build-fix-image.json`);
const started=new Date().toISOString(),stamp=started.replaceAll(/[^0-9]/g,'');
const imageRecord=`${root}/${stamp}-throughput-image.json`;
writeFileSync(imageRecord,JSON.stringify(image,null,2)+'\n');
const harnessDirectory=path.resolve(`build/${stamp}-throughput-harness`);mkdirSync(harnessDirectory,{recursive:true});
for(const file of ['compare_postgres.py','s3_client.py'])
  writeFileSync(path.join(harnessDirectory,file),readFileSync(neonTestPath(file),'utf8').replaceAll('\r\n','\n'));
const profiles=phase==='screen'?[16,32,64].map(clients=>({engine:'neon',clients,repeats:1,seconds:20,wake_cycles:1})):
  phase==='release'?[{engine:'neon',clients,repeats:3,seconds:20,wake_cycles:1,empty_compute_on_wake:true}]:
  phase==='slo'?[{engine:'neon',clients,repeats:1,seconds:120,wake_cycles:1,rates,trace_waits:true,empty_compute_on_wake:true}]:
  phase==='ram'?['disk','tmpfs'].map(compute_storage=>({engine:'neon',clients,repeats:1,seconds:120,wake_cycles:1,
    rates:[1500],scenarios:['jsonb-write'],trace_waits:true,empty_compute_on_wake:true,compute_storage,variant:compute_storage})):
  phase==='qualify'?['neon','upstream'].map(engine=>({engine,clients,repeats:3,seconds:30,wake_cycles:1})):
  phase==='arrival'?['neon','upstream'].map(engine=>({engine,clients,repeats:1,seconds:20,wake_cycles:1,rates})):
  phase==='diagnose'?[{engine:'neon',clients,repeats:1,seconds:120,wake_cycles:1,rates:[1500],scenarios:['jsonb-write'],trace_waits:true}]:
  phase==='checkpoint'?[{engine:'neon',clients,repeats:1,seconds:120,wake_cycles:1,rates:[1500],scenarios:['jsonb-write'],trace_waits:true,
    pageserver_checkpoint_mib:256,pageserver_checkpoint_seconds:600,verify_pageserver_crash:true}]:
  [{engine:'neon',clients:8,repeats:1,seconds:3,wake_cycles:20,scale:1,json_rows:1000,
    pageserver_checkpoint_mib:64,pageserver_checkpoint_seconds:30,empty_compute_on_wake:true}];
const manifest={status:'RUNNING',started_at:started,phase,image_id:image.image_id,profiles,
  harness_sha256:createHash('sha256').update(readFileSync(path.join(harnessDirectory,'compare_postgres.py'))).digest('hex'),
  objective:'Preserve independent synchronous transactions; measure throughput and latency together. Compute-local fsync off only for Neon; external quorum and safekeeper fsync stay on.',
  references:['neon-native-commit-comparison.json','neon-performance-comparison.json']};
const file=`${root}/neon-throughput-${phase}-experiments.json`;
if(existsSync(file))writeFileSync(`${root}/${stamp}-previous-neon-throughput-${phase}.json`,readFileSync(file));
const save=()=>writeFileSync(file,JSON.stringify(manifest,null,2)+'\n');save();
for(const profile of profiles){
  const prefix=`neon-throughput-${phase}-${profile.engine}-c${profile.clients}${profile.variant?'-'+profile.variant:''}`;
  const pointer=`${root}/${prefix}.json`;
  if(existsSync(pointer))writeFileSync(`${root}/${stamp}-previous-${prefix}.json`,readFileSync(pointer));
  const args=['neon/dev/performance/neon/run-neon-benchmark.mjs','--report-prefix',prefix,'--engine',profile.engine,
    '--seconds',String(profile.seconds),'--warmup',phase==='wake'?'1':'5','--repeats',String(profile.repeats),
    '--clients',String(profile.clients),'--wal-compression','zstd','--batch-size','1',
    '--scale',String(profile.scale||10),'--json-rows',String(profile.json_rows||100000),
    '--scenarios',(profile.scenarios||['relational-write','jsonb-write']).join(',')];
  if(profile.trace_waits)args.push('--trace-waits','--latency-sampling','1');
  if(profile.rates)args.push('--rates',profile.rates.join(','));
  if(profile.pageserver_checkpoint_mib)args.push('--pageserver-checkpoint-mib',String(profile.pageserver_checkpoint_mib),
    '--pageserver-checkpoint-seconds',String(profile.pageserver_checkpoint_seconds));
  if(profile.verify_pageserver_crash)args.push('--verify-pageserver-crash');
  if(profile.empty_compute_on_wake)args.push('--empty-compute-on-wake');
  if(profile.compute_storage)args.push('--compute-storage',profile.compute_storage);
  if(profile.engine==='neon')args.push('--compute-local-fsync','off','--verify-recovery',
    '--probe-index-checkpoint','--verify-compute-storage-loss','--verify-scale-zero','--wake-cycles',String(profile.wake_cycles));
  profile.started_at=new Date().toISOString();save();
  const child=spawnSync(process.execPath,args,{stdio:'inherit',env:{...process.env,NEON_BENCHMARK_IMAGE_RECORD:imageRecord,
    NEON_BENCHMARK_HARNESS_DIRECTORY:harnessDirectory}});
  profile.exit_code=child.status;profile.result=pointer;profile.completed_at=new Date().toISOString();
  if(existsSync(pointer)){const record=read(pointer);profile.raw_sha256=createHash('sha256').update(readFileSync(record.benchmark_json)).digest('hex');}
  profile.status=child.status===0?'PASS':'FAIL';save();
  if(child.status!==0){manifest.status='FAIL';manifest.completed_at=new Date().toISOString();save();process.exit(1);}
}
manifest.status='PASS';manifest.completed_at=new Date().toISOString();save();
