// Import the local RC and exercise its executable startup under Kubernetes.
// This has no database fixture, PVC, S3 secret or effect on existing workloads.
import fs from 'node:fs';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {randomUUID} from 'node:crypto';
import assert from 'node:assert/strict';
import {localConfiguration} from '../../shared/neon-qualification-config.mjs';
const release=JSON.parse(fs.readFileSync('neon/tests/reports/local/neon-release.json','utf8'));
const values=localConfiguration(),docker=process.env.DOCKER||'docker';
const base=['--kubeconfig',values.NEON_K8S_KUBECONFIG,'--context',values.NEON_K8S_CONTEXT,'--request-timeout=30s'];
assert(base.every(Boolean));assert(values.NEON_K8S_NODE_CONTAINER);
const namespace='neon-release-'+randomUUID().slice(0,8),nodeDirectory='/var/local/neon-releases/'+namespace;
const record={status:'RUNNING',namespace,context:values.NEON_K8S_CONTEXT,version:release.version,
  scope:'Exact role-image import, AMD64 scheduling, non-root read-only executable startup. No database deployment or automatic tenant lifecycle claim.',images:{}};
const file=path.join(release.output,'kubernetes-smoke.json');
const save=()=>fs.writeFileSync(file,JSON.stringify(record,null,2)+'\n');save();
const run=(program,args,input)=>{
  const r=spawnSync(program,args,{input,encoding:'utf8',maxBuffer:8*1024*1024});
  assert.equal(r.status,0,r.stderr||r.stdout);return r.stdout;
};
const kube=(args,input)=>run('kubectl',[...base,...args],input);
const apply=object=>kube(['apply','-f','-'],JSON.stringify(object));
const node=values.NEON_K8S_NODE_CONTAINER;
const staging=[];let created=false;
try{
  const inventory=JSON.parse(kube(['get','nodes','-o','json']));
  assert(inventory.items.some(n=>n.status.nodeInfo.architecture==='amd64'&&n.status.conditions.some(c=>c.type==='Ready'&&c.status==='True')));
  apply({apiVersion:'v1',kind:'Namespace',metadata:{name:namespace,labels:{'app.kubernetes.io/managed-by':'neon-release-smoke'}}});created=true;
  run(docker,['exec',node,'mkdir','-p',nodeDirectory]);
  for(const [role,image] of Object.entries(release.images)){
    const staged=nodeDirectory+'/'+path.basename(image.archive);staging.push(staged);
    run(docker,['cp',image.archive,`${node}:${staged}`]);
    run(docker,['exec',node,'ctr','--namespace','k8s.io','images','import','--platform','linux/amd64',staged]);
    const executable=role==='compute'?'/opt/postgres/v18/bin/postgres':'/usr/local/bin/'+role.replaceAll('-','_');
    apply({apiVersion:'v1',kind:'Pod',metadata:{name:role,namespace},spec:{restartPolicy:'Never',
      activeDeadlineSeconds:60,automountServiceAccountToken:false,nodeSelector:{'kubernetes.io/arch':'amd64'},
      securityContext:{runAsNonRoot:true,runAsUser:10001,runAsGroup:10001,seccompProfile:{type:'RuntimeDefault'}},
      containers:[{name:role,image:'docker.io/library/'+image.tag,imagePullPolicy:'Never',
        command:[executable,role==='storage-controller'?'--help':'--version'],
        resources:{requests:{cpu:'50m',memory:'32Mi'},limits:{cpu:'500m',memory:'256Mi'}},
        securityContext:{allowPrivilegeEscalation:false,readOnlyRootFilesystem:true,capabilities:{drop:['ALL']}}}]}});
    kube(['-n',namespace,'wait','--for=jsonpath={.status.phase}=Succeeded','pod/'+role,'--timeout=90s']);
    const pod=JSON.parse(kube(['-n',namespace,'get','pod',role,'-o','json']));
    const state=pod.status.containerStatuses[0];assert.equal(state.state.terminated.exitCode,0);
    const identity=state.imageID.split('@').at(-1).replace(/^sha256:/,'');
    assert([image.manifest_digest,image.config_digest,image.image_id].some(digest=>digest.endsWith(identity)),state.imageID);
    const logs=kube(['-n',namespace,'logs',role]);
    record.images[role]={status:'PASS',image:state.imageID,expected_manifest:image.manifest_digest,node:pod.spec.nodeName,logs:logs.trim()};save();
    console.log(`PASS Kubernetes ${role}: non-root, read-only root filesystem`);
  }
  record.status='PASS';
}catch(error){record.status='FAIL';record.error=error.message;throw error;}
finally{
  record.completed_at=new Date().toISOString();
  if(created)kube(['delete','namespace',namespace,'--wait=true','--timeout=90s']);
  if(staging.length)run(docker,['exec',node,'rm','-f',...staging]);
  run(docker,['exec',node,'rmdir',nodeDirectory]);
  record.namespace_removed=created;save();
}
release.kubernetes_smoke={status:record.status,report:file,scope:record.scope};
for(const target of ['neon/tests/reports/local/neon-release.json',path.join(release.output,'release.json')])fs.writeFileSync(target,JSON.stringify(release,null,2)+'\n');
