import {randomUUID,createHash} from 'node:crypto';
import {SecretText as secretText,RenderComputeSpec as renderSpec} from '../../domain/compute/ComputeSpecification.mjs';
import {Activity,AlwaysOn as alwaysOn} from '../../domain/compute/Activity.mjs';
const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const OWNER='neon.klustr.io/endpoint-uid';
const ADMISSION='neon.klustr.io/admission';
const FENCE='neon.klustr.io/controller-epoch';
/** @typedef {import('../kubernetes/Kubernetes.mjs').Kubernetes} LifecycleKubernetes */
/** @typedef {import('../kubernetes/Kubernetes.mjs').Leadership} LifecycleLeadership */
/** @typedef {(options: import('pg').ClientConfig) => Promise<import('pg').Client>} LifecycleSqlConnect */
/** @typedef {import('../../domain/compute/ComputeSpecification.mjs').ComputeEndpoint} ComputeEndpoint */
/** @typedef {import('../kubernetes/Kubernetes.mjs').KubernetesResource} WorkloadResource */
/**
 * @typedef {Object} LifecycleOptions
 * @property {() => number} [clock] - Monotonic milliseconds for lifecycle deadlines, cache validity and idle observations.
 * @property {number} [wakeTimeout] - Wake deadline in milliseconds, default 90000.
 * @property {(endpoint: ComputeEndpoint) => Promise<void>} [wakeGuard] - Serving-fleet and resource admission guard invoked before wake and before opening routing.
 */
/**
 * @typedef {Object} ComputeWakeMetadata
 * @property {string} endpoint_id - Stable proxy endpoint identity.
 * @property {string} project_id - Provider project metric identity.
 * @property {string} branch_id - Provider branch metric identity.
 * @property {string} compute_id - Verified compute Pod UID for this connection.
 * @property {'pool_miss' | 'warm'} cold_start_info - Whether the observed wake took more than 100 milliseconds.
 */
/**
 * @typedef {Object} ComputeWakeResult
 * @property {string} address - Verified internal compute service address with port.
 * @property {string} server_name - TLS server name required by the connecting proxy.
 * @property {ComputeWakeMetadata} aux - Noncredential connection attribution.
 */
/**
 * Own serialized, lease-guarded compute wake, SQL activity observation and durable suspension.
 * A namespace lease is not cross-worker writer fencing: compute remains pinned and uncertain drains retain the running writer.
 */
export class Lifecycle {
  /**
   * @param {LifecycleKubernetes} api - Namespace workload, endpoint and credential persistence adapter.
   * @param {LifecycleLeadership} leadership - Active controller lease and mutation epoch.
   * @param {LifecycleSqlConnect} connect - TLS administrative SQL connection port.
   * @param {LifecycleOptions} [options] - Monotonic deadline and wake-admission policy.
   */
  constructor(api,leadership,connect,{clock=()=>performance.now(),wakeTimeout=90000,wakeGuard=async()=>{}}={}){
    this.api=api;this.leader=leadership;this.connect=connect;this.clock=clock;this.wakeTimeout=wakeTimeout;this.wakeGuard=wakeGuard;
    this.locks=new Map();this.idleSince=new Map();this.readyCache=new Map();this.activity=new Map();
  }
  /**
   * Enumerate endpoint identities with an open SQL activity monitor.
   * Internal reconciliation needs no additional permission; this copied observation has no mutation side effects.
   * @returns {string[]} Endpoint ConfigMap UIDs with owned monitor connections.
   */
  activityIds(){return [...this.activity.keys()];}
  /**
   * Discard a cached verified wake result after routing or compute configuration changes.
   * Requires internal lifecycle authorization; side effects remove only the in-memory readiness entry.
   * @param {Pick<ComputeEndpoint, 'uid'>} endpoint - Endpoint identity whose readiness must be reverified.
   * @returns {void} Returns after cache invalidation without touching compute.
   */
  invalidateReady(endpoint){this.readyCache.delete(endpoint.uid);}
  /**
   * Serialize endpoint operations behind prior success or failure and check lease authority before execution.
   * Command authorization belongs to the caller; side effects reserve/release a local endpoint queue and invoke the supplied operation.
   * @template T
   * @param {ComputeEndpoint} endpoint - Immutable endpoint identity selecting the queue.
   * @param {() => Promise<T>} operation - Authorized endpoint operation to execute under the queue.
   * @returns {Promise<T>} Operation result without masking its rejection.
   * @throws {Error} On lost lease or operation failure.
   */
  async serialized(endpoint,operation){
    const before=this.locks.get(endpoint.uid)||Promise.resolve();
    const work=before.catch(()=>{}).then(()=>{this.leader.require();return operation();});
    this.locks.set(endpoint.uid,work);
    try{return await work;}finally{if(this.locks.get(endpoint.uid)===work)this.locks.delete(endpoint.uid);}
  }
  /**
   * Derive endpoint UID ownership and routing labels without provider side effects.
   * These labels identify resources; they do not grant authorization.
   * @param {ComputeEndpoint} endpoint - Validated endpoint identity.
   * @returns {Record<string, string>} Newly allocated ownership labels.
   */
  labels(endpoint){return {[OWNER]:endpoint.uid,'neon.klustr.io/endpoint':endpoint.endpointId};}
  /**
   * Reject adoption of a workload belonging to a different endpoint identity.
   * This ownership check complements caller authorization and has no mutation side effects.
   * @template {WorkloadResource} T
   * @param {T} resource - Provider resource observed before mutation or SQL access.
   * @param {ComputeEndpoint} endpoint - Expected endpoint owner.
   * @returns {T} The same resource after its endpoint UID matches.
   * @throws {Error} When the ownership label is missing or mismatched.
   */
  owned(resource,endpoint){if(resource.metadata.labels?.[OWNER]!==endpoint.uid)throw Error('Resource ownership mismatch');return resource;}
  /**
   * Mutate an endpoint-owned workload with optimistic concurrency and the current controller epoch.
   * Requires active lease authorization before and after the write; side effects patch provider state only after ownership verification.
   * @param {string} kind - Supported namespace workload collection.
   * @param {ComputeEndpoint} endpoint - Endpoint owner and resource name.
   * @param {Partial<WorkloadResource>} changes - Authorized desired-state patch; current concurrency/epoch fields are enforced here.
   * @returns {Promise<WorkloadResource>} Patched provider resource.
   * @throws {Error} On ownership mismatch, lost lease, resource-version conflict or provider failure.
   */
  async mutate(kind,endpoint,changes){
    this.leader.require();const current=this.owned(await this.api.get(kind,endpoint.name),endpoint);
    const next=await this.api.patch(kind,endpoint.name,{...changes,metadata:{...changes.metadata,
      resourceVersion:current.metadata.resourceVersion,annotations:{...current.metadata.annotations,
        ...changes.metadata?.annotations,[FENCE]:this.leader.identity}}});
    this.leader.require();return next;
  }
  /**
   * Persist a lifecycle observation before advancing destructive transitions.
   * Requires active lease authorization and the current endpoint UID; side effects merge status.json, persist the controller epoch/time and mutate the invocation's endpoint status.
   * @param {ComputeEndpoint} endpoint - Current persisted endpoint identity and mutable observation.
   * @param {Record<string, unknown>} fields - Lifecycle observation fields, including any durable handoff frontier.
   * @returns {Promise<void>} Resolves only after the status write and lease recheck.
   * @throws {Error} On replaced endpoint, malformed persisted status, lost lease, concurrency conflict or provider failure.
   */
  async status(endpoint,fields){
    this.leader.require();const current=await this.api.get('configmaps',endpoint.name);
    if(current.metadata.uid!==endpoint.uid)throw Error('Endpoint definition was replaced');
    const previous=JSON.parse(current.data['status.json']||'{}');
    const status={...previous,...fields,controller:this.leader.identity,updatedAt:new Date().toISOString()};
    await this.api.patch('configmaps',endpoint.name,{metadata:{resourceVersion:current.metadata.resourceVersion},
      data:{'status.json':JSON.stringify(status)}});this.leader.require();endpoint.status=status;
  }
  /**
   * Open or close new client routing through the endpoint Service selector.
   * Requires active lease and workload ownership authorization; side effects patch the admission selector without forcibly closing established SQL sessions.
   * @param {ComputeEndpoint} endpoint - Service owner to update.
   * @param {boolean} open - Whether verified compute may receive new proxied connections.
   * @returns {Promise<void>} Resolves after the Service patch is accepted.
   * @throws {Error} On ownership mismatch, lost lease, concurrency conflict or provider failure.
   */
  async admission(endpoint,open){
    await this.mutate('services',endpoint,{spec:{selector:{...this.labels(endpoint),[ADMISSION]:open?'open':'closed'}}});
  }
  /**
   * Request zero or one compute writer after the owning lifecycle transition authorizes it.
   * Requires active lease and endpoint ownership authorization; side effects patch desired Deployment replicas without waiting for Pod termination/readiness.
   * @param {ComputeEndpoint} endpoint - Writer Deployment owner.
   * @param {0 | 1} replicas - Desired single-writer availability.
   * @returns {Promise<WorkloadResource>} Updated Deployment.
   * @throws {Error} On ownership mismatch, lost lease, concurrency conflict or provider failure.
   */
  async scale(endpoint,replicas){return this.mutate('deployments',endpoint,{spec:{replicas}});}
  /**
   * Observe all Pods carrying the endpoint's immutable ownership label.
   * Requires namespace Pod read permission; side effects perform an inventory read only.
   * @param {ComputeEndpoint} endpoint - Endpoint whose running and terminating Pods must be counted.
   * @returns {Promise<WorkloadResource[]>} Complete matching Pod inventory.
   * @throws {Error} On provider list failure.
   */
  async pods(endpoint){return await this.api.list('pods',OWNER+'='+endpoint.uid);}
  /**
   * Poll a lifecycle prerequisite under a monotonic deadline and current lease authority.
   * Caller authorization covers the supplied predicate; side effects invoke it every 250 milliseconds until a truthy result or deadline.
   * @template T
   * @param {ComputeEndpoint} endpoint - Endpoint attribution retained in the lifecycle contract.
   * @param {() => Promise<T | false | null | undefined>} predicate - Authorized readiness or termination observation.
   * @param {number} [timeout] - Deadline in milliseconds, defaulting to the configured wake timeout.
   * @returns {Promise<T>} First truthy prerequisite result.
   * @throws {Error} DEADLINE on timeout, or lease/predicate failure.
   */
  async wait(endpoint,predicate,timeout=this.wakeTimeout){
    const end=this.clock()+timeout;
    do{this.leader.require();const result=await predicate();if(result)return result;await delay(250);}while(this.clock()<end);
    const error=Error('Lifecycle deadline exceeded');error.code='DEADLINE';throw error;
  }
  /**
   * Ensure an owned closed-admission Service and zero-replica single-writer Deployment exist.
   * Requires active lease authorization; side effects create missing resources and reject foreign ownership rather than adopting it.
   * @param {ComputeEndpoint} endpoint - Validated provider endpoint and pinned placement.
   * @returns {Promise<WorkloadResource>} Existing or newly created Deployment, without waking it.
   * @throws {Error} On lost lease, foreign ownership, create conflict or provider failure.
   */
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
  /**
   * Render a nonroot read-only compute Pod pinned to its existing writer worker.
   * Provider configuration authorization belongs to the owning boundary; rendering has no I/O or persistence side effects.
   * Infinite unreachable-worker tolerations deliberately prevent automatic replacement of a potentially live writer.
   * @param {ComputeEndpoint} endpoint - Digest-pinned image, resources, placement and Secret references.
   * @returns {WorkloadResource} Pod template with ephemeral compute data/cache and projected TLS/specification Secrets.
   */
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
        resources:{requests:{cpu:'250m',memory:'512Mi',...endpoint.resources?.requests},limits:{cpu:'2',memory:'2Gi',...endpoint.resources?.limits}},
        securityContext:{allowPrivilegeEscalation:false,readOnlyRootFilesystem:true,capabilities:{drop:['ALL']}},
        // The controller verifies SQL and the remote quorum before opening the
        // Service. Process probes avoid counting probe logins as user activity.
        readinessProbe:{exec:{command:['/bin/sh','-ec','read -r pg_pid < /var/lib/neon/pgdata/postmaster.pid; kill -0 "$pg_pid"']},periodSeconds:1,timeoutSeconds:1,failureThreshold:3},
        startupProbe:{exec:{command:['/bin/sh','-ec','read -r pg_pid < /var/lib/neon/pgdata/postmaster.pid; kill -0 "$pg_pid"']},periodSeconds:1,failureThreshold:90},
        volumeMounts:[{name:'data',mountPath:'/var/lib/neon'},{name:'tmp',mountPath:'/tmp'},
          {name:'shm',mountPath:'/dev/shm'},{name:'spec',mountPath:'/run/compute-spec',readOnly:true},
          {name:'tls',mountPath:'/run/compute-tls',readOnly:true},
          ...(endpoint.oauth?[{name:'oauth',mountPath:'/run/oauth',readOnly:true}]:[])]}],
      volumes:[{name:'data',emptyDir:{sizeLimit:'4Gi'}},{name:'tmp',emptyDir:{sizeLimit:'256Mi'}},
        {name:'shm',emptyDir:{medium:'Memory',sizeLimit:'256Mi'}},
        {name:'spec',secret:{secretName:endpoint.name+'-rendered',defaultMode:288}},
        {name:'tls',secret:{secretName:endpoint.tlsSecret,defaultMode:288}},
        ...(endpoint.oauth?[{name:'oauth',secret:{secretName:endpoint.oauth.secret,defaultMode:288}}]:[])]}};
  }
  /**
   * Render authenticated compute configuration and reserve its native timeline for this immutable endpoint UID.
   * Requires lifecycle command authorization and an active lease before publishing the rendered Secret.
   * Side effects read sensitive source configuration, create a nonexpiring writer reservation and create/update an endpoint-owned Secret.
   * @param {ComputeEndpoint} endpoint - Authorized writer identity and specification reference.
   * @returns {Promise<void>} Resolves after the reservation and rendered Secret are verified/persisted.
   * @throws {Error} On a different timeline writer, invalid specification, foreign Secret ownership, lost lease or provider failure.
   */
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
  /**
   * Open a verified-TLS lifecycle SQL connection to an already-selected compute Pod.
   * Requires internal administrative authorization and namespace Secret read permission; side effects read credentials/trust and open a bounded SQL connection.
   * The caller owns closing the returned client; this method does not wake compute or authorize customer SQL roles.
   * @param {ComputeEndpoint} endpoint - Administrative credential and expected service certificate identity.
   * @param {WorkloadResource} pod - Previously verified owned Pod with a current Pod IP.
   * @param {string} [database] - SQL database to inspect, default postgres.
   * @returns {Promise<import('pg').Client>} Connected administrative client with bounded connection/statement/query timeouts.
   * @throws {Error} On missing credentials, invalid Secret, TLS/connection failure or provider read failure.
   */
  async admin(endpoint,pod,database='postgres'){
    const [secret,ca]=await Promise.all([this.api.get('secrets',endpoint.adminSecret),this.api.get('secrets',endpoint.caSecret)]);
    const credentials=JSON.parse(secretText(secret,'admin.json'));
    if(!credentials.user||!credentials.password)throw Error('Missing administrator credentials');
    return await this.connect({...credentials,database,host:pod.status.podIP,port:5432,
      application_name:'neon-lifecycle-controller',connectionTimeoutMillis:3000,
      statement_timeout:10000,query_timeout:12000,
      ssl:{rejectUnauthorized:true,ca:secretText(ca,'ca.crt'),servername:endpoint.name+'.'+this.api.namespace+'.svc.cluster.local'}});
  }
  /**
   * Check Kubernetes process readiness without granting SQL or quorum authorization.
   * This observation requires no additional permission and has no mutation side effects.
   * @param {WorkloadResource} pod - Observed compute Pod.
   * @returns {boolean | undefined} Truthy only for a nonterminating Running Pod with a Ready condition.
   */
  ready(pod){return pod.metadata.deletionTimestamp===undefined&&pod.status.phase==='Running'&&
    pod.status.conditions?.some(condition=>condition.type==='Ready'&&condition.status==='True');}
  /**
   * Verify a guarded PG18 primary and its recovery beyond any persisted drain boundary.
   * Requires lifecycle administrative authorization; side effects open/read/close SQL without changing admission or replica count.
   * @param {ComputeEndpoint} endpoint - Required durability profile and prior handoff frontier.
   * @param {WorkloadResource} pod - Candidate compute Pod already observed ready.
   * @returns {Promise<void>} Resolves only for a PG18 primary with an enabled guard and available quorum.
   * @throws {Error} On failed primary/quorum/frontier checks or SQL/provider failure.
   */
  async verify(endpoint,pod){
    const client=await this.admin(endpoint,pod);
    try{
      const row=(await client.query("SELECT current_setting('server_version_num')::int AS version, pg_is_in_recovery() AS recovery, neon.bounded_commit_guard_status()::json AS guard")).rows[0];
      if(row.version<180000||row.version>=190000||row.recovery||!row.guard.enabled||!row.guard.quorum_available||
        Boolean(row.guard.best_effort)!==(endpoint.profile==='best-effort'))throw Error('Compute is not a guarded PG18 primary with the requested commit policy');
      if(endpoint.status.drainedLSN){
        const check=await client.query('SELECT pg_current_wal_insert_lsn() >= $1::pg_lsn AS recovered',[endpoint.status.drainedLSN]);
        if(!check.rows[0].recovered)throw Error('Compute is behind its persisted handoff frontier');
      }
    }finally{await client.end();}
  }
  /**
   * Wake or verify one writer, completing an interrupted drain before reopening client routing.
   * Requires serving-fleet/database authorization through wakeGuard and active lease authorization throughout serialized mutations.
   * Side effects may reserve/render/start compute, verify SQL/quorum, persist lifecycle state and open admission; verified routing is cached for one second.
   * @param {ComputeEndpoint} endpoint - Current policy revision and pinned writer identity.
   * @returns {Promise<ComputeWakeResult>} Verified TLS routing information for the proxy.
   * @throws {Error} On retirement, ownership/reservation mismatch, active configuration change, lost lease, deadline or provider/SQL failure.
   */
  async wake(endpoint){return await this.serialized(endpoint,async()=>{
    await this.wakeGuard?.(endpoint);
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
    await this.wakeGuard?.(endpoint);
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
  /**
   * Count SQL clients or WAL senders whose active work prevents suspension.
   * Requires an authorized lifecycle SQL connection; side effects read PostgreSQL activity statistics, excluding owned maintenance connections.
   * @param {import('pg').Client} client - Connected lifecycle administrator.
   * @returns {Promise<number>} Nonidle application work count used after admission closure.
   * @throws {Error} On SQL observation failure.
   */
  async activeClients(client){
    const result=await client.query("SELECT count(*)::int AS n FROM pg_stat_activity WHERE pid<>pg_backend_pid() AND backend_type IN ('client backend','walsender') AND state IS DISTINCT FROM 'idle' AND NOT (usename=current_user AND application_name='neon-lifecycle-controller') AND NOT (usename='cloud_admin' AND (application_name LIKE 'compute_ctl%' OR application_name IN ('vm-monitor','walproposer')))");
    return result.rows[0].n;
  }
  /**
   * Sample per-database cumulative activity, client states and replication/subscription/autovacuum blockers.
   * Requires authorized lifecycle SQL access; side effects read statistics without changing application sessions or wake demand.
   * @param {import('pg').Client} client - Connected lifecycle administrator.
   * @returns {Promise<import('../../domain/compute/Activity.mjs').ComputeActivitySample>} Inputs for idle detection, including short-lived connections absent from current backends.
   * @throws {Error} On SQL observation failure.
   */
  async activitySample(client){
    // Only the internal postgres database hosts owned SQL telemetry. Its global
    // session counters include each scrape, so use role-bound statement counters
    // there. Customer database counters still catch all short-lived connections.
    const result=await client.query(`WITH internal_work AS (
      SELECT coalesce(sum(calls),0)::text AS calls,
        coalesce(sum(total_exec_time+total_plan_time),0)::text AS active_ms
      FROM public.pg_stat_statements(false) WHERE dbid=(SELECT oid FROM pg_database WHERE datname='postgres')
        AND userid NOT IN (SELECT oid FROM pg_roles WHERE rolname IN ('cloud_admin','neon_lifecycle'))
    ) SELECT json_build_object(
      'databases',(SELECT coalesce(json_agg(json_build_object('name',datname,
        'work_count',CASE WHEN datname='postgres' THEN internal_work.calls ELSE sessions::text END,
        'active_ms',CASE WHEN datname='postgres' THEN internal_work.active_ms ELSE active_time::text END,
        'reset',CASE WHEN datname='postgres' THEN concat(d.stats_reset::text,'/',info.stats_reset::text,'/',info.dealloc::text)
          ELSE d.stats_reset::text END)),'[]'::json)
        FROM pg_stat_database d CROSS JOIN internal_work CROSS JOIN public.pg_stat_statements_info info
        WHERE datname NOT IN ('template0','template1')),
      'clients',(SELECT coalesce(json_agg(json_build_object('pid',pid,'database',datname,'state',state,
        'change',state_change::text)),'[]'::json) FROM pg_stat_activity WHERE backend_type='client backend'
        AND pid<>pg_backend_pid() AND NOT (usename=current_user AND application_name='neon-lifecycle-controller')
        AND NOT (usename='cloud_admin' AND (application_name LIKE 'compute_ctl%' OR application_name='vm-monitor'))),
      'blockers',((SELECT count(*) FROM pg_stat_replication WHERE application_name<>'walproposer')+
        (SELECT count(*) FROM pg_stat_subscription WHERE pid IS NOT NULL)+
        (SELECT count(*) FROM pg_stat_activity WHERE backend_type='autovacuum worker'))>0) AS activity`);
    return result.rows[0].activity;
  }
  /**
   * Remove and close the owned activity monitor for an endpoint.
   * Internal lifecycle cleanup authorization suffices; side effects remove local monitor state and close its SQL client without waking compute.
   * @param {Pick<ComputeEndpoint, 'uid'>} endpoint - Endpoint whose observation connection is obsolete.
   * @returns {Promise<void>} Resolves after closure or immediately when no monitor exists.
   * @throws {Error} On SQL client closure failure.
   */
  async closeActivity(endpoint){
    const monitor=this.activity.get(endpoint.uid);this.activity.delete(endpoint.uid);
    if(monitor)await monitor.client.end();
  }
  /**
   * Observe recent SQL demand on an already-running writer without starting sleeping compute.
   * Requires active lease and endpoint ownership authorization; side effects maintain a Pod-bound SQL monitor and local activity fingerprint.
   * Unready existing compute preserves demand rather than authorizing scale-down from missing observations.
   * @param {ComputeEndpoint} endpoint - Current endpoint and ownership identity.
   * @returns {Promise<boolean>} Whether recent SQL activity or uncertain readiness requires continued availability.
   * @throws {Error} On lost lease, foreign ownership, statistics or provider failure; failed monitors are closed.
   */
  async sampleDemand(endpoint){return this.serialized(endpoint,async()=>{
    const deployment=await this.api.optional('deployments',endpoint.name);
    if(!deployment||deployment.spec.replicas===0)return false;
    this.owned(deployment,endpoint);
    const pods=await this.pods(endpoint);if(pods.length!==1||!this.ready(pods[0]))return true;
    let monitor=this.activity.get(endpoint.uid);
    if(monitor&&monitor.podUID!==pods[0].metadata.uid){await this.closeActivity(endpoint);monitor=null;}
    if(!monitor){monitor={client:await this.admin(endpoint,pods[0]),tracker:new Activity(this.clock),podUID:pods[0].metadata.uid};this.activity.set(endpoint.uid,monitor);}
    try{
      const observed={...endpoint,suspend:{mode:'idle',idleSeconds:1},databasePolicies:{}};
      return !monitor.tracker.observe(await this.activitySample(monitor.client),observed);
    }catch(error){await this.closeActivity(endpoint);throw error;}
  });}
  /**
   * Attempt ordinary suspension while honoring never-suspend policy and active SQL work.
   * Requires authorized scale-down intent and active lease/ownership authorization; side effects serialize the durable drain and may stop the writer after its frontier is persisted.
   * @param {ComputeEndpoint} endpoint - Compute whose idle demand permits suspension.
   * @returns {Promise<boolean>} True after a completed drain; false for already-stopped compute, never-suspend policy or active work.
   * @throws {Error} On ownership/lease failure, uncertain drain or SQL/provider failure; uncertainty retains compute.
   */
  async suspend(endpoint){return this.serialized(endpoint,async()=>{
    const deployment=await this.api.optional('deployments',endpoint.name);
    if(!deployment||deployment.spec.replicas===0)return false;
    this.owned(deployment,endpoint);return this.suspendLocked(endpoint);
  });}
  /**
   * Attempt an explicitly authorized administrative stop, including never-suspend computes.
   * Requires administrative lifecycle authorization and active lease/ownership authorization; side effects use the same durable drain and active-work protection as ordinary suspension.
   * @param {ComputeEndpoint} endpoint - Writer being manually suspended, retired or resized.
   * @returns {Promise<boolean>} True when stopped/already stopped; false while active application work prevents draining.
   * @throws {Error} On ownership/lease failure, uncertain drain or SQL/provider failure.
   */
  async maintenanceSuspend(endpoint){return this.serialized(endpoint,async()=>{
    const deployment=await this.api.optional('deployments',endpoint.name);
    if(!deployment||deployment.spec.replicas===0)return true;
    this.owned(deployment,endpoint);return this.suspendLocked(endpoint,false,true);
  });}
  /**
   * Close admission, recheck active work, drain WAL, persist its frontier and only then remove compute.
   * Requires the caller to hold endpoint serialization plus scale-down authorization; individual mutations enforce the active lease.
   * Side effects terminate idle pooled clients, persist Draining/Dormant observations and scale to zero only after a verified native drain. Uncertain failures leave admission closed and the writer retained for retry.
   * @param {ComputeEndpoint} endpoint - Current writer and durable handoff observation.
   * @param {boolean} [resume] - Compatibility marker for interrupted-drain callers; does not bypass any drain check.
   * @param {boolean} [maintenance] - Explicit administrative authority to override never-suspend policy, never active work or durability checks.
   * @returns {Promise<boolean>} True after full termination; false when policy or observed active work keeps compute running.
   * @throws {Error} On unverified compute, failed quorum drain, invalid frontier, lease loss, deadline or persistence failure.
   */
  async suspendLocked(endpoint,resume=false,maintenance=false){
    this.readyCache.delete(endpoint.uid);
    if(alwaysOn(endpoint)&&!maintenance){await this.admission(endpoint,true);await this.status(endpoint,{phase:'Active'});return false;}
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
  /**
   * Apply effective per-database idle policy to a running standalone compute or resume its persisted drain.
   * Requires internal idle-reconciliation authorization and active lease/ownership authorization; side effects maintain SQL monitors and invoke durable suspension when every database is idle.
   * @param {ComputeEndpoint} endpoint - Normalized shared-compute idle policies and current observation.
   * @returns {Promise<boolean | undefined>} Drain result when recovering Draining state, otherwise no value after observation or policy skip.
   * @throws {Error} On lease/ownership loss, SQL observation failure or uncertain drain; monitor failures close the owned client.
   */
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
