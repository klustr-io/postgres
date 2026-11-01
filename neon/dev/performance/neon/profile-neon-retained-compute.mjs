// Reuses only an owned, stopped test fixture. Private perf stacks stay on its
// tmpfs; export aggregate function symbols only. No host sysctl changes.
import fs from 'node:fs';
import path from 'node:path';
import {spawn,spawnSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import assert from 'node:assert/strict';
import {s3Configuration,localConfiguration} from '../../shared/neon-qualification-config.mjs';
const prefix=process.argv[2];assert(/^[a-z0-9-]+$/.test(prefix||''));
const root='neon/tests/reports/local',read=file=>JSON.parse(fs.readFileSync(file,'utf8')),
  fixture=read(`${root}/${prefix}.json`),tools=read(`${root}/neon-perf-tools.json`);
assert.equal(fixture.status,'FAIL');assert.equal(tools.status,'PASS');assert(fixture.volume_storage?.provider==='docker-desktop-ext4-vhd');
assert(/^neon-pg18-benchmark-[a-f0-9]{8}-data$/.test(fixture.volume));
const run=args=>{const r=spawnSync('docker',args,{encoding:'utf8',maxBuffer:8*1024**2});assert.equal(r.status,0,r.stderr);return r.stdout;};
const original=JSON.parse(run(['inspect',fixture.container]))[0];
assert.equal(original.State.Running,false);assert.equal(original.Image,fixture.image_id);
assert.equal(run(['ps','-q','--filter',`volume=${fixture.volume}`]).trim(),'','No concurrent fixture writer allowed');
for(const [name,sha] of Object.entries(tools.manifest.files))
  assert.equal(createHash('sha256').update(fs.readFileSync(path.join(tools.output,name))).digest('hex'),sha);
const stamp=new Date().toISOString().replaceAll(/[^0-9]/g,''),container='neon-perf-'+stamp,
  directory=fs.realpathSync('neon/tests/neon/performance'),privateDir=`/tmp/private-perf-${stamp}`;
const record={status:'RUNNING',started_at:new Date().toISOString(),container,image_id:fixture.image_id,fixture:prefix,
  tools_manifest_sha256:createHash('sha256').update(fs.readFileSync(path.join(tools.output,'manifest.json'))).digest('hex'),
  source_sha256:createHash('sha256').update(fs.readFileSync('neon/tests/neon/performance/profile_retained_compute.py')).digest('hex'),
  claims:'Diagnostic function attribution only; reuses and updates an owned retained test database. No comparative TPS/wake/RPO claim.',
  private_stack_trace:privateDir+'/perf.data',public_export:'Aggregate DSO/function names only; raw sampled stacks never exported',
  raw_stack_retention:'Private tmpfs only; discarded on container stop after aggregate report',
  capability:'PERFMON in this isolated diagnostic container only; no host PID namespace, sysctl change or production-image mutation'};
const report=`${root}/${prefix}-function-profile.json`,log=`${root}/${stamp}-owned-compute-profile.log`;
if(fs.existsSync(report))fs.copyFileSync(report,`${root}/${stamp}-previous-${prefix}-function-profile.json`);
record.log=log;const save=()=>fs.writeFileSync(report,JSON.stringify(record,null,2)+'\n');save();
const fd=fs.openSync(log,'w'),config=s3Configuration(localConfiguration());config.prefix=fixture.s3_prefix;
const child=spawn('docker',['run','-i','--init','--read-only','--name',container,'--cpu-period','10000','--cpu-quota','80000',
  '--memory','16g','--memory-swap','16g','--cap-drop','ALL','--cap-add','PERFMON','--security-opt','no-new-privileges','--shm-size','1g',
  '--tmpfs','/tmp:rw,nosuid,nodev,size=512m,mode=1777',
  '--mount',`type=volume,source=${fixture.volume},target=/var/lib/neon`,
  '--mount',`type=bind,source=${directory},target=/probe,readonly`,
  '--mount',`type=bind,source=${path.resolve(tools.output)},target=/perf-tools,readonly`,
  '--entrypoint','python3',fixture.image_id,'-B','/probe/profile_retained_compute.py'],{stdio:['pipe','pipe',fd]});
child.stdin.on('error',()=>{});
child.stdin.write(JSON.stringify({config})+'\n');
let buffer='',profileTask=null;
function perf(args){return new Promise(resolve=>{
  const task=spawn('docker',['exec','--user','0',container,`/perf-tools/${tools.manifest.loader}`,'--library-path','/perf-tools/lib','/perf-tools/perf',...args],{stdio:['ignore','pipe','pipe']});
  const out=[],err=[];task.stdout.on('data',b=>out.push(b));task.stderr.on('data',b=>err.push(b));
  task.once('exit',code=>resolve({code,stdout:Buffer.concat(out).toString(),stderr:Buffer.concat(err).toString()}));
});}
child.stdout.on('data',chunk=>{
  buffer+=chunk;
  while(buffer.includes('\n')) {
    const end=buffer.indexOf('\n'),line=buffer.slice(0,end);buffer=buffer.slice(end+1);
    const event=JSON.parse(line);
    if(event.event==='PROFILE-READY') {
      assert(!profileTask);assert(event.backend_pids.length===64&&event.backend_pids.every(p=>Number.isInteger(p)&&p>1));
      profileTask=(async()=>{
        run(['exec','--user','0',container,'mkdir','-p',privateDir]);
        const sampled=await perf(['record','-e','cpu-clock:u','-F','99','--call-graph','dwarf,8192',
          '-p',event.backend_pids.join(','),'-o',privateDir+'/perf.data','--','sleep','10']);
        record.capture_exit_code=sampled.code;record.capture_diagnostic=sampled.stderr;save();
        if(sampled.code!==0)return;
        const aggregate=await perf(['report','--stdio','--no-children','--no-inline','--call-graph','none','--sort','dso,symbol','--percent-limit','0.5','-i',privateDir+'/perf.data']);
        record.aggregate_exit_code=aggregate.code;record.aggregate_diagnostic=aggregate.stderr;save();
        assert.equal(aggregate.code,0);record.aggregate_functions=aggregate.stdout;save();
      })().catch(error=>{record.profile_error=String(error);record.capture_exit_code??=1;save();}).finally(()=>child.stdin.end('finish\n'));
    }
    if(event.event==='WORKLOAD-PASS')record.workload_status='PASS';
  }
});
console.log('RUN isolated owned-fixture function profiling; log: '+log);
const code=await new Promise((resolve,reject)=>{child.once('error',reject);child.once('exit',resolve);});
if(profileTask)await profileTask;fs.closeSync(fd);
record.exit_code=code;record.completed_at=new Date().toISOString();
record.status=code===0&&record.workload_status==='PASS'&&record.capture_exit_code===0&&record.aggregate_functions?'DIAGNOSTIC':'FAILED-NO-ATTRIBUTION';
save();assert.equal(record.status,'DIAGNOSTIC','Inspect diagnostic report; never infer symbols from a failed profiler');
console.log(record.aggregate_functions);
