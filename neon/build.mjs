// One checkout -> one source compilation -> seven local OCI images.
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawnSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import assert from 'node:assert/strict';
process.chdir(path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..'));
for(const version of ['v14','v15','v16','v17'])
  assert(fs.existsSync(`neon/vendor/pg-ffi/${version}/include/postgresql/server/postgres.h`),`Missing licensed decoder headers: ${version}`);
const docker=process.env.DOCKER||'docker';
const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
const read=file=>JSON.parse(fs.readFileSync(file,'utf8').replace(/^\uFEFF/,''));
const arg=name=>process.argv.find(value=>value.startsWith(name+'='))?.slice(name.length+1);
const version=arg('--version')||'18.6-dev';assert(/^[a-zA-Z0-9_.-]+$/.test(version));
const jobs=process.env.BUILD_JOBS||'8';assert(/^[1-9][0-9]*$/.test(jobs));
const output=path.resolve('build/monorepo-'+new Date().toISOString().replace(/\D/g,''));
fs.mkdirSync(output,{recursive:true});
const record={status:'BUILDING',version,source:'Current working tree, including uncommitted changes',
  output,started_at:new Date().toISOString(),images:{},production_qualified:false};
const save=()=>fs.writeFileSync(path.join(output,'build.json'),JSON.stringify(record,null,2)+'\n');save();
const run=(program,args,options={})=>{
  const result=spawnSync(program,args,{encoding:'utf8',maxBuffer:256*1024*1024,...options});
  assert.equal(result.status,0,result.stderr||`Command failed: ${program} ${args[0]}`);return result.stdout;
};
const git=args=>run('git',args);
const context=path.join(output,'context');fs.mkdirSync(context);
const archive=path.join(output,'tracked-source.tar');
run('git',['-c','core.autocrlf=false','archive','--format=tar','--output='+archive,'HEAD']);
run('tar',['-xmf',archive,'-C',context]);
const changed=git(['diff','HEAD','--name-only']).trim().split('\n').filter(Boolean);
const added=git(['ls-files','--others','--exclude-standard','--','src','contrib','doc','config','neon','.dockerignore','.github/workflows']).trim().split('\n').filter(Boolean);
const inputs={};
for(const name of new Set([...changed,...added])){
  if(name.split('/').some(part=>['local','node_modules','__pycache__'].includes(part))||
     name.startsWith('neon/tests/reports/local/')||/(^|\/)\.env(?:\.|$)/.test(name)&&!name.endsWith('.env.example'))continue;
  assert(!path.isAbsolute(name)&&!name.split('/').includes('..'));
  const target=path.join(context,name);
  if(!fs.existsSync(name)){if(fs.existsSync(target))fs.unlinkSync(target);continue;}
  assert(fs.lstatSync(name).isFile(),'Build inputs must be regular files: '+name);
  let bytes=fs.readFileSync(name);if(!bytes.includes(0))bytes=Buffer.from(bytes.toString('utf8').replaceAll('\r\n','\n'));
  fs.mkdirSync(path.dirname(target),{recursive:true});fs.writeFileSync(target,bytes);inputs[name]=hash(bytes);
}
record.base_commit=git(['rev-parse','HEAD']).trim();record.changed_inputs=inputs;
record.source_digest=hash(JSON.stringify({base:record.base_commit,inputs}));
fs.writeFileSync(path.join(context,'neon/build-inputs.json'),JSON.stringify({base_commit:record.base_commit,source_digest:record.source_digest,changed_inputs:inputs},null,2)+'\n');
let builder=arg('--builder')||process.env.NEON_BUILDX_BUILDER;
const localBuilder='neon/tests/reports/local/neon-isolated-disk-builder.json';
if(!builder&&fs.existsSync(localBuilder))builder=read(localBuilder).name;
const buildPrefix=['buildx','build',...(builder?['--builder',builder]:[]),'--platform','linux/amd64','--progress=plain','--provenance=false'];
const build=(name,args)=>{
  console.log('BUILD '+name+'; '+path.join(output,name+'.log'));
  const fd=fs.openSync(path.join(output,name+'.log'),'w');
  try{run(docker,[...buildPrefix,...args],{stdio:['ignore',fd,fd]});}finally{fs.closeSync(fd);}
};
const toolchain=arg('--toolchain-image')||'klustr-neon-toolchain:18.6';
if(arg('--toolchain-image'))assert(/^sha256:[a-f0-9]{64}$/.test(toolchain),'Toolchain override must use an immutable local image ID');
try{
  if(process.argv.includes('--plan')){
    record.status='PLAN';record.toolchain=toolchain;save();console.log(JSON.stringify({output,source_digest:record.source_digest,toolchain,roles:['compute','pageserver','safekeeper','storage-controller','storage-broker','proxy','tenant-controller']},null,2));process.exit(0);
  }
  if(!arg('--toolchain-image')){
    const native=path.join(output,'native');fs.mkdirSync(native);
    const lock=read('neon/packaging/neon/native-dependencies.lock.json');
    for(const source of [...lock.sources,...lock.auxiliary_sources]){
      const destination=path.join(native,source.archive),cached=path.join('build/neon-native-context',source.archive);
      if(fs.existsSync(cached))fs.copyFileSync(cached,destination);
      else run(process.platform==='win32'?'curl.exe':'curl',['--fail','--location','--silent','--show-error','--max-time','180','--output',destination,source.url]);
      assert.equal(hash(fs.readFileSync(destination)),source.sha256,'Dependency hash mismatch: '+source.name);
    }
    build('toolchain',['--build-context','native-inputs='+native,'--build-arg','BUILD_JOBS='+jobs,'--file',path.join(context,'neon/packaging/docker/neon/Dockerfile.toolchain'),'--load','--tag',toolchain,context]);
  }
  const identity=JSON.parse(run(docker,['image','inspect',toolchain]))[0];
  record.toolchain={image_id:identity.Id,override:Boolean(arg('--toolchain-image'))};save();
  if(process.argv.includes('--toolchain-only')){
    record.status='TOOLCHAIN-BUILD-PASS';record.completed_at=new Date().toISOString();save();
    console.log(JSON.stringify({status:record.status,toolchain:record.toolchain,output},null,2));process.exit(0);
  }
  const extensions=read('neon/packaging/neon/extensions.lock.json');
  const extensionInputs=path.join(output,'extensions');fs.mkdirSync(extensionInputs);
  for(const source of extensions.sources){
    const destination=path.join(extensionInputs,source.archive),cached=path.join('build/extension-inputs',source.archive);
    if(fs.existsSync(cached))fs.copyFileSync(cached,destination);
    else if(source.repository){
      const checkout=path.join(extensionInputs,source.name+'-source');
      run('git',['init',checkout]);
      const gitCheckout=['-c','safe.directory='+fs.realpathSync(checkout).replaceAll('\\','/'),
        '-c','core.autocrlf=false','-c','tar.umask=0022','-C',checkout];
      run('git',[...gitCheckout,'fetch','--depth=1',source.repository,source.revision]);
      assert.equal(run('git',[...gitCheckout,'rev-parse','FETCH_HEAD']).trim(),source.revision);
      run('git',[...gitCheckout,'archive','--format=tar','--output='+destination,'FETCH_HEAD']);
      assert.equal(path.dirname(fs.realpathSync(checkout)),fs.realpathSync(extensionInputs));
      fs.rmSync(fs.realpathSync(checkout),{recursive:true});
    }else run(process.platform==='win32'?'curl.exe':'curl',['--fail','--location','--silent','--show-error','--max-time','180','--output',destination,source.url]);
    assert.equal(hash(fs.readFileSync(destination)),source.sha256,'Extension dependency hash mismatch: '+source.name);
  }
  record.extensions=extensions;save();
  // This also lets a container-driver builder use the exact local toolchain.
  const toolchainArchive=path.join(output,'toolchain.tar'),toolchainLayout=path.join(output,'toolchain');
  run(docker,['image','save','--output',toolchainArchive,identity.Id]);fs.mkdirSync(toolchainLayout);
  run('tar',['-xmf',toolchainArchive,'-C',toolchainLayout]);
  const index=read(path.join(toolchainLayout,'index.json'));
  assert(index.manifests.some(item=>item.digest===identity.Id));
  for(const name of fs.readdirSync(path.join(toolchainLayout,'blobs/sha256')))
    assert.equal(hash(fs.readFileSync(path.join(toolchainLayout,'blobs/sha256',name))),name);
  const sourceArgs=['--build-context',`build-toolchain=oci-layout://${toolchainLayout.replaceAll('\\','/')}@${identity.Id}`,
    '--build-context','extension-inputs='+extensionInputs,
    '--build-arg','TOOLCHAIN_IMAGE=build-toolchain','--build-arg','BUILD_JOBS='+jobs,
    '--build-arg','SOURCE_REVISION='+record.base_commit,
    '--build-arg','RUST_CACHE_NAMESPACE='+(process.env.NEON_RUST_CACHE_NAMESPACE||'neon-monorepo'),
    '--file',path.join(context,'neon/packaging/docker/neon/Dockerfile')];
  if(process.argv.includes('--verify-native-oauth')){
    const artifactTag='klustr-neon-artifacts:oauth-'+record.source_digest.slice(0,12);
    build('oauth-artifacts',[...sourceArgs,'--target','artifacts','--load','--tag',artifactTag,context]);
    const report=path.join(output,'native-oauth.json');
    const fd=fs.openSync(path.join(output,'native-oauth.log'),'w');
    try{run(process.execPath,['neon/tests/neon/identity/native-oauth.mjs'],{
      env:{...process.env,NEON_OAUTH_ARTIFACT_IMAGE:artifactTag,NEON_OAUTH_REPORT_FILE:report},stdio:['ignore',fd,fd]});}
    finally{fs.closeSync(fd);}
    record.native_oauth=read(report);assert.equal(record.native_oauth.passed,true);save();
  }
  for(const role of ['compute','pageserver','safekeeper','storage-controller','storage-broker','proxy']){
    const tag=`klustr-neon-${role}:${version}`;
    build(role,[...sourceArgs,'--target',role,'--load','--tag',tag,context]);
    const image=JSON.parse(run(docker,['image','inspect',tag]))[0];assert.equal(image.Config.User,'10001:10001');
    record.images[role]={tag,image_id:image.Id};save();
    if(role==='compute'){
      const fd=fs.openSync(path.join(output,'compute-extensions.log'),'w');
      try{run(docker,['run','--rm','--network','none','--read-only','--cap-drop','ALL','--security-opt','no-new-privileges',
        '--tmpfs','/tmp:rw,size=512m,uid=10001,gid=10001','--shm-size','256m','--env','PGUSER=neon','--env','USER=neon',
        '--mount',`type=bind,source=${path.join(context,'neon/tests/neon/smoke')},target=/smoke,readonly`,
        '--entrypoint','/bin/sh',image.Id,'/smoke/check_minimal_postgres.sh'],{stdio:['ignore',fd,fd]});}
      finally{fs.closeSync(fd);}
      record.images[role].extensions_smoke='PASS';save();
      if(process.argv.includes('--verify-native-oauth')){
        const report=path.join(output,'statement-telemetry.json');
        const telemetryLog=fs.openSync(path.join(output,'statement-telemetry.log'),'w');
        try{run(process.execPath,['neon/tests/neon/compute/statement-telemetry.mjs'],{
          env:{...process.env,NEON_TELEMETRY_IMAGE:image.Id,NEON_TELEMETRY_REPORT_FILE:report},stdio:['ignore',telemetryLog,telemetryLog]});}
        finally{fs.closeSync(telemetryLog);}
        record.statement_telemetry=read(report);assert.equal(record.statement_telemetry.passed,true);save();
      }
    }
  }
  // Bind the operator's deployment artifact to this build, rather than the
  // previously published defaults in the checked-in deployment examples.
  let fleetBundle=fs.readFileSync(path.join(context,'neon/packaging/kubernetes/fleet-stack.json'),'utf8');
  const runtimeImages={};
  for(const [role,image] of Object.entries(record.images)){
    assert(/^sha256:[a-f0-9]{64}$/.test(image.image_id));
    const expression=new RegExp('ghcr\\.io/klustr-io/neon-'+role+'@sha256:[a-f0-9]{64}','g');
    assert(expression.test(fleetBundle),'Missing packaged runtime: '+role);
    runtimeImages[role]='ghcr.io/klustr-io/neon-'+role+'@'+image.image_id;
    fleetBundle=fleetBundle.replace(expression,runtimeImages[role]);
  }
  JSON.parse(fleetBundle);
  fs.writeFileSync(path.join(context,'neon/build-fleet-stack.json'),fleetBundle);
  record.fleet_release={runtime_images:runtimeImages,bundle_sha256:hash(Buffer.from(fleetBundle))};save();
  const tag=`klustr-neon-tenant-controller:${version}`;
  build('tenant-controller',['--build-arg','SOURCE_REVISION='+record.base_commit,'--build-arg','FLEET_BUNDLE=neon/build-fleet-stack.json','--file',path.join(context,'neon/packaging/docker/neon/runtime/Dockerfile.tenant-controller'),'--load','--tag',tag,context]);
  record.images['tenant-controller']={tag,image_id:JSON.parse(run(docker,['image','inspect',tag]))[0].Id};
  const packagedBundle=run(docker,['run','--rm','--network','none','--read-only','--cap-drop','ALL','--security-opt','no-new-privileges','--entrypoint','/usr/local/bin/node',record.images['tenant-controller'].image_id,'--input-type=module','-e',
    "import {PackagedFleetResources} from '/app/src/infrastructure/provisioning/FleetResources.mjs'; import fs from 'node:fs'; PackagedFleetResources('/app/fleet-templates'); process.stdout.write(fs.readFileSync('/app/fleet-templates/fleet-stack.json')); "]);
  assert.equal(hash(Buffer.from(packagedBundle)),record.fleet_release.bundle_sha256,'Controller packaged runtime release differs');
  for(const [role,image] of Object.entries(record.images)){
    const executable=role==='compute'?'/opt/postgres/v18/bin/postgres':role==='tenant-controller'?'/usr/local/bin/node':'/usr/local/bin/'+role.replaceAll('-','_');
    image.executable_smoke=run(docker,['run','--rm','--network','none','--read-only','--cap-drop','ALL','--security-opt','no-new-privileges','--entrypoint',executable,image.image_id,role==='storage-controller'?'--help':'--version']).trim();
    const directory=path.join(output,'images');fs.mkdirSync(directory,{recursive:true});
    image.archive=path.join(directory,role+'.oci.tar');
    run(docker,['image','save','--output',image.archive,image.image_id]);
    image.archive_sha256=hash(fs.readFileSync(image.archive));
  }
  record.status='SOURCE-BUILD-AND-IMAGE-SMOKE-PASS';record.completed_at=new Date().toISOString();save();
  fs.mkdirSync('neon/tests/reports/local',{recursive:true});fs.writeFileSync('neon/tests/reports/local/neon-source-build.json',JSON.stringify(record,null,2)+'\n');
  console.log(JSON.stringify({status:record.status,output,images:record.images},null,2));
}catch(error){record.status='FAIL';record.error=error.message;save();throw error;}
