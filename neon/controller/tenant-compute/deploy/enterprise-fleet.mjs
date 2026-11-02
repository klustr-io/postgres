import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {parseAllDocuments, stringify} from 'yaml';
import {normalizeConfiguration} from './config.mjs';
import {identityConfiguration} from './identity.mjs';
import {recoveryPolicy} from './recovery.mjs';
import {sizes, tiers} from './catalog.mjs';
import {policy} from '../activity.mjs';
const safeName = value => typeof value === 'string' && /^[a-z][a-z0-9-]{0,62}$/.test(value);
const digestImage = value => typeof value === 'string' && /^[-a-zA-Z0-9./:]+@sha256:[a-f0-9]{64}$/.test(value);
export function validateFleet(resource) {
  const spec = resource.spec;
  if (!safeName(resource.metadata.name) || resource.metadata.name.length > 39 || !spec || !/^[a-z0-9.-]+$/.test(spec.domain || '')) throw Error('Invalid fleet identity/domain');
  if (Object.keys(spec).some(key => !['domain', 'identity', 'storage', 'replication', 'defaults', 'clientCIDRs'].includes(key))) throw Error('Unsupported fleet field');
  identityConfiguration(spec.identity);
  if (!spec.identity) throw Error('Enterprise fleets require identity configuration');
  const replication = spec.replication;
  if (replication?.scope !== 'availability-zones' || replication.mode !== 'synchronous-quorum' || replication.safekeepers !== 3 ||
      replication.zones?.length !== 3 || new Set(replication.zones).size !== 3 || replication.zones.some(zone => typeof zone !== 'string' || !/^[A-Za-z0-9](?:[-A-Za-z0-9_.]{0,61}[A-Za-z0-9])?$/.test(zone))) throw Error('Three distinct zones and three synchronous safekeepers are required');
  if (Object.keys(replication).some(key => !['scope', 'mode', 'zones', 'safekeepers'].includes(key))) throw Error('Unsupported replication policy');
  if (!safeName(spec.storage?.objectStoreSecretRef) || !safeName(spec.storage.storageClass) ||
      spec.storage.metadataDatabaseSecretRef && !safeName(spec.storage.metadataDatabaseSecretRef) ||
      spec.identity.caSecretRef && !safeName(spec.identity.caSecretRef)) throw Error('Explicit storage/identity Secret references and storage class required');
  if (spec.defaults && Object.keys(spec.defaults).some(key => !['size', 'tier', 'suspend', 'backup'].includes(key))) throw Error('Unsupported fleet database default');
  recoveryPolicy(spec.defaults?.backup);
  if (spec.defaults?.suspend) policy(spec.defaults.suspend);
  if (spec.defaults?.size && !sizes[spec.defaults.size] || spec.defaults?.tier && !tiers[spec.defaults.tier]) throw Error('Unknown fleet size/tier default');
  return spec;
}
// Apply the limited, checked-in Kustomize overlay in-process. Customer input can
// never supply patch programs, filesystem paths or arbitrary Kubernetes objects.
function merge(left, right) {
  if (Array.isArray(right)) {
    if (right.every(value => value && typeof value === 'object' && value.name)) {
      const result = structuredClone(Array.isArray(left) ? left : []);
      for (const value of right) {const index = result.findIndex(row => row.name === value.name); if (index < 0) result.push(value); else result[index] = merge(result[index], value);}
      return result;
    }
    return structuredClone(right);
  }
  if (!right || typeof right !== 'object') return right;
  const result = {...left}; for (const [key, value] of Object.entries(right)) result[key] = merge(left?.[key], value); return result;
}
function jsonPatch(value, operations) {
  for (const operation of operations) {
    const parts = operation.path.slice(1).split('/').map(part => part.replaceAll('~1', '/').replaceAll('~0', '~'));
    const leaf = parts.pop(); let parent = value;
    for (const part of parts) parent = parent[part];
    if (operation.op === 'remove') delete parent[leaf]; else if (operation.op === 'add') parent[leaf] = operation.value; else throw Error('Unsupported packaged patch');
  }
}
export function packagedResources(folder) {
  const read = file => parseAllDocuments(fs.readFileSync(path.join(folder, file), 'utf8')).map(doc => {if (doc.errors.length) throw doc.errors[0]; return doc.toJS();}).flatMap(value => value?.kind === 'List' ? value.items : [value]).filter(Boolean);
  const base = read('base/kustomization.yaml')[0], overlay = read('keda/kustomization.yaml')[0];
  let resources = base.resources.flatMap(file => read('base/' + file));
  resources.push(...overlay.resources.filter(file => file !== '../base').flatMap(file => read('keda/' + file)));
  for (const patch of overlay.patches) {
    if (patch.path) for (const value of read('keda/' + patch.path)) {
      const index = resources.findIndex(row => row.kind === value.kind && row.metadata.name === value.metadata.name);
      if (index < 0) throw Error('Packaged overlay target missing');
      if (value.$patch === 'delete') resources.splice(index, 1); else resources[index] = merge(resources[index], value);
    }
    else {
      const target = resources.find(row => row.kind === patch.target.kind && row.metadata.name === patch.target.name);
      if (!target) throw Error('Packaged JSON patch target missing'); jsonPatch(target, JSON.parse(patch.patch));
    }
  }
  return resources;
}
export function fleetResources(resource, {templates, controllerImage, objectStore, nodes, metadataIdentity = null}) {
  const spec = validateFleet(resource), namespace = resource.metadata.namespace;
  if (!digestImage(controllerImage)) throw Error('Fleet controller image must be digest pinned');
  const selected = nodes.filter(node => spec.replication.zones.includes(node.metadata.labels?.['topology.kubernetes.io/zone']) && !node.spec?.unschedulable &&
    !(node.spec?.taints || []).some(taint => ['NoSchedule', 'NoExecute'].includes(taint.effect)) && node.status?.conditions?.some(condition => condition.type === 'Ready' && condition.status === 'True')).sort((a, b) => a.metadata.name.localeCompare(b.metadata.name));
  if (spec.replication.zones.some(zone => !selected.some(node => node.metadata.labels['topology.kubernetes.io/zone'] === zone))) throw Error('A ready schedulable node in each configured physical zone is required');
  const value = key => {const data = objectStore.data?.[key]; if (!data) throw Error('Object storage Secret missing ' + key); return Buffer.from(data, 'base64').toString();};
  value('AWS_ACCESS_KEY_ID'); value('AWS_SECRET_ACCESS_KEY');
  const config = normalizeConfiguration({name: resource.metadata.name, domain: spec.domain,
    computeImage: 'ghcr.io/klustr-io/neon-compute@sha256:f84df9577c542dbf3be8a789d301716f77c7d6ac5c79bfd519818834b3427aef',
    computeNodes: selected.map(node => node.metadata.name), identity: spec.identity, replication: spec.replication,
    defaults: {size: 'small', tier: 'standard', ...spec.defaults}, clientCIDRs: spec.clientCIDRs || ['10.0.0.0/8'],
    storage: {pageservers: [{id: 1, host: 'pageserver', zone: spec.replication.zones[0]}, {id: 2, host: 'pageserver-2', zone: spec.replication.zones[1]}],
      safekeeperZones: spec.replication.zones, externalMetadata: Boolean(spec.storage.metadataDatabaseSecretRef)},
    s3: {endpoint: value('NEON_S3_ENDPOINT'), region: value('AWS_REGION'), bucket: value('NEON_S3_BUCKET'),
      prefix: value('NEON_S3_PREFIX').replace(/\/$/, '') + '/' + namespace + '/' + resource.metadata.uid}, tenants: []});
  const identity = createHash('sha256').update(JSON.stringify([config.name, config.domain, config.s3, spec.replication, spec.storage, metadataIdentity])).digest('hex');
  if (resource.status?.storageIdentity && resource.status.storageIdentity !== identity) throw Error('Storage identity/topology changes require an explicit migration');
  const zoneFor = name => name.startsWith('safekeeper-') ? spec.replication.zones[Number(name.slice(-1)) - 1] : name === 'pageserver' ? spec.replication.zones[0] : name === 'pageserver-2' ? spec.replication.zones[1] : null;
  const resources = packagedResources(templates).filter(row => !['Namespace', 'CustomResourceDefinition'].includes(row.kind) &&
    !(spec.storage.metadataDatabaseSecretRef && ['StatefulSet', 'Service'].includes(row.kind) && row.metadata.name === 'metadata'));
  function rewrite(value) {
    if (typeof value === 'string') return value.replaceAll('neon-controller.neon.svc.cluster.local', 'neon-controller.' + namespace + '.svc.cluster.local');
    if (Array.isArray(value)) return value.map(rewrite);
    if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, key === 'namespace' && item === 'neon' ? namespace : rewrite(item)]));
    return value;
  }
  for (let index = 0; index < resources.length; index++) {
    const row = resources[index] = rewrite(resources[index]); row.metadata.namespace = namespace;
    row.metadata.labels = {...row.metadata.labels, 'neon.klustr.io/fleet-uid': resource.metadata.uid};
    row.metadata.ownerReferences = [{apiVersion: resource.apiVersion, kind: 'NeonFleet', name: resource.metadata.name, uid: resource.metadata.uid, controller: true, blockOwnerDeletion: true}];
    if (row.kind === 'ConfigMap' && row.metadata.name === 'neon-cluster') row.data['cluster.yaml'] = stringify(config);
    if (row.kind === 'ScaledObject') delete row.metadata.annotations; // KEDA owns its runtime status.
    const pod = row.spec?.template?.spec; if (!pod) continue;
    const zone = zoneFor(row.metadata.name);
    if (zone) pod.affinity = {nodeAffinity: {requiredDuringSchedulingIgnoredDuringExecution: {nodeSelectorTerms: [{matchExpressions: [{key: 'topology.kubernetes.io/zone', operator: 'In', values: [zone]}]}]}}};
    if (row.spec.volumeClaimTemplates) for (const claim of row.spec.volumeClaimTemplates) claim.spec.storageClassName = spec.storage.storageClass;
    for (const container of pod.containers) {
      if (container.image.includes('neon-tenant-controller')) container.image = controllerImage;
      if (row.metadata.name === 'neon-proxy') container.args.push('--project-info-cache', 'size=0');
      for (const env of container.envFrom || []) if (env.secretRef?.name === 'neon-s3') env.secretRef.name = spec.storage.objectStoreSecretRef;
      if (row.metadata.name === 'neon-tenant-controller' && spec.identity.caSecretRef) {
        container.volumeMounts.push({name: 'oidc-ca', mountPath: '/run/oidc-ca', readOnly: true});
        pod.volumes.push({name: 'oidc-ca', secret: {secretName: spec.identity.caSecretRef, items: [{key: 'ca.crt', path: 'ca.crt'}]}});
      }
      if (row.metadata.name === 'storage-controller' && spec.storage.metadataDatabaseSecretRef) {
        // The checked-in command uses nested shell quotes. Replace its exact argument.
        container.command = container.command.map(text => text.replace(/--database-url .*? --public-key=/, '--database-url "$(cat /run/external-metadata/url)" --public-key='));
        container.volumeMounts.push({name: 'external-metadata', mountPath: '/run/external-metadata', readOnly: true});
        pod.volumes.push({name: 'external-metadata', secret: {secretName: spec.storage.metadataDatabaseSecretRef}});
      }
    }
  }
  return {resources, config, storageIdentity: identity};
}
