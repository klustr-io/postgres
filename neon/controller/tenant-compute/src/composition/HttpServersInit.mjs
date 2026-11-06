import fs from 'node:fs';
import http from 'node:http';
import https from 'node:https';
/**
 * @typedef {Object} ControllerTlsIdentity
 * @property {string} keyFile - Projected server private key path.
 * @property {string} certFile - Projected server certificate path.
 * @property {string} [caFile] - Deployment CA for endpoint client certificate verification.
 */
/**
 * @typedef {Object} HttpServersDependencies
 * @property {ControllerTlsIdentity} tls - Projected TLS server and optional compute client trust.
 * @property {(request: import('node:http').IncomingMessage, response: import('node:http').ServerResponse) => Promise<void>} handleController - Controller router callback.
 * @property {(request: import('node:http').IncomingMessage, response: import('node:http').ServerResponse) => Promise<void>} handleHealth - Health and storage-hook callback.
 */
/**
 * @typedef {Object} ControllerHttpServers
 * @property {import('node:https').Server} server - TLS controller server, not yet listening.
 * @property {import('node:http').Server} health - Health and notification server, not yet listening.
 */
/**
 * Construct HTTP servers with explicit TLS identity and transport limits.
 * Request handling and application policy remain in injected callbacks.
 * @param {HttpServersDependencies} dependencies - TLS identity and controller/health adapters.
 * @returns {ControllerHttpServers} Servers owned by process lifecycle composition.
 */
export function HttpServersInit({tls, handleController, handleHealth}) {
  const server = https.createServer({key: fs.readFileSync(tls.keyFile), cert: fs.readFileSync(tls.certFile),
    ...(tls.caFile ? {ca: fs.readFileSync(tls.caFile), requestCert: true, rejectUnauthorized: false} : {}),
    minVersion: 'TLSv1.2', maxHeaderSize: 8192}, handleController);
  server.requestTimeout = 10000; server.headersTimeout = 5000; server.keepAliveTimeout = 5000;
  server.maxConnections = 256; server.maxRequestsPerSocket = 1000;
  const health = http.createServer(handleHealth);
  health.requestTimeout = 10000; health.headersTimeout = 5000; health.maxConnections = 256;
  return {server, health};
}
