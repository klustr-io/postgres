import {spawnSync} from 'node:child_process';
import {readFileSync,writeFileSync} from 'node:fs';
import assert from 'node:assert/strict';
import {sourceProvenance} from '../shared/source-provenance.mjs';
const reports=process.env.REPORT_DIR || 'neon/tests/reports/local';
const version=readFileSync('configure.ac','utf8').match(/AC_INIT\(\[PostgreSQL\], \[([^\]]+)\]/)[1];
const image=process.env.PG_IMAGE || `klustr-postgres:${version}-dev`;
const provenance=sourceProvenance();
writeFileSync(`${reports}/source-provenance.json`,JSON.stringify(provenance,null,2)+'\n');
function docker(args) {
  const r=spawnSync(process.env.DOCKER || 'docker',args,{encoding:'utf8',maxBuffer:16*1024*1024});
  assert.equal(r.status,0,r.stderr);
  return r.stdout.trim();
}
for(const name of ['builder-packages.txt','runtime-packages.txt','source-revision','source-patch-sha256','postgres.sha256']) {
  writeFileSync(`${reports}/${name}`,docker(['run','--rm',image,'cat',`/opt/postgres/share/qualification/${name}`])+'\n');
}
const info=JSON.parse(docker(['info','--format','{{json .}}']));
const selected=Object.fromEntries(['ServerVersion','OperatingSystem','OSType','Architecture','NCPU','MemTotal','Driver','DockerRootDir','SecurityOptions'].map(key=>[key,info[key]]));
writeFileSync(`${reports}/docker-info.json`,JSON.stringify(selected,null,2)+'\n');
writeFileSync(`${reports}/docker-version.json`,docker(['version','--format','{{json .}}'])+'\n');
writeFileSync(`${reports}/compose-version.txt`,docker(['compose','version'])+'\n');
const id=docker(['compose','--env-file','neon/dev/.env','-f','neon/dev/operations/docker/compose.yaml','ps','-q','postgres']);
writeFileSync(`${reports}/container-state.json`,docker(['inspect','--format','{{json .State}}',id])+'\n');
writeFileSync(`${reports}/volume.json`,docker(['volume','inspect','klustr-pg18-dev-data'])+'\n');
const context=readFileSync('build/oci-context-path','utf8').trim();
const changes=spawnSync('git',['-c','core.autocrlf=true','diff','--name-only','HEAD','--','src','contrib','configure','configure.ac','meson.build','meson_options.txt'],{encoding:'utf8'});
assert.equal(changes.status,0,changes.stderr);
const sourceFiles=new Set([...changes.stdout.trim().split('\n').filter(Boolean),...provenance.added.map(row=>row.path)]);
for(const name of [...sourceFiles,'neon/packaging/docker/postgres/Dockerfile','neon/packaging/docker/postgres/entrypoint.sh']) {
  assert.equal(readFileSync(`${context}/${name}`,'utf8').replaceAll('\r\n','\n'),readFileSync(name,'utf8').replaceAll('\r\n','\n'),`Built context differs: ${name}`);
}
console.log('Captured image package/binary provenance, Docker/volume/state metadata; final source patch, Dockerfile and entrypoint match the built context.');
