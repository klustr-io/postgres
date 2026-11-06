import https from 'node:https';
import fs from 'node:fs';
import {rootCertificates} from 'node:tls';
import {IdentityError} from '../../domain/identity/IdentityPolicy.mjs';
import {TokenValidationPolicy} from '../../domain/identity/TokenValidationPolicy.mjs';
/**
 * @typedef {Object} IntrospectionDependencies
 * @property {(kind: 'management' | 'database') => string} [readSecret] - Fresh projected credential read port.
 * @property {(config: import('../../domain/identity/IdentityPolicy.mjs').IdentityConfigurationValue) => string | undefined} [caForConfig] - Fixed provider CA file resolver.
 */
const ReadSecret = kind => fs.readFileSync(`/run/oidc-introspection/${kind}/client-secret`, 'utf8');
const CaFile = config => config.caSecretRef ? '/run/oidc-ca/ca.crt' : undefined;
const FormValue = value => new URLSearchParams({value}).toString().slice(6);
function RequestBody(token, policy, secret) {
  const body = new URLSearchParams({token, token_type_hint: 'access_token'});
  const headers = {Accept: 'application/json', 'Content-Type': 'application/x-www-form-urlencoded'};
  if (policy.authMethod === 'client_secret_post') {body.set('client_id', policy.clientId); body.set('client_secret', secret);}
  else headers.Authorization = 'Basic '+Buffer.from(FormValue(policy.clientId)+':'+FormValue(secret)).toString('base64');
  return {body: body.toString(), headers};
}
function ReadResponse(response, resolve, reject) {
  if (response.statusCode !== 200) {response.resume(); reject(IdentityError('OIDC_INTROSPECTION_UNAVAILABLE', 503)); return;}
  const chunks = []; let size = 0;
  response.on('data', chunk => {size += chunk.length; if (size > 262144) response.destroy(); else chunks.push(chunk);});
  response.on('error', () => reject(IdentityError('OIDC_INTROSPECTION_UNAVAILABLE', 503)));
  response.on('aborted', () => reject(IdentityError('OIDC_INTROSPECTION_UNAVAILABLE', 503)));
  response.on('end', () => {
    try {
      const result = JSON.parse(Buffer.concat(chunks));
      if (!result || typeof result !== 'object' || Array.isArray(result)) throw Error('Invalid response');
      resolve(result);
    } catch {reject(IdentityError('OIDC_INTROSPECTION_UNAVAILABLE', 503));}
  });
}
/**
 * Ask the fixed authorization server about an opaque or structured access token.
 * Requires provider-configured introspection authority; side effects send one authenticated HTTPS POST, never persist or log tokens.
 * Credentials are read afresh, responses are not cached, and redirects are not followed.
 * @param {string} token - Bounded opaque bearer token.
 * @param {import('../../domain/identity/IdentityPolicy.mjs').IdentityConfigurationValue} config - Validated issuer and audience policy.
 * @param {'management' | 'database'} kind - Intended resource boundary.
 * @param {IntrospectionDependencies} [dependencies] - Credential and CA read ports.
 * @returns {Promise<Record<string, unknown>>} Untrusted introspection metadata, still requiring active/claims/resource authorization.
 * @throws {Error} OIDC_INTROSPECTION_UNAVAILABLE for credentials, TLS, timeout, HTTP or malformed-response failures.
 */
export async function IntrospectAccessToken(token, config, kind, {readSecret = ReadSecret, caForConfig = CaFile} = {}) {
  try {
    if (!['management', 'database'].includes(kind)) throw Error('Invalid introspection boundary');
    const policy = TokenValidationPolicy(config[kind].tokenValidation), secret = readSecret(kind), caFile = caForConfig(config);
    if (policy.mode !== 'introspection' || typeof secret !== 'string' || !secret || secret.length > 4096) throw Error('Introspection credentials unavailable');
    const {body, headers} = RequestBody(token, policy, secret);
    return await new Promise((resolve, reject) => {
      const request = https.request(policy.endpoint, {method: 'POST', headers: {...headers, 'Content-Length': Buffer.byteLength(body)},
        signal: AbortSignal.timeout(3000), ...(caFile ? {ca: [...rootCertificates, fs.readFileSync(caFile, 'utf8')]} : {})},
      response => ReadResponse(response, resolve, reject));
      request.on('error', () => reject(IdentityError('OIDC_INTROSPECTION_UNAVAILABLE', 503))); request.end(body);
    });
  } catch {throw IdentityError('OIDC_INTROSPECTION_UNAVAILABLE', 503);}
}
