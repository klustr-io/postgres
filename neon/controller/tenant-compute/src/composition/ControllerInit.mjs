import pg from 'pg';
import {Kubernetes,Leadership} from '../infrastructure/kubernetes/Kubernetes.mjs';
import {Lifecycle} from '../infrastructure/compute/Lifecycle.mjs';
import {FleetConfiguration} from '../application/fleet/FleetConfiguration.mjs';
import {KubernetesFleetRepository} from '../infrastructure/kubernetes/KubernetesFleetRepository.mjs';
import {FleetController} from '../api/fleet/FleetController.mjs';
import {FleetRoutes} from '../api/fleet/FleetRoutes.mjs';
import {ManagementAuthorization} from '../api/identity/ManagementAuthorization.mjs';
import {DatabaseController} from '../api/database/DatabaseController.mjs';
import {RecoveryController} from '../api/recovery/RecoveryController.mjs';
import {BranchController} from '../api/database/BranchController.mjs';
import {DatabaseRoutes} from '../api/database/DatabaseRoutes.mjs';
import {BranchDatabase} from '../application/database/BranchDatabase.mjs';
import {DatabaseQuery} from '../application/database/DatabaseQuery.mjs';
import {KubernetesDatabaseRepository} from '../infrastructure/kubernetes/KubernetesDatabaseRepository.mjs';
import {ReconcileTenants as reconcileTenants} from '../infrastructure/provisioning/TenantProvisioning.mjs';
import {ManagedDatabasesInit} from './ManagedDatabasesInit.mjs';
import {NativeOAuthController, NativeOAuthRoutes} from '../api/identity/NativeOAuthController.mjs';
import {ProxyAccess} from '../application/identity/ProxyAccess.mjs';
import {WakeCompute} from '../application/compute/WakeCompute.mjs';
import {EndpointRoleVerifiers} from '../infrastructure/identity/EndpointRoleVerifiers.mjs';
import {TokenFileAuthorization} from '../infrastructure/identity/TokenFileAuthorization.mjs';
import {ProxyController} from '../api/proxy/ProxyController.mjs';
import {ProxyRoutes} from '../api/proxy/ProxyRoutes.mjs';
import {CredentialsController,CredentialsRoutes} from '../api/identity/CredentialsController.mjs';
import {ControlPlaneRouter} from '../api/http/ControlPlaneRouter.mjs';
import {HealthController} from '../api/http/HealthController.mjs';
import {HttpServersInit} from './HttpServersInit.mjs';
import {ComputeReconciliation} from '../application/compute/ComputeReconciliation.mjs';
import {KubernetesEndpointDefinitions} from '../infrastructure/kubernetes/KubernetesEndpointDefinitions.mjs';
const namespace=process.env.POD_NAMESPACE,podName=process.env.POD_NAME;
const compose=process.env.NEON_PLATFORM==='compose';
if(!compose&&(!namespace||!podName))throw Error('Kubernetes identity is required');
const runtime=compose?await (await import('../infrastructure/compose/ComposeRuntime.mjs')).ComposeRuntimeInit():null;
const api=runtime?.api||new Kubernetes({namespace}),leader=runtime?.leader||new Leadership(api,{podName});
let databases=null,storage=null,fleet=null,recovery=null,scaler=null;
const lifecycle=runtime?.lifecycle||new Lifecycle(api,leader,async options=>{const client=new pg.Client(options);client.on('error',error=>emit('postgres_connection_error',{reason:error.code||'CONNECTION_FAILED'}));await client.connect();return client;},
  {wakeGuard:async endpoint=>{if(databases&&endpoint.databaseResource)await databases.assertAvailable(endpoint.databaseResource);}});
let worker,stopping=false;
const events={wakes:0,errors:0,suspends:0};
const emit=(event,fields={})=>console.log(JSON.stringify({time:new Date().toISOString(),event,...fields}));
const managed=!compose&&process.env.NEON_DATABASE_API==='true';
const managedRuntime=managed?ManagedDatabasesInit({api,leader,lifecycle,getEndpoints:()=>worker.Endpoints(),
  configFile:process.env.NEON_DEPLOYMENT_CONFIG,emit,enableFleet:process.env.NEON_FLEET_SCALE_TO_ZERO==='true',
  publishDemand:(name,active)=>scaler?.publish(name,active),provision:desired=>reconcileTenants(desired,()=>leader.require(),api)}):null;
if(managedRuntime)({databases,storage,fleet,recovery}=managedRuntime);
else if(process.env.NEON_DEPLOYMENT_CONFIG)storage=new (await import('../infrastructure/storage/StorageRouting.mjs')).StorageRouting({api,leader,lifecycle,compose,getEndpoints:()=>worker.Endpoints(),
  getConfig:async()=>(await import('../infrastructure/configuration/ConfigurationFile.mjs')).ConfigurationFile(process.env.NEON_DEPLOYMENT_CONFIG)});
const identity=managedRuntime?.identity,credentials=managedRuntime?.credentials;
const fleetRoutes=databases?FleetRoutes(new FleetController({configuration:new FleetConfiguration({
  repository:new KubernetesFleetRepository({api}),requireLeader:()=>leader.require()})})):[];
const proxyToken=new TokenFileAuthorization({file:process.env.CONTROLLER_API_TOKEN_FILE||'/run/controller-auth/token'});
const managementToken=new TokenFileAuthorization({file:process.env.NEON_MANAGEMENT_TOKEN_FILE||'/run/management/token'});
const managementAuthorization=databases?new ManagementAuthorization({configuration:()=>databases.base().identity,identity,
  authenticateStatic:managementToken.Authenticate.bind(managementToken),emit}):null;
const databaseRepository=databases?new KubernetesDatabaseRepository({api}):null;
const databaseQuery=databases?new DatabaseQuery({readDatabase:databaseRepository.Read.bind(databaseRepository)}):null;
const databaseRoutes=databases?DatabaseRoutes(
  new DatabaseController({getDatabase:databaseQuery.Get.bind(databaseQuery),putDatabase:databases.put.bind(databases),recordEvent:databases.event.bind(databases),
    changeLifecycle:databases.operation.bind(databases),requestReconcile:()=>{void databases.reconcile();},requestPoll:()=>{void poll();}}),
  new RecoveryController({readBackup:recovery.get.bind(recovery),listBackups:recovery.list.bind(recovery),createBackup:recovery.create.bind(recovery),
    deleteBackup:recovery.delete.bind(recovery),history:recovery.history.bind(recovery),requestReconcile:()=>{void recovery.reconcile();}}),
  new BranchController({branch:new BranchDatabase({readSource:recovery.readSource.bind(recovery),putDatabase:databases.put.bind(databases),requestReconcile:()=>{void databases.reconcile();}})})):[];
let stopDatabaseWatch=null;
const endpointDefinitions=new KubernetesEndpointDefinitions({api});
const background=[
  ...(fleet?[{name:'storage-fleet',Reconcile:fleet.reconcile.bind(fleet)}]:[]),
  ...(databases?[{name:'databases',Reconcile:databases.reconcile.bind(databases)}]:[]),
  ...(recovery?[{name:'recovery',Reconcile:recovery.reconcile.bind(recovery)}]:[]),
  ...(credentials?[{name:'credentials',Reconcile:credentials.cleanup.bind(credentials)}]:[])];
worker=new ComputeReconciliation({listDefinitions:endpointDefinitions.List.bind(endpointDefinitions),activeMonitorIds:lifecycle.activityIds.bind(lifecycle),
  closeMonitor:lifecycle.closeActivity.bind(lifecycle),reconcileManaged:databases?databases.endpoint.bind(databases):null,wake:lifecycle.wake.bind(lifecycle),idle:lifecycle.idle.bind(lifecycle),
  isLeader:()=>leader.active,stopping:()=>stopping,background,suspended:id=>{events.suspends++;emit('suspended',{endpoint:id});},
  deferred:(event,fields)=>{events.errors++;emit(event,fields);}});
function poll(){return worker.Reconcile();}
const roleVerifiers=new EndpointRoleVerifiers({api});
const access=new ProxyAccess({identityConfiguration:()=>databases?.connectionPolicy().identity,
  loadRoleVerifiers:roleVerifiers.Load.bind(roleVerifiers),oidcVerifier:async(endpoint,role)=>credentials?credentials.roleSecret(endpoint,role):null});
const wake=new WakeCompute({beginConnection:databases?databases.beginConnection.bind(databases):null,recordEvent:databases?databases.event.bind(databases):null,
  ensureStorageActive:async()=>{if(fleet)await fleet.ensureActive();},wake:lifecycle.wake.bind(lifecycle),requireLeader:()=>leader.require(),
  ready:id=>{events.wakes++;emit('compute_ready',{endpoint:id});}});
const routes=[...fleetRoutes,...databaseRoutes,...ProxyRoutes(new ProxyController({findEndpoint:id=>worker.Find(id),access,wake})),
  ...(credentials?CredentialsRoutes(new CredentialsController({exchange:credentials.exchange.bind(credentials)})):[]),
  ...(managedRuntime?NativeOAuthRoutes(new NativeOAuthController(managedRuntime.nativeOAuth,
    id=>worker.Find(id)||[...worker.Endpoints().values()].find(endpoint=>endpoint.databaseResource===id))):[])];
const router=new ControlPlaneRouter({routes,management:managementAuthorization,authorizeProxy:proxyToken.Require.bind(proxyToken),
  requireLeader:()=>leader.require(),stopping:()=>stopping,unavailable:reason=>{events.errors++;emit('request_deferred',{reason});}});
const healthController=new HealthController({authorizeHook:proxyToken.Authenticate.bind(proxyToken),notify:storage?storage.notify.bind(storage):null,
  isLeader:()=>leader.active,stopping:()=>stopping,metrics:()=>({leader:leader.active,endpoints:worker.Count(),events}),emit});
const {server,health}=HttpServersInit({tls:{keyFile:process.env.CONTROLLER_TLS_KEY||'/run/controller-tls/tls.key',certFile:process.env.CONTROLLER_TLS_CERT||'/run/controller-tls/tls.crt',
  ...(!compose?{caFile:process.env.CONTROLLER_TLS_CA||'/run/trust/ca.crt'}:{})},
  handleController:router.Handle.bind(router),handleHealth:healthController.Handle.bind(healthController)});
await leader.tick();await worker.Refresh();
if(databases){
  await databases.load();
  scaler=await (await import('../infrastructure/keda/KedaScaler.mjs')).KedaScalerInit({namespace,leader,demand:name=>name==='@fleet'?fleet.demand():databases.demand(name),
    tls:{ca:'/run/trust/ca.crt',key:'/run/controller-tls/tls.key',cert:'/run/controller-tls/tls.crt'}});
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
