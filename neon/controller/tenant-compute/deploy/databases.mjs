import {createHash} from 'node:crypto';
import fs from 'node:fs';
import {isDeepStrictEqual} from 'node:util';
import {configuration, normalizeConfiguration} from './config.mjs';
import {alwaysOn} from '../activity.mjs';
import {branchSource, recoveryPolicy, problem} from './recovery.mjs';

const allowed = ['database', 'user', 'size', 'tier', 'profile', 'suspend', 'databasePolicies', 'allowedIps', 'shards', 'replicas', 'lifecycle', 'deletionPolicy', 'backup', 'branchFrom'];
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
  tenant(resource, base, seen = new Set()) {
    if (seen.has(resource.metadata.name)) throw problem('BRANCH_CYCLE');
    seen.add(resource.metadata.name);
    for (const key of Object.keys(resource.spec)) if (!allowed.includes(key)) throw Error('Unsupported tenant field: ' + key);
    if (!['active', 'suspended', 'retired'].includes(resource.spec.lifecycle || 'active') || !['Retain', 'Delete'].includes(resource.spec.deletionPolicy || 'Retain')) throw problem('INVALID_SPEC');
    if (resource.spec.deletionPolicy === 'Delete' && resource.spec.lifecycle !== 'retired') throw problem('INVALID_SPEC');
    recoveryPolicy(resource.spec.backup);
    const seed = base.tenants.find(tenant => tenant.name === resource.metadata.name);
    const {resources: unusedResources, settings: unusedSettings, storagePolicy: unusedPolicy, ...seedPolicy} = seed || {};
    const nodes = base.computeNodes || (base.computeNode ? [base.computeNode] : []);
    const existing = [...this.getEndpoints().values()].find(endpoint => endpoint.databaseResource === resource.metadata.name);
    const selected = nodes.length ? nodes[parseInt(hash(resource.metadata.name).slice(0, 8), 16) % nodes.length] : undefined;
    const tenant = normalizeConfiguration({...base, tenants: [{...seedPolicy, ...resource.spec, name: resource.metadata.name,
      allowedIps: resource.spec.allowedIps || base.clientCIDRs, nodeName: existing?.nodeName || selected,
      databaseResource: resource.metadata.name}]}).tenants[0];
    if (resource.spec.branchFrom) {
      const source = branchSource(resource.spec.branchFrom), parent = this.resources.get(source.database);
      if (!parent || parent.metadata.deletionTimestamp || parent.spec.deletionPolicy === 'Delete' || parent.status?.phase === 'Deleted') throw problem('SOURCE_NOT_READY');
      const ancestor = this.tenant(parent, base, seen);
      if (tenant.database !== ancestor.database || tenant.user !== ancestor.user) throw problem('BRANCH_DATABASE_ROLE_MISMATCH');
      if (resource.spec.backup !== undefined) throw problem('BRANCH_STORAGE_POLICY_INHERITED');
      tenant.tenantId = ancestor.tenantId;
      tenant.tier = ancestor.tier; tenant.shards = ancestor.shards;
      tenant.storagePolicy = ancestor.storagePolicy;
    }
    if (tenant.storagePolicy.placement_policy.Attached >= base.storage.pageservers.length) throw Error('Tier needs additional storage capacity');
    return tenant;
  }
  async desired() {
    const base = this.base(), tenants = base.tenants.filter(tenant => !this.resources.has(tenant.name));
    for (const resource of this.resources.values()) {
      if (resource.status?.phase === 'Deleted') continue;
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
    const {replicas: unusedReplicas, lifecycle: unusedLifecycle, deletionPolicy: unusedDeletion, backup: unusedBackup, ...provisioning} = tenant;
    return hash([provisioning, base.storage, base.computeImage]);
  }
  scaledObject(resource, tenant) {
    const paused = resource.metadata.deletionTimestamp || ['suspended', 'retired'].includes(resource.spec.lifecycle);
    return {apiVersion: 'keda.sh/v1alpha1', kind: 'ScaledObject', metadata: {name: 'neon-' + resource.metadata.name,
      annotations: {'autoscaling.keda.sh/paused-replicas': paused ? '0' : null},
      labels: {'neon.klustr.io/database-uid': resource.metadata.uid}, ownerReferences: [{apiVersion: resource.apiVersion, kind: resource.kind,
        name: resource.metadata.name, uid: resource.metadata.uid, controller: true, blockOwnerDeletion: false}]}, spec: {
      scaleTargetRef: {apiVersion: 'neon.klustr.io/v1alpha1', kind: 'NeonDatabase', name: resource.metadata.name},
      pollingInterval: 5, cooldownPeriod: alwaysOn(tenant) ? 300 : Math.max(tenant.suspend.idleSeconds, ...Object.values(tenant.databasePolicies || {}).map(value => value.idleSeconds || 0)),
      minReplicaCount: !paused && alwaysOn(tenant) ? 1 : 0, maxReplicaCount: 1,
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
          if (resource.status?.phase === 'Deleted') continue;
          if (resource.metadata.deletionTimestamp) continue;
          if (!resource.metadata.finalizers?.includes('neon.klustr.io/retain-data')) {
            await this.api.patch('neondatabases', name, {metadata: {resourceVersion: resource.metadata.resourceVersion,
              finalizers: [...(resource.metadata.finalizers || []), 'neon.klustr.io/retain-data']}});
          }
          const tenant = this.tenant(resource, base), desired = {...structuredClone(base), tenants: [tenant]};
          if (resource.spec.lifecycle === 'retired' || resource.spec.lifecycle === 'suspended') {
            const old = await this.api.optional('scaledobjects', 'neon-' + name);
            if (old) await this.api.patch('scaledobjects', old.metadata.name, {metadata: {resourceVersion: old.metadata.resourceVersion,
              annotations: {'autoscaling.keda.sh/paused-replicas': '0'}}});
            if (resource.spec.deletionPolicy === 'Delete') await this.purge(resource, tenant);
            continue;
          }
          const revision = this.revision(resource, tenant);
          if ((this.applied.get(name) || resource.status?.provisioningRevision) !== revision) {
            this.backendWork = true;
            if (this.fleet) {await this.status(name, {phase: 'WaitingForStorage'}); await this.fleet.ensureActive();}
            if (resource.spec.branchFrom) await this.recovery.prepareBranch(resource, tenant);
            await this.status(name, {phase: 'Provisioning', observedGeneration: resource.metadata.generation});
            const {reconcileTenants} = await import('./bootstrap.mjs');
            await reconcileTenants(desired, () => this.leader.require());
            const scaled = this.scaledObject(resource, tenant), old = await this.api.optional('scaledobjects', scaled.metadata.name);
            if (old && old.metadata.labels?.['neon.klustr.io/database-uid'] !== resource.metadata.uid) throw Error('ScaledObject has a different owner');
            if (old) await this.api.patch('scaledobjects', scaled.metadata.name, {metadata: {resourceVersion: old.metadata.resourceVersion, annotations: scaled.metadata.annotations}, spec: scaled.spec});
            else await this.api.create('scaledobjects', scaled);
            await this.status(name, {phase: 'Provisioned', observedGeneration: resource.metadata.generation,
              endpoint: tenant.endpointId + '.' + base.domain, credentialsSecret: name + '-client', tier: tenant.tier, size: tenant.size,
              provisioningRevision: revision, reason: null});
            this.applied.set(name, revision);
          }
          // Lifecycle changes do not reprovision storage, but must unpause KEDA.
          const scaled = await this.api.optional('scaledobjects', 'neon-' + name);
          if (scaled?.metadata.annotations?.['autoscaling.keda.sh/paused-replicas'] !== undefined)
            await this.api.patch('scaledobjects', scaled.metadata.name, {metadata: {resourceVersion: scaled.metadata.resourceVersion,
              annotations: {'autoscaling.keda.sh/paused-replicas': null}}});
        } catch (error) {
          this.emit('database_reconcile_deferred', {database: name, reason: error.code || 'INVALID_OR_UNAVAILABLE'});
          await this.status(name, {phase: 'Pending', reason: error.code || 'INVALID_OR_UNAVAILABLE'});
        } finally {this.backendWork = false;}
      }
    } catch (error) {this.emit('database_reconcile_unavailable', {reason: error.code || 'API_UNAVAILABLE'});} finally {this.busy = false;}
  }
  async event(name, {id, holdSeconds = 30} = {}) {
    this.leader.require();
    if (typeof id !== 'string' || !/^[a-zA-Z0-9_.:-]{1,128}$/.test(id) || !Number.isInteger(holdSeconds) || holdSeconds < 1 || holdSeconds > 86400) throw problem('INVALID_SPEC');
    const resource = await this.api.get('neondatabases', name);
    this.available(resource);
    if (resource.status?.event?.id !== id) await this.status(name, {event: {id, until: new Date(Date.now() + holdSeconds * 1000).toISOString()}});
    this.scaler?.publish(name, true);
  }
  async demand(name) {
    this.leader.require();
    const resource = await this.api.get('neondatabases', name), tenant = this.tenant(resource, this.base());
    if (resource.metadata.deletionTimestamp || ['suspended', 'retired'].includes(resource.spec.lifecycle)) return false;
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
    if (resource.metadata.deletionTimestamp || ['suspended', 'retired'].includes(resource.spec.lifecycle)) {
      if (resource.status?.phase === 'Deleted') return;
      await this.lifecycle.maintenanceSuspend(endpoint);
      const remaining = await this.api.optional('deployments', endpoint.name);
      const pods = await this.lifecycle.pods(endpoint);
      const stopped = !remaining?.spec.replicas && !pods.length;
      await this.status(name, {phase: stopped ? resource.spec.lifecycle === 'suspended' ? 'Suspended' : 'Retained' : 'Stopping',
        reason: stopped ? null : 'ACTIVE_WORK', replicas: remaining?.spec.replicas || 0, drainedLSN: endpoint.status.drainedLSN || resource.status?.drainedLSN || null}); return;
    }
    if (this.fleet && resource.spec.replicas === 1) await this.fleet.ensureActive();
    const sample = await this.lifecycle.sampleDemand(endpoint);
    this.samples.set(name, {active: sample, at: Date.now()}); this.scaler?.publish(name, await this.demand(name));
    const deployment = await this.api.optional('deployments', endpoint.name);
    const desiredTenant = this.tenant(resource, this.base());
    if (endpoint.size !== desiredTenant.size || endpoint.tier !== desiredTenant.tier) {
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
      observedGeneration: resource.metadata.generation, phase: endpoint.status.phase || 'Dormant', reason: null, drainedLSN: endpoint.status.drainedLSN || null});
  }
  async put(name, spec) {
    this.leader.require();
    if (!/^[a-z][a-z0-9-]{0,38}$/.test(name)) throw problem('INVALID_SPEC');
    const old = await this.api.optional('neondatabases', name);
    if (!spec || typeof spec !== 'object' || Array.isArray(spec) || 'deletionPolicy' in spec || 'lifecycle' in spec) throw problem('INVALID_SPEC');
    if (old && (old.metadata.deletionTimestamp || old.spec.lifecycle === 'retired')) throw problem('DATABASE_RETIRED');
    if (old && !isDeepStrictEqual(spec.branchFrom ?? old.spec.branchFrom, old.spec.branchFrom)) throw problem('IMMUTABLE_BRANCH_SOURCE');
    if (old && ['database', 'user'].some(key => spec[key] !== undefined && spec[key] !== old.spec[key])) throw problem('INVALID_SPEC');
    const candidate = {metadata: {name}, spec: {...old?.spec, ...spec}};
    try {this.tenant(candidate, this.base());} catch (error) {throw Object.assign(error, {code: 'INVALID_SPEC'});}
    if (old) return this.api.patch('neondatabases', name, {metadata: {resourceVersion: old.metadata.resourceVersion}, spec: candidate.spec});
    return this.api.create('neondatabases', {apiVersion: 'neon.klustr.io/v1alpha1', kind: 'NeonDatabase', metadata: {name}, spec: candidate.spec});
  }
  available(resource) {
    if (resource.metadata.deletionTimestamp || ['suspended', 'retired'].includes(resource.spec.lifecycle)) throw problem('DATABASE_' + (resource.spec.lifecycle === 'suspended' ? 'SUSPENDED' : 'RETIRED'));
  }
  async assertAvailable(name) {const resource = await this.api.get('neondatabases', name); this.available(resource); return resource;}
  async operation(name, action, input = {}) {
    this.leader.require();
    if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).some(key => !['mode', 'confirm'].includes(key))) throw problem('INVALID_SPEC');
    const resource = await this.api.get('neondatabases', name);
    if (action === 'resume' && (resource.metadata.deletionTimestamp || resource.spec.lifecycle === 'retired')) throw problem('DATABASE_RETIRED');
    const spec = action === 'resume' ? {lifecycle: 'active'} : {lifecycle: action === 'delete' ? 'retired' : 'suspended', replicas: 0};
    if (action === 'delete') {
      if (!['retain', 'purge'].includes(input.mode || 'retain')) throw problem('INVALID_SPEC');
      if (input.mode === 'purge' && input.confirm !== name) throw problem('PURGE_CONFIRMATION_REQUIRED');
      spec.deletionPolicy = input.mode === 'purge' ? 'Delete' : 'Retain';
      if (input.mode === 'purge') await this.dependencies(resource);
    }
    if (!['suspend', 'resume', 'delete'].includes(action)) throw problem('INVALID_SPEC');
    const updated = await this.api.patch('neondatabases', name, {metadata: {resourceVersion: resource.metadata.resourceVersion}, spec});
    this.resources.set(name, updated); this.scaler?.publish(name, action === 'resume');
    return updated;
  }
  async dependencies(resource) {
    await this.load(); await this.recovery.load();
    const name = resource.metadata.name;
    if ([...this.resources.values()].some(row => row.status?.phase !== 'Deleted' && row.spec.branchFrom?.database === name) ||
        [...this.recovery.resources.values()].some(row => row.status?.phase !== 'Deleted' && row.spec.database === name)) throw problem('DEPENDENT_BRANCHES_OR_BACKUPS');
  }
  async purge(resource, tenant) {
    if (resource.status?.phase === 'Deleted') return;
    const endpoint = [...this.getEndpoints().values()].find(row => row.databaseResource === resource.metadata.name);
    if (endpoint) {
      await this.lifecycle.maintenanceSuspend(endpoint);
      const deployment = await this.api.optional('deployments', endpoint.name);
      if (deployment?.spec.replicas || (await this.lifecycle.pods(endpoint)).length) return;
    }
    await this.dependencies(resource);
    this.backendWork = true;
    await this.recovery.storage(async () => {
      const route = tenant.branchFrom ? `/v1/tenant/${tenant.tenantId}/timeline/${tenant.timelineId}` : `/v1/tenant/${tenant.tenantId}`;
      if (!tenant.branchFrom) {
        try {
          const timelines = await this.recovery.routing.request('GET', route + '/timeline');
          if (!Array.isArray(timelines) || timelines.some(row => row.timeline_id !== tenant.timelineId)) throw problem('DEPENDENT_BRANCHES_OR_BACKUPS');
        } catch (error) {if (error.code !== 'STORAGE_404') throw error;}
      }
      try {await this.recovery.routing.request('DELETE', route);} catch (error) {if (error.code !== 'STORAGE_404') throw error;}
      if (!tenant.branchFrom) {
        try {await this.recovery.routing.request('GET', '/control/v1/tenant/' + tenant.tenantId); throw problem('DELETION_PENDING');}
        catch (error) {if (error.code !== 'STORAGE_404') throw error;}
      }
      await this.status(resource.metadata.name, {phase: 'Deleted', replicas: 0, deletedAt: new Date().toISOString(), reason: null});
      const current = await this.api.get('neondatabases', resource.metadata.name);
      await this.api.patch('neondatabases', resource.metadata.name, {metadata: {resourceVersion: current.metadata.resourceVersion,
        finalizers: (current.metadata.finalizers || []).filter(value => value !== 'neon.klustr.io/retain-data')}});
    });
  }
}
