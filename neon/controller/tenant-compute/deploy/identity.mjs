import https from 'node:https';
import fs from 'node:fs';
import {createPublicKey, verify} from 'node:crypto';
import {rootCertificates} from 'node:tls';

export const identityError = (code, status = 401) => Object.assign(Error(code), {code, status});
export function httpsURL(value, allowQuery = false) {
  const url = new URL(value);
  if (url.protocol !== 'https:' || url.username || url.password || url.hash || !allowQuery && url.search) throw Error('An HTTPS identity URL without credentials or fragment is required');
  return url;
}
const roles = ['fleet-admin', 'database-operator', 'backup-operator', 'viewer'];
export function identityConfiguration(value) {
  if (value === undefined) return null;
  if (!value || typeof value !== 'object') throw Error('Invalid identity configuration');
  if (Object.keys(value).some(key => !['issuer', 'jwksUrl', 'caSecretRef', 'algorithms', 'groupsClaim', 'tenantClaim', 'projectClaim', 'management', 'database'].includes(key))) throw Error('Unsupported identity field');
  httpsURL(value.issuer); if (value.jwksUrl) httpsURL(value.jwksUrl, true);
  for (const kind of ['management', 'database']) {
    const config = value[kind];
    if (!config || typeof config.audience !== 'string' || !config.audience || !Array.isArray(config.roleBindings) || config.roleBindings.length > 100) throw Error('Identity audience and role bindings are required');
    for (const binding of config.roleBindings) {
      if (Object.keys(binding).some(key => !['group', kind === 'management' ? 'role' : 'postgresRole'].includes(key))) throw Error('Unsupported role binding field');
      if (typeof binding.group !== 'string' || !binding.group || binding.group.length > 200) throw Error('Explicit identity group required');
      if (kind === 'management' ? !roles.includes(binding.role) : !/^[a-z][a-z0-9_]{0,62}$/.test(binding.postgresRole || '') || ['postgres', 'cloud_admin', 'neon_lifecycle'].includes(binding.postgresRole)) throw Error('Invalid identity role binding');
    }
    const flags = kind === 'management' ? ['allowStaticToken'] : ['allowPasswordAuth', 'requireTenantProjectBinding'];
    if (Object.keys(config).some(key => !['audience', 'roleBindings', ...(kind === 'database' ? ['managedRole'] : []), ...flags].includes(key)) || flags.some(key => config[key] !== undefined && typeof config[key] !== 'boolean')) throw Error('Invalid identity access policy');
    if (config.managedRole !== undefined && !/^[a-z][a-z0-9_]{0,62}$/.test(config.managedRole)) throw Error('Invalid managed data role');
  }
  if (value.management.audience === value.database.audience) throw Error('Management and database audiences must differ');
  if (value.database.requireTenantProjectBinding !== true) throw Error('Database identity requires tenant/project binding');
  for (const key of ['groupsClaim', 'tenantClaim', 'projectClaim']) if (value[key] !== undefined && !/^[a-zA-Z][a-zA-Z0-9_]{0,63}$/.test(value[key])) throw Error('Invalid claim name');
  if (value.algorithms && (!Array.isArray(value.algorithms) || !value.algorithms.length || value.algorithms.some(alg => !['RS256', 'ES256', 'EdDSA'].includes(alg)))) throw Error('Unsupported signing algorithms');
  return value;
}
export function authorizationRole(method, path) {
  if (method === 'GET') return roles;
  if (path === '/v1/fleet' || method === 'DELETE' && !path.startsWith('/v1/backups/')) return ['fleet-admin'];
  if (path.startsWith('/v1/backups/') || path.endsWith('/backups')) return ['fleet-admin', 'backup-operator'];
  return ['fleet-admin', 'database-operator'];
}
export function getJSON(url, caFile) {
  return new Promise((resolve, reject) => {
    const request = https.get(httpsURL(url, true), {timeout: 5000,
      ...(caFile ? {ca: [...rootCertificates, fs.readFileSync(caFile, 'utf8')]} : {})}, response => {
      if (response.statusCode !== 200) {response.resume(); return reject(identityError('OIDC_KEYS_UNAVAILABLE', 503));}
      const chunks = []; let size = 0;
      response.on('data', chunk => {size += chunk.length; if (size > 262144) response.destroy(Error('Identity response limit')); else chunks.push(chunk);});
      response.on('error', reject); response.on('end', () => {try {resolve(JSON.parse(Buffer.concat(chunks)));} catch {reject(identityError('OIDC_KEYS_UNAVAILABLE', 503));}});
    });
    request.on('timeout', () => request.destroy(Error('Identity request timeout'))); request.on('error', () => reject(identityError('OIDC_KEYS_UNAVAILABLE', 503)));
  });
}
export class Identity {
  constructor({configuration, fetchJSON = getJSON, clock = () => Date.now()}) {Object.assign(this, {configuration, fetchJSON, clock}); this.cache = null; this.loading = null;}
  async keys(config, force = false) {
    const key = JSON.stringify([config.issuer, config.jwksUrl, config.caSecretRef]);
    if (this.cache?.key === key && this.clock() - this.cache.at < (force ? 5000 : 300000)) return this.cache.keys;
    if (this.loading) {await this.loading; if (this.cache?.key === key) return this.cache.keys;}
    const task = (async () => {
      let url = config.jwksUrl;
      const ca = config.caSecretRef ? '/run/oidc-ca/ca.crt' : undefined;
      if (!url) {
        const discovery = await this.fetchJSON(config.issuer.replace(/\/$/, '') + '/.well-known/openid-configuration', ca);
        if (discovery.issuer !== config.issuer) throw identityError('OIDC_ISSUER_MISMATCH');
        url = discovery.jwks_uri; httpsURL(url, true);
      }
      const body = await this.fetchJSON(url, ca);
      if (!Array.isArray(body.keys) || body.keys.length > 100 || !body.keys.length) throw identityError('OIDC_KEYS_UNAVAILABLE', 503);
      const keys = body.keys.filter(jwk => ['RSA', 'EC', 'OKP'].includes(jwk.kty) && (!jwk.use || jwk.use === 'sig') && (!jwk.key_ops || jwk.key_ops.includes('verify')));
      this.cache = {key, keys, at: this.clock()}; return keys;
    })();
    this.loading = task;
    try {return await task;} finally {if (this.loading === task) this.loading = null;}
  }
  async authenticate(request, kind) {
    const config = identityConfiguration(this.configuration());
    if (!config) throw identityError('OIDC_NOT_CONFIGURED');
    const token = /^Bearer ([A-Za-z0-9_.-]+)$/.exec(request.headers.authorization || '')?.[1];
    if (!token || token.length > 12288) throw identityError('OIDC_TOKEN_REQUIRED');
    const parts = token.split('.'); if (parts.length !== 3 || parts.some(part => !/^[A-Za-z0-9_-]+$/.test(part))) throw identityError('OIDC_TOKEN_INVALID');
    let header, claims;
    try {header = JSON.parse(Buffer.from(parts[0], 'base64url')); claims = JSON.parse(Buffer.from(parts[1], 'base64url'));} catch {throw identityError('OIDC_TOKEN_INVALID');}
    if (!header || !claims || !['JWT', 'at+jwt', undefined].includes(header.typ) || header.crit || !header.kid || !(config.algorithms || ['RS256']).includes(header.alg)) throw identityError('OIDC_TOKEN_INVALID');
    let keys = await this.keys(config);
    if (!keys.some(key => key.kid === header.kid)) keys = await this.keys(config, true);
    const matches = keys.filter(key => key.kid === header.kid && (!key.alg || key.alg === header.alg));
    if (matches.length !== 1) throw identityError('OIDC_TOKEN_INVALID');
    const jwk = matches[0];
    if (header.alg === 'RS256' && jwk.kty !== 'RSA' || header.alg === 'ES256' && (jwk.kty !== 'EC' || jwk.crv !== 'P-256') || header.alg === 'EdDSA' && (jwk.kty !== 'OKP' || jwk.crv !== 'Ed25519')) throw identityError('OIDC_TOKEN_INVALID');
    let valid = false;
    try {
      const key = createPublicKey({key: jwk, format: 'jwk'});
      if (key.asymmetricKeyType === 'rsa' && key.asymmetricKeyDetails.modulusLength < 2048) throw Error('Weak RSA key');
      valid = verify(header.alg === 'EdDSA' ? null : 'sha256', Buffer.from(parts[0] + '.' + parts[1]), {key, ...(header.alg === 'ES256' ? {dsaEncoding: 'ieee-p1363'} : {})}, Buffer.from(parts[2], 'base64url'));
    } catch {throw identityError('OIDC_TOKEN_INVALID');}
    const now = Math.floor(this.clock() / 1000), audiences = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
    if (!valid || claims.iss !== config.issuer || !audiences.includes(config[kind].audience) || !Number.isSafeInteger(claims.exp) || claims.exp <= now ||
        claims.nbf !== undefined && (!Number.isSafeInteger(claims.nbf) || claims.nbf > now + 30) || typeof claims.sub !== 'string' || !claims.sub || claims.sub.length > 256) throw identityError('OIDC_TOKEN_INVALID');
    const groups = claims[config.groupsClaim || 'groups'];
    const bindings = config[kind].roleBindings.filter(binding => Array.isArray(groups) && groups.includes(binding.group));
    if (!bindings.length) throw identityError('OIDC_ACCESS_DENIED', 403);
    return {subject: claims.sub, issuer: claims.iss, expires: claims.exp, claims, config, bindings};
  }
  async management(request) {
    const actor = await this.authenticate(request, 'management');
    if (!actor.bindings.some(binding => authorizationRole(request.method, request.url).includes(binding.role))) throw identityError('OIDC_ACCESS_DENIED', 403);
    return actor;
  }
  async database(request, resource, role) {
    const actor = await this.authenticate(request, 'database'), binding = resource.spec.identity;
    if (!binding || actor.claims[actor.config.tenantClaim || 'tenant'] !== binding.tenant || actor.claims[actor.config.projectClaim || 'project'] !== binding.project ||
        !actor.bindings.some(binding => binding.postgresRole === role)) throw identityError('OIDC_ACCESS_DENIED', 403);
    return actor;
  }
}
