// Windows companion: export Git's LF source without starting a WSL distro.
import {spawnSync} from 'node:child_process';
import {readFileSync,writeFileSync,mkdirSync,mkdtempSync,readdirSync,lstatSync,existsSync} from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import assert from 'node:assert/strict';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../../../..');
process.chdir(root);
function git(args,binary=false) {
  const result=spawnSync('git',['-c','core.autocrlf=true',...args],{encoding:binary ? undefined : 'utf8',maxBuffer:256*1024*1024});
  assert.equal(result.status,0,String(result.stderr));
  return result.stdout;
}
mkdirSync('build',{recursive:true});
const revision=git(['rev-parse','HEAD']).trim();
const archive=git(['-c','core.autocrlf=false','archive','--format=tar','HEAD'],true);
assert.equal(git(['rev-parse','HEAD']).trim(),revision,'Source revision changed during export.');
const context=mkdtempSync(path.join(root,'build','oci-context-'));
const extracted=spawnSync('tar',['-xf','-','-C',context],{input:archive,maxBuffer:8*1024*1024});
assert.equal(extracted.status,0,String(extracted.stderr));
const overlay=new Set(['.dockerignore','neon/Makefile']);
for(const name of git(['diff','HEAD','--name-only']).split('\n').filter(Boolean)) overlay.add(name);
for(const name of git(['ls-files','--others','--exclude-standard','--','src','contrib']).split('\n').filter(Boolean)) overlay.add(name);
function visit(directory) {
  if(!existsSync(directory)) return;
  for(const entry of readdirSync(directory,{withFileTypes:true})) {
    const name=`${directory}/${entry.name}`;
    if(name==='neon/dev/.env'||name==='neon/dev/.venv'||name==='neon/tests/reports'||entry.name==='__pycache__'||entry.name==='.pytest_cache') continue;
    if(entry.isDirectory()) visit(name);
    else if(entry.isFile()) overlay.add(name);
    else throw new Error(`Inspect linked source before packaging: ${name}`);
  }
}
for(const directory of ['neon/dev','neon/packaging','neon/tests','neon/docs/qualification']) visit(directory);
for(const name of [...overlay].sort()) {
  assert(!name.split('/').includes('..')&&!path.isAbsolute(name));
  if(!existsSync(name)) {
    assert(!existsSync(path.join(context,name)),`Tracked deletion was not applied by archive overlay: ${name}`);
    continue;
  }
  assert(lstatSync(name).isFile(),`Inspect non-regular source: ${name}`);
  const raw=readFileSync(name);
  const data=raw.includes(0) ? raw : Buffer.from(raw.toString('utf8').replaceAll('\r\n','\n'));
  const target=path.join(context,name);
  mkdirSync(path.dirname(target),{recursive:true});
  writeFileSync(target,data);
}
writeFileSync('build/oci-context-path',path.relative(root,context).replaceAll('\\','/')+'\n');
assert(!readFileSync(path.join(context,'configure'),'utf8').includes('\r\n'),'Exported configure contains Windows line endings.');
console.log(`Prepared ${revision} plus explicit local changes in ${context}`);
