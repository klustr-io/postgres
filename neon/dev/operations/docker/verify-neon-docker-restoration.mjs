// Verify the maintenance inventory without printing environment variables.
import fs from 'node:fs';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {localConfiguration} from '../../shared/neon-qualification-config.mjs';
const root='neon/tests/reports/local', read=file=>JSON.parse(fs.readFileSync(file,'utf8').replace(/^\uFEFF/,''));
const plan=read(`${root}/neon-docker-compaction-plan.json`);
const record={status:'RUNNING',started_at:new Date().toISOString(),containers:[],kubernetes:null};
const save=()=>fs.writeFileSync(`${root}/neon-docker-restoration-verification.json`,JSON.stringify(record,null,2)+'\n');
const run=(exe,args)=>{
  const child=spawnSync(exe,args,{encoding:'utf8',timeout:30000,maxBuffer:16*1024**2});
  assert.equal(child.status,0,`${exe} verification command failed: ${child.stderr}`);return child.stdout;
};
const sortMounts=rows=>[...rows].sort((a,b)=>a.destination.localeCompare(b.destination));
const normalize=rows=>sortMounts(rows.map(m=>({type:m.Type,name:m.Name,source:m.Source,destination:m.Destination})));
try {
  const deadline=Date.now()+180000;
  do {
    const current=JSON.parse(run('docker',['inspect',...plan.containers.map(row=>row.id)]));
    record.containers=plan.containers.map(before=>{
      const after=current.find(row=>row.Id===before.id);assert(after,before.name);
      const checks={image:after.Image===before.image_id,name:after.Name==='/'+before.name,
        restart_policy:JSON.stringify(after.HostConfig.RestartPolicy)===JSON.stringify(before.restart_policy),
        mounts:JSON.stringify(normalize(after.Mounts))===JSON.stringify(sortMounts(before.mounts)),
        running:after.State.Running,
        health:before.health!=='healthy'||after.State.Health?.Status==='healthy'};
      return {id:before.id,name:before.name,health_before:before.health,
        health_after:after.State.Health?.Status||null,checks,status:Object.values(checks).every(Boolean)?'PASS':'WAITING'};
    });save();
    if(record.containers.every(row=>row.status==='PASS'))break;
    assert(Date.now()<deadline,'Some recorded containers did not recover; inspect verification JSON');
    await new Promise(resolve=>setTimeout(resolve,5000));
  }while(true);
  const env=localConfiguration();
  assert(env.NEON_K8S_KUBECONFIG&&env.NEON_K8S_CONTEXT,'Recorded qualification kubeconfig/context required');
  const nodes=JSON.parse(run('kubectl',['--kubeconfig',env.NEON_K8S_KUBECONFIG,'--context',env.NEON_K8S_CONTEXT,
    '--request-timeout=20s','get','nodes','-o','json']));
  record.kubernetes={context:env.NEON_K8S_CONTEXT,nodes:nodes.items.map(row=>({name:row.metadata.name,
    ready:row.status.conditions.some(c=>c.type==='Ready'&&c.status==='True')}))};
  assert(record.kubernetes.nodes.length&&record.kubernetes.nodes.every(row=>row.ready),'Kubernetes node not Ready');
  const disk=fs.statfsSync('C:/');record.c_free_bytes=disk.bavail*disk.bsize;
  record.status='PASS';
}catch(error){record.status='FAIL';record.error=String(error);process.exitCode=1;}
record.completed_at=new Date().toISOString();save();
console.log(JSON.stringify({status:record.status,containers_pass:record.containers.filter(row=>row.status==='PASS').length,
  containers_total:plan.containers.length,kubernetes:record.kubernetes,c_free_gib:record.c_free_bytes/1024**3,error:record.error},null,2));
