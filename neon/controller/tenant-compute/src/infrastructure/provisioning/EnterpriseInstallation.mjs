// Namespace-scoped enterprise operator; CRDs and node-reader role are installed
// once by the cluster administrator. KEDA is a prerequisite.
/**
 * @typedef {Object} EnterpriseInstallationResources
 * @property {import('../kubernetes/Kubernetes.mjs').KubernetesResource} fleetCRD - Cluster-scoped fleet schema installed by the platform administrator.
 * @property {import('../kubernetes/Kubernetes.mjs').KubernetesResource} nodeReader - Shared read-only node-discovery ClusterRole.
 * @property {import('../kubernetes/Kubernetes.mjs').KubernetesResource} operator - Namespace operator/RBAC resource list, including a distinct node-reader binding.
 */
/**
 * Render enterprise installation resources without applying them.
 * Requires administrative caller review before deployment; this renderer has no API or persistence side effects.
 * @param {string} image - Qualified tenant-controller/operator image reference.
 * @param {string} [namespace] - Customer fleet namespace, default neon.
 * @returns {EnterpriseInstallationResources} CRD, shared role and namespace operator manifests.
 */
export function EnterpriseInstallation(image, namespace = 'neon') {
  const metadata = name => ({name, namespace});
  const fleetCRD = {apiVersion: 'apiextensions.k8s.io/v1', kind: 'CustomResourceDefinition', metadata: {name: 'neonfleets.neon.klustr.io'}, spec: {
    group: 'neon.klustr.io', scope: 'Namespaced', names: {kind: 'NeonFleet', plural: 'neonfleets', singular: 'neonfleet', shortNames: ['neonfleet']},
    versions: [{name: 'v1alpha1', served: true, storage: true, subresources: {status: {}},
      additionalPrinterColumns: [{name: 'Phase', type: 'string', jsonPath: '.status.phase'}, {name: 'Zones', type: 'boolean', jsonPath: '.status.zonePlacementConfigured'}],
      schema: {openAPIV3Schema: {type: 'object', properties: {spec: {type: 'object', required: ['domain', 'identity', 'storage', 'replication'],
        properties: {domain: {type: 'string', minLength: 1, maxLength: 253, pattern: '^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)*$'}, clientCIDRs: {type: 'array', minItems: 1, maxItems: 100, items: {type: 'string'}},
          allowAsyncCommits: {type: 'boolean', default: false},
          identity: {type: 'object', 'x-kubernetes-preserve-unknown-fields': true},
          storage: {type: 'object', required: ['objectStoreSecretRef', 'storageClass'], properties: {objectStoreSecretRef: {type: 'string'}, storageClass: {type: 'string'}, metadataDatabaseSecretRef: {type: 'string'}}},
          replication: {type: 'object', required: ['scope', 'mode', 'zones', 'safekeepers'], properties: {
            scope: {type: 'string', enum: ['availability-zones']}, mode: {type: 'string', enum: ['synchronous-quorum']},
            zones: {type: 'array', minItems: 3, maxItems: 3, items: {type: 'string'}}, safekeepers: {type: 'integer', enum: [3]}}},
          defaults: {type: 'object', 'x-kubernetes-preserve-unknown-fields': true}}}, status: {type: 'object', 'x-kubernetes-preserve-unknown-fields': true}}}}}]}};
  const nodeReader = {apiVersion: 'rbac.authorization.k8s.io/v1', kind: 'ClusterRole', metadata: {name: 'neon-fleet-node-reader'},
    rules: [{apiGroups: [''], resources: ['nodes'], verbs: ['get', 'list']}]};
  const permissions = [
    {apiGroups: [''], resources: ['configmaps', 'secrets', 'services', 'serviceaccounts'], verbs: ['get', 'list', 'create', 'patch', 'delete']},
    {apiGroups: [''], resources: ['pods'], verbs: ['get', 'list']},
    {apiGroups: ['apps'], resources: ['deployments', 'statefulsets'], verbs: ['get', 'list', 'create', 'patch']},
    {apiGroups: ['batch'], resources: ['jobs'], verbs: ['get', 'create', 'patch']},
    {apiGroups: ['networking.k8s.io'], resources: ['networkpolicies'], verbs: ['get', 'create', 'patch']},
    {apiGroups: ['rbac.authorization.k8s.io'], resources: ['roles', 'rolebindings'], verbs: ['get', 'create', 'patch']},
    {apiGroups: ['coordination.k8s.io'], resources: ['leases'], verbs: ['get', 'create', 'patch']},
    {apiGroups: ['discovery.k8s.io'], resources: ['endpointslices'], verbs: ['get', 'list']},
    {apiGroups: ['neon.klustr.io'], resources: ['neonfleets', 'neonfleets/status', 'neondatabases', 'neondatabases/status', 'neondatabases/scale', 'neonbackups', 'neonbackups/status', 'neonstoragefleets', 'neonstoragefleets/status', 'neonstoragefleets/scale'], verbs: ['get', 'list', 'watch', 'create', 'patch', 'update', 'delete']},
    {apiGroups: ['keda.sh'], resources: ['scaledobjects', 'triggerauthentications'], verbs: ['get', 'list', 'create', 'patch']}
  ];
  // KEDA's SA needs to be bound to the scale role created inside this namespace.
  // Binding that one external SA is part of provisioning, not cluster-wide admin.
  const operator = {apiVersion: 'v1', kind: 'List', items: [
    {apiVersion: 'v1', kind: 'ServiceAccount', metadata: metadata('neon-fleet-operator')},
    {apiVersion: 'rbac.authorization.k8s.io/v1', kind: 'Role', metadata: metadata('neon-fleet-operator'), rules: permissions},
    {apiVersion: 'rbac.authorization.k8s.io/v1', kind: 'RoleBinding', metadata: metadata('neon-fleet-operator'),
      roleRef: {apiGroup: 'rbac.authorization.k8s.io', kind: 'Role', name: 'neon-fleet-operator'}, subjects: [{kind: 'ServiceAccount', name: 'neon-fleet-operator', namespace}]},
    {apiVersion: 'rbac.authorization.k8s.io/v1', kind: 'ClusterRoleBinding', metadata: {name: 'neon-fleet-node-reader-' + namespace},
      roleRef: {apiGroup: 'rbac.authorization.k8s.io', kind: 'ClusterRole', name: 'neon-fleet-node-reader'}, subjects: [{kind: 'ServiceAccount', name: 'neon-fleet-operator', namespace}]},
    {apiVersion: 'apps/v1', kind: 'Deployment', metadata: metadata('neon-fleet-operator'), spec: {replicas: 1, strategy: {type: 'Recreate'},
      selector: {matchLabels: {'app.kubernetes.io/name': 'neon-fleet-operator'}}, template: {metadata: {labels: {'app.kubernetes.io/name': 'neon-fleet-operator'}}, spec: {
        serviceAccountName: 'neon-fleet-operator', securityContext: {runAsNonRoot: true, runAsUser: 10001, runAsGroup: 10001, seccompProfile: {type: 'RuntimeDefault'}},
        containers: [{name: 'operator', image, command: ['/usr/local/bin/node', '/app/src/composition/FleetOperatorInit.mjs'],
          env: [{name: 'POD_NAMESPACE', valueFrom: {fieldRef: {fieldPath: 'metadata.namespace'}}}, {name: 'POD_NAME', valueFrom: {fieldRef: {fieldPath: 'metadata.name'}}}, {name: 'FLEET_CONTROLLER_IMAGE', value: image}],
          securityContext: {allowPrivilegeEscalation: false, readOnlyRootFilesystem: true, capabilities: {drop: ['ALL']}},
          resources: {requests: {cpu: '100m', memory: '128Mi'}, limits: {cpu: '1', memory: '512Mi'}}, ports: [{name: 'health', containerPort: 9092}],
          readinessProbe: {httpGet: {path: '/readyz', port: 9092}}, livenessProbe: {httpGet: {path: '/livez', port: 9092}}}]
      }}}}
  ]};
  return {fleetCRD, nodeReader, operator};
}
