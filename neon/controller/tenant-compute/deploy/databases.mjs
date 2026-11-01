import {createHash} from 'node:crypto';
import fs from 'node:fs';
import {configuration, normalizeConfiguration} from './config.mjs';
import {alwaysOn} from '../activity.mjs';

const allowed = ['database', 'user', 'size', 'tier', 'profile', 'suspend', 'databasePolicies', 'allowedIps', 'shards', 'replicas'];
const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
export class Databases {
  constructor({api, leader, lifecycle, getEndpoints, configFile, emit}) {
    Object.assign(this, {api, leader, lifecycle, getEndpoints, configFile, emit});
    this.resources = new Map(); this.applied = new Map(); this.samples = new Map(); this.busy = false; this.scaler = null;
    this.backendWork = false; this.fleet = null;
    this.pendingConnections = new Map();
  }
  base() {
    const stat=fs.statSync(this.configFile),key=stat.mtimeMs+':'+stat.size;
    if(this.baseCache?.key!==key)this.baseCache={key,value:configuration(this.configFile)};
    return this.baseCache.value;
  }
  async load() {
    const rows = await this.api.list('neondatabases', '');
    this.resources = new Map(rows.map(resource => [resource.metadata.name, resource]));
  }
  watch(changed){
    return this.api.watch('neondatabases',event=>{
      const resource=event.object,name=resource.metadata.name,previous=this.resources.get(name);
      if(event.type==='DELETED')this.resources.delete(name);else this.resources.set(name,resource);
      if(event.type==='ADDED'||event.type==='DELETED'||previous?.metadata.generation!==resource.metadata.generation||
        Boolean(previous?.metadata.deletionTimestamp)!==Boolean(resource.metadata.deletionTimestamp))changed();
    },()=>this.emit('database_watch_resync'));
  }
  tenant(resource, base) {
    for (const key of Object.keys(resource.spec)) if (!allowed.includes(key)) throw Error('Unsupported tenant field: ' + key);
    const seed = base.tenants.find(tenant => tenant.name === resource.metadata.name);
    const {resources: unusedResources, settings: unusedSettings, storagePolicy: unusedPolicy, ...seedPolicy} = seed || {};
    const nodes = base.computeNodes || (base.computeNode ? [base.computeNode] : []);
    const existing = [...this.getEndpoints().values()].find(endpoint => endpoint.databaseResource === resource.metadata.name);
    const selected = nodes.length ? nodes[parseInt(hash(resource.metadata.name).slice(0, 8), 16) % nodes.length] : undefined;
    const tenant = normalizeConfiguration({...base, tenants: [{...seedPolicy, ...resource.spec, name: resource.metadata.name,
      allowedIps: resource.spec.allowedIps || base.clientCIDRs, nodeName: existing?.nodeName || selected,
      databaseResource: resource.metadata.name}]}).tenants[0];
    if (tenant.storagePolicy.placement_policy.Attached >= base.storage.pageservers.length) throw Error('Tier needs additional storage capacity');
    return tenant;
  }
  async desired() {
    const base = this.base(), tenants = base.tenants.filter(tenant => !this.resources.has(tenant.name));
    for (const resource of this.resources.values()) {
      if (resource.metadata.deletionTimestamp) continue;
      try {tenants.push(this.tenant(resource, base));} catch {}
    }
    return {...base, tenants};
  }
  async status(name, values) {
    this.leader.require();
    const resource = await this.api.get('neondatabases', name);
    await this.api.request('PATCH', this.api.path('neondatabases', name) + '/status', {metadata: {resourceVersion: resource.metadata.resourceVersion},
      status: {replicas: 0, selector: 'neon.klustr.io/endpoint=ep-' + name, ...resource.status, ...values, updatedAt: new Date().toISOString()}});
  }
  revision(resource, tenant, base=this.base()) {
    const {replicas: unusedReplicas, ...provisioning} = tenant;
    return hash([provisioning, base.storage, base.computeImage]);
  }
  scaledObject(resource, tenant) {
    return {apiVersion: 'keda.sh/v1alpha1', kind: 'ScaledObject', metadata: {name: 'neon-' + resource.metadata.name,
      labels: {'neon.klustr.io/database-uid': resource.metadata.uid}, ownerReferences: [{apiVersion: resource.apiVersion, kind: resource.kind,
        name: resource.metadata.name, uid: resource.metadata.uid, controller: true, blockOwnerDeletion: false}]}, spec: {
      scaleTargetRef: {apiVersion: 'neon.klustr.io/v1alpha1', kind: 'NeonDatabase', name: resource.metadata.name},
      pollingInterval: 5, cooldownPeriod: alwaysOn(tenant) ? 300 : Math.max(tenant.suspend.idleSeconds, ...Object.values(tenant.databasePolicies || {}).map(value => value.idleSeconds || 0)),
      minReplicaCount: alwaysOn(tenant) ? 1 : 0, maxReplicaCount: 1,
      triggers: [{type: 'external-push', metadata: {scalerAddress: 'neon-controller.' + this.api.namespace + '.svc.cluster.local:9091',
        database: resource.metadata.name, enableTLS: 'true'}, authenticationRef: {name: 'neon-keda-tls'}}]}};
  }
  async reconcile() {
    if (this.busy || !this.leader.active) return; this.busy = true;
    try {
      await this.load(); const base = this.base();
      for (const tenant of base.tenants) if (!this.resources.has(tenant.name)) {
        const spec = Object.fromEntries(allowed.filter(key => key !== 'replicas' && tenant[key] !== undefined).map(key => [key, tenant[key]]));
        await this.api.create('neondatabases', {apiVersion: 'neon.klustr.io/v1alpha1', kind: 'NeonDatabase', metadata: {name: tenant.name}, spec});
      }
      await this.load();
      for (const resource of this.resources.values()) {
        this.leader.require(); const name = resource.metadata.name;
        try {
          if (resource.metadata.deletionTimestamp) continue;
          if (!resource.metadata.finalizers?.includes('neon.klustr.io/retain-data')) {
            await this.api.patch('neondatabases', name, {metadata: {resourceVersion: resource.metadata.resourceVersion,
              finalizers: [...(resource.metadata.finalizers || []), 'neon.klustr.io/retain-data']}});
          }
          const tenant = this.tenant(resource, base), desired = {...structuredClone(base), tenants: [tenant]};
          const revision = this.revision(resource, tenant);
          if ((this.applied.get(name) || resource.status?.provisioningRevision) !== revision) {
            this.backendWork = true;
            if (this.fleet) {await this.status(name, {phase: 'WaitingForStorage'}); await this.fleet.ensureActive();}
            await this.status(name, {phase: 'Provisioning', observedGeneration: resource.metadata.generation});
            const {reconcileTenants} = await import('./bootstrap.mjs');
            await reconcileTenants(desired, () => this.leader.require());
            const scaled = this.scaledObject(resource, tenant), old = await this.api.optional('scaledobjects', scaled.metadata.name);
            if (old && old.metadata.labels?.['neon.klustr.io/database-uid'] !== resource.metadata.uid) throw Error('ScaledObject has a different owner');
            if (old) await this.api.patch('scaledobjects', scaled.metadata.name, {metadata: {resourceVersion: old.metadata.resourceVersion}, spec: scaled.spec});
            else await this.api.create('scaledobjects', scaled);
            await this.status(name, {phase: 'Provisioned', observedGeneration: resource.metadata.generation,
              endpoint: tenant.endpointId + '.' + base.domain, credentialsSecret: name + '-client', tier: tenant.tier, size: tenant.size,
              provisioningRevision: revision, reason: null});
            this.applied.set(name, revision);
          }
        } catch (error) {
          this.emit('database_reconcile_deferred', {database: name, reason: error.code || 'INVALID_OR_UNAVAILABLE'});
          await this.status(name, {phase: 'Pending', reason: error.code || 'INVALID_OR_UNAVAILABLE'});
        } finally {this.backendWork = false;}
      }
    } catch (error) {this.emit('database_reconcile_unavailable', {reason: error.code || 'API_UNAVAILABLE'});} finally {this.busy = false;}
  }
  async event(name, {id, holdSeconds = 30} = {}) {
    this.leader.require();
    if (typeof id !== 'string' || !/^[a-zA-Z0-9_.:-]{1,128}$/.test(id) || !Number.isInteger(holdSeconds) || holdSeconds < 1 || holdSeconds > 86400) throw Error('Invalid demand event');
    const resource = await this.api.get('neondatabases', name);
    if (resource.metadata.deletionTimestamp) throw Error('Database is being retired');
    if (resource.status?.event?.id !== id) await this.status(name, {event: {id, until: new Date(Date.now() + holdSeconds * 1000).toISOString()}});
    this.scaler?.publish(name, true);
  }
  async demand(name) {
    this.leader.require();
    const resource = await this.api.get('neondatabases', name), tenant = this.tenant(resource, this.base());
    if (resource.metadata.deletionTimestamp) return false;
    if (this.pendingConnections.get(name) || alwaysOn(tenant) || Date.parse(resource.status?.event?.until || '') > Date.now()) return true;
    const endpoint = [...this.getEndpoints().values()].find(endpoint => endpoint.databaseResource === name);
    if(endpoint?.status.phase==='Waking')return true;
    const sample = this.samples.get(name);
    if (sample && Date.now() - sample.at < 15000) return sample.active;
    if (endpoint && ['Active', 'Waking', 'Draining'].includes(endpoint.status.phase)) throw Error('Demand sample stale; refuse scale-down');
    return false;
  }
  beginConnection(name) {
    this.pendingConnections.set(name,(this.pendingConnections.get(name)||0)+1);this.scaler?.publish(name,true);
    return ()=>{const remaining=this.pendingConnections.get(name)-1;if(remaining)this.pendingConnections.set(name,remaining);else this.pendingConnections.delete(name);};
  }
  async endpoint(endpoint) {
    const name = endpoint.databaseResource, resource = await this.api.get('neondatabases', name);
    if (resource.metadata.deletionTimestamp) {
      await this.lifecycle.maintenanceSuspend(endpoint);
      const remaining = await this.api.optional('deployments', endpoint.name);
      await this.status(name, {phase: remaining?.spec.replicas ? 'Retiring' : 'Retained', replicas: remaining?.spec.replicas || 0}); return;
    }
    if (this.fleet && resource.spec.replicas === 1) await this.fleet.ensureActive();
    const sample = await this.lifecycle.sampleDemand(endpoint);
    this.samples.set(name, {active: sample, at: Date.now()}); this.scaler?.publish(name, await this.demand(name));
    const deployment = await this.api.optional('deployments', endpoint.name);
    if (endpoint.size !== resource.spec.size || endpoint.tier !== resource.spec.tier) {
      await this.status(name, {phase: 'Updating', replicas: deployment?.spec.replicas || 0}); return;
    }
    if (deployment?.spec.replicas === 1 && deployment.spec.template.metadata.annotations?.['neon.klustr.io/config-revision'] !== endpoint.computeRevision) {
      await this.status(name, {phase: 'Resizing'});
      await this.lifecycle.maintenanceSuspend(endpoint);
      const after = await this.api.get('deployments', endpoint.name);
      if (after.spec.replicas !== 0) {await this.status(name, {phase: 'PendingResize', reason: 'ACTIVE_WORK'}); return;}
      await this.lifecycle.wake(endpoint);
    } else if (resource.spec.replicas === 1 && (!deployment || deployment.spec.replicas === 0 || endpoint.status.phase !== 'Active')) {
      await this.status(name, {phase: 'Waking'}); await this.lifecycle.wake(endpoint);
    }
    else if (resource.spec.replicas === 0 && !await this.demand(name)) await this.lifecycle.suspend(endpoint);
    const current = await this.api.optional('deployments', endpoint.name);
    await this.status(name, {replicas: current?.spec.replicas || 0, selector: 'neon.klustr.io/endpoint=' + endpoint.endpointId,
      observedGeneration: resource.metadata.generation, phase: endpoint.status.phase || 'Dormant', drainedLSN: endpoint.status.drainedLSN || null});
  }
  async put(name, spec) {
    this.leader.require();
    if (!/^[a-z][a-z0-9-]{0,38}$/.test(name)) throw Error('Invalid database name');
    const old = await this.api.optional('neondatabases', name);
    const candidate = {metadata: {name}, spec: {...old?.spec, ...spec}};
    try {this.tenant(candidate, this.base());} catch (error) {throw Object.assign(error, {code: 'INVALID_SPEC'});}
    if (old) return this.api.patch('neondatabases', name, {metadata: {resourceVersion: old.metadata.resourceVersion}, spec: candidate.spec});
    return this.api.create('neondatabases', {apiVersion: 'neon.klustr.io/v1alpha1', kind: 'NeonDatabase', metadata: {name}, spec: candidate.spec});
  }
}
