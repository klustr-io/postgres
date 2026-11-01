// Copy the Node executable and its actual ELF dependency closure into distroless.
// Preserve package records for copied libraries; npm/build tools stay in build.
import fs from 'node:fs';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
const base='/minimal-base',output='/rootfs',inventory={},packages=new Map(),queue=[];
const digest=file=>createHash('sha256').update(fs.readFileSync(file)).digest('hex');
function baseFile(name){
  let current=base,parts=name.replace(/^\//,'').split('/');
  for(let count=0;count<100;count++){
    if(!parts.length)return fs.existsSync(current)?current:null;
    const part=parts.shift();if(!part||part==='.')continue;
    if(part==='..'){if(current===base)throw Error('Base symlink escaped');current=path.dirname(current);continue;}
    const next=path.join(current,part);if(!fs.existsSync(next))return null;
    if(fs.lstatSync(next).isSymbolicLink()){
      const target=fs.readlinkSync(next);if(target.startsWith('/'))current=base;
      parts=target.replace(/^\//,'').split('/').concat(parts);
    }else current=next;
  }
  throw Error('Base symlink loop');
}
function packageFor(file){
  if(file.startsWith('/usr/local/'))return null;
  for(const candidate of new Set([file,fs.realpathSync(file),file.replace(/^\/lib\//,'/usr/lib/')])){
    try{return execFileSync('dpkg-query',['-S',candidate],{encoding:'utf8',stdio:['ignore','pipe','ignore']}).split(': ')[0].trim();}catch{}
  }
  throw Error('Missing OS package provenance for '+file);
}
function copy(file,destination=file){
  if(!destination.startsWith('/')||destination.split('/').includes('..'))throw Error('Unsafe destination');
  if(baseFile(destination)||inventory[destination])return;
  const target=path.join(output,destination);fs.mkdirSync(path.dirname(target),{recursive:true});fs.copyFileSync(file,target);
  const pkg=packageFor(file);inventory[destination]={sha256:digest(file),source_package:pkg};
  if(pkg&&!packages.has(pkg)){
    const stanza=execFileSync('dpkg-query',['-s',pkg],{encoding:'utf8'}),name=stanza.match(/^Package: (.+)$/m)[1];
    const prior=base+'/var/lib/dpkg/status.d/'+name;
    if(fs.existsSync(prior)&&fs.readFileSync(prior,'utf8').match(/^Version: (.+)$/m)?.[1]!==stanza.match(/^Version: (.+)$/m)[1])
      throw Error('Mixed base package versions: '+name);
    packages.set(pkg,stanza);const status=output+'/var/lib/dpkg/status.d/'+name;
    fs.mkdirSync(path.dirname(status),{recursive:true});fs.writeFileSync(status,stanza);
    const license='/usr/share/doc/'+name+'/copyright';
    if(fs.existsSync(license)){const target=output+'/usr/local/share/neon/licenses/'+name;fs.mkdirSync(path.dirname(target),{recursive:true});fs.copyFileSync(license,target);}
  }
  if(fs.readFileSync(file).subarray(0,4).equals(Buffer.from([127,69,76,70])))queue.push(file);
}
copy('/usr/local/bin/node');
while(queue.length){
  const file=queue.pop(),output=execFileSync('ldd',[file],{encoding:'utf8'});
  if(output.includes('not found'))throw Error('Unresolved Node runtime dependency');
  for(const match of output.matchAll(/(?:=>\s+|^\s*)(\/[^\s(]+)/gm))copy(match[1]);
}
const metadata=output+'/usr/local/share/neon';fs.mkdirSync(metadata+'/licenses',{recursive:true});
fs.copyFileSync('/usr/local/LICENSE',metadata+'/licenses/node-LICENSE');
fs.writeFileSync(metadata+'/runtime-file-inventory.json',JSON.stringify(inventory,null,2)+'\n');
fs.writeFileSync(metadata+'/node-runtime.json',JSON.stringify({version:process.version,versions:process.versions,
  source:'Official Node 24.19.0 executable; pinned builder digest in Dockerfile',npm_in_runtime:false},null,2)+'\n');
console.log('Collected Node runtime and '+packages.size+' additional OS library package records');
