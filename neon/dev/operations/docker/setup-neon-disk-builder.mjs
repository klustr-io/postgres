// Dedicated BuildKit state on a fresh D: native VHD. Default builder unchanged.
import fs from 'node:fs';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {randomUUID} from 'node:crypto';
import assert from 'node:assert/strict';
import {createBenchmarkVhdVolume} from '../../shared/neon-benchmark-vhd.mjs';
const docker=process.env.DOCKER||'docker';
const root='D:/code-artifacts/postgres-neon-qualification-20261030';
const output='neon/tests/reports/local/neon-isolated-disk-builder.json';
assert(!fs.existsSync(output),'Retain and inspect the existing isolated builder record rather than replacing it');
function run(args){const r=spawnSync(docker,args,{encoding:'utf8',maxBuffer:4*1024**2});assert.equal(r.status,0,r.stderr);return r.stdout.trim();}
const id=randomUUID().slice(0,8),name='neon-pg18-disk-'+id,node=name+'0',stateVolume='buildx_buildkit_'+node+'_state';
const record={status:'SETTING-UP',name,node,state_volume:stateVolume,root,created_at:new Date().toISOString(),
  default_builder_changed:false,docker_volumes_deleted:false,publication_performed:false};
const save=()=>fs.writeFileSync(output,JSON.stringify(record,null,2)+'\n');save();
record.storage=createBenchmarkVhdVolume({root:root+'/builder-vhds',volume:'neon-pg18-benchmark-'+id+'-data',
  image:'sha256:9f236dccd6afcc5f87750959bc233eb63ef28ecce22b67665be52860df241f67'});save();
run(['volume','create','--label','io.klustr.purpose=pg18-isolated-build-cache','--label',`io.klustr.filesystem-uuid=${record.storage.filesystem_uuid}`,
  '--driver','local','--opt','type=ext4','--opt',`device=${record.storage.device}`,'--opt','o=rw',stateVolume]);
console.log('Pulling the pinned-version BuildKit service image for the isolated builder');
run(['pull','moby/buildkit:v0.32.2']);
const image=JSON.parse(run(['image','inspect','moby/buildkit:v0.32.2']))[0];
record.buildkit_image=image.RepoDigests.find(d=>d.startsWith('moby/buildkit@sha256:'));assert(record.buildkit_image);save();
run(['buildx','create','--name',name,'--node',node,'--driver','docker-container',
  '--driver-opt',`image=${record.buildkit_image}`,'--driver-opt','memory=16g','--driver-opt','cpu-period=10000','--driver-opt','cpu-quota=80000']);
console.log('Bootstrapping isolated D: builder '+name);
run(['buildx','inspect',name,'--bootstrap']);
const container=JSON.parse(run(['inspect','buildx_buildkit_'+node]))[0];
assert(container.Mounts.some(m=>m.Name===stateVolume&&m.Destination==='/var/lib/buildkit'));
record.state_mount_verified=true;save();
record.contexts={};
for(const [label,imageId] of [['guard-artifacts','sha256:f3b88abd63ef2088f345aa070825e25ecac772b34ca9cc4794ac941f6e605943'],
  ['guard-benchmark','sha256:9f236dccd6afcc5f87750959bc233eb63ef28ecce22b67665be52860df241f67']]) {
  const directory=path.join(root,'builder-inputs',label+'-'+imageId.slice(7,19)),archive=directory+'.tar';
  assert(!fs.existsSync(directory)&&!fs.existsSync(archive));fs.mkdirSync(directory,{recursive:true});
  console.log('Exporting local OCI input '+label+' onto D:');
  run(['image','save','--output',archive,imageId]);
  const listing=spawnSync('tar.exe',['-tf',archive],{encoding:'utf8',maxBuffer:8*1024**2});assert.equal(listing.status,0,listing.stderr);
  for(const item of listing.stdout.trim().split(/\r?\n/))assert(!item.startsWith('/')&&!item.split('/').includes('..'),'Unsafe archive member');
  const extract=spawnSync('tar.exe',['-xmf',archive,'-C',directory],{encoding:'utf8'});assert.equal(extract.status,0,extract.stderr);
  const index=JSON.parse(fs.readFileSync(path.join(directory,'index.json'),'utf8'));
  assert(fs.existsSync(path.join(directory,'oci-layout'))&&index.manifests.length>=1);
  const descriptor=index.manifests.find(m=>m.digest===imageId)||index.manifests[0];
  record.contexts[label]={image_id:imageId,directory,archive,digest:descriptor.digest,
    argument:`${label}=oci-layout://${directory.replaceAll('\\','/')}@${descriptor.digest}`};save();
}
record.status='PASS';record.completed_at=new Date().toISOString();save();
console.log('PASS isolated builder and local OCI inputs ready; no registry push or global builder selection');
