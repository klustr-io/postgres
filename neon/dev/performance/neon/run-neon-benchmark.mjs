import {spawnSync} from 'node:child_process';
import {readFileSync,writeFileSync,mkdirSync,statfsSync,existsSync,realpathSync} from 'node:fs';
import {createHash,randomUUID} from 'node:crypto';
import path from 'node:path';
import assert from 'node:assert/strict';
import {localConfiguration,s3Configuration} from '../../shared/neon-qualification-config.mjs';
import {createBenchmarkVolume} from '../../shared/neon-benchmark-volume.mjs';
import {createBenchmarkVhdVolume} from '../../shared/neon-benchmark-vhd.mjs';
import {probeS3WriteCapacity} from './neon-s3-write-capacity.mjs';
import {neonTestPath} from '../../shared/neon-test-paths.mjs';
const docker=process.env.DOCKER || 'docker';
const memoryGiB=Number(process.env.NEON_BENCHMARK_MEMORY_GIB||8);
assert(Number.isInteger(memoryGiB)&&memoryGiB>=8&&memoryGiB<=32,'Benchmark memory must be 8–32 GiB');
const cpuPeriodUs=Number(process.env.NEON_BENCHMARK_CPU_PERIOD_US||100000);
assert(Number.isInteger(cpuPeriodUs)&&cpuPeriodUs>=1000&&cpuPeriodUs<=100000);
const resourceProfile=process.env.NEON_BENCHMARK_RESOURCE_PROFILE||'total8';
assert(['total8','compute8-storage8'].includes(resourceProfile));
const cpuLimit=Number(process.env.NEON_BENCHMARK_CPU_LIMIT||8);
assert(resourceProfile==='total8'?cpuLimit===8:[8,16].includes(cpuLimit));
const cpuFlags=cpuPeriodUs===100000?['--cpus',String(cpuLimit)]:['--cpu-period',String(cpuPeriodUs),'--cpu-quota',String(cpuPeriodUs*cpuLimit)];
if(resourceProfile==='compute8-storage8')cpuFlags.push('--cpuset-cpus',cpuLimit===16?'0-15':'0-7');
const minHostFreeGiB=Number(process.env.NEON_BENCHMARK_MIN_FREE_GIB||12);
assert(Number.isInteger(minHostFreeGiB)&&minHostFreeGiB>=8&&minHostFreeGiB<=64);
const imageRecord=process.env.NEON_BENCHMARK_IMAGE_RECORD || 'neon/tests/reports/local/neon-benchmark-image.json';
const image=JSON.parse(readFileSync(imageRecord,'utf8'));
const id=randomUUID().slice(0,8),container=`neon-pg18-benchmark-${id}`,volume=container+'-data';
const parameters=process.argv.slice(2);
const prefixIndex=parameters.indexOf('--report-prefix');
const reportPrefix=prefixIndex<0?'neon-performance-comparison':parameters[prefixIndex+1];
assert(/^[a-z0-9-]+$/.test(reportPrefix),'Invalid report prefix');
if(prefixIndex>=0) parameters.splice(prefixIndex,2);
const local=parameters.includes('--local-storage');
const args=parameters.filter(value=>value!=='--local-storage');
if(resourceProfile!=='total8'&&!process.env.NEON_BENCHMARK_HARNESS_DIRECTORY&&!args.includes('--resource-profile'))
  args.push('--resource-profile',resourceProfile);
const computeStorageIndex=args.indexOf('--compute-storage');
const computeStorage=computeStorageIndex<0?'disk':args[computeStorageIndex+1];
let computeTmpfs=[];
let computeIdentity=null;
if(computeStorage==='tmpfs') {
  const identity=spawnSync(docker,['run','--rm','--network','none','--read-only','--cap-drop','ALL',
    '--security-opt','no-new-privileges','--entrypoint','python3',image.image_id,
    '-c','import os; print(str(os.getuid())+":"+str(os.getgid()))'],{encoding:'utf8'});
  assert.equal(identity.status,0,identity.stderr);assert(/^\d+:\d+\s*$/.test(identity.stdout));
  const [uid,gid]=identity.stdout.trim().split(':');assert.notEqual(uid,'0');
  computeIdentity={uid:Number(uid),gid:Number(gid)};
  computeTmpfs=['--tmpfs',`/compute:rw,nosuid,nodev,noexec,size=2g,mode=0700,uid=${uid},gid=${gid}`];
}
const localValues=localConfiguration();
const volumeProvider=localValues.NEON_BENCHMARK_VOLUME_PROVIDER||'vhd';
assert(['vhd','loop','docker'].includes(volumeProvider));
const volumeRoot=volumeProvider==='docker'?null:(localValues.NEON_BENCHMARK_VOLUME_ROOT||null);
const selectedEngineIndex=args.indexOf('--engine');
const selectedEngine=selectedEngineIndex<0?'both':args[selectedEngineIndex+1];
// Standalone PostgreSQL neither uses nor receives S3 credentials.
const config=local||selectedEngine==='upstream'?null:s3Configuration(localValues);
if(config) config.prefix=config.prefix.replace('neon-pg18-qualification/','neon-pg18-benchmark/');
if(resourceProfile==='compute8-storage8')assert.equal(cpuLimit,selectedEngine==='neon'?16:8);
const s3CapacityPreflight=config&&selectedEngine!=='upstream'?probeS3WriteCapacity({docker,image:image.image_id,config,reportPrefix}):null;
const disk=statfsSync('.'),requiredHostFree=volumeRoot?4:minHostFreeGiB;
assert(disk.bavail*disk.bsize>requiredHostFree*1024**3,`At least ${requiredHostFree} GiB host disk headroom is required`);
const reportDirectory=path.resolve(`neon/tests/reports/local/${container}`);mkdirSync(reportDirectory);
const harnessDirectory=process.env.NEON_BENCHMARK_HARNESS_DIRECTORY;
const harnessSource=file=>harnessDirectory?path.join(harnessDirectory,file):neonTestPath(file);
const script=readFileSync(harnessSource('compare_postgres.py'),'utf8').replaceAll('\r\n','\n');
const sourceDirectoryInput=path.resolve(`build/${container}-scripts`);mkdirSync(sourceDirectoryInput);
const sourceDirectory=realpathSync(sourceDirectoryInput);
const modulesFile=harnessDirectory?path.join(harnessDirectory,'harness-modules.json'):null;
const extraModules=modulesFile&&existsSync(modulesFile)?JSON.parse(readFileSync(modulesFile,'utf8')):[];
assert(Array.isArray(extraModules)&&extraModules.every(file=>/^[a-z0-9_]+\.py$/.test(file)));
const moduleHashes={};
for(const file of new Set(['compare_postgres.py','s3_client.py',
  ...(resourceProfile==='compute8-storage8'&&!harnessDirectory?['cpu_layout.py']:[]),...extraModules])) {
  writeFileSync(path.join(sourceDirectory,file),readFileSync(harnessSource(file),'utf8').replaceAll('\r\n','\n'));
  moduleHashes[file]=createHash('sha256').update(readFileSync(path.join(sourceDirectory,file))).digest('hex');
}
let volumeStorage=null;
if(volumeRoot)volumeStorage=(volumeProvider==='vhd'?createBenchmarkVhdVolume:createBenchmarkVolume)({root:volumeRoot,volume,image:image.image_id,docker,
  allowSystemDrive:localValues.NEON_BENCHMARK_ALLOW_SYSTEM_DRIVE==='1'});
else {
  const created=spawnSync(docker,['volume','create','--label','io.klustr.purpose=pg18-performance-comparison',volume],{encoding:'utf8'});
  assert.equal(created.status,0,created.stderr);
}
const record={...image,status:'RUNNING',container,volume,image_id:image.image_id,image_record:imageRecord,parameters:args,
  compute_storage:computeStorage,compute_tmpfs_identity:computeIdentity,compute_tmpfs_mount:computeTmpfs[1]||null,
  harness_sha256:createHash('sha256').update(script).digest('hex'),
  harness_module_sha256:moduleHashes,
  report_directory:reportDirectory,s3_prefix:config?.prefix || null,started_at:new Date().toISOString(),
  cpu_limit:cpuLimit,cpu_period_us:cpuPeriodUs,memory_limit_bytes:memoryGiB*1024**3,min_host_free_gib:requiredHostFree,
  resource_profile:resourceProfile,compute_and_loadgen_cpu_budget:8,
  separate_storage_cpu_budget:resourceProfile==='compute8-storage8'?(selectedEngine==='neon'?8:0):null,
  volume_storage:volumeStorage};
record.s3_capacity_preflight=s3CapacityPreflight;
function save(){writeFileSync(`neon/tests/reports/local/${reportPrefix}.json`,JSON.stringify(record,null,2)+'\n');}
save();
console.log(`Benchmark container: ${container}; new retained volume: ${volume}`);
const execution=spawnSync(docker,['run','-i','--init','--read-only','--name',container,...cpuFlags,'--memory',`${memoryGiB}g`,'--memory-swap',`${memoryGiB}g`,
  '--cap-drop','ALL','--security-opt','no-new-privileges','--shm-size','1g',
  '--tmpfs','/tmp:rw,nosuid,nodev,size=512m,mode=1777',
  ...computeTmpfs,
  '--mount',`type=volume,source=${volume},target=/var/lib/neon`,
  '--mount',`type=bind,source=${sourceDirectory},target=/benchmark,readonly`,image.image_id,...args],
  {input:JSON.stringify(config)+'\n',stdio:['pipe','inherit','inherit']});
let code=execution.status;
for(const [source,name] of [['benchmark.json','benchmark.json'],['public','logs']]) {
  const copied=spawnSync(docker,['cp',`${container}:/var/lib/neon/comparison/${source}`,path.join(reportDirectory,name)],{encoding:'utf8'});
  if(copied.status!==0) {code=1;console.error(`Evidence copy failed: ${name}`);}
}
record.status=code===0?'PASS':'FAIL';record.exit_code=code;record.completed_at=new Date().toISOString();
record.benchmark_json=path.join(reportDirectory,'benchmark.json');save();
assert.equal(code,0,'Benchmark failed; retained volume and copied logs contain diagnostic evidence');
