import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {parse, stringify} from 'yaml';
import {NormalizeClusterConfiguration as normalizeConfiguration} from '../../domain/configuration/ClusterConfiguration.mjs';
import {ValidateFleet} from '../../domain/fleet/FleetSpecification.mjs';
const digestImage = value => typeof value === 'string' && /^[-a-zA-Z0-9./:]+@sha256:[a-f0-9]{64}$/.test(value);
/**
 * Read the immutable stack rendered by real Kustomize during release preparation.
 * No patch interpreter or Kubernetes executable is included in the runtime.
 * @param {string} folder - Packaged template directory, fixed by composition.
 * @returns {Array<import('../kubernetes/Kubernetes.mjs').KubernetesResource>} Fresh resource records.
 * @throws {Error} If the release bundle is missing or malformed.
 */
export function PackagedFleetResources(folder) {
  const {resources} = JSON.parse(fs.readFileSync(path.join(folder, 'fleet-stack.json'), 'utf8'));
  if (!Array.isArray(resources) || !resources.length || resources.some(row => !row?.apiVersion || !row.kind || !row.metadata?.name)) throw Error('Invalid packaged fleet stack');
  return resources;
}
/**
 * @typedef {Object} FleetResourceOptions
 * @property {string} templates - Provider-packaged fleet-stack directory, never chosen by a tenant.
 * @property {string} controllerImage - Qualified immutable controller/operator image digest.
 * @property {import('../kubernetes/Kubernetes.mjs').KubernetesResource} objectStore - Referenced S3 Secret, consumed only for provider configuration.
 * @property {import('../kubernetes/Kubernetes.mjs').KubernetesResource[]} nodes - Actual node readiness and physical-zone observations.
 * @property {string | null} [metadataIdentity] - Stable external metadata host/database identity without credentials.
 */
/**
 * @typedef {Object} FleetResourcePlan
 * @property {import('../kubernetes/Kubernetes.mjs').KubernetesResource[]} resources - Fresh namespace manifests with validated ownership and zone placement.
 * @property {ReturnType<typeof normalizeConfiguration>} config - Normalized provider configuration for the owned fleet.
 * @property {string} storageIdentity - Immutable storage/topology identity recorded before bootstrap side effects.
 */
/**
 * Plan one fleet from its immutable packaged release and actual provider prerequisites.
 * Requires the owning operator's authorization before application; side effects read packaged manifests, but never mutate Kubernetes or supplied resources.
 * @param {import('../../domain/fleet/FleetSpecification.mjs').FleetResource} resource - Desired namespace fleet and established storage identity.
 * @param {FleetResourceOptions} options - Packaged release, referenced credentials and physical node observations.
 * @returns {FleetResourcePlan} Owned configuration/resources ready for guarded application.
 * @throws {Error} On invalid policy, missing zones/Secrets, image disagreement or implicit storage migration.
 */
export function FleetResources(resource, {templates, controllerImage, objectStore, nodes, metadataIdentity = null}) {
  const spec = ValidateFleet(resource), namespace = resource.metadata.namespace;
  if (!digestImage(controllerImage)) throw Error('Fleet controller image must be digest pinned');
  const packaged = PackagedFleetResources(templates);
  const computeImage = PackagedComputeImage(packaged), selected = SelectComputeNodes(nodes, spec);
  const {config, identity} = ResolveFleetConfiguration(resource, selected, computeImage, objectStore, metadataIdentity);
  const resources = packaged.filter(row => !['Namespace', 'CustomResourceDefinition'].includes(row.kind) &&
    !(spec.storage.metadataDatabaseSecretRef && ['StatefulSet', 'Service'].includes(row.kind) && row.metadata.name === 'metadata'))
    .map(row => RewriteNamespace(row, namespace));
  for (const row of resources) {ApplyFleetOwnership(row, resource, config); ConfigurePod(row, spec, controllerImage);}
  return {resources, config, storageIdentity: identity};
}
function PackagedComputeImage(packaged) {
  const clusters = packaged.filter(row => row.kind === 'ConfigMap' && row.metadata.name === 'neon-cluster');
  if (clusters.length !== 1) throw Error('One packaged release configuration required');
  const computeImage = parse(clusters[0].data['cluster.yaml']).computeImage;
  if (!digestImage(computeImage)) throw Error('Packaged compute image must be digest pinned');
  const metadata = packaged.find(row => row.kind === 'StatefulSet' && row.metadata.name === 'metadata');
  if (metadata?.spec.template.spec.containers[0].image !== computeImage) throw Error('Packaged compute images disagree');
  return computeImage;
}
function SelectComputeNodes(nodes, spec) {
  const selected = nodes.filter(node => spec.replication.zones.includes(node.metadata.labels?.['topology.kubernetes.io/zone']) && !node.spec?.unschedulable &&
    !(node.spec?.taints || []).some(taint => ['NoSchedule', 'NoExecute'].includes(taint.effect)) && node.status?.conditions?.some(condition => condition.type === 'Ready' && condition.status === 'True')).sort((a, b) => a.metadata.name.localeCompare(b.metadata.name));
  if (spec.replication.zones.some(zone => !selected.some(node => node.metadata.labels['topology.kubernetes.io/zone'] === zone))) throw Error('A ready schedulable node in each configured physical zone is required');
  return selected;
}
function ResolveFleetConfiguration(resource, selected, computeImage, objectStore, metadataIdentity) {
  const {spec} = resource, namespace = resource.metadata.namespace;
  const value = key => {const data = objectStore.data?.[key]; if (!data) throw Error('Object storage Secret missing ' + key); return Buffer.from(data, 'base64').toString();};
  value('AWS_ACCESS_KEY_ID'); value('AWS_SECRET_ACCESS_KEY');
  const config = normalizeConfiguration({name: resource.metadata.name, domain: spec.domain,
    computeImage,
    computeNodes: selected.map(node => node.metadata.name), identity: spec.identity, replication: spec.replication,
    allowAsyncCommits: spec.allowAsyncCommits === true,
    defaults: {size: 'small', tier: 'standard', ...spec.defaults}, clientCIDRs: spec.clientCIDRs || ['10.0.0.0/8'],
    storage: {pageservers: [{id: 1, host: 'pageserver', zone: spec.replication.zones[0]}, {id: 2, host: 'pageserver-2', zone: spec.replication.zones[1]}],
      safekeeperZones: spec.replication.zones, externalMetadata: Boolean(spec.storage.metadataDatabaseSecretRef)},
    s3: {endpoint: value('NEON_S3_ENDPOINT'), region: value('AWS_REGION'), bucket: value('NEON_S3_BUCKET'),
      prefix: value('NEON_S3_PREFIX').replace(/\/$/, '') + '/' + namespace + '/' + resource.metadata.uid}, tenants: []});
  const identity = createHash('sha256').update(JSON.stringify([config.name, config.domain, config.s3, spec.replication, spec.storage, metadataIdentity])).digest('hex');
  if (resource.status?.storageIdentity && resource.status.storageIdentity !== identity) throw Error('Storage identity/topology changes require an explicit migration');
  return {config, identity};
}
function RewriteNamespace(value, namespace) {
  if (typeof value === 'string') return value.replaceAll('neon-controller.neon.svc.cluster.local', 'neon-controller.' + namespace + '.svc.cluster.local');
  if (Array.isArray(value)) return value.map(item => RewriteNamespace(item, namespace));
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, key === 'namespace' && item === 'neon' ? namespace : RewriteNamespace(item, namespace)]));
  return value;
}
function FleetZone(name, zones) {
  if (name.startsWith('safekeeper-')) return zones[Number(name.slice(-1)) - 1];
  const index = ['pageserver', 'pageserver-2'].indexOf(name);
  return index >= 0 ? zones[index] : null;
}
function ApplyFleetOwnership(row, resource, config) {
    row.metadata.namespace = resource.metadata.namespace;
    row.metadata.labels = {...row.metadata.labels, 'neon.klustr.io/fleet-uid': resource.metadata.uid};
    row.metadata.ownerReferences = [{apiVersion: resource.apiVersion, kind: 'NeonFleet', name: resource.metadata.name, uid: resource.metadata.uid, controller: true, blockOwnerDeletion: true}];
    if (row.kind === 'ConfigMap' && row.metadata.name === 'neon-cluster') row.data['cluster.yaml'] = stringify(config);
    if (row.kind === 'ScaledObject') delete row.metadata.annotations; // KEDA owns its runtime status.
}
function ConfigurePod(row, spec, controllerImage) {
    const pod = row.spec?.template?.spec; if (!pod) return;
    const zone = FleetZone(row.metadata.name, spec.replication.zones);
    if (zone) pod.affinity = {nodeAffinity: {requiredDuringSchedulingIgnoredDuringExecution: {nodeSelectorTerms: [{matchExpressions: [{key: 'topology.kubernetes.io/zone', operator: 'In', values: [zone]}]}]}}};
    if (row.spec.volumeClaimTemplates) for (const claim of row.spec.volumeClaimTemplates) claim.spec.storageClassName = spec.storage.storageClass;
    for (const container of pod.containers) ConfigureContainer(row, pod, container, spec, controllerImage);
}
function ConfigureContainer(row, pod, container, spec, controllerImage) {
      if (container.image.includes('neon-tenant-controller')) container.image = controllerImage;
      if (row.metadata.name === 'neon-proxy') container.args.push('--project-info-cache', 'size=0,max_roles=10,gc_interval=60s');
      for (const env of container.envFrom || []) if (env.secretRef?.name === 'neon-s3') env.secretRef.name = spec.storage.objectStoreSecretRef;
      if (row.metadata.name === 'neon-tenant-controller' && spec.identity.caSecretRef) {
        container.volumeMounts.push({name: 'oidc-ca', mountPath: '/run/oidc-ca', readOnly: true});
        pod.volumes.push({name: 'oidc-ca', secret: {secretName: spec.identity.caSecretRef, items: [{key: 'ca.crt', path: 'ca.crt'}]}});
      }
      if (row.metadata.name === 'neon-tenant-controller') ConfigureIntrospectionCredentials(pod, container, spec.identity);
      if (row.metadata.name === 'storage-controller' && spec.storage.metadataDatabaseSecretRef) {
        // The checked-in command uses nested shell quotes. Replace its exact argument.
        container.command = container.command.map(text => text.replace(/--database-url .*? --public-key=/, '--database-url "$(cat /run/external-metadata/url)" --public-key='));
        container.volumeMounts.push({name: 'external-metadata', mountPath: '/run/external-metadata', readOnly: true});
        pod.volumes.push({name: 'external-metadata', secret: {secretName: spec.storage.metadataDatabaseSecretRef}});
      }
}
function ConfigureIntrospectionCredentials(pod, container, identity) {
  for (const kind of ['management', 'database']) {
    const policy = identity[kind].tokenValidation;
    if (policy?.mode !== 'introspection') continue;
    const name = 'oidc-introspection-'+kind;
    container.volumeMounts.push({name, mountPath: '/run/oidc-introspection/'+kind, readOnly: true});
    pod.volumes.push({name, secret: {secretName: policy.clientSecretRef, defaultMode: 288,
      items: [{key: policy.clientSecretKey || 'clientSecret', path: 'client-secret'}]}});
  }
}
