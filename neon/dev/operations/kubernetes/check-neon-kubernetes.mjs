// Isolated local-cluster qualification. No existing workloads or data are replaced.
import {spawnSync} from 'node:child_process';
import {readFileSync,writeFileSync,mkdirSync} from 'node:fs';
import {createHash,randomUUID} from 'node:crypto';
import path from 'node:path';
import assert from 'node:assert/strict';
import {neonTestPath} from '../../shared/neon-test-paths.mjs';
import {localConfiguration,s3Configuration} from '../../shared/neon-qualification-config.mjs';
const values=localConfiguration();
const s3=s3Configuration(values);
const manifest=JSON.parse(readFileSync('neon/tests/reports/local/neon-component-images.json','utf8'));
const image=manifest.images.qualification;
const docker=process.env.DOCKER || 'docker';
const base=['--kubeconfig',values.NEON_K8S_KUBECONFIG,'--context',values.NEON_K8S_CONTEXT,'--request-timeout=30s'];
assert(base.every(Boolean),'Kubernetes connection configuration is incomplete');
const namespace=`${values.NEON_K8S_NAMESPACE_PREFIX || 'neon-pg18-qualification'}-${randomUUID().slice(0,8)}`;
assert(/^[a-z0-9-]{1,63}$/.test(namespace),'Invalid qualification namespace');
const tag=`klustr-neon-qualification:qa-${image.image_id.slice(7,19)}`;
const reports='neon/tests/reports/local';
const stem=`neon-k8s-${namespace}`;
const record={status:'RUNNING',namespace,context:values.NEON_K8S_CONTEXT,image_id:image.image_id,
  s3_prefix:s3.prefix,storage_class:values.NEON_K8S_STORAGE_CLASS,pvc:'qualification-data',
  scope:'one-node Kubernetes PVC/Pod replacement and real S3; not multi-zone qualification',phases:[]};
function save() {writeFileSync(`${reports}/neon-kubernetes-acceptance.json`,JSON.stringify(record,null,2)+'\n');}
function command(program,args,input,description='command') {
  const result=spawnSync(program,args,{input,encoding:'utf8',maxBuffer:16*1024*1024});
  assert.equal(result.status,0,`${description} failed (exit ${result.status}); secret-bearing request bodies are not logged`);
  return result.stdout;
}
function kube(args,input) {return command('kubectl',[...base,...args],input,`kubectl ${args[0]}`);}
function apply(items) {kube(['apply','--server-side','-f','-'],JSON.stringify({apiVersion:'v1',kind:'List',items}));}
function collect(pod,source,name) {
  const file=`${reports}/${stem}-${name}`;
  const contents=kube(['-n',namespace,'exec',pod,'--','cat',source]);
  JSON.parse(contents);
  writeFileSync(file,contents);
  record[name]=file;
}
async function phase(pod,phaseName) {
  apply([{apiVersion:'v1',kind:'Pod',metadata:{name:pod,namespace,labels:{'app.kubernetes.io/name':'neon-pg18-qualification'}},
    spec:{restartPolicy:'Never',activeDeadlineSeconds:1200,automountServiceAccountToken:false,
      securityContext:{runAsNonRoot:true,runAsUser:10001,runAsGroup:10001,fsGroup:10001,fsGroupChangePolicy:'OnRootMismatch',
        seccompProfile:{type:'RuntimeDefault'}},
      containers:[{name:'qualification',image:`docker.io/library/${tag}`,imagePullPolicy:'Never',
        command:['python3','/qualification/k8s_entrypoint.py'],
        env:[{name:'NEON_S3_CONFIG',value:'/run/secrets/neon-s3/config.json'},
          {name:'NEON_QUALIFICATION_PHASE',value:phaseName}],
        resources:{requests:{cpu:'1',memory:'2Gi'},limits:{cpu:'8',memory:'8Gi'}},
        securityContext:{allowPrivilegeEscalation:false,readOnlyRootFilesystem:true,capabilities:{drop:['ALL']}},
        volumeMounts:[{name:'data',mountPath:'/var/lib/neon'},{name:'scripts',mountPath:'/qualification',readOnly:true},
          {name:'s3',mountPath:'/run/secrets/neon-s3',readOnly:true},{name:'tmp',mountPath:'/tmp'},
          {name:'shm',mountPath:'/dev/shm'}]}],
      volumes:[{name:'data',persistentVolumeClaim:{claimName:'qualification-data'}},
        {name:'scripts',configMap:{name:'qualification-scripts'}},
        {name:'s3',secret:{secretName:'s3-credentials',defaultMode:288}},
        {name:'tmp',emptyDir:{sizeLimit:'1Gi'}},{name:'shm',emptyDir:{medium:'Memory',sizeLimit:'256Mi'}}]}}]);
  let previous;
  const deadline=Date.now()+18*60*1000;
  while(Date.now()<deadline) {
    const podState=JSON.parse(kube(['-n',namespace,'get','pod',pod,'-o','json']));
    if(podState.status.phase!==previous) {
      previous=podState.status.phase;console.log(`${pod}: ${previous}`);
    }
    assert(!['Failed','Succeeded'].includes(previous),'Qualification entrypoint exited before evidence collection');
    const phaseResult=spawnSync('kubectl',[...base,'-n',namespace,'exec',pod,'--','cat',
      `/var/lib/neon/${phaseName}-phase-status.json`],{encoding:'utf8'});
    if(phaseResult.status===0) {
      const state=JSON.parse(phaseResult.stdout);
      const logs=kube(['-n',namespace,'logs',pod]);
      writeFileSync(`${reports}/${stem}-${phaseName}.log`,logs);
      console.log(logs.trim());
      record.phases.push({...state,pod,runtime_image_id:podState.status.containerStatuses?.[0]?.imageID});
      save();
      assert.equal(state.status,'PASS',`${phaseName} failed; retained PVC and private service logs`);
      return;
    }
    await new Promise(resolve=>setTimeout(resolve,3000));
  }
  throw new Error('Qualification Pod deadline exceeded; retained namespace/PVC for diagnosis');
}
save();
let created=false;
try {
  const inspected=command(docker,['image','inspect',image.tag,'--format','{{.Id}}']);
  assert.equal(inspected.trim(),image.image_id,'Local candidate tag changed');
  command(docker,['tag',image.image_id,tag]);
  mkdirSync('build/neon-k8s',{recursive:true});
  const archive=path.resolve(`build/neon-k8s/qualification-${image.image_id.slice(7,19)}.oci.tar`);
  command(docker,['save','--output',archive,tag]);
  const node=values.NEON_K8S_NODE_CONTAINER;
  assert(node,'Missing local cluster node container');
  command(docker,['exec',node,'mkdir','-p','/var/local/neon-qualification']);
  const nodeArchive=`/var/local/neon-qualification/qualification-${image.image_id.slice(7,19)}.oci.tar`;
  command(docker,['cp',archive,`${node}:${nodeArchive}`]);
  command(docker,['exec',node,'ctr','-n','k8s.io','images','import',nodeArchive]);
  record.archive_sha256=createHash('sha256').update(readFileSync(archive)).digest('hex');
  const scripts={};
  for(const file of ['check_pg18_distributed.py','s3_client.py','s3_fault_proxy.py','k8s_entrypoint.py']) {
    scripts[file]=readFileSync(neonTestPath(file),'utf8').replaceAll('\r\n','\n');
  }
  record.harness_sha256=createHash('sha256').update(scripts['check_pg18_distributed.py']).digest('hex');
  record.script_sha256=Object.fromEntries(Object.entries(scripts).map(([name,text])=>
    [name,createHash('sha256').update(text).digest('hex')]));
  apply([{apiVersion:'v1',kind:'Namespace',metadata:{name:namespace,labels:{'pod-security.kubernetes.io/enforce':'restricted',
      'app.kubernetes.io/part-of':'neon-pg18-qualification'}}}]);
  created=true;
  apply([{apiVersion:'v1',kind:'PersistentVolumeClaim',metadata:{name:'qualification-data',namespace},
    spec:{accessModes:['ReadWriteOnce'],storageClassName:values.NEON_K8S_STORAGE_CLASS,resources:{requests:{storage:'4Gi'}}}},
    {apiVersion:'v1',kind:'ConfigMap',metadata:{name:'qualification-scripts',namespace},data:scripts},
    {apiVersion:'v1',kind:'Secret',metadata:{name:'s3-credentials',namespace},type:'Opaque',
      data:{'config.json':Buffer.from(JSON.stringify(s3)).toString('base64')}}]);
  console.log(`Qualification namespace: ${namespace}; unique S3 prefix: ${s3.prefix}`);
  await phase('primary','primary');
  collect('primary','/var/lib/neon/s3-acceptance.json','s3.json');
  collect('primary','/var/lib/neon/acceptance-logs/pgbench-summary.json','pgbench.json');
  kube(['-n',namespace,'delete','pod','primary','--wait=true','--timeout=120s']);
  await phase('replacement','verify-replacement');
  collect('replacement','/var/lib/neon/acceptance-results.json','results.json');
  kube(['-n',namespace,'delete','pod','replacement','--wait=true','--timeout=120s']);
  record.status='PASS';
  console.log('PASS Kubernetes PVC/Pod replacement, S3-backed PG18 runtime, WAL offload and outage recovery');
} catch(error) {
  record.status='FAIL';record.error=error.message;process.exitCode=1;
  console.error(error.message);
} finally {
  if(created) {
    // Remove only this run's credential Secret. Keep PVC, public scripts and logs.
    const cleanup=spawnSync('kubectl',[...base,'-n',namespace,'delete','secret','s3-credentials','--ignore-not-found'],{encoding:'utf8'});
    record.credential_secret_removed=cleanup.status===0;
    if(cleanup.status!==0) {record.status='FAIL';process.exitCode=1;}
  }
  save();
}
