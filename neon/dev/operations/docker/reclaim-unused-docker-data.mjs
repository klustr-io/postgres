// Explicitly requested host cleanup. No containers or volumes are removed.
import fs from 'node:fs';
import {spawnSync} from 'node:child_process';
import assert from 'node:assert/strict';
const root='neon/tests/reports/local',execute=process.argv.includes('--execute');
const previous=`${root}/neon-unused-docker-data-cleanup.json`;
if(execute&&fs.existsSync(previous))fs.copyFileSync(previous,
  `${root}/${new Date().toISOString().replaceAll(/[^0-9]/g,'')}-previous-neon-unused-docker-data-cleanup.json`);
const report={status:execute?'RUNNING':'PLAN',started_at:new Date().toISOString(),
  authorization:'User requested clearing/purging dead Docker images and cache on 2026-10-31 (Asia/Tokyo)',
  containers_removed:false,volumes_removed:false,images:[],removed:[],skipped:[],cache:null};
const save=()=>fs.writeFileSync(`${root}/neon-unused-docker-data-cleanup.json`,JSON.stringify(report,null,2)+'\n');
function run(args,timeout=30000) {
  const child=spawnSync('docker',args,{encoding:'utf8',timeout,maxBuffer:32*1024**2});
  assert.equal(child.status,0,child.stderr||child.stdout);return child.stdout;
}
function collect(value,set) {
  if(typeof value==='string'&&/^sha256:[a-f0-9]{64}$/.test(value))set.add(value);
  else if(value&&typeof value==='object')for(const item of Object.values(value))collect(item,set);
}
try {
  const protectedImages=new Set();
  for(const file of fs.readdirSync(root).filter(name=>name.endsWith('.json')&&!name.includes('unused-docker-data-cleanup'))) {
    collect(JSON.parse(fs.readFileSync(`${root}/${file}`,'utf8').replace(/^\uFEFF/,'')),protectedImages);
  }
  const containers=run(['ps','-aq','--no-trunc']).trim().split(/\s+/).filter(Boolean);
  const currentContainers=containers.length?JSON.parse(run(['inspect',...containers])):[];
  const inUse=new Set(currentContainers.flatMap(row=>[row.Image,row.Config.Image]));
  const ids=[...new Set(run(['image','ls','-aq','--no-trunc']).trim().split(/\s+/).filter(Boolean))];
  const images=[];
  for(let i=0;i<ids.length;i+=50)images.push(...JSON.parse(run(['image','inspect',...ids.slice(i,i+50)])));
  report.before=run(['system','df']);
  report.images=images.map(row=>{
    // Containerd may expose manifest/index and configuration IDs separately.
    const aliases=[row.Id,row.Descriptor?.digest,...(row.RepoTags||[]),
      ...(row.RepoDigests||[]).flatMap(value=>[value,value.split('@').at(-1)])].filter(Boolean);
    const referenced=aliases.some(value=>inUse.has(value)),retained=aliases.some(value=>protectedImages.has(value));
    return {id:row.Id,tags:row.RepoTags,created:row.Created,referenced_by_container:referenced,
      retained_evidence:retained,eligible:!referenced&&!retained&&Date.parse(row.Created)<Date.now()-7*86400000};
  });
  save();
  if(execute) {
    for(const image of report.images.filter(row=>row.eligible)) {
      // No --force, no parent pruning: concurrent references prevent removal.
      const child=spawnSync('docker',['image','rm','--no-prune',image.id],{encoding:'utf8',timeout:60000});
      const row={id:image.id,tags:image.tags,exit_code:child.status,output:child.stdout,detail:child.stderr};
      (child.status===0?report.removed:report.skipped).push(row);save();
    }
    // Only the engine's default builder. The owned D: builder and its private
    // fault-test evidence are deliberately excluded. Volumes are never pruned.
    assert.equal(run(['context','show']).trim(),'desktop-linux','Cleanup is limited to the local Docker Desktop context');
    report.cache={builder:'desktop-linux',older_than_hours:24,
      output:run(['buildx','prune','--builder','desktop-linux','--all','--filter','until=24h','--force'],300000)};
    report.after=run(['system','df']);
  }
  report.status=execute?'PASS':'PLAN';
}catch(error){report.status='FAIL';report.error=String(error);process.exitCode=1;}
report.completed_at=new Date().toISOString();
const disk=fs.statfsSync('C:/');report.c_free_bytes=disk.bavail*disk.bsize;save();
console.log(JSON.stringify({status:report.status,eligible_images:report.images.filter(row=>row.eligible).length,
  images_removed:report.removed.length,images_skipped:report.skipped.length,
  cache:report.cache&&{builder:report.cache.builder,older_than_hours:report.cache.older_than_hours,
    result:report.cache.output.trim().split('\n').slice(-2).join('\n')},
  c_free_gib:report.c_free_bytes/1024**3,error:report.error},null,2));
