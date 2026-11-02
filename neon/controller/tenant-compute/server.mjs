import fs from 'node:fs';
import https from 'node:https';
import http from 'node:http';
import {timingSafeEqual,randomUUID} from 'node:crypto';
import pg from 'pg';
import {Kubernetes,Leadership} from './kubernetes.mjs';
import {endpointConfig,secretText} from './config.mjs';
import {Lifecycle} from './lifecycle.mjs';
import {alwaysOn} from './activity.mjs';
const namespace=process.env.POD_NAMESPACE,podName=process.env.POD_NAME;
const compose=process.env.NEON_PLATFORM==='compose';
if(!compose&&(!namespace||!podName))throw Error('Kubernetes identity is required');
const runtime=compose?await (await import('./deploy/compose.mjs')).composeRuntime():null;
const api=runtime?.api||new Kubernetes({namespace}),leader=runtime?.leader||new Leadership(api,{podName});
const lifecycle=runtime?.lifecycle||new Lifecycle(api,leader,async options=>{const client=new pg.Client(options);client.on('error',()=>{});await client.connect();return client;});
let endpoints=new Map(),polling=false,inFlight=0,stopping=false;
const events={wakes:0,errors:0,suspends:0};
const emit=(event,fields={})=>console.log(JSON.stringify({time:new Date().toISOString(),event,...fields}));
const managed=!compose&&process.env.NEON_DATABASE_API==='true';
const databases=managed?new (await import('./deploy/databases.mjs')).Databases({api,leader,lifecycle,getEndpoints:()=>endpoints,
  configFile:process.env.NEON_DEPLOYMENT_CONFIG,emit}):null;
const storage=process.env.NEON_DEPLOYMENT_CONFIG?new (await import('./deploy/routing.mjs')).StorageRouting({api,leader,lifecycle,compose,getEndpoints:()=>endpoints,
  getConfig:async()=>databases?databases.desired():(await import('./deploy/config.mjs')).configuration(process.env.NEON_DEPLOYMENT_CONFIG)}):null;
const fleet=databases&&process.env.NEON_FLEET_SCALE_TO_ZERO==='true'?new (await import('./deploy/fleet.mjs')).StorageFleet({api,leader,databases,
  routing:storage,getEndpoints:()=>endpoints,emit}):null;
if(fleet)databases.fleet=fleet;
const recovery=databases?new (await import('./deploy/recovery.mjs')).Recovery({databases,routing:storage,api,leader,lifecycle,getEndpoints:()=>endpoints,emit}):null;
if(databases){databases.recovery=recovery;lifecycle.wakeGuard=endpoint=>endpoint.databaseResource?databases.assertAvailable(endpoint.databaseResource):undefined;}
const identity=databases?new (await import('./deploy/identity.mjs')).Identity({configuration:()=>databases.base().identity}):null;
const credentials=databases?new (await import('./deploy/database-credentials.mjs')).DatabaseCredentials({api,leader,databases,identity,lifecycle,getEndpoints:()=>endpoints,emit}):null;
let scaler=null;
let stopDatabaseWatch=null;
async function refresh(){
  const resources=await api.list('configmaps','neon.klustr.io/endpoint=true');
  const next=new Map();
  for(const resource of resources){
    try{const endpoint=endpointConfig(resource);next.set(endpoint.endpointId,endpoint);}
    catch{emit('invalid_endpoint_definition',{resource:resource.metadata.name});}
  }
  endpoints=next;
}
async function poll(){
  if(polling||stopping)return;polling=true;
  try{
    if(fleet)void fleet.reconcile();
    if(databases)void databases.reconcile();
    if(recovery)void recovery.reconcile();
    if(credentials)void credentials.cleanup();
    await refresh();
    for(const uid of lifecycle.activity.keys())
      if(!leader.active||![...endpoints.values()].some(endpoint=>endpoint.uid===uid))await lifecycle.closeActivity({uid});
    if(leader.active)for(const endpoint of endpoints.values()){
      if(stopping||!leader.active)break;
      try{
        const before=endpoint.status.phase;
        if(databases&&endpoint.databaseResource)await databases.endpoint(endpoint);
        else if(alwaysOn(endpoint))await lifecycle.wake(endpoint);else await lifecycle.idle(endpoint);
        if(before!=='Dormant'&&endpoint.status.phase==='Dormant'){events.suspends++;emit('suspended',{endpoint:endpoint.endpointId});}
      }catch(error){events.errors++;emit('lifecycle_deferred',{endpoint:endpoint.endpointId,reason:error.code||'OPERATION_FAILED'});}
    }
  }catch{events.errors++;emit('reconcile_unavailable');}finally{polling=false;}
}
function authorized(request,file=process.env.CONTROLLER_API_TOKEN_FILE||'/run/controller-auth/token'){
  const expected=Buffer.from('Bearer '+fs.readFileSync(file,'utf8').trim());
  const actual=Buffer.from(request.headers.authorization||'');
  return expected.length>30&&expected.length===actual.length&&timingSafeEqual(expected,actual);
}
async function managementAuthorized(request){
  const configured=databases.base().identity;
  if(!configured || configured.management.allowStaticToken===true){
    if(authorized(request,process.env.NEON_MANAGEMENT_TOKEN_FILE||'/run/management/token'))return true;
    if(!configured)return false;
  }
  const actor=await identity.management(request);
  emit('management_authorized',{subject:actor.subject,method:request.method,path:request.url});return true;
}
async function body(request,limit=16384){
  const chunks=[];let size=0;
  for await(const chunk of request){size+=chunk.length;if(size>limit)throw Error('Request too large');chunks.push(chunk);}
  return JSON.parse(Buffer.concat(chunks).toString()||'{}');
}
function respond(response,status,body){
  const payload=JSON.stringify(body);response.writeHead(status,{'Content-Type':'application/json','Cache-Control':'no-store'});response.end(payload);
}
const server=https.createServer({key:fs.readFileSync(process.env.CONTROLLER_TLS_KEY||'/run/controller-tls/tls.key'),
  cert:fs.readFileSync(process.env.CONTROLLER_TLS_CERT||'/run/controller-tls/tls.crt'),minVersion:'TLSv1.2',maxHeaderSize:8192},async(request,response)=>{
  if(stopping||inFlight>=32)return respond(response,503,{error:'Control plane busy'});
  inFlight++;
  try{
    const exchange=request.url.match(/^\/v1\/databases\/([a-z][a-z0-9-]{0,38})\/credentials$/);
    if(credentials&&exchange&&request.method==='POST'){
      leader.require();return respond(response,201,await credentials.exchange(request,exchange[1],await body(request)));
    }
    if(databases&&request.url==='/v1/fleet'){
      if(!await managementAuthorized(request))return respond(response,401,{error:'Unauthorized'});
      leader.require();const items=await api.list('neonfleets','');
      if(items.length!==1)return respond(response,409,{error:'Expected one NeonFleet in this namespace'});
      const resource=items[0];
      if(request.method==='GET')return respond(response,200,{name:resource.metadata.name,spec:resource.spec,status:resource.status});
      if(request.method==='PUT'){
        const spec=await body(request,131072);try{(await import('./enterprise-fleet.mjs')).validateFleet({metadata:resource.metadata,spec});}catch{ return respond(response,422,{error:'INVALID_FLEET_SPEC'});}
        const updated=await api.request('PUT',api.path('neonfleets',resource.metadata.name),{...resource,spec});
        return respond(response,202,{name:updated.metadata.name,generation:updated.metadata.generation});
      }
      return respond(response,405,{error:'Unsupported fleet operation'});
    }
    const backupRoute=request.url.match(/^\/v1\/backups\/([a-z][a-z0-9-]{0,38})$/);
    if(recovery&&backupRoute){
      if(!await managementAuthorized(request))return respond(response,401,{error:'Unauthorized'});
      leader.require();const name=backupRoute[1],resource=await api.get('neonbackups',name);
      if(request.method==='GET')return respond(response,200,{name,spec:resource.spec,status:resource.status||{phase:'Pending'}});
      if(request.method==='DELETE'){
        await api.request('DELETE',api.path('neonbackups',name),{preconditions:{uid:resource.metadata.uid}});
        return respond(response,202,{name,accepted:true});
      }
      return respond(response,405,{error:'Unsupported backup operation'});
    }
    const management=request.url.match(/^\/v1\/databases\/([a-z][a-z0-9-]{0,38})(?:\/(events|suspend|resume|branches|backups|history))?$/);
    if(databases&&management){
      if(!await managementAuthorized(request))return respond(response,401,{error:'Unauthorized'});
      leader.require();
      const name=management[1];
      if(request.method==='GET'&&management[2]==='history')return respond(response,200,await recovery.history(name));
      if(request.method==='PUT'&&!management[2]){
        try{const resource=await databases.put(name,await body(request));void databases.reconcile();return respond(response,202,{name,generation:resource.metadata.generation});}
        catch(error){if(error.code==='INVALID_SPEC'||error.status===422)return respond(response,422,{error:'Invalid database specification'});throw error;}
      }
      if(request.method==='POST'&&management[2]==='events'){await databases.event(name,await body(request));return respond(response,202,{name,accepted:true});}
      if(request.method==='POST'&&['suspend','resume'].includes(management[2])){
        await databases.operation(name,management[2]);void poll();return respond(response,202,{name,accepted:true});
      }
      if(request.method==='DELETE'&&!management[2]){
        await databases.operation(name,'delete',await body(request));void poll();return respond(response,202,{name,accepted:true});
      }
      if(request.method==='GET'&&management[2]==='backups'){
        await recovery.load();return respond(response,200,{backups:[...recovery.resources.values()].filter(row=>row.spec.database===name).map(row=>({name:row.metadata.name,spec:row.spec,status:row.status||{phase:'Pending'}}))});
      }
      if(request.method==='POST'&&management[2]==='backups'){
        const input=await body(request);
        if(Object.keys(input).some(key=>!['name','retentionSeconds'].includes(key)))return respond(response,422,{error:'Invalid backup specification'});
        const resource=await recovery.create(name,input.name,{retentionSeconds:input.retentionSeconds});void recovery.reconcile();
        return respond(response,202,{name:resource.metadata.name,accepted:true});
      }
      if(request.method==='POST'&&management[2]==='branches'){
        const input=await body(request);
        if(Object.keys(input).some(key=>!['name','backup','lsn','timestamp','size','suspend','profile','allowedIps'].includes(key)))return respond(response,422,{error:'Invalid branch specification'});
        await databases.load();const source=recovery.source(name),parent=source.tenant;
        const spec={...(source.resource.spec.identity?{identity:source.resource.spec.identity}:{}),database:parent.database,user:parent.user,size:input.size||parent.size,tier:parent.tier,shards:parent.shards,
          profile:input.profile||parent.profile,suspend:input.suspend||parent.suspend,allowedIps:input.allowedIps||parent.allowedIps,
          branchFrom:{database:name,...Object.fromEntries(['backup','lsn','timestamp'].filter(key=>input[key]!==undefined).map(key=>[key,input[key]]))}};
        const resource=await databases.put(input.name,spec);void databases.reconcile();return respond(response,202,{name:resource.metadata.name,accepted:true});
      }
      if(request.method==='GET'&&!management[2]){const resource=await api.get('neondatabases',name);return respond(response,200,{name,spec:resource.spec,status:resource.status||{phase:'Pending'}});}
      return respond(response,405,{error:'Unsupported database operation'});
    }
    if(request.method!=='GET'||request.headers['transfer-encoding']||Number(request.headers['content-length']||0)!==0)
      return respond(response,405,{error:'GET without request body required'});
    if(!authorized(request))return respond(response,401,{error:'Unauthorized'});
    leader.require();
    const url=new URL(request.url,'https://control-plane.invalid');
    if(request.url.length>4096)return respond(response,414,{error:'Request too large'});
    const id=(url.searchParams.get('endpointish')||url.pathname.match(/^\/endpoints\/([^/]+)\/jwks$/)?.[1]||'').replace(/-pooler$/,'');
    const endpoint=endpoints.get(id);if(!endpoint)return respond(response,404,{error:'Endpoint not found'});
    if(url.pathname==='/get_endpoint_access_control'){
      const role=url.searchParams.get('role')||'';
      if(Buffer.byteLength(role)>63||!role)return respond(response,404,{error:'Role not found'});
      if(databases?.base().identity&&!databases.base().identity.database.allowPasswordAuth&&!/^oidc_[a-f0-9]{24}$/.test(role))return respond(response,404,{error:'OIDC credential exchange required'});
      const roles=JSON.parse(secretText(await api.get('secrets',endpoint.rolesSecret),'roles.json'));
      const roleSecret=Object.hasOwn(roles,role)?roles[role]:await credentials?.roleSecret(endpoint,role);
      if(typeof roleSecret!=='string'||!/^SCRAM-SHA-256\$[0-9]+:/.test(roleSecret))
        return respond(response,404,{error:'Role not found'});
      const iterations=Number(roleSecret.match(/^SCRAM-SHA-256\$([0-9]+):/)[1]);
      if(!Number.isSafeInteger(iterations)||iterations<1||iterations>100000)
        return respond(response,404,{error:'Role verifier is outside supported bounds'});
      return respond(response,200,{role_secret:roleSecret,allowed_ips:endpoint.allowedIps,
        allowed_vpc_endpoint_ids:[],block_public_connections:false,block_vpc_connections:true,
        project_id:endpoint.projectId,account_id:'self-hosted'});
    }
    if(url.pathname==='/wake_compute'){
      const complete=databases&&endpoint.databaseResource?databases.beginConnection(endpoint.databaseResource):()=>{};
      try{
        if(databases&&endpoint.databaseResource)await databases.event(endpoint.databaseResource,{id:'connection-'+randomUUID(),holdSeconds:3});
        if(fleet)await fleet.ensureActive();
        const result=await lifecycle.wake(endpoint);leader.require();events.wakes++;
        emit('compute_ready',{endpoint:id});return respond(response,200,result);
      }finally{complete();}
    }
    if(url.pathname===`/endpoints/${id}/jwks`)return respond(response,200,{jwks:[]});
    return respond(response,404,{error:'Unknown API method'});
  }catch(error){
    if(error.status&&[401,403,422,429].includes(error.status))return respond(response,error.status,{error:error.code||'REQUEST_REJECTED'});
    if(error.status===404)return respond(response,404,{error:'Resource not found'});
    if(error.code==='INVALID_SPEC')return respond(response,422,{error:error.code});
    if(['DATABASE_SUSPENDED','DATABASE_RETIRED','PURGE_CONFIRMATION_REQUIRED','DEPENDENT_BRANCHES_OR_BACKUPS','IMMUTABLE_BRANCH_SOURCE','BACKUP_NAME_CONFLICT','SOURCE_NOT_READY'].includes(error.code))return respond(response,409,{error:error.code});
    events.errors++;emit('request_deferred',{reason:error.code||'OPERATION_FAILED'});
    return respond(response,503,{error:'Endpoint temporarily unavailable',status:{code:'UNAVAILABLE',message:'Retry request',
      details:{error_info:{reason:'RUNNING_OPERATIONS'},retry_info:{retry_delay_ms:250}}}});
  }finally{inFlight--;}
});
server.requestTimeout=10000;server.headersTimeout=5000;server.keepAliveTimeout=5000;
server.maxConnections=256;server.maxRequestsPerSocket=1000;
const health=http.createServer(async(request,response)=>{
  if(['/notify-attach','/notify-safekeepers'].includes(request.url)&&request.method==='PUT'&&storage){
    if(!authorized(request)||!leader.active)return respond(response,503,{error:'Hook unavailable'});
    try{
      await storage.notify(request.url==='/notify-attach'?'attach':'safekeepers',await body(request));
      return respond(response,200,{status:'ok'});
    }catch(error){emit('storage_reconfigure_deferred',{reason:error.code||'STORAGE_NOT_READY'});return respond(response,503,{error:'Storage reconfiguration deferred'});}
  }
  if(request.url==='/livez')return respond(response,200,{status:'ok'});
  if(request.url==='/readyz')return respond(response,leader.active&&!stopping?200:503,{leader:leader.active});
  if(request.url==='/metrics'){
    response.writeHead(200,{'Content-Type':'text/plain'});return response.end(
      `neon_controller_leader ${leader.active?1:0}\nneon_controller_endpoints ${endpoints.size}\n`+
      Object.entries(events).map(([key,value])=>`neon_controller_${key}_total ${value}\n`).join(''));
  }
  return respond(response,404,{error:'Not found'});
});
await leader.tick();await refresh();
if(databases){
  await databases.load();
  scaler=await (await import('./keda/scaler.mjs')).startScaler({namespace,leader,demand:name=>name==='@fleet'?fleet.demand():databases.demand(name),
    tls:{ca:'/run/trust/ca.crt',key:'/run/controller-tls/tls.key',cert:'/run/controller-tls/tls.crt'}});
  databases.scaler=scaler;
  if(fleet)fleet.scaler=scaler;
  stopDatabaseWatch=databases.watch(()=>{void databases.reconcile();void poll();});
}
let previousLeaseError=null;
const renew=setInterval(async()=>{
  await leader.tick();
  if(leader.lastError&&leader.lastError!==previousLeaseError)emit('lease_unavailable',{reason:leader.lastError});
  previousLeaseError=leader.lastError;
},2000),reconcile=setInterval(()=>poll(),3000);
server.listen(8080,'0.0.0.0');health.listen(9090,'0.0.0.0');emit('controller_started');
async function shutdown(){
  if(stopping)return;stopping=true;clearInterval(renew);clearInterval(reconcile);
  // No replica changes during shutdown. Kubernetes state holds the handoff.
  stopDatabaseWatch?.();scaler?.close();server.close();health.close();setTimeout(()=>process.exit(0),2000).unref();
}
process.on('SIGTERM',shutdown);process.on('SIGINT',shutdown);
