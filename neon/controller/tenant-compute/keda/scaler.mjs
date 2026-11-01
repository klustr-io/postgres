import fs from 'node:fs';
import {fileURLToPath} from 'node:url';
import grpc from '@grpc/grpc-js';
import loader from '@grpc/proto-loader';
const definition = loader.loadSync(fileURLToPath(new URL('./externalscaler.proto', import.meta.url)), {longs: String, defaults: true});
export const protocol = grpc.loadPackageDefinition(definition).externalscaler;

export async function startScaler({namespace, demand, leader, port = 9091, tls}) {
  const streams = new Map();
  const server = new grpc.Server({'grpc.max_receive_message_length': 16384});
  const identify = ref => {
    leader.require();
    if(ref.namespace===namespace&&ref.scalerMetadata?.fleet==='true')return '@fleet';
    const name = ref.scalerMetadata?.database;
    if (ref.namespace !== namespace || !/^[a-z][a-z0-9-]{0,38}$/.test(name || '')) throw Error('Invalid scaler identity');
    return name;
  };
  const error = cause => ({code: grpc.status.UNAVAILABLE, message: 'Database demand temporarily unavailable'});
  server.addService(protocol.ExternalScaler.service, {
    IsActive: async (call, callback) => {try {callback(null, {result: await demand(identify(call.request))});} catch (cause) {callback(error(cause));}},
    GetMetricSpec: (call, callback) => {try {identify(call.request); callback(null, {metricSpecs: [{metricName: 'neon_database_demand', targetSize: '1', targetSizeFloat: 1}]});} catch (cause) {callback(error(cause));}},
    GetMetrics: async (call, callback) => {try {const active = await demand(identify(call.request.scaledObjectRef));
      callback(null, {metricValues: [{metricName: 'neon_database_demand', metricValue: active ? '1' : '0', metricValueFloat: active ? 1 : 0}]});} catch (cause) {callback(error(cause));}},
    StreamIsActive: async call => {
      let name;
      try {name = identify(call.request); call.write({result: await demand(name)});} catch (cause) {call.destroy(error(cause)); return;}
      const set = streams.get(name) || new Set(); set.add(call); streams.set(name, set);
      const remove = () => {set.delete(call); if (!set.size) streams.delete(name);}; call.on('cancelled', remove); call.on('error', remove);
    },
    StreamMetricSpec: call => call.destroy({code: grpc.status.UNIMPLEMENTED, message: 'Fixed demand metric'})
  });
  const credentials = tls ? grpc.ServerCredentials.createSsl(fs.readFileSync(tls.ca), [{private_key: fs.readFileSync(tls.key), cert_chain: fs.readFileSync(tls.cert)}], true)
    : grpc.ServerCredentials.createInsecure();
  if (!tls && process.env.NODE_ENV !== 'test') throw Error('KEDA scaler requires mutual TLS');
  const bound = await new Promise((resolve, reject) => server.bindAsync('0.0.0.0:' + port, credentials, (error, bound) => error ? reject(error) : resolve(bound)));
  return {port: bound, publish(name, active) {if (leader.active) for (const call of streams.get(name) || []) call.write({result: active});},
    close() {server.forceShutdown();}};
}
