import http from 'node:http';
import {pathToFileURL} from 'node:url';
import {createHash} from 'node:crypto';
import {Kubernetes, Leadership} from '../kubernetes.mjs';
import {fleetResources} from './enterprise-fleet.mjs';
const kinds = {ConfigMap: 'configmaps', ServiceAccount: 'serviceaccounts', Role: 'roles', RoleBinding: 'rolebindings',
  Service: 'services', StatefulSet: 'statefulsets', Deployment: 'deployments', Job: 'jobs', NetworkPolicy: 'networkpolicies',
  NeonStorageFleet: 'neonstoragefleets', ScaledObject: 'scaledobjects', TriggerAuthentication: 'triggerauthentications'};
export class FleetOperator {
  constructor({api, leader, image, templates, emit}) {Object.assign(this, {api, leader, image, templates, emit}); this.busy = false;}
  async status(resource, values) {
    this.leader.require(); const current = await this.api.get('neonfleets', resource.metadata.name);
    await this.api.request('PATCH', this.api.path('neonfleets', current.metadata.name) + '/status', {metadata: {resourceVersion: current.metadata.resourceVersion},
      status: {...current.status, ...values, updatedAt: new Date().toISOString()}});
  }
  async reconcile() {
    if (this.busy || !this.leader.active) return; this.busy = true;
    try {
      const fleets = await this.api.list('neonfleets', '');
      if (fleets.length !== 1) {if (fleets.length) this.emit('fleet_reconcile_deferred', {reason: 'ONE_FLEET_PER_NAMESPACE_REQUIRED'}); return;}
      const fleet = fleets[0];
      try {
        if (fleet.metadata.deletionTimestamp) {
          for (const database of await this.api.list('neondatabases', '')) if (database.spec.lifecycle !== 'retired')
            await this.api.patch('neondatabases', database.metadata.name, {metadata: {resourceVersion: database.metadata.resourceVersion}, spec: {lifecycle: 'suspended', replicas: 0}});
          await this.status(fleet, {phase: 'Retaining', reason: 'DATA_RETAINED_REMOVE_FINALIZER_ONLY_AFTER_REVIEW'}); return;
        }
        if (!fleet.metadata.finalizers?.includes('neon.klustr.io/retain-fleet')) {
          await this.api.patch('neonfleets', fleet.metadata.name, {metadata: {resourceVersion: fleet.metadata.resourceVersion,
            finalizers: [...(fleet.metadata.finalizers || []), 'neon.klustr.io/retain-fleet']}}); return;
        }
        const objectStore = await this.api.get('secrets', fleet.spec.storage.objectStoreSecretRef);
        const nodes = (await this.api.request('GET', '/api/v1/nodes?limit=500')).items;
        let metadataIdentity = null;
        if (fleet.spec.storage.metadataDatabaseSecretRef) {
          const secret = await this.api.get('secrets', fleet.spec.storage.metadataDatabaseSecretRef);
          const url = new URL(Buffer.from(secret.data.url || '', 'base64').toString());
          if (!['postgres:', 'postgresql:'].includes(url.protocol) || url.searchParams.get('sslmode') !== 'verify-full') throw Error('External metadata must use TLS verify-full');
          metadataIdentity = url.host + url.pathname;
        }
        const plan = fleetResources(fleet, {templates: this.templates, controllerImage: this.image, objectStore, nodes, metadataIdentity});
        const revision = createHash('sha256').update(JSON.stringify(plan.resources)).digest('hex');
        if (fleet.status?.appliedRevision !== revision) {
          // Refuse to adopt an existing stack. No force-apply, data deletion or
          // PVC migration is performed by a fleet configuration update.
          for (const object of plan.resources) {
            this.leader.require(); const kind = kinds[object.kind]; if (!kind) throw Error('Unsupported packaged resource');
            const existing = await this.api.optional(kind, object.metadata.name);
            if (existing && existing.metadata.labels?.['neon.klustr.io/fleet-uid'] !== fleet.metadata.uid) throw Error('Existing resource belongs to a different deployment');
          }
          // Persist immutable storage identity before starting any bootstrap Job.
          await this.status(fleet, {phase: 'Provisioning', storageIdentity: plan.storageIdentity, reason: null});
          for (const object of plan.resources) {
            this.leader.require(); const kind = kinds[object.kind];
            const existing = await this.api.optional(kind, object.metadata.name);
            if (object.kind === 'Job' && existing) continue;
            if (!existing) await this.api.request('POST', this.api.path(kind) + '?fieldManager=neon-fleet-operator', object);
            else await this.api.request('PATCH', this.api.path(kind, object.metadata.name) + '?fieldManager=neon-fleet-operator', object, 'application/apply-patch+yaml');
          }
        }
        const pods = await this.api.list('pods', ''), nodeZones = new Map(nodes.map(node => [node.metadata.name, node.metadata.labels?.['topology.kubernetes.io/zone']]));
        const placementObserved = [1, 2, 3].every(id => pods.some(pod => pod.metadata.labels?.app === 'safekeeper-' + id &&
          nodeZones.get(pod.spec.nodeName) === fleet.spec.replication.zones[id - 1] && !pod.metadata.deletionTimestamp &&
          pod.status?.conditions?.some(condition => condition.type === 'Ready' && condition.status === 'True')));
        await this.status(fleet, {phase: 'Provisioned', observedGeneration: fleet.metadata.generation, storageIdentity: plan.storageIdentity,
          appliedRevision: revision, zonePlacementConfigured: true, ...(placementObserved ? {lastVerifiedZonePlacementAt: new Date().toISOString()} : {}),
          automaticFailoverReady: false, reason: 'AUTOMATIC_WRITER_FENCING_AND_ZONE_FAILURE_QUALIFICATION_REQUIRED'});
      } catch (error) {this.emit('fleet_reconcile_deferred', {reason: error.code || 'PREREQUISITE_OR_RESOURCE_CONFLICT'});
        await this.status(fleet, {phase: 'Pending', reason: error.code || 'PREREQUISITE_OR_RESOURCE_CONFLICT', message: error.code ? undefined : error.message});}
    } catch {this.emit('fleet_reconcile_deferred', {reason: 'KUBERNETES_UNAVAILABLE'});} finally {this.busy = false;}
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const api = new Kubernetes({namespace: process.env.POD_NAMESPACE}), leader = new Leadership(api, {podName: process.env.POD_NAME, leaseName: 'neon-fleet-operator'});
  const emit = (event, fields) => console.log(JSON.stringify({event, ...fields}));
  const operator = new FleetOperator({api, leader, image: process.env.FLEET_CONTROLLER_IMAGE, templates: '/app/fleet-templates', emit});
  await leader.tick(); void operator.reconcile();
  const renew = setInterval(() => leader.tick(), 2000), reconcile = setInterval(() => operator.reconcile(), 10000);
  const stop = api.watch('neonfleets', event => {if (['ADDED', 'DELETED'].includes(event.type) || event.type === 'MODIFIED' && event.object.metadata.generation !== event.object.status?.observedGeneration) void operator.reconcile();});
  const health = http.createServer((request, response) => {response.writeHead(request.url === '/readyz' && !leader.active ? 503 : 200); response.end('ok');});
  health.listen(9092, '0.0.0.0');
  for (const signal of ['SIGTERM', 'SIGINT']) process.on(signal, () => {stop(); clearInterval(renew); clearInterval(reconcile); health.close(); setTimeout(() => process.exit(0), 1000).unref();});
}
