import https from 'node:https';
import fs from 'node:fs';
import {randomUUID} from 'node:crypto';

export class ApiError extends Error {
  constructor(status){super(`Kubernetes API returned ${status}`);this.status=status;this.code='KUBERNETES_API';}
}
export class Kubernetes {
  constructor({namespace,host=process.env.KUBERNETES_SERVICE_HOST,port=process.env.KUBERNETES_SERVICE_PORT_HTTPS||443,
    account='/var/run/secrets/kubernetes.io/serviceaccount'}){
    if(!/^[a-z0-9][a-z0-9-]{0,62}$/.test(namespace))throw Error('Invalid namespace');
    this.namespace=namespace;this.host=host;this.port=port;this.account=account;
    this.agent=new https.Agent({keepAlive:true,maxSockets:32,ca:fs.readFileSync(account+'/ca.crt'),rejectUnauthorized:true});
  }
  async request(method,url,body){
    const data=body===undefined?null:Buffer.from(JSON.stringify(body));
    // Read projected credentials per request to honor Kubernetes token rotation.
    const token=fs.readFileSync(this.account+'/token','utf8').trim();
    return await new Promise((resolve,reject)=>{
      const request=https.request({host:this.host,port:this.port,path:url,method,agent:this.agent,
        headers:{Authorization:'Bearer '+token,Accept:'application/json',
          ...(data?{'Content-Type':method==='PATCH'?'application/merge-patch+json':'application/json','Content-Length':data.length}:{})}},response=>{
        const chunks=[];let size=0;
        response.on('data',chunk=>{size+=chunk.length;if(size>8*1024*1024)response.destroy(Error('API response limit'));else chunks.push(chunk);});
        response.on('error',reject);
        response.on('end',()=>{
          if(response.statusCode<200||response.statusCode>=300)return reject(new ApiError(response.statusCode));
          try{resolve(size?JSON.parse(Buffer.concat(chunks).toString()):null);}catch{reject(Error('Invalid Kubernetes JSON'));}
        });
      });
      request.setTimeout(15000,()=>request.destroy(Error('Kubernetes API timeout')));
      request.on('error',reject);if(data)request.write(data);request.end();
    });
  }
  path(kind,name=''){
    const prefixes={configmaps:'/api/v1',secrets:'/api/v1',services:'/api/v1',pods:'/api/v1',
      deployments:'/apis/apps/v1',leases:'/apis/coordination.k8s.io/v1',endpointslices:'/apis/discovery.k8s.io/v1'};
    if(!prefixes[kind]||name&&!/^[a-z0-9][a-z0-9.-]{0,252}$/.test(name))throw Error('Invalid resource path');
    return `${prefixes[kind]}/namespaces/${this.namespace}/${kind}${name?'/'+name:''}`;
  }
  get(kind,name){return this.request('GET',this.path(kind,name));}
  create(kind,body){return this.request('POST',this.path(kind),body);}
  patch(kind,name,body){return this.request('PATCH',this.path(kind,name),body);}
  async optional(kind,name){try{return await this.get(kind,name);}catch(error){if(error.status===404)return null;throw error;}}
  async list(kind,selector){
    const items=[];let continuation='';
    do{
      const query=new URLSearchParams({labelSelector:selector,limit:'500',...(continuation?{continue:continuation}:{})});
      const page=await this.request('GET',this.path(kind)+'?'+query);items.push(...page.items);
      continuation=page.metadata.continue||'';
    }while(continuation);
    return items;
  }
}

// Takeover observes a stable resourceVersion for an entire lease interval rather
// than trusting wall-clock agreement between workers. Local expiry is monotonic.
export class Leadership {
  constructor(api,{podName,duration=15,clock=()=>performance.now()}){
    this.api=api;this.identity=podName+':'+randomUUID();this.duration=duration;this.clock=clock;
    this.deadline=0;this.observedVersion=null;this.observedAt=0;this.busy=false;this.lastError=null;
  }
  get active(){return this.clock()<this.deadline;}
  require(){if(!this.active){const error=Error('Controller ownership unavailable');error.code='NOT_LEADER';throw error;}}
  async tick(){
    if(this.busy)return;this.busy=true;const started=this.clock();
    try{
      let lease=await this.api.optional('leases','neon-tenant-controller');
      if(!lease){
        lease=await this.api.create('leases',{apiVersion:'coordination.k8s.io/v1',kind:'Lease',
          metadata:{name:'neon-tenant-controller'},spec:{holderIdentity:this.identity,leaseDurationSeconds:this.duration,
            acquireTime:new Date().toISOString().replace(/Z$/,'000Z'),renewTime:new Date().toISOString().replace(/Z$/,'000Z')}});
      }else if(lease.spec.holderIdentity!==this.identity){
        this.deadline=0;
        if(lease.metadata.resourceVersion!==this.observedVersion){
          this.observedVersion=lease.metadata.resourceVersion;this.observedAt=started;return;
        }
        const wait=Math.max(this.duration,lease.spec.leaseDurationSeconds||this.duration)*1000+2000;
        if(started-this.observedAt<wait)return;
      }
      lease=await this.api.patch('leases','neon-tenant-controller',{
        metadata:{resourceVersion:lease.metadata.resourceVersion},spec:{holderIdentity:this.identity,
          leaseDurationSeconds:this.duration,renewTime:new Date().toISOString().replace(/Z$/,'000Z')}});
      if(lease.spec.holderIdentity!==this.identity)throw Error('Lease holder mismatch');
      this.deadline=started+(this.duration-3)*1000;
      this.lastError=null;
    }catch(error){this.lastError=error.status||error.code||error.name;if(error.status===409||error.status===403)this.deadline=0;}
    finally{this.busy=false;}
  }
}
