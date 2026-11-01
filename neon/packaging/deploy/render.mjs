// Maintainer entry point. Checked-in Compose/Kustomize YAML is ready to consume;
// users do not need to run this renderer.
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {stringify} from '../../controller/tenant-compute/node_modules/yaml/dist/index.js';
import {controllerResources} from '../kubernetes/tenant-controller.mjs';
const root = path.dirname(fileURLToPath(import.meta.url));
const digests = {compute: 'c7d0b5e0a359941fb766253bd8e2b0f8fe6408a6fa855ebf0287070ef280abc8',
  pageserver: 'b5e045980dd183cdb853cfb870696a31bee85e05aba927163b7c78bb20473d53',
  safekeeper: '102cad9f13f67e1da256d69e5437399ad090e2100c63136a10b3f52b4b0c4b59',
  'storage-controller': '4716c664590fea18d9a49bd36502ff9ff6d47352f1a952213b606d1cf04bd13b',
  'storage-broker': 'c66d30b177d651148d2c70e52c9e974a289dca236aa8cfa33896a8ed6cf55208',
  proxy: '562852b3eecd2726fcdf05d592e5d6692f7cff1c9434c2db2509a29559d49dd5'};
const image = role => `ghcr.io/klustr-io/neon-${role}@sha256:${digests[role]}`;
const helper = 'ghcr.io/klustr-io/neon-tenant-controller@sha256:fe71ce0d74172f1c10b612930822ad2f86575cef9fc96f58ffdc230be94ba246';
const shell = command => ['/bin/sh', '-ec', command];
const pageserver = 'cat /run/neon/pageserver.toml > /var/lib/neon/pageserver.toml; printf "id=1\\n" > /var/lib/neon/identity.toml; export NEON_AUTH_TOKEN="$(cat /run/neon/safekeeper.jwt)"; exec /usr/local/bin/pageserver -D /var/lib/neon';
const metadataCommand = 'if [ ! -f /var/lib/neon/metadata/PG_VERSION ]; then /opt/postgres/v18/bin/initdb -D /var/lib/neon/metadata -U neon --pwfile=/run/metadata/password --auth-host=scram-sha-256; fi; printf "local all all trust\n host postgres neon 0.0.0.0/0 scram-sha-256\n host postgres neon ::/0 scram-sha-256\n" > /var/lib/neon/metadata/pg_hba.conf; exec /opt/postgres/v18/bin/postgres -D /var/lib/neon/metadata -c listen_addresses=* -p 5432';
const storageController = 'exec /usr/local/bin/storage_controller --listen 0.0.0.0:1234 --initial-split-threshold 17179869184 --initial-split-shards 2 --split-threshold 1099511627776 --max-split-shards 16 --control-plane-url http://neon-controller:9090 --control-plane-jwt-token "$(cat /run/neon/controller-token)" --address-for-peers http://storage-controller:1234 --database-url "postgresql://neon:$(cat /run/metadata/password)@metadata:5432/postgres" --public-key="$(cat /run/neon/storage.pub)" --jwt-token "$(cat /run/neon/pageserver.jwt)" --safekeeper-jwt-token "$(cat /run/neon/safekeeper.jwt)" --peer-jwt-token "$(cat /run/neon/peer.jwt)"';
const sk = id => `exec /usr/local/bin/safekeeper -D /var/lib/neon --id ${id} --listen-pg 0.0.0.0:5454 --listen-http 0.0.0.0:7676 --advertise-pg safekeeper-${id}:5454 --broker-endpoint http://storage-broker:50051 --pg-auth-public-key-path /run/neon/storage.pub --http-auth-public-key-path /run/neon/storage.pub --auth-token-path /run/neon/safekeeper.jwt --remote-storage "$(cat /run/neon/remote.toml)"`;
const bootstrapCommand = operation => ['/usr/local/bin/node', '/app/deploy/bootstrap.mjs', operation];
const cluster = {
  name: 'neon', domain: 'db.local', computeImage: image('compute'),
  clientCIDRs: ['10.0.0.0/8', '172.16.0.0/12', '192.168.0.0/16', '127.0.0.1/32'],
  storage: {pageservers: [{id: 1, host: 'pageserver', zone: 'zone-1'}, {id: 2, host: 'pageserver-2', zone: 'zone-2'}]},
  s3: {endpoint: 'https://s3.example.com', region: 'us-east-1', bucket: 'replace-me', prefix: 'neon/my-cluster'},
  tenants: []
};
function output(file, value) {
  const target = path.resolve(root, file); fs.mkdirSync(path.dirname(target), {recursive: true});
  fs.writeFileSync(target, '# Deployment source: neon/packaging/deploy/render.mjs\n' + stringify(value, {lineWidth: 0, aliasDuplicateObjects: false}));
}

const shared = {platform: 'linux/amd64', restart: 'unless-stopped', user: '10001:10001', read_only: true,
  cap_drop: ['ALL'], security_opt: ['no-new-privileges:true'], networks: ['backend'], tmpfs: ['/tmp:uid=10001,gid=10001,mode=1770,size=256m']};
const configMount = './config:/etc/neon:ro';
const s3env = {AWS_ACCESS_KEY_ID: '${AWS_ACCESS_KEY_ID:?Set AWS_ACCESS_KEY_ID}', AWS_SECRET_ACCESS_KEY: '${AWS_SECRET_ACCESS_KEY:?Set AWS_SECRET_ACCESS_KEY}',
  AWS_SESSION_TOKEN: '${AWS_SESSION_TOKEN:-}',
  AWS_REGION: '${AWS_REGION:-us-east-1}', AWS_EC2_METADATA_DISABLED: 'true'};
const initDepends = {init: {condition: 'service_completed_successfully'}};
const stateMount = (subpath, target = '/run/neon') => ({type: 'volume', source: 'state', target, read_only: true, volume: {subpath}});
const helperService = {...shared, image: '${NEON_CONTROLLER_IMAGE:-' + helper + '}',
  entrypoint: ['/usr/local/bin/node'], volumes: ['state:/state', configMount]};
const compose = {name: 'neon', services: {
  init: {...helperService, user: '0:0', restart: 'no', cap_add: ['CHOWN', 'FOWNER', 'DAC_OVERRIDE'], command: ['/app/deploy/bootstrap.mjs', 'init']},
  metadata: {...shared, image: image('compute'), entrypoint: shell(metadataCommand),
    volumes: [stateMount('metadata', '/run/metadata'), 'metadata:/var/lib/neon'], depends_on: initDepends,
    healthcheck: {test: ['CMD', '/opt/postgres/v18/bin/pg_isready', '-U', 'neon', '-d', 'postgres'], interval: '3s', timeout: '3s', retries: 30}},
  'storage-broker': {...shared, image: image('storage-broker')},
  'storage-controller': {...shared, image: image('storage-controller'), entrypoint: shell(storageController),
    volumes: [stateMount('storage-controller'), stateMount('metadata', '/run/metadata')], depends_on: {...initDepends, metadata: {condition: 'service_healthy'}}},
  pageserver: {...shared, image: image('pageserver'), entrypoint: shell(pageserver), environment: s3env,
    volumes: [stateMount('pageserver'), 'pageserver:/var/lib/neon'], depends_on: {...initDepends, 'storage-controller': {condition: 'service_started'}}},
  'pageserver-2': {...shared, image: image('pageserver'), entrypoint: shell(pageserver.replace('id=1', 'id=2')), environment: s3env,
    volumes: [stateMount('pageserver'), 'pageserver-2:/var/lib/neon'], depends_on: {...initDepends, 'storage-controller': {condition: 'service_started'}}},
  ...Object.fromEntries([1, 2, 3].map(id => ['safekeeper-' + id, {...shared, image: image('safekeeper'), entrypoint: shell(sk(id)), environment: s3env,
    volumes: [stateMount('safekeeper'), 'safekeeper-' + id + ':/var/lib/neon'], depends_on: initDepends}])),
  provision: {...helperService, restart: 'on-failure:5', command: ['/app/deploy/bootstrap.mjs', 'provision'], depends_on: {
    pageserver: {condition: 'service_started'}, 'pageserver-2': {condition: 'service_started'}, ...Object.fromEntries([1, 2, 3].map(id => ['safekeeper-' + id, {condition: 'service_started'}]))}},
  controller: {...helperService, command: ['/app/server.mjs'], volumes: ['state:/state', configMount, '/var/run/docker.sock:/var/run/docker.sock'],
    // Docker socket authority is explicit. Read-only bind flags do not restrict API methods.
    group_add: ['${DOCKER_GID:-0}'],
    environment: {NEON_PLATFORM: 'compose', NEON_DOCKER_PROJECT: '${COMPOSE_PROJECT_NAME:-neon}', NEON_DOCKER_NETWORK: '${COMPOSE_PROJECT_NAME:-neon}-backend',
      NEON_DOCKER_STATE_VOLUME: '${COMPOSE_PROJECT_NAME:-neon}-state', CONTROLLER_API_TOKEN_FILE: '/state/controller-token',
      NEON_DEPLOYMENT_CONFIG: '/etc/neon/cluster.yaml', CONTROLLER_TLS_KEY: '/state/controller.key', CONTROLLER_TLS_CERT: '/state/controller.crt'},
    networks: {backend: {aliases: ['neon-controller']}}, depends_on: initDepends},
  proxy: {...shared, image: image('proxy'), entrypoint: shell('export NEON_PROXY_TO_CONTROLPLANE_TOKEN="$(cat /run/neon/controller-token)"; exec /usr/local/bin/proxy --proxy 0.0.0.0:5432 --http 0.0.0.0:7001 --auth-backend control-plane --auth-endpoint https://neon-controller:8080/ --tls-key /run/neon/proxy.key --tls-cert /run/neon/proxy.crt --wake-compute-cache size=0'),
    environment: {SSL_CERT_FILE: '/run/neon/ca.crt', OTEL_SDK_DISABLED: 'true'}, volumes: [stateMount('proxy')], ports: ['${NEON_BIND_ADDRESS:-127.0.0.1}:${NEON_PORT:-55432}:5432'],
    depends_on: {controller: {condition: 'service_started'}}},
  // Pull-only profile: dynamic compute containers use this exact image locally.
  'compute-image': {...shared, image: image('compute'), profiles: ['pull'], entrypoint: ['/opt/postgres/v18/bin/postgres'], command: ['--version'], restart: 'no'}
}, networks: {backend: {name: '${COMPOSE_PROJECT_NAME:-neon}-backend'}}, volumes: Object.fromEntries(['state', 'metadata', 'pageserver', 'pageserver-2', 'safekeeper-1', 'safekeeper-2', 'safekeeper-3'].map(name => [name, {name: '${COMPOSE_PROJECT_NAME:-neon}-' + name}]))};
output('../compose/compose.yaml', compose);
output('../compose/config/cluster.yaml', cluster);
fs.writeFileSync(path.resolve(root, '../compose/.env.example'), 'AWS_ACCESS_KEY_ID=replace-me\nAWS_SECRET_ACCESS_KEY=replace-me\nAWS_REGION=us-east-1\nNEON_PORT=55432\n# Linux: use the group owning /var/run/docker.sock\nDOCKER_GID=0\n# Optional controller image override\n# NEON_CONTROLLER_IMAGE=your-registry/neon-tenant-controller:deploy\n');

const ns = 'neon';
const metadata = name => ({name});
const sec = {runAsNonRoot: true, runAsUser: 10001, runAsGroup: 10001, fsGroup: 10001, seccompProfile: {type: 'RuntimeDefault'}};
const containerSec = {allowPrivilegeEscalation: false, readOnlyRootFilesystem: true, capabilities: {drop: ['ALL']}};
const secretVol = (name, secretName = name) => ({name, secret: {secretName, defaultMode: 288}});
const mount = (name, mountPath) => ({name, mountPath, readOnly: true});
const configVol = {name: 'config', configMap: {name: 'neon-cluster'}};
const service = (name, ports, headless = false) => ({apiVersion: 'v1', kind: 'Service', metadata: metadata(name), spec: {
  ...(headless ? {clusterIP: 'None', publishNotReadyAddresses: true} : {}), selector: {app: name}, ports: ports.map(([name, port]) => ({name, port, targetPort: port}))}});
function stateful(name, image, command, ports, {aws = false, postgres = false, size = '10Gi'} = {}) {
  return {apiVersion: 'apps/v1', kind: 'StatefulSet', metadata: metadata(name), spec: {serviceName: name, replicas: 1,
    selector: {matchLabels: {app: name}}, template: {metadata: {labels: {app: name}}, spec: {
      automountServiceAccountToken: false, securityContext: sec,
      terminationGracePeriodSeconds: 120,
      containers: [{name, image, imagePullPolicy: 'IfNotPresent', ...(command ? {command} : {}),
        securityContext: containerSec,
        resources: {requests: {cpu: '250m', memory: postgres ? '256Mi' : '512Mi'}, limits: {cpu: '2', memory: '2Gi'}},
        ...(aws ? {envFrom: [{secretRef: {name: 'neon-s3'}}], env: [{name: 'AWS_EC2_METADATA_DISABLED', value: 'true'}]} : {}),
        ports: ports.map(([name, containerPort]) => ({name, containerPort})),
        readinessProbe: postgres ? {exec: {command: ['/opt/postgres/v18/bin/pg_isready', '-U', 'neon', '-d', 'postgres']}} : {tcpSocket: {port: ports[0][1]}, periodSeconds: 3},
        volumeMounts: [{name: 'data', mountPath: '/var/lib/neon'},
          ...(postgres ? [mount('metadata', '/run/metadata')] : [mount('storage-config', '/run/neon')]), {name: 'tmp', mountPath: '/tmp'}]}],
      volumes: [{name: 'tmp', emptyDir: {sizeLimit: '256Mi'}}, ...(postgres ? [secretVol('metadata', 'neon-metadata')] : [secretVol('storage-config', 'neon-' + (name.startsWith('safekeeper-') ? 'safekeeper' : name.startsWith('pageserver') ? 'pageserver' : name) + '-config')])] }},
    volumeClaimTemplates: [{metadata: {name: 'data'}, spec: {accessModes: ['ReadWriteOnce'], resources: {requests: {storage: size}}}}]}};
}
const storage = [service('metadata', [['postgres', 5432]], true), stateful('metadata', image('compute'), shell(metadataCommand), [['postgres', 5432]], {postgres: true}),
  service('storage-broker', [['grpc', 50051]]),
  {apiVersion: 'apps/v1', kind: 'Deployment', metadata: metadata('storage-broker'), spec: {replicas: 1, selector: {matchLabels: {app: 'storage-broker'}},
    template: {metadata: {labels: {app: 'storage-broker'}}, spec: {automountServiceAccountToken: false, securityContext: sec,
      containers: [{name: 'broker', image: image('storage-broker'), securityContext: containerSec, ports: [{containerPort: 50051}],
        resources: {requests: {cpu: '50m', memory: '64Mi'}, limits: {cpu: '1', memory: '256Mi'}}}]}}}},
  service('storage-controller', [['http', 1234]]),
  {apiVersion: 'apps/v1', kind: 'Deployment', metadata: metadata('storage-controller'), spec: {replicas: 1, strategy: {type: 'Recreate'}, selector: {matchLabels: {app: 'storage-controller'}},
    template: {metadata: {labels: {app: 'storage-controller'}}, spec: {automountServiceAccountToken: false, securityContext: sec,
      containers: [{name: 'controller', image: image('storage-controller'), command: shell(storageController), securityContext: containerSec,
        ports: [{containerPort: 1234}], resources: {requests: {cpu: '100m', memory: '128Mi'}, limits: {cpu: '1', memory: '512Mi'}},
        readinessProbe: {tcpSocket: {port: 1234}}, volumeMounts: [mount('storage-config', '/run/neon'), mount('metadata', '/run/metadata'), {name: 'tmp', mountPath: '/tmp'}]}],
      volumes: [secretVol('storage-config', 'neon-storage-controller-config'), secretVol('metadata', 'neon-metadata'), {name: 'tmp', emptyDir: {sizeLimit: '64Mi'}}]}}}},
  service('pageserver', [['postgres', 6400], ['http', 9898]], true), stateful('pageserver', image('pageserver'), shell(pageserver), [['postgres', 6400], ['http', 9898]], {aws: true}),
  service('pageserver-2', [['postgres', 6400], ['http', 9898]], true), stateful('pageserver-2', image('pageserver'), shell(pageserver.replace('id=1', 'id=2')), [['postgres', 6400], ['http', 9898]], {aws: true}),
  ...[1, 2, 3].flatMap(id => [service('safekeeper-' + id, [['postgres', 5454], ['http', 7676]], true),
    stateful('safekeeper-' + id, image('safekeeper'), shell(sk(id)), [['postgres', 5454], ['http', 7676]], {aws: true})])];
const jobs = ['init', 'provision'].map(operation => ({apiVersion: 'batch/v1', kind: 'Job', metadata: metadata('neon-' + operation), spec: {
  backoffLimit: 8, activeDeadlineSeconds: 900, template: {metadata: {labels: {app: 'neon-bootstrap'}}, spec: {
    serviceAccountName: 'neon-bootstrap', restartPolicy: 'OnFailure', securityContext: sec,
    containers: [{name: operation, image: helper, imagePullPolicy: 'IfNotPresent', command: bootstrapCommand(operation), securityContext: containerSec,
      env: [{name: 'NEON_PLATFORM', value: 'kubernetes'}, {name: 'POD_NAMESPACE', valueFrom: {fieldRef: {fieldPath: 'metadata.namespace'}}}],
      resources: {requests: {cpu: '100m', memory: '128Mi'}, limits: {cpu: '1', memory: '512Mi'}},
      volumeMounts: [mount('config', '/etc/neon'), {name: 'state', mountPath: '/state'}, {name: 'tmp', mountPath: '/tmp'}]}],
    volumes: [configVol, {name: 'state', emptyDir: {}}, {name: 'tmp', emptyDir: {}}]}}}}));
const apps = names => ({podSelector: {matchExpressions: [{key: 'app', operator: 'In', values: names}]}});
const computePeer = {podSelector: {matchLabels: {'app.kubernetes.io/name': 'neon-compute'}}};
const policy = (name, targets, rules) => ({apiVersion: 'networking.k8s.io/v1', kind: 'NetworkPolicy', metadata: metadata(name), spec: {
  podSelector: apps(targets).podSelector, policyTypes: ['Ingress'], ingress: rules.map(([from, ports]) => ({from, ports: ports.map(port => ({protocol: 'TCP', port}))}))}});
storage.push(
  policy('neon-metadata-ingress', ['metadata'], [[[apps(['storage-controller'])], [5432]]]),
  policy('neon-storage-controller-ingress', ['storage-controller'], [[[apps(['neon-bootstrap', 'pageserver', 'pageserver-2']), {podSelector: {matchLabels: {'app.kubernetes.io/name': 'neon-tenant-controller'}}}], [1234]]]),
  policy('neon-pageserver-ingress', ['pageserver', 'pageserver-2'], [[[apps(['storage-controller', 'neon-bootstrap'])], [9898]], [[computePeer], [6400]]]),
  policy('neon-safekeeper-ingress', ['safekeeper-1', 'safekeeper-2', 'safekeeper-3'], [
    [[apps(['storage-controller', 'neon-bootstrap', 'safekeeper-1', 'safekeeper-2', 'safekeeper-3'])], [7676]],
    [[apps(['pageserver', 'pageserver-2', 'safekeeper-1', 'safekeeper-2', 'safekeeper-3']), computePeer], [5454]]]),
  policy('neon-broker-ingress', ['storage-broker'], [[[apps(['pageserver', 'pageserver-2', 'safekeeper-1', 'safekeeper-2', 'safekeeper-3'])], [50051]]])
);
const controller = controllerResources({namespace: ns, controllerImage: 'ghcr.io/klustr-io/neon-tenant-controller@sha256:' + '0'.repeat(64), proxyImage: image('proxy')});
const controllerPod = controller.find(row => row.kind === 'Deployment' && row.metadata.name === 'neon-tenant-controller').spec.template.spec;
controllerPod.containers[0].image = helper;
controllerPod.containers[0].env.push({name: 'NEON_DEPLOYMENT_CONFIG', value: '/etc/neon/cluster.yaml'});
controllerPod.containers[0].volumeMounts.push(mount('config', '/etc/neon'));
controllerPod.volumes.push(configVol);
const proxyContainer = controller.find(row => row.kind === 'Deployment' && row.metadata.name === 'neon-proxy').spec.template.spec.containers[0];
proxyContainer.args = proxyContainer.args.map(value => value === 'https://neon-controller.neon.svc.cluster.local:8080/' ? 'https://neon-controller:8080/' : value);
controller.find(row => row.kind === 'Service' && row.metadata.name === 'neon-controller').spec.ports[0].name = 'api';
controller.find(row => row.kind === 'Service' && row.metadata.name === 'neon-controller').spec.ports.push({name: 'hooks', port: 9090, targetPort: 9090});
controller.find(row => row.kind === 'NetworkPolicy' && row.metadata.name === 'neon-controller-ingress').spec.ingress.push({from: [{podSelector: {matchLabels: {app: 'storage-controller'}}}], ports: [{protocol: 'TCP', port: 9090}]});
for (const resource of [...storage, ...controller, ...jobs]) {
  const pod = resource.spec?.template?.spec;
  if (pod) pod.nodeSelector = {...pod.nodeSelector, 'kubernetes.io/arch': 'amd64', 'kubernetes.io/os': 'linux'};
}
output('../kubernetes/base/namespace.yaml', {apiVersion: 'v1', kind: 'Namespace', metadata: {name: ns, labels: {'pod-security.kubernetes.io/enforce': 'restricted'}}});
output('../kubernetes/base/cluster.yaml', {apiVersion: 'v1', kind: 'ConfigMap', metadata: metadata('neon-cluster'), data: {'cluster.yaml': stringify({...cluster, computeNode: 'replace-with-ready-amd64-node'})}});
output('../kubernetes/base/bootstrap.yaml', {apiVersion: 'v1', kind: 'List', items: [
  {apiVersion: 'v1', kind: 'ServiceAccount', metadata: metadata('neon-bootstrap')},
  {apiVersion: 'rbac.authorization.k8s.io/v1', kind: 'Role', metadata: metadata('neon-bootstrap'), rules: [{apiGroups: [''], resources: ['secrets', 'configmaps'], verbs: ['get', 'create', 'patch']}]},
  {apiVersion: 'rbac.authorization.k8s.io/v1', kind: 'RoleBinding', metadata: metadata('neon-bootstrap'), roleRef: {apiGroup: 'rbac.authorization.k8s.io', kind: 'Role', name: 'neon-bootstrap'},
    subjects: [{kind: 'ServiceAccount', name: 'neon-bootstrap', namespace: ns}]}, ...jobs]});
output('../kubernetes/base/storage.yaml', {apiVersion: 'v1', kind: 'List', items: storage});
output('../kubernetes/base/controller.yaml', {apiVersion: 'v1', kind: 'List', items: controller});
output('../kubernetes/base/kustomization.yaml', {apiVersion: 'kustomize.config.k8s.io/v1beta1', kind: 'Kustomization', namespace: ns,
  resources: ['namespace.yaml', 'cluster.yaml', 'bootstrap.yaml', 'storage.yaml', 'controller.yaml']});

const databaseSchema = {type: 'object', required: ['size', 'tier'], properties: {
  lifecycle: {type: 'string', enum: ['active', 'suspended', 'retired'], default: 'active'},
  deletionPolicy: {type: 'string', enum: ['Retain', 'Delete'], default: 'Retain'},
  backup: {type: 'object', 'x-kubernetes-validations': [
    {rule: 'self.scheduleSeconds == 0 || (self.scheduleSeconds >= 300 && self.retentionSeconds >= self.scheduleSeconds)', message: 'Schedule must be at least five minutes and fit retention'}], properties: {
    historySeconds: {type: 'integer', minimum: 0, maximum: 2592000, default: 604800},
    scheduleSeconds: {type: 'integer', minimum: 0, maximum: 2592000, default: 0},
    retentionSeconds: {type: 'integer', minimum: 300, maximum: 31536000, default: 604800}}},
  branchFrom: {type: 'object', required: ['database'], properties: {
    database: {type: 'string', pattern: '^[a-z][a-z0-9-]{0,38}$'},
    backup: {type: 'string', pattern: '^[a-z][a-z0-9-]{0,38}$'},
    lsn: {type: 'string', pattern: '^[0-9A-Fa-f]{1,8}/[0-9A-Fa-f]{1,8}$'},
    timestamp: {type: 'string', format: 'date-time'}}},
  replicas: {type: 'integer', minimum: 0, maximum: 1, default: 0},
  database: {type: 'string', pattern: '^[a-z][a-z0-9_]{0,62}$', default: 'app', 'x-kubernetes-validations': [{rule: 'self == oldSelf', message: 'Database name is immutable'}]},
  user: {type: 'string', pattern: '^[a-z][a-z0-9_]{0,62}$', default: 'app_user', 'x-kubernetes-validations': [{rule: 'self == oldSelf', message: 'Database role is immutable'}]},
  size: {type: 'string', maxLength: 39}, tier: {type: 'string', maxLength: 39},
  profile: {type: 'string', enum: ['durable', 'bounded-async'], default: 'durable'},
  shards: {type: 'integer', enum: [1, 2, 4, 8, 16, 32], default: 1},
  allowedIps: {type: 'array', maxItems: 100, minItems: 1, items: {type: 'string', maxLength: 64}},
  suspend: {type: 'object', default: {mode: 'idle', idleSeconds: 300}, properties: {
    mode: {type: 'string', enum: ['idle', 'never'], default: 'idle'}, idleSeconds: {type: 'integer', minimum: 1, maximum: 604800, default: 300}}},
  databasePolicies: {type: 'object', additionalProperties: {type: 'object', properties: {
    mode: {type: 'string', enum: ['idle', 'never']}, idleSeconds: {type: 'integer', minimum: 1, maximum: 604800}}}}
}, 'x-kubernetes-validations': [
  {rule: '!has(oldSelf.branchFrom) ? !has(self.branchFrom) : has(self.branchFrom) && self.branchFrom == oldSelf.branchFrom', message: 'Branch source is immutable'},
  {rule: 'self.lifecycle != "retired" || oldSelf.lifecycle == "retired" || self.replicas == 0', message: 'Retirement stops compute'},
  {rule: 'oldSelf.lifecycle != "retired" || self.lifecycle == "retired"', message: 'Retired names cannot be reused'},
  {rule: 'self.deletionPolicy != "Delete" || self.lifecycle == "retired"', message: 'Delete requires retirement'},
  {rule: '!has(self.branchFrom) || !has(self.backup)', message: 'Branches inherit root history policy'}
]};
output('../kubernetes/keda/database-crd.yaml', {apiVersion: 'apiextensions.k8s.io/v1', kind: 'CustomResourceDefinition', metadata: {name: 'neondatabases.neon.klustr.io'}, spec: {
  group: 'neon.klustr.io', scope: 'Namespaced', names: {kind: 'NeonDatabase', plural: 'neondatabases', singular: 'neondatabase', shortNames: ['neondb']},
  versions: [{name: 'v1alpha1', served: true, storage: true, subresources: {status: {}, scale: {
    specReplicasPath: '.spec.replicas', statusReplicasPath: '.status.replicas', labelSelectorPath: '.status.selector'}},
    additionalPrinterColumns: [{name: 'Size', type: 'string', jsonPath: '.spec.size'}, {name: 'Tier', type: 'string', jsonPath: '.spec.tier'},
      {name: 'Phase', type: 'string', jsonPath: '.status.phase'}, {name: 'Replicas', type: 'integer', jsonPath: '.status.replicas'}],
    schema: {openAPIV3Schema: {type: 'object', properties: {spec: databaseSchema,
      status: {type: 'object', 'x-kubernetes-preserve-unknown-fields': true, properties: {replicas: {type: 'integer'}, selector: {type: 'string'}}}}}}}]}});
output('../kubernetes/keda/backup-crd.yaml', {apiVersion: 'apiextensions.k8s.io/v1', kind: 'CustomResourceDefinition', metadata: {name: 'neonbackups.neon.klustr.io'}, spec: {
  group: 'neon.klustr.io', scope: 'Namespaced', names: {kind: 'NeonBackup', plural: 'neonbackups', singular: 'neonbackup', shortNames: ['neonbackup']},
  versions: [{name: 'v1alpha1', served: true, storage: true, subresources: {status: {}},
    additionalPrinterColumns: [{name: 'Database', type: 'string', jsonPath: '.spec.database'}, {name: 'Phase', type: 'string', jsonPath: '.status.phase'}, {name: 'Expires', type: 'string', jsonPath: '.status.expiresAt'}],
    schema: {openAPIV3Schema: {type: 'object', properties: {spec: {type: 'object', required: ['database', 'databaseUID', 'retentionSeconds'],
      'x-kubernetes-validations': [{rule: 'self == oldSelf', message: 'Backup identity and retention are immutable'}], properties: {
        database: {type: 'string', pattern: '^[a-z][a-z0-9-]{0,38}$'}, databaseUID: {type: 'string', minLength: 1, maxLength: 128},
        retentionSeconds: {type: 'integer', minimum: 300, maximum: 31536000}}}, status: {type: 'object', 'x-kubernetes-preserve-unknown-fields': true}}}}}]}});
output('../kubernetes/keda/rbac.yaml', {apiVersion: 'v1', kind: 'List', items: [
  {apiVersion: 'rbac.authorization.k8s.io/v1', kind: 'Role', metadata: {name: 'neon-database-controller'}, rules: [
    {apiGroups: ['neon.klustr.io'], resources: ['neondatabases', 'neondatabases/status', 'neonstoragefleets', 'neonstoragefleets/status'], verbs: ['get', 'list', 'watch', 'create', 'patch']},
    {apiGroups: ['neon.klustr.io'], resources: ['neonbackups', 'neonbackups/status'], verbs: ['get', 'list', 'create', 'patch', 'delete']},
    {apiGroups: ['apps'], resources: ['statefulsets'], verbs: ['get', 'list', 'patch']},
    {apiGroups: ['keda.sh'], resources: ['scaledobjects'], verbs: ['get', 'list', 'create', 'patch']},
    {apiGroups: [''], resources: ['configmaps'], verbs: ['create']}]},
  {apiVersion: 'rbac.authorization.k8s.io/v1', kind: 'RoleBinding', metadata: {name: 'neon-database-controller'},
    roleRef: {apiGroup: 'rbac.authorization.k8s.io', kind: 'Role', name: 'neon-database-controller'},
    subjects: [{kind: 'ServiceAccount', name: 'neon-tenant-controller', namespace: ns}]},
  {apiVersion: 'rbac.authorization.k8s.io/v1', kind: 'Role', metadata: {name: 'neon-keda-scale'}, rules: [
    {apiGroups: ['neon.klustr.io'], resources: ['neondatabases', 'neondatabases/scale', 'neonstoragefleets', 'neonstoragefleets/scale'], verbs: ['get', 'list', 'watch', 'update', 'patch']},
    {apiGroups: [''], resources: ['secrets'], resourceNames: ['neon-keda-client-tls'], verbs: ['get']}]},
  {apiVersion: 'rbac.authorization.k8s.io/v1', kind: 'RoleBinding', metadata: {name: 'neon-keda-scale'},
    roleRef: {apiGroup: 'rbac.authorization.k8s.io', kind: 'Role', name: 'neon-keda-scale'},
    subjects: [{kind: 'ServiceAccount', name: 'keda-operator', namespace: 'keda'}]}
]});
output('../kubernetes/keda/trigger-authentication.yaml', {apiVersion: 'keda.sh/v1alpha1', kind: 'TriggerAuthentication', metadata: {name: 'neon-keda-tls'},
  spec: {secretTargetRef: [{parameter: 'caCert', name: 'neon-keda-client-tls', key: 'ca.crt'},
    {parameter: 'tlsClientCert', name: 'neon-keda-client-tls', key: 'tls.crt'}, {parameter: 'tlsClientKey', name: 'neon-keda-client-tls', key: 'tls.key'}]}});
output('../kubernetes/keda/controller-patch.yaml', {apiVersion: 'apps/v1', kind: 'Deployment', metadata: {name: 'neon-tenant-controller', namespace: ns}, spec: {template: {spec: {
  containers: [{name: 'controller', env: [{name: 'NEON_DATABASE_API', value: 'true'}, {name: 'NEON_PLATFORM', value: 'kubernetes'},
    {name: 'NEON_FLEET_SCALE_TO_ZERO', value: 'true'},
    {name: 'NEON_STATE', value: '/tmp/provision-state'}], ports: [{name: 'keda', containerPort: 9091}],
    volumeMounts: [mount('management', '/run/management'), mount('trust', '/run/trust'), mount('bootstrap-ready', '/run/bootstrap-ready')]}],
  volumes: [secretVol('management', 'neon-management-auth'), secretVol('trust', 'neon-service-ca'),
    {name: 'bootstrap-ready', secret: {secretName: 'neon-bootstrap-state', items: [{key: 'identity.json', path: 'identity.json'}]}}]
}}}});
output('../kubernetes/keda/init-patch.yaml', {apiVersion: 'batch/v1', kind: 'Job', metadata: {name: 'neon-init', namespace: ns}, spec: {template: {spec: {
  containers: [{name: 'init', env: [{name: 'NEON_INITIALIZE_ONLY', value: 'true'}]}]
}}}});
output('../kubernetes/keda/provision-patch.yaml', {apiVersion: 'batch/v1', kind: 'Job', metadata: {name: 'neon-provision', namespace: ns}, $patch: 'delete'});
output('../kubernetes/keda/service-patch.yaml', {apiVersion: 'v1', kind: 'Service', metadata: {name: 'neon-controller', namespace: ns}, spec: {
  ports: [{name: 'api', port: 8080, targetPort: 8080}, {name: 'hooks', port: 9090, targetPort: 9090}, {name: 'keda', port: 9091, targetPort: 9091}]}});
output('../kubernetes/keda/network-policy.yaml', {apiVersion: 'networking.k8s.io/v1', kind: 'NetworkPolicy', metadata: {name: 'neon-database-control-ingress'}, spec: {
  podSelector: {matchLabels: {'app.kubernetes.io/name': 'neon-tenant-controller'}}, policyTypes: ['Ingress'], ingress: [
    {from: [{namespaceSelector: {matchLabels: {'kubernetes.io/metadata.name': 'keda'}}}], ports: [{protocol: 'TCP', port: 9091}]},
    {from: [{podSelector: {matchLabels: {'neon.klustr.io/webhook-client': 'true'}}}], ports: [{protocol: 'TCP', port: 8080}]}]}});
output('../kubernetes/keda/fleet-crd.yaml', {apiVersion: 'apiextensions.k8s.io/v1', kind: 'CustomResourceDefinition', metadata: {name: 'neonstoragefleets.neon.klustr.io'}, spec: {
  group: 'neon.klustr.io', scope: 'Namespaced', names: {kind: 'NeonStorageFleet', plural: 'neonstoragefleets', singular: 'neonstoragefleet'},
  versions: [{name: 'v1alpha1', served: true, storage: true, subresources: {status: {}, scale: {
    specReplicasPath: '.spec.replicas', statusReplicasPath: '.status.replicas', labelSelectorPath: '.status.selector'}},
    schema: {openAPIV3Schema: {type: 'object', properties: {spec: {type: 'object', properties: {replicas: {type: 'integer', minimum: 0, maximum: 1, default: 0}}},
      status: {type: 'object', 'x-kubernetes-preserve-unknown-fields': true, properties: {replicas: {type: 'integer'}, selector: {type: 'string'}}}}}}}]}});
output('../kubernetes/keda/fleet.yaml', {apiVersion: 'v1', kind: 'List', items: [
  {apiVersion: 'neon.klustr.io/v1alpha1', kind: 'NeonStorageFleet', metadata: {name: 'storage'}, spec: {}},
  {apiVersion: 'keda.sh/v1alpha1', kind: 'ScaledObject', metadata: {name: 'neon-storage'}, spec: {
    scaleTargetRef: {apiVersion: 'neon.klustr.io/v1alpha1', kind: 'NeonStorageFleet', name: 'storage'}, minReplicaCount: 0, maxReplicaCount: 1,
    pollingInterval: 5, cooldownPeriod: 30, triggers: [{type: 'external-push', metadata: {scalerAddress: 'neon-controller.'+ns+'.svc.cluster.local:9091', fleet: 'true', enableTLS: 'true'},
      authenticationRef: {name: 'neon-keda-tls'}}]}}
]});
const fleetPatches = storage.filter(resource => ['Deployment', 'StatefulSet'].includes(resource.kind)).map(resource => ({
  target: {group: 'apps', version: 'v1', kind: resource.kind, name: resource.metadata.name},
  patch: JSON.stringify([{op: 'remove', path: '/spec/replicas'},
    {op: 'add', path: '/spec/template/metadata/labels/neon.klustr.io~1storage-fleet', value: 'storage'}])
}));
output('../kubernetes/keda/kustomization.yaml', {apiVersion: 'kustomize.config.k8s.io/v1beta1', kind: 'Kustomization', namespace: ns,
  resources: ['../base', 'database-crd.yaml', 'backup-crd.yaml', 'fleet-crd.yaml', 'fleet.yaml', 'rbac.yaml', 'trigger-authentication.yaml', 'network-policy.yaml'],
  patches: [{path: 'controller-patch.yaml'}, {path: 'service-patch.yaml'}, {path: 'init-patch.yaml'}, {path: 'provision-patch.yaml'}, ...fleetPatches]});
output('../kubernetes/examples/database.yaml', {apiVersion: 'neon.klustr.io/v1alpha1', kind: 'NeonDatabase', metadata: {name: 'events', namespace: ns},
  spec: {database: 'app', size: 'small', tier: 'shared', suspend: {mode: 'idle', idleSeconds: 300}}});
