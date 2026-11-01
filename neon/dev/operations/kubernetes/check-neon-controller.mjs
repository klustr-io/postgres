// One fresh namespace/PVC/S3 prefix: actual native proxy -> managed PG18 compute
// -> authenticated Neon storage -> S3, then idle-to-zero and wake/readback.
// Retain new database state on completion; never touch an existing fixture.
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {randomUUID,randomBytes,pbkdf2Sync,createHmac,createHash} from 'node:crypto';
import {localConfiguration,s3Configuration} from '../../shared/neon-qualification-config.mjs';
import {controllerResources} from '../../../packaging/kubernetes/tenant-controller.mjs';
import {endpointConfig,renderSpec} from '../../../controller/tenant-compute/config.mjs';
const docker=process.env.DOCKER||'docker',values=localConfiguration();
const base=['--kubeconfig',values.NEON_K8S_KUBECONFIG,'--context',values.NEON_K8S_CONTEXT,'--request-timeout=30s'];
assert(base.every(Boolean));assert(values.NEON_K8S_NODE_CONTAINER);
const resume=process.env.NEON_CONTROLLER_SMOKE_RESUME;
const previous=resume?JSON.parse(fs.readFileSync(resume,'utf8')):null;
const id=previous?.namespace.slice('neon-controller-'.length)||randomUUID().slice(0,8),namespace='neon-controller-'+id;
assert(/^[a-f0-9]{8}$/.test(id));
const directory=path.resolve(`build/neon-controller-private-${id}`);fs.mkdirSync(directory,{recursive:true});
const reportFile=`neon/tests/reports/local/neon-controller-${id}.json`;
const record=previous||{status:'RUNNING',namespace,started_at:new Date().toISOString(),
  scope:'Single local worker and a small real-S3 fixture; native proxy, guarded compute, configurable idle suspension and wake. Not HA storage qualification.',phases:[]};
if(record.error){(record.previous_attempts??=[]).push({error:record.error,completed_at:record.completed_at});delete record.error;}
record.status='RUNNING';let backendPod=record.backend_pod||'neon-storage';
const save=()=>fs.writeFileSync(reportFile,JSON.stringify(record,null,2)+'\n');save();
const run=(program,args,{input,publicOutput=false}={})=>{
  const result=spawnSync(program,args,{input,encoding:'utf8',maxBuffer:16*1024*1024});
  if(result.status!==0)throw Error(`${program} ${args[0]} failed (exit ${result.status}); private state retained`);
  if(publicOutput)console.log(result.stdout.trim());return result.stdout;
};
const kube=(args,input)=>run('kubectl',[...base,...args],{input});
const apply=items=>kube(['apply','-f','-'],JSON.stringify({apiVersion:'v1',kind:'List',items:Array.isArray(items)?items:[items]}));
const wait=async(check,seconds=120)=>{
  const end=Date.now()+seconds*1000;
  do{const result=await check();if(result)return result;await new Promise(resolve=>setTimeout(resolve,1000));}while(Date.now()<end);
  throw Error('Controller smoke deadline exceeded; inspect retained namespace');
};
const json=(args)=>JSON.parse(kube(args));
const secret=(name,data)=>({apiVersion:'v1',kind:'Secret',metadata:{name,namespace},type:'Opaque',
  data:Object.fromEntries(Object.entries(data).map(([key,value])=>[key,Buffer.from(value).toString('base64')]))});
const phase=name=>{record.phases.push({name,status:'PASS',at:new Date().toISOString()});save();console.log('PASS '+name);};
function scram(password){
  const salt=randomBytes(16),salted=pbkdf2Sync(password,salt,4096,32,'sha256');
  const client=createHmac('sha256',salted).update('Client Key').digest();
  const stored=createHash('sha256').update(client).digest('base64');
  const server=createHmac('sha256',salted).update('Server Key').digest('base64');
  return `SCRAM-SHA-256$4096:${salt.toString('base64')}$${stored}:${server}`;
}
async function importImage(source,role){
  const info=JSON.parse(run(docker,['image','inspect',source]))[0];
  const alias=`klustr-neon-controller-smoke-${role}:${id}`,qualified='docker.io/library/'+alias;
  run(docker,['tag',info.Id,alias]);const archive=path.join(directory,role+'.tar');
  run(docker,['save','--output',archive,alias]);
  const nodeFile='/var/local/neon-controller-'+id+'-'+role+'.tar';
  run(docker,['cp',archive,values.NEON_K8S_NODE_CONTAINER+':'+nodeFile]);
  run(docker,['exec',values.NEON_K8S_NODE_CONTAINER,'ctr','--namespace','k8s.io','images','import','--platform','linux/amd64',nodeFile]);
  const pinned=qualified.split(':')[0]+'@'+info.Id;
  run(docker,['exec',values.NEON_K8S_NODE_CONTAINER,'ctr','--namespace','k8s.io','images','tag',qualified,pinned]);
  run(docker,['exec',values.NEON_K8S_NODE_CONTAINER,'rm','-f',nodeFile]);
  return {image:pinned,id:info.Id};
}
try{
  const release=JSON.parse(fs.readFileSync('neon/tests/reports/local/neon-release.json'));
  const proxy=JSON.parse(fs.readFileSync('neon/tests/reports/local/neon-proxy-image.json'));
  const controller=JSON.parse(fs.readFileSync('neon/tests/reports/local/neon-tenant-controller-image.json'));
  const [node]=json(['get','nodes','-o','json']).items.filter(n=>n.status.nodeInfo.architecture==='amd64'&&n.status.conditions.some(c=>c.type==='Ready'&&c.status==='True'));
  assert(node);record.node=node.metadata.name;save();
  const images=record.images||{};
  for(const [role,source] of Object.entries({controller:controller.image_id,proxy:proxy.image_id,
    compute:release.images.compute.image_id,backend:release.runtime_parent}))
    if(images[role]?.id!==source)images[role]=await importImage(source,role);
  record.images=images;save();
  if(!resume){
  apply({apiVersion:'v1',kind:'Namespace',metadata:{name:namespace,labels:{'pod-security.kubernetes.io/enforce':'restricted'}}});
  // Generate test-only private TLS material inside an ignored directory. None
  // of these private keys or database credentials enters the public RC bundle.
  const openssl=args=>run(docker,['run','--rm','--network','none','--read-only',
    '--mount',`type=bind,source=${directory},target=/private`,'--workdir','/private','--entrypoint','openssl',release.runtime_parent,...args]);
  openssl(['req','-x509','-newkey','rsa:2048','-nodes','-keyout','ca.key','-out','ca.crt','-days','2','-subj','/CN=Neon controller RC test CA']);
  for(const [name,dns] of Object.entries({controller:`neon-controller.${namespace}.svc.cluster.local`,
    compute:`neon-ep-demo.${namespace}.svc.cluster.local`,proxy:'*.neon.test'})){
    fs.writeFileSync(path.join(directory,name+'.ext'),`subjectAltName=DNS:${dns}\nextendedKeyUsage=serverAuth\n`);
    openssl(['req','-new','-newkey','rsa:2048','-nodes','-keyout',name+'.key','-out',name+'.csr','-subj','/CN='+dns]);
    openssl(['x509','-req','-in',name+'.csr','-CA','ca.crt','-CAkey','ca.key','-CAcreateserial',
      '-out',name+'.crt','-days','2','-extfile',name+'.ext']);
  }
  const ca=fs.readFileSync(path.join(directory,'ca.crt'),'utf8'),apiToken=randomBytes(32).toString('hex');
  const tls=name=>({'tls.crt':fs.readFileSync(path.join(directory,name+'.crt')),'tls.key':fs.readFileSync(path.join(directory,name+'.key'))});
  const s3=s3Configuration(values);s3.prefix=s3.prefix.replace('neon-pg18-qualification/','neon-controller-rc/');
  record.s3_prefix=s3.prefix;save();
  apply([secret('neon-controller-tls',tls('controller')),secret('neon-proxy-tls',tls('proxy')),
    secret('neon-compute-tls',tls('compute')),secret('neon-service-ca',{'ca.crt':ca}),
    secret('neon-controller-auth',{token:apiToken}),secret('neon-smoke-s3',{'config.json':JSON.stringify(s3)}),
    {apiVersion:'v1',kind:'ConfigMap',metadata:{name:'neon-backend-helper',namespace},
      data:{'prepare_backend.py':fs.readFileSync('neon/tests/neon/controller/prepare_backend.py','utf8')}},
    {apiVersion:'v1',kind:'PersistentVolumeClaim',metadata:{name:'backend-data',namespace},spec:{
      accessModes:['ReadWriteOnce'],storageClassName:values.NEON_K8S_STORAGE_CLASS,resources:{requests:{storage:'4Gi'}}}},
    {apiVersion:'v1',kind:'Service',metadata:{name:'neon-storage',namespace},spec:{selector:{app:'neon-storage'},
      ports:[{name:'pageserver',port:6400,targetPort:16400},...[5454,5455,5456].map(port=>({name:'sk-'+port,port,targetPort:port+10000}))]}},
    {apiVersion:'v1',kind:'Pod',metadata:{name:'neon-storage',namespace,labels:{app:'neon-storage'}},spec:{
      automountServiceAccountToken:false,restartPolicy:'Never',nodeSelector:{'kubernetes.io/hostname':node.metadata.name},
      securityContext:{runAsNonRoot:true,runAsUser:10001,runAsGroup:10001,fsGroup:10001,seccompProfile:{type:'RuntimeDefault'}},
      containers:[{name:'storage',image:images.backend.image,imagePullPolicy:'Never',command:['python3','-B','/helper/prepare_backend.py'],
        env:[{name:'STORAGE_SERVICE_HOSTNAME',value:`neon-storage.${namespace}.svc.cluster.local`}],
        securityContext:{allowPrivilegeEscalation:false,readOnlyRootFilesystem:true,capabilities:{drop:['ALL']}},
        resources:{requests:{cpu:'500m',memory:'1Gi'},limits:{cpu:'4',memory:'4Gi'}},
        volumeMounts:[{name:'data',mountPath:'/var/lib/neon'},{name:'tmp',mountPath:'/tmp'},
          {name:'shm',mountPath:'/dev/shm'},{name:'helper',mountPath:'/helper',readOnly:true},{name:'s3',mountPath:'/run/s3',readOnly:true}]}],
      volumes:[{name:'data',persistentVolumeClaim:{claimName:'backend-data'}},{name:'tmp',emptyDir:{sizeLimit:'256Mi'}},
        {name:'shm',emptyDir:{medium:'Memory',sizeLimit:'256Mi'}},{name:'helper',configMap:{name:'neon-backend-helper'}},
        {name:'s3',secret:{secretName:'neon-smoke-s3',defaultMode:288}}]}}]);
  }else{
    apply({apiVersion:'v1',kind:'ConfigMap',metadata:{name:'neon-backend-helper',namespace},
      data:{'prepare_backend.py':fs.readFileSync('neon/tests/neon/controller/prepare_backend.py','utf8')}});
    const old=json(['-n',namespace,'get','pod',backendPod,'-o','json']);
    if(old.status.phase==='Failed'){
      backendPod='neon-storage-'+randomUUID().slice(0,6);
      const spec=old.spec;spec.containers[0].env=spec.containers[0].env.filter(value=>value.name!=='NEON_CONTROLLER_BACKEND_RESUME');
      spec.containers[0].env.push({name:'NEON_CONTROLLER_BACKEND_RESUME',value:'1'});
      apply({apiVersion:'v1',kind:'Pod',metadata:{name:backendPod,namespace,labels:{app:'neon-storage'}},spec});
    }
  }
  record.backend_pod=backendPod;save();
  kube(['-n',namespace,'wait','--for=condition=Ready','pod/'+backendPod,'--timeout=120s']);
  await wait(()=>{
    const pod=json(['-n',namespace,'get','pod',backendPod,'-o','json']);
    assert(!['Failed','Succeeded'].includes(pod.status.phase),'Storage fixture exited; inspect its private logs');
    const check=spawnSync('kubectl',[...base,'-n',namespace,'exec',backendPod,'--','cat','/var/lib/neon/backend-ready.json'],{encoding:'utf8'});
    return check.status===0;
  },180);phase('Authenticated shared storage with external S3');
  const spec=JSON.parse(kube(['-n',namespace,'exec',backendPod,'--','cat','/var/lib/neon/operator-spec.json']));
  const previousSecret=name=>{
    const contents=kube(['-n',namespace,'get','secret',name,'--ignore-not-found','-o','json']);
    return contents.trim()?JSON.parse(contents):null;
  };
  const decoded=(secret,key)=>secret?.data?.[key]?Buffer.from(secret.data[key],'base64').toString():null;
  const oldClient=previousSecret('neon-demo-client'),oldAdmin=previousSecret('neon-demo-admin');
  const oldRoles=previousSecret('neon-demo-roles'),oldSpec=previousSecret('neon-demo-spec');
  const appPassword=decoded(oldClient,'password')||randomBytes(24).toString('hex');
  const adminPassword=oldAdmin?JSON.parse(decoded(oldAdmin,'admin.json')).password:randomBytes(24).toString('hex');
  const appVerifier=oldRoles?JSON.parse(decoded(oldRoles,'roles.json')).app_user:scram(appPassword);
  const adminVerifier=(oldSpec?JSON.parse(decoded(oldSpec,'spec.json')).cluster.roles.find(role=>role.name==='neon_lifecycle')?.encrypted_password:null)||scram(adminPassword);
  // compute_ctl already adds LOGIN to provisioned roles.
  spec.cluster.roles.push({name:'app_user',encrypted_password:appVerifier,options:[]},
    {name:'neon_lifecycle',encrypted_password:adminVerifier,options:[{name:'SUPERUSER',value:null,vartype:'string'}]});
  spec.cluster.databases.push({name:'app',owner:'app_user',options:[]});
  apply([secret('neon-demo-spec',{'spec.json':JSON.stringify(spec)}),secret('neon-demo-admin',
    {'admin.json':JSON.stringify({user:'neon_lifecycle',password:adminPassword,database:'postgres'})}),
    secret('neon-demo-roles',{'roles.json':JSON.stringify({app_user:appVerifier})}),secret('neon-demo-client',{password:appPassword}),
    {apiVersion:'v1',kind:'ConfigMap',metadata:{name:'neon-ep-demo',namespace,labels:{'neon.klustr.io/endpoint':'true'}},
      data:{'endpoint.json':JSON.stringify({endpointId:'ep-demo',projectId:'project-rc',branchId:'branch-rc',
        computeSpecSecret:'neon-demo-spec',adminSecret:'neon-demo-admin',rolesSecret:'neon-demo-roles',
        tlsSecret:'neon-compute-tls',caSecret:'neon-service-ca',image:images.compute.image,nodeName:node.metadata.name,
        profile:'bounded-async',suspend:{mode:'idle',idleSeconds:10},allowedIps:['0.0.0.0/0','::/0']})}},
    ...controllerResources({namespace,controllerImage:images.controller.image,proxyImage:images.proxy.image})]);
  if(resume&&!record.phases.some(phase=>phase.name.startsWith('Standard PostgreSQL connection'))){
    const rendered=previousSecret('neon-ep-demo-rendered');
    if(rendered){
      const definition=json(['-n',namespace,'get','configmap','neon-ep-demo','-o','json']);
      const current=endpointConfig(definition);
      const body=Buffer.from(JSON.stringify({spec:renderSpec(spec,current),compute_ctl_config:{jwks:{keys:[]},tls:null}})).toString('base64');
      kube(['-n',namespace,'patch','secret','neon-ep-demo-rendered','--type=merge','--patch-file','-'],JSON.stringify({data:{'config.json':body}}));
      // Fixture-only repair before its first successful application connection.
      // Recreate guarantees the failed bootstrap container stops before retry.
      kube(['-n',namespace,'rollout','restart','deployment/neon-ep-demo']);
    }
  }
  kube(['-n',namespace,'rollout','status','deployment/neon-tenant-controller','--timeout=120s']);
  kube(['-n',namespace,'rollout','status','deployment/neon-proxy','--timeout=120s']);
  const existingComputeText=kube(['-n',namespace,'get','deployment','neon-ep-demo','--ignore-not-found','-o','json']);
  if(existingComputeText){
    const existingCompute=JSON.parse(existingComputeText);
    if(existingCompute.spec.replicas===1&&existingCompute.spec.template.spec.containers[0].image!==images.compute.image)
      await wait(()=>json(['-n',namespace,'get','deployment','neon-ep-demo','-o','json']).spec.replicas===0,90);
  }
  const proxyIP=json(['-n',namespace,'get','service','neon-proxy','-o','json']).spec.clusterIP;
  // A client Pod contains only a standard pg driver. Its SQL is ordinary SQL.
  apply({apiVersion:'v1',kind:'Pod',metadata:{name:'client',namespace},spec:{restartPolicy:'Never',automountServiceAccountToken:false,
    securityContext:{runAsNonRoot:true,runAsUser:10001,runAsGroup:10001,fsGroup:10001,seccompProfile:{type:'RuntimeDefault'}},
    containers:[{name:'client',image:images.controller.image,imagePullPolicy:'Never',command:['node','-e','setInterval(()=>{},1000)'],
      env:[{name:'PROXY_IP',value:proxyIP},{name:'APP_PASSWORD',valueFrom:{secretKeyRef:{name:'neon-demo-client',key:'password'}}}],
      securityContext:{allowPrivilegeEscalation:false,readOnlyRootFilesystem:true,capabilities:{drop:['ALL']}},
      volumeMounts:[{name:'ca',mountPath:'/run/trust',readOnly:true}]}],volumes:[{name:'ca',secret:{secretName:'neon-service-ca'}}]}});
  kube(['-n',namespace,'wait','--for=condition=Ready','pod/client','--timeout=90s']);
  const execute=statement=>{
    const script=`import pg from 'pg';import fs from 'node:fs';const c=new pg.Client({host:process.env.PROXY_IP,port:5432,user:'app_user',password:process.env.APP_PASSWORD,database:'app',ssl:{rejectUnauthorized:true,ca:fs.readFileSync('/run/trust/ca.crt'),servername:'ep-demo.neon.test'},connectionTimeoutMillis:60000});await c.connect();const r=await c.query(JSON.parse(process.argv[1]));console.log(JSON.stringify(r.rows));await c.end();`;
    return JSON.parse(kube(['-n',namespace,'exec','client','--','node','--input-type=module','-e',script,JSON.stringify(statement)]));
  };
  const began=Date.now();
  execute("CREATE TABLE IF NOT EXISTS documents(id int PRIMARY KEY,doc jsonb NOT NULL)");
  execute("INSERT INTO documents VALUES(1,'{\"kind\":\"event\",\"value\":7}') ON CONFLICT(id) DO NOTHING");
  record.initial_wake_ms=Date.now()-began;phase('Standard PostgreSQL connection wakes guarded PG18 and writes JSONB');
  const activePod=json(['-n',namespace,'get','pods','-l','neon.klustr.io/endpoint=ep-demo','-o','json']).items
    .find(pod=>pod.status.conditions?.some(condition=>condition.type==='Ready'&&condition.status==='True'));
  assert(activePod);
  const tcp4=kube(['-n',namespace,'exec',activePod.metadata.name,'--','cat','/proc/net/tcp']);
  const tcp6=kube(['-n',namespace,'exec',activePod.metadata.name,'--','cat','/proc/net/tcp6']);
  assert(tcp4.split('\n').some(line=>line.includes('0100007F:0C09')&&line.trim().split(/\s+/)[3]==='0A'));
  assert(!tcp6.split('\n').some(line=>line.includes(':0C09')&&line.trim().split(/\s+/)[3]==='0A'));
  record.compute_internal_listener='127.0.0.1:3081';phase('Unauthenticated compute-local API is bound only to loopback');
  await wait(()=>json(['-n',namespace,'get','deployment','neon-ep-demo','-o','json']).spec.replicas===0,90);
  const dormant=json(['-n',namespace,'get','configmap','neon-ep-demo','-o','json']);
  record.drain_frontier=JSON.parse(dormant.data['status.json']).drainedLSN;assert(record.drain_frontier);phase('Idle policy drains and scales compute to zero');
  const wake=Date.now();const rows=execute("SELECT doc->>'kind' AS kind,(doc->>'value')::int AS value FROM documents WHERE id=1");
  assert.deepEqual(rows,[{kind:'event',value:7}]);record.wake_and_read_ms=Date.now()-wake;
  phase('Proxy reconnect wakes compute and reads the acknowledged document');
  const definition=json(['-n',namespace,'get','configmap','neon-ep-demo','-o','json']);
  const endpoint=JSON.parse(definition.data['endpoint.json']);endpoint.suspend={mode:'never'};
  kube(['-n',namespace,'patch','configmap','neon-ep-demo','--type=merge','-p',JSON.stringify({data:{'endpoint.json':JSON.stringify(endpoint)}})]);
  await new Promise(resolve=>setTimeout(resolve,14000));
  assert.equal(json(['-n',namespace,'get','deployment','neon-ep-demo','-o','json']).spec.replicas,1);
  phase('Never-suspend policy keeps compute running beyond the idle interval');
  record.status='PASS';record.completed_at=new Date().toISOString();save();
  fs.writeFileSync('neon/tests/reports/local/neon-controller-acceptance.json',JSON.stringify(record,null,2)+'\n');
  console.log(`Controller smoke passed; retained isolated namespace ${namespace}`);
}catch(error){record.status='FAIL';record.error=error.message;record.completed_at=new Date().toISOString();save();throw error;}
