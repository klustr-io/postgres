import {isIP} from 'node:net';
import {createHash} from 'node:crypto';
import {SuspendPolicy as policy} from './Activity.mjs';
const dns=value=>typeof value==='string'&&/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(value);
/**
 * @typedef {Object} EndpointDefinition
 * @property {import('../database/DatabaseContracts.mjs').ResourceIdentity} metadata - ConfigMap identity.
 * @property {Record<string, string>} data - Serialized endpoint definition and status.
 */
/**
 * @typedef {Object} EndpointSpecification
 * @property {string} endpointId - DNS-safe endpoint identifier beginning with ep-.
 * @property {string} image - Provider-authorized digest-pinned compute image.
 * @property {string} nodeName - Explicit single-writer worker placement.
 * @property {'durable' | 'bounded-async'} profile - Commit durability configuration.
 * @property {string} projectId - Bounded project identity used in metrics.
 * @property {string} branchId - Bounded branch identity used in metrics.
 * @property {string} computeSpecSecret - Secret containing the native compute specification.
 * @property {string} adminSecret - Lifecycle SQL credentials Secret.
 * @property {string} rolesSecret - Proxy SCRAM verifier Secret.
 * @property {string} tlsSecret - Compute server certificate Secret.
 * @property {string} caSecret - Trusted compute certificate authority Secret.
 * @property {string[]} allowedIps - Explicit client IP or CIDR allowlist.
 * @property {import('./Activity.mjs').ComputeSuspendPolicy} suspend - Normalized idle policy.
 * @property {Record<string, import('./Activity.mjs').ComputeSuspendPolicy>} [databasePolicies] - Per-database idle overrides.
 * @property {import('../database/DatabaseCatalog.mjs').ComputeResourceBudget} [resources] - Compute resource budget.
 * @property {import('../identity/ComputeOAuth.mjs').ComputeOAuthSettings} [oauth] - Provider-derived native OAuth configuration.
 * @property {string} [specRevision] - Provisioned compute specification revision.
 * @property {string} [databaseResource] - Owning managed NeonDatabase name, absent for standalone endpoints.
 */
/**
 * @typedef {Object} EndpointObservation
 * @property {string} name - Source ConfigMap name.
 * @property {string} [uid] - Immutable ConfigMap identity when persisted.
 * @property {string} revision - Hash of the entire normalized endpoint policy.
 * @property {string} computeRevision - Hash of fields requiring a compute replacement.
 * @property {Record<string, unknown>} status - Persisted controller observation decoded from status.json.
 */
/** @typedef {EndpointSpecification & EndpointObservation} ComputeEndpoint */
/**
 * @typedef {Object} EncodedSecret
 * @property {Record<string, string>} [data] - Base64-encoded Kubernetes Secret entries.
 */
/**
 * @typedef {Object} NativeComputeRole
 * @property {string} name - SQL role name in the native compute specification.
 * @property {string | null} [encrypted_password] - SCRAM verifier when configured.
 * @property {string[]} [options] - Native compute_ctl role options.
 */
/**
 * @typedef {Object} NativeComputeCluster
 * @property {NativeComputeRole[]} roles - Roles managed by compute_ctl.
 * @property {import('../database/DatabaseCatalog.mjs').PostgresSetting[]} [settings] - Native PostgreSQL settings.
 */
/**
 * @typedef {Object} NativeComputeSpec
 * @property {string} [mode] - Native compute mode; only Primary is supported here.
 * @property {string} tenant_id - Native storage tenant identity.
 * @property {string} timeline_id - Native writable timeline identity.
 * @property {string[]} safekeeper_connstrings - Authenticated WAL quorum addresses.
 * @property {string} storage_auth_token - Storage bearer credential; never log this specification.
 * @property {NativeComputeCluster} cluster - SQL roles and configuration consumed by compute_ctl.
 * @property {number} [suspend_timeout_seconds] - Native idle actor disabled by rendering.
 */
/**
 * Validate an endpoint ConfigMap and derive policy/replacement revision hashes.
 * The owning application boundary authorizes the repository read; this parser has no external side effects.
 * Normalizes only its freshly decoded JSON, leaving the supplied resource unchanged.
 * @param {EndpointDefinition} resource - Serialized endpoint definition and observation.
 * @returns {ComputeEndpoint} Validated definition with independent policy and compute revisions.
 * @throws {Error} When JSON, identity, placement, resource limits, idle policy or network allowlists are invalid.
 */
export function EndpointConfig(resource){
  const config=JSON.parse(resource.data?.['endpoint.json']||'null');
  ValidateEndpointIdentity(resource,config);
  ValidateComputePlacement(config);
  if(config.resources)ValidateComputeResources(config.resources);
  config.suspend=policy(config.suspend,config.idleSeconds??300);
  NormalizeDatabasePolicies(config);
  ValidateAllowedNetworks(config.allowedIps);
  for(const key of ['projectId','branchId'])if(typeof config[key]!=='string'||config[key].length>128||!config[key])throw Error('Missing metric identity');
  const revision=createHash('sha256').update(JSON.stringify(config)).digest('hex');
  const computeRevision=createHash('sha256').update(JSON.stringify(Object.fromEntries(
    ['computeSpecSecret','adminSecret','tlsSecret','caSecret','nodeName','image','profile','resources','specRevision','oauth'].map(key=>[key,config[key]])))).digest('hex');
  return {...config,name:resource.metadata.name,uid:resource.metadata.uid,revision,computeRevision,
    status:JSON.parse(resource.data?.['status.json']||'{}')};
}
function ValidateEndpointIdentity(resource,config){
  if(!config||!dns(config.endpointId)||!config.endpointId.startsWith('ep-'))throw Error('Invalid endpoint ID');
  if(resource.metadata.name!=='neon-'+config.endpointId)throw Error('Endpoint ConfigMap name mismatch');
  for(const key of ['computeSpecSecret','adminSecret','rolesSecret','tlsSecret','caSecret'])
    if(!dns(config[key]))throw Error('Missing endpoint Secret reference');
}
function ValidateComputePlacement(config){
  if(typeof config.image!=='string'||!/^[-a-zA-Z0-9./:]+@sha256:[a-f0-9]{64}$/.test(config.image))throw Error('Compute image must be digest-pinned');
  if(typeof config.nodeName!=='string'||!/^[a-z0-9][a-z0-9.-]{0,252}$/.test(config.nodeName))throw Error('Explicit compute worker placement is required');
  if(!['durable','bounded-async'].includes(config.profile))throw Error('Invalid commit profile');
}
function ValidateComputeResources(resources){
  if(typeof resources!=='object'||Array.isArray(resources))throw Error('Invalid compute resources');
  for(const section of ['requests','limits']){
    for(const [key,value] of Object.entries(resources[section]||{}))ValidateResourceQuantity(key,value);
  }
  if(resources.dockerCpus!==undefined&&(!Number.isFinite(resources.dockerCpus)||resources.dockerCpus<=0))throw Error('Invalid Docker CPU budget');
  if(resources.dockerMemoryBytes!==undefined&&(!Number.isSafeInteger(resources.dockerMemoryBytes)||resources.dockerMemoryBytes<536870912))throw Error('Invalid Docker memory budget');
}
function ValidateResourceQuantity(key,value){
  if(!['cpu','memory','ephemeral-storage'].includes(key)||typeof value!=='string'||!/^([0-9]+(?:\.[0-9]+)?)(?:m|Ki|Mi|Gi|Ti)?$/.test(value))throw Error('Invalid compute resource quantity');
}
function NormalizeDatabasePolicies(config){
  for(const [name,value] of Object.entries(config.databasePolicies||{})){
    if(!name||Buffer.byteLength(name)>63||['template0','template1'].includes(name))throw Error('Invalid database policy name');
    config.databasePolicies[name]=policy(value,config.suspend.idleSeconds??300);
  }
}
function ValidateAllowedNetworks(allowedIps){
  if(!Array.isArray(allowedIps)||!allowedIps.length||allowedIps.length>100)throw Error('Explicit client IP allowlist required');
  for(const entry of allowedIps){
    if(typeof entry!=='string')throw Error('Invalid client CIDR');
    const [ip,prefix,...rest]=entry.split('/'),family=isIP(ip);
    if(!family||rest.length||prefix!==undefined&&(!/^\d+$/.test(prefix)||Number(prefix)>(family===4?32:128)))throw Error('Invalid client CIDR');
  }
}
/**
 * Decode a required bounded UTF-8 Kubernetes Secret value for an authorized internal consumer.
 * Read permission belongs to the owning application boundary; decoding has no mutation or network side effects.
 * @param {EncodedSecret} secret - Secret envelope already obtained from the trusted repository.
 * @param {string} key - Required Secret data entry.
 * @returns {string} Decoded sensitive text; callers must not log it.
 * @throws {Error} When the entry is absent or decoded text exceeds one MiB.
 */
export function SecretText(secret,key){
  if(!Object.hasOwn(secret.data||{},key))throw Error('Secret key missing');
  const value=Buffer.from(secret.data[key],'base64').toString('utf8');
  if(value.length>1024*1024)throw Error('Secret size limit');return value;
}
/**
 * Clone a primary compute specification and apply provider-owned durability, TLS and optional OAuth settings.
 * The owning application boundary authorizes endpoint policy; this renderer performs no I/O or SQL side effects.
 * Preserves unrelated specification fields and disables the competing native idle actor.
 * @param {NativeComputeSpec} input - Authenticated native specification, which remains unchanged.
 * @param {EndpointSpecification} endpoint - Provider-validated commit and authentication policy.
 * @returns {NativeComputeSpec} Independent specification containing sensitive storage credentials.
 * @throws {Error} When the compute is not Primary or lacks authenticated storage and cluster roles.
 */
export function RenderComputeSpec(input,endpoint){
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
  if(endpoint.oauth)Object.assign(settings,{oauth_validator_libraries:'klustr_oauth',hba_file:'/run/oauth/pg_hba.conf',
    'klustr_oauth.validator_url':endpoint.oauth.validatorUrl,'klustr_oauth.ca_file':'/run/oauth/ca.crt',
    'klustr_oauth.cert_file':'/run/oauth/validator.crt','klustr_oauth.key_file':'/run/oauth/validator.key',log_connections:'authorization'});
  spec.cluster.settings=(spec.cluster.settings||[]).filter(option=>!Object.hasOwn(settings,option.name));
  spec.cluster.settings.push(...Object.entries(settings).map(([name,value])=>({name,value,vartype:'string'})));
  spec.suspend_timeout_seconds=-1; // This controller owns suspension; no second idle actor.
  return spec;
}
