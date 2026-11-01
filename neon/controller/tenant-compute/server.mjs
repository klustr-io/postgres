import fs from 'node:fs';
import https from 'node:https';
import http from 'node:http';
import {timingSafeEqual} from 'node:crypto';
import pg from 'pg';
import {Kubernetes,Leadership} from './kubernetes.mjs';
import {endpointConfig,secretText} from './config.mjs';
import {Lifecycle} from './lifecycle.mjs';
import {alwaysOn} from './activity.mjs';
const namespace=process.env.POD_NAMESPACE,podName=process.env.POD_NAME;
if(!namespace||!podName)throw Error('Kubernetes identity is required');
const api=new Kubernetes({namespace}),leader=new Leadership(api,{podName});
const lifecycle=new Lifecycle(api,leader,async options=>{const client=new pg.Client(options);client.on('error',()=>{});await client.connect();return client;});
let endpoints=new Map(),polling=false,inFlight=0,stopping=false;
const events={wakes:0,errors:0,suspends:0};
const emit=(event,fields={})=>console.log(JSON.stringify({time:new Date().toISOString(),event,...fields}));
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
    await refresh();
    for(const uid of lifecycle.activity.keys())
      if(!leader.active||![...endpoints.values()].some(endpoint=>endpoint.uid===uid))await lifecycle.closeActivity({uid});
    if(leader.active)for(const endpoint of endpoints.values()){
      if(stopping||!leader.active)break;
      try{
        const before=endpoint.status.phase;
        if(alwaysOn(endpoint))await lifecycle.wake(endpoint);else await lifecycle.idle(endpoint);
        if(before!=='Dormant'&&endpoint.status.phase==='Dormant'){events.suspends++;emit('suspended',{endpoint:endpoint.endpointId});}
      }catch(error){events.errors++;emit('lifecycle_deferred',{endpoint:endpoint.endpointId,reason:error.code||'OPERATION_FAILED'});}
    }
  }catch{events.errors++;emit('reconcile_unavailable');}finally{polling=false;}
}
function authorized(request){
  const expected=Buffer.from('Bearer '+fs.readFileSync(process.env.CONTROLLER_API_TOKEN_FILE||'/run/controller-auth/token','utf8').trim());
  const actual=Buffer.from(request.headers.authorization||'');
  return expected.length>30&&expected.length===actual.length&&timingSafeEqual(expected,actual);
}
function respond(response,status,body){
  const payload=JSON.stringify(body);response.writeHead(status,{'Content-Type':'application/json','Cache-Control':'no-store'});response.end(payload);
}
const server=https.createServer({key:fs.readFileSync('/run/controller-tls/tls.key'),
  cert:fs.readFileSync('/run/controller-tls/tls.crt'),minVersion:'TLSv1.2',maxHeaderSize:8192},async(request,response)=>{
  if(stopping||inFlight>=32)return respond(response,503,{error:'Control plane busy'});
  inFlight++;
  try{
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
      const roles=JSON.parse(secretText(await api.get('secrets',endpoint.rolesSecret),'roles.json'));
      if(!Object.hasOwn(roles,role)||typeof roles[role]!=='string'||!/^SCRAM-SHA-256\$[0-9]+:/.test(roles[role]))
        return respond(response,404,{error:'Role not found'});
      const iterations=Number(roles[role].match(/^SCRAM-SHA-256\$([0-9]+):/)[1]);
      if(!Number.isSafeInteger(iterations)||iterations<1||iterations>100000)
        return respond(response,404,{error:'Role verifier is outside supported bounds'});
      return respond(response,200,{role_secret:roles[role],allowed_ips:endpoint.allowedIps,
        allowed_vpc_endpoint_ids:[],block_public_connections:false,block_vpc_connections:true,
        project_id:endpoint.projectId,account_id:'self-hosted'});
    }
    if(url.pathname==='/wake_compute'){
      const result=await lifecycle.wake(endpoint);leader.require();events.wakes++;
      emit('compute_ready',{endpoint:id});return respond(response,200,result);
    }
    if(url.pathname===`/endpoints/${id}/jwks`)return respond(response,200,{jwks:[]});
    return respond(response,404,{error:'Unknown API method'});
  }catch(error){
    events.errors++;emit('request_deferred',{reason:error.code||'OPERATION_FAILED'});
    return respond(response,503,{error:'Endpoint temporarily unavailable',status:{code:'UNAVAILABLE',message:'Retry request',
      details:{error_info:{reason:'RUNNING_OPERATIONS'},retry_info:{retry_delay_ms:250}}}});
  }finally{inFlight--;}
});
server.requestTimeout=10000;server.headersTimeout=5000;server.keepAliveTimeout=5000;
server.maxConnections=256;server.maxRequestsPerSocket=1000;
const health=http.createServer((request,response)=>{
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
  server.close();health.close();setTimeout(()=>process.exit(0),2000).unref();
}
process.on('SIGTERM',shutdown);process.on('SIGINT',shutdown);
