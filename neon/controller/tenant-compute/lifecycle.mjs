import {randomUUID,createHash} from 'node:crypto';
import {secretText,renderSpec} from './config.mjs';
import {Activity,alwaysOn} from './activity.mjs';
const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const OWNER='neon.klustr.io/endpoint-uid';
const ADMISSION='neon.klustr.io/admission';
const FENCE='neon.klustr.io/controller-epoch';
export class Lifecycle {
  constructor(api,leadership,connect,{clock=()=>performance.now(),wakeTimeout=90000}={}){
    this.api=api;this.leader=leadership;this.connect=connect;this.clock=clock;this.wakeTimeout=wakeTimeout;
    this.locks=new Map();this.idleSince=new Map();this.readyCache=new Map();this.activity=new Map();
  }
  async serialized(endpoint,operation){
    const before=this.locks.get(endpoint.uid)||Promise.resolve();
    const work=before.catch(()=>{}).then(()=>{this.leader.require();return operation();});
    this.locks.set(endpoint.uid,work);
    try{return await work;}finally{if(this.locks.get(endpoint.uid)===work)this.locks.delete(endpoint.uid);}
  }
  labels(endpoint){return {[OWNER]:endpoint.uid,'neon.klustr.io/endpoint':endpoint.endpointId};}
  owned(resource,endpoint){if(resource.metadata.labels?.[OWNER]!==endpoint.uid)throw Error('Resource ownership mismatch');return resource;}
  async mutate(kind,endpoint,changes){
    this.leader.require();const current=this.owned(await this.api.get(kind,endpoint.name),endpoint);
    const next=await this.api.patch(kind,endpoint.name,{...changes,metadata:{...changes.metadata,
      resourceVersion:current.metadata.resourceVersion,annotations:{...current.metadata.annotations,
        ...changes.metadata?.annotations,[FENCE]:this.leader.identity}}});
    this.leader.require();return next;
  }
  async status(endpoint,fields){
    this.leader.require();const current=await this.api.get('configmaps',endpoint.name);
    if(current.metadata.uid!==endpoint.uid)throw Error('Endpoint definition was replaced');
    const previous=JSON.parse(current.data['status.json']||'{}');
    const status={...previous,...fields,controller:this.leader.identity,updatedAt:new Date().toISOString()};
    await this.api.patch('configmaps',endpoint.name,{metadata:{resourceVersion:current.metadata.resourceVersion},
      data:{'status.json':JSON.stringify(status)}});this.leader.require();endpoint.status=status;
  }
  async admission(endpoint,open){
    await this.mutate('services',endpoint,{spec:{selector:{...this.labels(endpoint),[ADMISSION]:open?'open':'closed'}}});
  }
  async scale(endpoint,replicas){return this.mutate('deployments',endpoint,{spec:{replicas}});}
  async pods(endpoint){return await this.api.list('pods',OWNER+'='+endpoint.uid);}
  async wait(endpoint,predicate,timeout=this.wakeTimeout){
    const end=this.clock()+timeout;
    do{this.leader.require();const result=await predicate();if(result)return result;await delay(250);}while(this.clock()<end);
    const error=Error('Lifecycle deadline exceeded');error.code='DEADLINE';throw error;
  }
  async ensure(endpoint){
    this.leader.require();
    let service=await this.api.optional('services',endpoint.name);
    if(!service)service=await this.api.create('services',{apiVersion:'v1',kind:'Service',
      metadata:{name:endpoint.name,labels:this.labels(endpoint)},spec:{type:'ClusterIP',
        selector:{...this.labels(endpoint),[ADMISSION]:'closed'},ports:[{name:'postgres',port:5432,targetPort:5432}]}});
    this.owned(service,endpoint);
    const existing=await this.api.optional('deployments',endpoint.name);
    if(existing){this.owned(existing,endpoint);return existing;}
    return await this.api.create('deployments',{apiVersion:'apps/v1',kind:'Deployment',
      metadata:{name:endpoint.name,labels:this.labels(endpoint)},spec:{replicas:0,strategy:{type:'Recreate'},
        selector:{matchLabels:this.labels(endpoint)},template:this.template(endpoint)}});
  }
  template(endpoint){
    return {metadata:{labels:{...this.labels(endpoint),[ADMISSION]:'open','app.kubernetes.io/name':'neon-compute'},
      annotations:{'neon.klustr.io/config-revision':endpoint.computeRevision}},spec:{
      // No cross-worker failover based on Lease expiry. Infinite NoExecute
      // tolerations prevent replacement of a partitioned, possibly live writer.
      nodeName:endpoint.nodeName,tolerations:['node.kubernetes.io/not-ready','node.kubernetes.io/unreachable'].map(key=>({key,operator:'Exists',effect:'NoExecute'})),
      automountServiceAccountToken:false,terminationGracePeriodSeconds:60,
      securityContext:{runAsNonRoot:true,runAsUser:10001,runAsGroup:10001,fsGroup:10001,
        seccompProfile:{type:'RuntimeDefault'}},
      containers:[{name:'compute',image:endpoint.image,imagePullPolicy:'IfNotPresent',
        args:['--dev','--pgbin','/opt/postgres/v18/bin/postgres','--pgdata','/var/lib/neon/pgdata',
          '--connstr','postgresql://cloud_admin@localhost/postgres','--compute-id',endpoint.endpointId,
          '--config','/run/compute-spec/config.json'],
        env:[{name:'OTEL_SDK_DISABLED',value:'true'}],
        ports:[{name:'postgres',containerPort:5432}],
        resources:{requests:{cpu:'250m',memory:'512Mi'},limits:{cpu:'2',memory:'2Gi'}},
        securityContext:{allowPrivilegeEscalation:false,readOnlyRootFilesystem:true,capabilities:{drop:['ALL']}},
        // The controller verifies SQL and the remote quorum before opening the
        // Service. Process probes avoid counting probe logins as user activity.
        readinessProbe:{exec:{command:['/bin/sh','-ec','read -r pg_pid < /var/lib/neon/pgdata/postmaster.pid; kill -0 "$pg_pid"']},periodSeconds:1,timeoutSeconds:1,failureThreshold:3},
        startupProbe:{exec:{command:['/bin/sh','-ec','read -r pg_pid < /var/lib/neon/pgdata/postmaster.pid; kill -0 "$pg_pid"']},periodSeconds:1,failureThreshold:90},
        volumeMounts:[{name:'data',mountPath:'/var/lib/neon'},{name:'tmp',mountPath:'/tmp'},
          {name:'shm',mountPath:'/dev/shm'},{name:'spec',mountPath:'/run/compute-spec',readOnly:true},
          {name:'tls',mountPath:'/run/compute-tls',readOnly:true}]}],
      volumes:[{name:'data',emptyDir:{sizeLimit:'4Gi'}},{name:'tmp',emptyDir:{sizeLimit:'256Mi'}},
        {name:'shm',emptyDir:{medium:'Memory',sizeLimit:'256Mi'}},
        {name:'spec',secret:{secretName:endpoint.name+'-rendered',defaultMode:288}},
        {name:'tls',secret:{secretName:endpoint.tlsSecret,defaultMode:288}}]}};
  }
  async prepare(endpoint){
    const source=await this.api.get('secrets',endpoint.computeSpecSecret);
    const input=JSON.parse(secretText(source,'spec.json'));
    const rendered=renderSpec(input,endpoint);
    // A writer reservation has no expiry. A different endpoint cannot acquire
    // the same tenant/timeline merely because compute or the controller stopped.
    const branchName='neon-writer-'+createHash('sha256').update(input.tenant_id+':'+input.timeline_id).digest('hex').slice(0,40);
    let reservation=await this.api.optional('leases',branchName);
    if(!reservation){
      try{reservation=await this.api.create('leases',{apiVersion:'coordination.k8s.io/v1',kind:'Lease',
        metadata:{name:branchName,labels:this.labels(endpoint)},spec:{holderIdentity:endpoint.uid}});}
      catch(error){if(error.status!==409)throw error;reservation=await this.api.get('leases',branchName);}
    }
    if(reservation.spec.holderIdentity!==endpoint.uid)throw Error('Timeline already has a different writer owner');
    const data=Buffer.from(JSON.stringify({spec:rendered,compute_ctl_config:{jwks:{keys:[]},tls:null}})).toString('base64');
    const name=endpoint.name+'-rendered',existing=await this.api.optional('secrets',name);
    this.leader.require();
    if(existing){this.owned(existing,endpoint);await this.api.patch('secrets',name,{
      metadata:{resourceVersion:existing.metadata.resourceVersion},data:{'config.json':data}});}
    else await this.api.create('secrets',{apiVersion:'v1',kind:'Secret',metadata:{name,labels:this.labels(endpoint)},
      type:'Opaque',data:{'config.json':data}});
    this.leader.require();
  }
  async admin(endpoint,pod){
    const [secret,ca]=await Promise.all([this.api.get('secrets',endpoint.adminSecret),this.api.get('secrets',endpoint.caSecret)]);
    const credentials=JSON.parse(secretText(secret,'admin.json'));
    if(!credentials.user||!credentials.password)throw Error('Missing administrator credentials');
    return await this.connect({...credentials,database:'postgres',host:pod.status.podIP,port:5432,
      application_name:'neon-lifecycle-controller',connectionTimeoutMillis:3000,
      statement_timeout:10000,query_timeout:12000,
      ssl:{rejectUnauthorized:true,ca:secretText(ca,'ca.crt'),servername:endpoint.name+'.'+this.api.namespace+'.svc.cluster.local'}});
  }
  ready(pod){return pod.metadata.deletionTimestamp===undefined&&pod.status.phase==='Running'&&
    pod.status.conditions?.some(condition=>condition.type==='Ready'&&condition.status==='True');}
  async verify(endpoint,pod){
    const client=await this.admin(endpoint,pod);
    try{
      const row=(await client.query("SELECT current_setting('server_version_num')::int AS version, pg_is_in_recovery() AS recovery, neon.bounded_commit_guard_status()::json AS guard")).rows[0];
      if(row.version<180000||row.version>=190000||row.recovery||!row.guard.enabled||!row.guard.quorum_available)throw Error('Compute is not a guarded PG18 primary');
      if(endpoint.status.drainedLSN){
        const check=await client.query('SELECT pg_current_wal_insert_lsn() >= $1::pg_lsn AS recovered',[endpoint.status.drainedLSN]);
        if(!check.rows[0].recovered)throw Error('Compute is behind its persisted handoff frontier');
      }
    }finally{await client.end();}
  }
  async wake(endpoint){return await this.serialized(endpoint,async()=>{
    const cached=this.readyCache.get(endpoint.uid);
    if(cached&&cached.revision===endpoint.revision&&cached.expires>this.clock()){
      this.idleSince.set(endpoint.uid,this.clock());return cached.result;
    }
    const began=this.clock();let deployment=await this.ensure(endpoint);
    // Claim both objects before changing admission or replica state. Old-owner
    // requests carry old resourceVersions and cannot overwrite this new fence.
    await this.mutate('deployments',endpoint,{});await this.mutate('services',endpoint,{});
    if(endpoint.status.phase==='Draining'){
      // Resume an interrupted, already-admission-closed transition before wake.
      if(deployment.spec.replicas===0&&endpoint.status.drainedLSN){
        await this.wait(endpoint,async()=>!(await this.pods(endpoint)).length);
        await this.status(endpoint,{phase:'Dormant',podUID:null});
      }else await this.suspendLocked(endpoint,true);
      deployment=await this.api.get('deployments',endpoint.name);
    }
    if(deployment.spec.replicas===0){
      await this.admission(endpoint,false);
      await this.wait(endpoint,async()=>!(await this.pods(endpoint)).length);
      await this.prepare(endpoint);
      await this.mutate('deployments',endpoint,{spec:{template:this.template(endpoint)}});
      await this.status(endpoint,{phase:'Waking',nodeName:endpoint.nodeName,operation:randomUUID()});
      await this.scale(endpoint,1);
    }else if(deployment.spec.template.metadata.annotations?.['neon.klustr.io/config-revision']!==endpoint.computeRevision){
      throw Error('Active compute configuration changes require a completed suspend first');
    }
    const pod=await this.wait(endpoint,async()=>{
      const pods=await this.pods(endpoint);
      if(pods.length!==1||!this.ready(pods[0]))return null;
      try{await this.verify(endpoint,pods[0]);return pods[0];}catch{return null;}
    });
    if(pod.spec.nodeName!==endpoint.nodeName)throw Error('Compute worker placement changed');
    await this.admission(endpoint,true);
    await this.status(endpoint,{phase:'Active',podUID:pod.metadata.uid,nodeName:pod.spec.nodeName});
    this.idleSince.set(endpoint.uid,this.clock());
    const result={address:endpoint.name+'.'+this.api.namespace+'.svc.cluster.local:5432',
      server_name:endpoint.name+'.'+this.api.namespace+'.svc.cluster.local',
      aux:{endpoint_id:endpoint.endpointId,project_id:endpoint.projectId,branch_id:endpoint.branchId,
        compute_id:pod.metadata.uid,cold_start_info:began+100<this.clock()?'pool_miss':'warm'}};
    this.readyCache.set(endpoint.uid,{revision:endpoint.revision,expires:this.clock()+1000,result});
    return result;
  });}
  async activeClients(client){
    const result=await client.query("SELECT count(*)::int AS n FROM pg_stat_activity WHERE pid<>pg_backend_pid() AND backend_type IN ('client backend','walsender') AND state IS DISTINCT FROM 'idle' AND NOT (usename=current_user AND application_name='neon-lifecycle-controller') AND NOT (usename='cloud_admin' AND (application_name LIKE 'compute_ctl%' OR application_name IN ('vm-monitor','walproposer')))");
    return result.rows[0].n;
  }
  async activitySample(client){
    const result=await client.query(`SELECT json_build_object(
      'databases',(SELECT coalesce(json_agg(json_build_object('name',datname,'sessions',sessions::text,
        'active_ms',active_time::text,'reset',stats_reset::text)),'[]'::json) FROM pg_stat_database WHERE datname NOT IN ('template0','template1')),
      'clients',(SELECT coalesce(json_agg(json_build_object('pid',pid,'database',datname,'state',state,
        'change',state_change::text)),'[]'::json) FROM pg_stat_activity WHERE backend_type='client backend'
        AND pid<>pg_backend_pid() AND NOT (usename=current_user AND application_name='neon-lifecycle-controller')
        AND NOT (usename='cloud_admin' AND (application_name LIKE 'compute_ctl%' OR application_name='vm-monitor'))),
      'blockers',((SELECT count(*) FROM pg_stat_replication WHERE application_name<>'walproposer')+
        (SELECT count(*) FROM pg_stat_subscription WHERE pid IS NOT NULL)+
        (SELECT count(*) FROM pg_stat_activity WHERE backend_type='autovacuum worker'))>0) AS activity`);
    return result.rows[0].activity;
  }
  async closeActivity(endpoint){
    const monitor=this.activity.get(endpoint.uid);this.activity.delete(endpoint.uid);
    if(monitor)await monitor.client.end();
  }
  async suspendLocked(endpoint,resume=false){
    this.readyCache.delete(endpoint.uid);
    if(alwaysOn(endpoint)){await this.admission(endpoint,true);await this.status(endpoint,{phase:'Active'});return false;}
    await this.closeActivity(endpoint);
    const pods=await this.pods(endpoint);
    if(pods.length!==1||!this.ready(pods[0]))throw Error('A verified running compute is required to drain');
    const client=await this.admin(endpoint,pods[0]);let admissionClosed=false,clientClosed=false;
    try{
      await this.admission(endpoint,false);admissionClosed=true;
      await this.status(endpoint,{phase:'Draining',podUID:pods[0].metadata.uid});
      await this.wait(endpoint,async()=>!(await this.api.list('endpointslices','kubernetes.io/service-name='+endpoint.name))
        .some(slice=>slice.endpoints?.some(entry=>entry.conditions?.ready!==false)),15000);
      if(await this.activeClients(client)>0){
        await this.admission(endpoint,true);admissionClosed=false;
        await this.status(endpoint,{phase:'Active'});this.idleSince.set(endpoint.uid,this.clock());return false;
      }
      // Idle pooled connections do not keep an inactive database running. Open
      // transactions and observed active queries are protected above.
      await client.query("SELECT pg_terminate_backend(pid,1000) FROM pg_stat_activity WHERE pid<>pg_backend_pid() AND backend_type='client backend' AND state='idle' AND NOT (usename=current_user AND application_name='neon-lifecycle-controller') AND NOT (usename='cloud_admin' AND (application_name LIKE 'compute_ctl%' OR application_name='vm-monitor'))");
      const drain=(await client.query('SELECT neon.bounded_commit_guard_drain()::text AS lsn')).rows[0].lsn;
      if(!/^[0-9A-F]+\/[0-9A-F]+$/i.test(drain))throw Error('Invalid drain frontier');
      // Durable Kubernetes state precedes removal of every compute process.
      await this.status(endpoint,{phase:'Draining',drainedLSN:drain,drainedPodUID:pods[0].metadata.uid});
      await client.end();clientClosed=true;
      await this.scale(endpoint,0);
      await this.wait(endpoint,async()=>!(await this.pods(endpoint)).length,90000);
      await this.status(endpoint,{phase:'Dormant',podUID:null});this.idleSince.delete(endpoint.uid);
      return true;
    }catch(error){
      // Uncertain drains and ownership loss never remove compute. Keep admission
      // closed; the next owner resumes from the persisted Draining state.
      if(admissionClosed&&this.leader.active)await this.status(endpoint,{phase:'Draining',lastError:error.code||'DRAIN_FAILED'});
      throw error;
    }finally{if(!clientClosed)await client.end();}
  }
  async idle(endpoint){return await this.serialized(endpoint,async()=>{
    if(alwaysOn(endpoint))return;
    const deployment=await this.api.optional('deployments',endpoint.name);
    if(!deployment||deployment.spec.replicas!==1)return;
    this.owned(deployment,endpoint);
    if(endpoint.status.phase==='Draining')return await this.suspendLocked(endpoint,true);
    const pods=await this.pods(endpoint);if(pods.length!==1||!this.ready(pods[0]))return;
    let monitor=this.activity.get(endpoint.uid);
    if(monitor&&monitor.podUID!==pods[0].metadata.uid){await this.closeActivity(endpoint);monitor=null;}
    if(!monitor){monitor={client:await this.admin(endpoint,pods[0]),tracker:new Activity(this.clock),podUID:pods[0].metadata.uid};this.activity.set(endpoint.uid,monitor);}
    try{
      if(monitor.tracker.observe(await this.activitySample(monitor.client),endpoint))await this.suspendLocked(endpoint);
    }catch(error){await this.closeActivity(endpoint);throw error;}
  });}
}
