// Publish verified GitHub-built OCI archives; never rebuild during publication.
import fs from 'node:fs';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import assert from 'node:assert/strict';
const arg=name=>process.argv.find(value=>value.startsWith(name+'='))?.slice(name.length+1);
const read=file=>JSON.parse(fs.readFileSync(file,'utf8').replace(/^\uFEFF/,''));
const sha=bytes=>createHash('sha256').update(bytes).digest('hex');
const run=(program,args,options={})=>{const r=spawnSync(program,args,{encoding:'utf8',maxBuffer:16*1024*1024,...options});assert.equal(r.status,0,r.stderr||`Command failed: ${program} ${args[0]}`);return r.stdout;};
const matches=[];
function search(folder){for(const e of fs.readdirSync(folder,{withFileTypes:true})){
  const file=path.join(folder,e.name);
  if(e.isDirectory()&&!['context','toolchain','node_modules'].includes(e.name))search(file);
  else if(e.isFile()&&e.name==='build.json'&&read(file).status==='SOURCE-BUILD-AND-IMAGE-SMOKE-PASS')matches.push(file);
}}
search(path.resolve(arg('--input')||'build'));assert.equal(matches.length,1,'Expected one successful build artifact');
const buildFile=matches[0],build=read(buildFile),version=arg('--version')||build.version;
assert.equal(build.native_oauth?.passed,true,'Native OAuth qualification must pass before publication');
assert.equal(build.native_oauth?.opaqueIntrospection,true,'Opaque token introspection qualification must pass before publication');
assert.equal(build.native_oauth?.managementIntrospection,true,'Management introspection qualification must pass before publication');
assert(/^[a-z0-9][a-z0-9_.-]{0,110}$/.test(version),'Invalid version');
const repository=(process.env.GITHUB_REPOSITORY||'klustr-io/postgres').toLowerCase();assert.equal(repository,'klustr-io/postgres');
const commit=process.env.GITHUB_SHA||build.base_commit;assert(/^[a-f0-9]{40}$/.test(commit));
const roles=['compute','pageserver','safekeeper','storage-controller','storage-broker','proxy','tenant-controller'];
assert.deepEqual(Object.keys(build.images).sort(),[...roles].sort());
const output=path.resolve(arg('--output')||'build/published-release');fs.mkdirSync(output,{recursive:true});
const manifest={schema_version:1,version,platform:'linux/amd64',source_repository:'https://github.com/'+repository,
  source_commit:commit,source_digest:build.source_digest,created_at:new Date().toISOString(),production_qualified:false,
  validation:'Source build, PostgreSQL regressions, native libpq/proxy/validator OAuth integration, protocol tests and non-root/read-only executable smoke. Production HA/RPO/performance qualification remains open.',
  native_oauth:build.native_oauth,images:{}};
const archives={};
for(const role of roles){
  const file=path.join(path.dirname(buildFile),'images',role+'.oci.tar');assert.equal(sha(fs.readFileSync(file)),build.images[role].archive_sha256,'Archive checksum: '+role);
  const index=JSON.parse(run('tar',['-xOf',file,'index.json']));
  const descriptor=index.manifests.find(x=>x.digest===build.images[role].image_id);assert(descriptor,'Archive identity: '+role);
  const image=JSON.parse(run('tar',['-xOf',file,'blobs/sha256/'+descriptor.digest.slice(7)]));
  const config=JSON.parse(run('tar',['-xOf',file,'blobs/sha256/'+image.config.digest.slice(7)]));
  assert.equal(config.architecture,'amd64');assert.equal(config.os,'linux');assert.equal(config.config.User,'10001:10001');
  archives[role]={file,config_digest:image.config.digest,revision:config.config.Labels?.['org.opencontainers.image.revision']};
  const name='ghcr.io/klustr-io/neon-'+role;
  manifest.images[role]={image:name+':'+version,immutable_tag:name+':sha-'+commit,archive:role+'.oci.tar',archive_sha256:build.images[role].archive_sha256};
}
if(process.argv.includes('--plan')){console.log(JSON.stringify({status:'ARCHIVES-VERIFIED',version,commit,clean_source:Object.keys(build.changed_inputs).length===0,roles},null,2));process.exit(0);}
assert.equal(process.env.GITHUB_ACTIONS,'true','Publication runs in GitHub Actions');
assert.notEqual(process.env.GITHUB_EVENT_NAME,'pull_request','Pull requests never publish');
assert.equal(build.base_commit,commit,'Artifact commit differs');assert.equal(Object.keys(build.changed_inputs).length,0,'Source must be committed');
for(const archive of Object.values(archives))assert.equal(archive.revision,commit,'Image revision label differs');
const token=process.env.GITHUB_TOKEN;assert(token&&process.env.GITHUB_ACTOR,'Missing registry credentials');
run('docker',['login','ghcr.io','--username',process.env.GITHUB_ACTOR,'--password-stdin'],{input:token+'\n'});
async function remote(role,tag,anonymous=false,allowAbsent=false){
  const name='klustr-io/neon-'+role,headers=anonymous?{}:{Authorization:'Basic '+Buffer.from(process.env.GITHUB_ACTOR+':'+token).toString('base64')};
  const response=await fetch('https://ghcr.io/token?service=ghcr.io&scope='+encodeURIComponent('repository:'+name+':pull'),{headers});
  if((anonymous||allowAbsent)&&[401,403,404].includes(response.status))return null;
  assert(response.ok,'Registry token HTTP '+response.status);
  const credential=await response.json();
  const result=await fetch('https://ghcr.io/v2/'+name+'/manifests/'+tag,{headers:{Authorization:'Bearer '+credential.token,
    Accept:'application/vnd.oci.image.manifest.v1+json, application/vnd.docker.distribution.manifest.v2+json'}});
  if(result.status===404||anonymous&&!result.ok)return null;assert(result.ok,'Registry manifest HTTP '+result.status);
  const data=await result.json(),digest=result.headers.get('docker-content-digest');assert(/^sha256:[a-f0-9]{64}$/.test(digest));return {digest,data};
}
// Verify all commit tags before advancing any named version or channel.
for(const role of roles){
  const image=manifest.images[role],archive=archives[role],previous=await remote(role,'sha-'+commit,false,true);
  if(previous)assert.equal(previous.data.config.digest,archive.config_digest,'Immutable commit tag differs');
  else{run('docker',['load','--input',archive.file]);run('docker',['tag',build.images[role].image_id,image.immutable_tag]);run('docker',['push',image.immutable_tag]);}
  const published=await remote(role,'sha-'+commit);assert.equal(published.data.config.digest,archive.config_digest);
  image.digest=published.digest;image.pinned='ghcr.io/klustr-io/neon-'+role+'@'+published.digest;console.log('Verified '+image.pinned);
}
for(const role of roles){
  const image=manifest.images[role],previous=await remote(role,version);
  if(previous)assert.equal(previous.digest,image.digest,'Refusing to overwrite an existing version');
  else run('docker',['buildx','imagetools','create','--prefer-index=false','--tag',image.image,image.pinned]);
  assert.equal((await remote(role,version)).digest,image.digest);
}
if(process.env.GITHUB_REF_TYPE==='tag')for(const role of roles){
  const image=manifest.images[role],channel=version.includes('-')?'candidate':'latest';
  run('docker',['buildx','imagetools','create','--prefer-index=false','--tag','ghcr.io/klustr-io/neon-'+role+':'+channel,image.pinned]);
}
for(const role of roles)manifest.images[role].anonymous_pull_verified=(await remote(role,version,true))?.digest===manifest.images[role].digest;
manifest.public_registry_pull_verified=roles.every(role=>manifest.images[role].anonymous_pull_verified);
fs.writeFileSync(path.join(output,'release-manifest.json'),JSON.stringify(manifest,null,2)+'\n');
const checksums=[];
for(const role of roles){fs.copyFileSync(archives[role].file,path.join(output,role+'.oci.tar'));checksums.push(manifest.images[role].archive_sha256+'  '+role+'.oci.tar');}
checksums.push(sha(fs.readFileSync(path.join(output,'release-manifest.json')))+'  release-manifest.json');fs.writeFileSync(path.join(output,'SHA256SUMS'),checksums.join('\n')+'\n');
const table=['| Component | Digest-pinned image |','|---|---|',...roles.map(role=>'| '+role+' | `'+manifest.images[role].pinned+'` |')].join('\n');
let notes=fs.readFileSync('neon/RELEASE-NOTES.md','utf8')+'\n\n## Published image digests\n\n'+table+'\n';
if(!manifest.public_registry_pull_verified)notes+='\nGHCR packages initially need their visibility set to **Public** in package settings. Public OCI archives attached here can be downloaded without registry authentication. Anonymous-pull verification is recorded per image.\n';
fs.writeFileSync(path.join(output,'release-notes.md'),notes);
if(process.env.GITHUB_REF_TYPE==='tag'){
  const tag=process.env.GITHUB_REF_NAME;assert.equal(tag,'neon-v'+version);
  const files=roles.map(role=>path.join(output,role+'.oci.tar')).concat(['release-manifest.json','SHA256SUMS'].map(f=>path.join(output,f)));
  const options={env:{...process.env,GH_TOKEN:token}};
  const exists=spawnSync('gh',['release','view',tag,'--repo',repository],{...options,stdio:'ignore'}).status===0;
  if(exists){
    const current=JSON.parse(run('gh',['api','repos/'+repository+'/releases/tags/'+tag],options));
    for(const role of roles){
      const name=role+'.oci.tar',asset=current.assets.find(a=>a.name===name);
      if(asset)assert.equal(asset.digest,'sha256:'+manifest.images[role].archive_sha256,'Existing release archive differs');
      else run('gh',['release','upload',tag,'--repo',repository,path.join(output,name)],options);
    }
    run('gh',['release','upload',tag,'--repo',repository,'--clobber',path.join(output,'release-manifest.json'),path.join(output,'SHA256SUMS')],options);
    run('gh',['release','edit',tag,'--repo',repository,'--notes-file',path.join(output,'release-notes.md')],options);
  }
  else run('gh',['release','create',tag,'--repo',repository,'--verify-tag','--title','Neon PostgreSQL '+version,'--notes-file',path.join(output,'release-notes.md'),...(version.includes('-')?['--prerelease']:[]),...files],options);
}
console.log(JSON.stringify({status:'PUBLISHED',version,commit,public_registry_pull_verified:manifest.public_registry_pull_verified,manifest:path.join(output,'release-manifest.json')}));
