import http from 'node:http';
import {Kubernetes, Leadership} from '../infrastructure/kubernetes/Kubernetes.mjs';
import {FleetOperator} from '../application/fleet/FleetOperator.mjs';
import {FleetResources as fleetResources} from '../infrastructure/provisioning/FleetResources.mjs';
import {HealthController} from '../api/http/HealthController.mjs';

const api = new Kubernetes({namespace: process.env.POD_NAMESPACE});
const leader = new Leadership(api, {podName: process.env.POD_NAME, leaseName: 'neon-fleet-operator'});
const emit = (event, fields) => console.log(JSON.stringify({event, ...fields}));
const operator = new FleetOperator({api, leader, emit, planFleet: (fleet, inputs) => fleetResources(fleet,
  {...inputs, templates: '/app/fleet-templates', controllerImage: process.env.FLEET_CONTROLLER_IMAGE})});
const controller = new HealthController({authorizeHook: () => false, notify: null, isLeader: () => leader.active,
  stopping: () => false, metrics: () => ({leader: leader.active, endpoints: 0, events: {}}), emit});
await leader.tick(); void operator.reconcile();
const renew = setInterval(() => leader.tick(), 2000), reconcile = setInterval(() => operator.reconcile(), 10000);
const stop = api.watch('neonfleets', event => {
  if (['ADDED', 'DELETED'].includes(event.type) || event.type === 'MODIFIED' && event.object.metadata.generation !== event.object.status?.observedGeneration) void operator.reconcile();
});
const health = http.createServer(controller.Handle.bind(controller));
health.listen(9092, '0.0.0.0');
for (const signal of ['SIGTERM', 'SIGINT']) process.on(signal, () => {
  stop(); clearInterval(renew); clearInterval(reconcile); health.close(); setTimeout(() => process.exit(0), 1000).unref();
});
