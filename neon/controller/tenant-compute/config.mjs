import {isIP} from 'node:net';
import {createHash} from 'node:crypto';
import {policy} from './activity.mjs';
const dns=value=>typeof value==='string'&&/^[a-z0-9][a-z0-9-]{0,48}$/.test(value);
export function endpointConfig(resource){
  const config=JSON.parse(resource.data?.['endpoint.json']||'null');
  if(!config||!dns(config.endpointId)||!config.endpointId.startsWith('ep-'))throw Error('Invalid endpoint ID');
  if(resource.metadata.name!=='neon-'+config.endpointId)throw Error('Endpoint ConfigMap name mismatch');
  for(const key of ['computeSpecSecret','adminSecret','rolesSecret','tlsSecret','caSecret'])
    if(!dns(config[key]))throw Error('Missing endpoint Secret reference');
  if(typeof config.image!=='string'||!/^[-a-zA-Z0-9./:]+@sha256:[a-f0-9]{64}$/.test(config.image))throw Error('Compute image must be digest-pinned');
  if(typeof config.nodeName!=='string'||!/^[a-z0-9][a-z0-9.-]{0,252}$/.test(config.nodeName))throw Error('Explicit compute worker placement is required');
  if(!['durable','bounded-async'].includes(config.profile))throw Error('Invalid commit profile');
  config.suspend=policy(config.suspend,config.idleSeconds??300);
  for(const [name,value] of Object.entries(config.databasePolicies||{})){
    if(!name||Buffer.byteLength(name)>63||['template0','template1'].includes(name))throw Error('Invalid database policy name');
    config.databasePolicies[name]=policy(value,config.suspend.idleSeconds??300);
  }
  if(!Array.isArray(config.allowedIps)||!config.allowedIps.length||config.allowedIps.length>100)throw Error('Explicit client IP allowlist required');
  for(const entry of config.allowedIps){
    if(typeof entry!=='string')throw Error('Invalid client CIDR');
    const [ip,prefix,...rest]=entry.split('/'),family=isIP(ip);
    if(!family||rest.length||prefix!==undefined&&(!/^\d+$/.test(prefix)||Number(prefix)>(family===4?32:128)))throw Error('Invalid client CIDR');
  }
  for(const key of ['projectId','branchId'])if(typeof config[key]!=='string'||config[key].length>128||!config[key])throw Error('Missing metric identity');
  const revision=createHash('sha256').update(JSON.stringify(config)).digest('hex');
  const computeRevision=createHash('sha256').update(JSON.stringify(Object.fromEntries(
    ['computeSpecSecret','adminSecret','tlsSecret','caSecret','nodeName','image','profile'].map(key=>[key,config[key]])))).digest('hex');
  return {...config,name:resource.metadata.name,uid:resource.metadata.uid,revision,computeRevision,
    status:JSON.parse(resource.data?.['status.json']||'{}')};
}
export function secretText(secret,key){
  if(!Object.hasOwn(secret.data||{},key))throw Error('Secret key missing');
  const value=Buffer.from(secret.data[key],'base64').toString('utf8');
  if(value.length>1024*1024)throw Error('Secret size limit');return value;
}
export function renderSpec(input,endpoint){
  const spec=structuredClone(input);
  if(spec.mode&&spec.mode!=='Primary')throw Error('Only primary compute is supported');
  if(!spec.tenant_id||!spec.timeline_id||!spec.safekeeper_connstrings?.length||!spec.storage_auth_token)throw Error('Incomplete authenticated storage spec');
  if(!spec.cluster||!Array.isArray(spec.cluster.roles))throw Error('Incomplete compute cluster spec');
  // Built-in upstream compute configuration; application SQL remains untouched.
  const settings={listen_addresses:'*',port:'5432',ssl:'on',ssl_cert_file:'/run/compute-tls/tls.crt',
    ssl_key_file:'/run/compute-tls/tls.key',full_page_writes:'on',wal_compression:'zstd',
    fsync:endpoint.profile==='durable'?'on':'off',synchronous_commit:endpoint.profile==='durable'?'on':'off',
    'neon.bounded_async_commit':'on','neon.bounded_async_max_age':'750ms','neon.bounded_async_max_wal':'64MB',
    'neon.file_cache_path':'/var/lib/neon/lfc.cache'};
  spec.cluster.settings=(spec.cluster.settings||[]).filter(option=>!Object.hasOwn(settings,option.name));
  spec.cluster.settings.push(...Object.entries(settings).map(([name,value])=>({name,value,vartype:'string'})));
  spec.suspend_timeout_seconds=-1; // This controller owns suspension; no second idle actor.
  return spec;
}
