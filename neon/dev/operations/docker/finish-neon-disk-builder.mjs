import fs from 'node:fs';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import assert from 'node:assert/strict';
const file='neon/tests/reports/local/neon-isolated-disk-builder.json',record=JSON.parse(fs.readFileSync(file,'utf8'));
assert(record.state_mount_verified&&/^neon-pg18-disk-[a-f0-9]{8}$/.test(record.name));
const docker=process.env.DOCKER||'docker';
const volume=spawnSync(docker,['volume','inspect',record.state_volume],{encoding:'utf8'});assert.equal(volume.status,0);
assert.equal(JSON.parse(volume.stdout)[0].Options.device,record.storage.device);
record.contexts??={};
for(const [label,id] of [['guard-artifacts','sha256:f3b88abd63ef2088f345aa070825e25ecac772b34ca9cc4794ac941f6e605943'],
  ['guard-benchmark','sha256:9f236dccd6afcc5f87750959bc233eb63ef28ecce22b67665be52860df241f67']]) {
  const directory=path.join(record.root,'builder-inputs',label+'-'+id.slice(7,19)),archive=directory+'.tar';
  assert(path.resolve(directory).startsWith(path.resolve(record.root)+path.sep));fs.mkdirSync(directory,{recursive:true});
  if(!fs.existsSync(archive)) {
    const saved=spawnSync(docker,['image','save','--output',archive,id],{stdio:'inherit'});assert.equal(saved.status,0);
  }
  const listed=spawnSync('tar.exe',['-tf',archive],{encoding:'utf8',maxBuffer:8*1024**2});assert.equal(listed.status,0);
  assert(listed.stdout.trim().split(/\r?\n/).every(p=>!p.startsWith('/')&&!p.split('/').includes('..')));
  const extracted=spawnSync('tar.exe',['-xmf',archive,'-C',directory],{encoding:'utf8'});assert.equal(extracted.status,0,extracted.stderr);
  const index=JSON.parse(fs.readFileSync(path.join(directory,'index.json'),'utf8'));
  assert(index.manifests.some(d=>d.digest===id),'Export must contain the exact requested image index');
  let count=0;
  for(const blob of fs.readdirSync(path.join(directory,'blobs/sha256'))) {
    assert(/^[a-f0-9]{64}$/.test(blob));const hash=createHash('sha256');
    for await(const chunk of fs.createReadStream(path.join(directory,'blobs/sha256',blob)))hash.update(chunk);
    assert.equal(hash.digest('hex'),blob);count++;
  }
  record.contexts[label]={image_id:id,directory,archive,digest:id,verified_blob_count:count,
    argument:`${label}=oci-layout://${directory.replaceAll('\\','/')}@${id}`};
  fs.writeFileSync(file,JSON.stringify(record,null,2)+'\n');console.log('PASS local OCI input '+label+'; '+count+' verified blobs');
}
record.status='PASS';record.completed_at=new Date().toISOString();fs.writeFileSync(file,JSON.stringify(record,null,2)+'\n');
console.log('PASS isolated D: builder ready; default builder unchanged; no publication');
