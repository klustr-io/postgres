import {SendJson} from './HttpJson.mjs';
/**
 * @typedef {Object} ControlPlaneRoute
 * @property {RegExp} pattern - Fixed route pattern with named resource parameters.
 * @property {boolean} [query] - Whether route matching uses only the URL pathname.
 * @property {'management' | 'proxy' | 'proxy-command' | 'database' | 'compute'} authentication - Authentication boundary.
 * @property {Record<string, (request: import('node:http').IncomingMessage, response: import('node:http').ServerResponse, parameters: import('../database/DatabaseController.mjs').DatabaseRouteParameters) => Promise<void>>} methods - Named controller operations.
 */
/**
 * @typedef {Object} ControlPlaneRouterDependencies
 * @property {ControlPlaneRoute[]} routes - Explicit controller route registry.
 * @property {import('../identity/ManagementAuthorization.mjs').ManagementAuthorization | null} management - Management authorization middleware.
 * @property {(request: import('node:http').IncomingMessage) => void} authorizeProxy - Proxy token assertion.
 * @property {() => void} requireLeader - Lease assertion before application commands.
 * @property {() => boolean} stopping - Whether new requests must be rejected.
 * @property {(reason: string) => void} unavailable - Record unexpected request failures without sensitive data.
 */
/**
 * @typedef {Error & {status?: number, code?: string, publicMessage?: string}} ControlPlaneError
 */
const ConflictCodes = new Set(['FLEET_RETIRED', 'FLEET_OWNERSHIP_CONFLICT', 'DATABASE_SUSPENDED', 'DATABASE_RETIRED',
  'PURGE_CONFIRMATION_REQUIRED', 'DEPENDENT_BRANCHES_OR_BACKUPS', 'IMMUTABLE_BRANCH_SOURCE', 'BACKUP_NAME_CONFLICT', 'SOURCE_NOT_READY']);

/** HTTP dispatch, transport admission, authentication middleware and error presentation. */
export class ControlPlaneRouter {
  #routes; #management; #authorizeProxy; #requireLeader; #stopping; #unavailable; #inFlight = 0;
  /** @param {ControlPlaneRouterDependencies} dependencies - Explicit routes and transport middleware. */
  constructor({routes, management, authorizeProxy, requireLeader, stopping, unavailable}) {
    this.#routes = routes; this.#management = management; this.#authorizeProxy = authorizeProxy;
    this.#requireLeader = requireLeader; this.#stopping = stopping; this.#unavailable = unavailable;
  }
  /**
   * Dispatch one bounded request through its declared authentication boundary.
   * Enforces each route's authorization before commands; side effects delegate to the selected operation and present its HTTP outcome.
   * @param {import('node:http').IncomingMessage} request - Incoming HTTP request.
   * @param {import('node:http').ServerResponse} response - JSON response boundary.
   * @returns {Promise<void>} Sends one controller result or a bounded error response.
   * @throws {Error} When the response transport cannot present the result; command rejections normally become HTTP errors.
   */
  async Handle(request, response) {
    if (this.#stopping() || this.#inFlight >= 32) return SendJson(response, 503, {error: 'Control plane busy'});
    this.#inFlight++;
    try {
      if (request.url.length > 4096) return SendJson(response, 414, {error: 'Request too large'});
      const selected = this.#select(request.url);
      if (!selected) return SendJson(response, 404, {error: 'Unknown API method'});
      await this.#authenticate(selected.route, request, response);
      const handle = selected.route.methods[request.method];
      if (!handle) return SendJson(response, 405, {error: 'Unsupported API operation'});
      this.#requireLeader();
      await handle(request, response, selected.parameters);
    } catch (error) {this.#presentError(response, error);}
    finally {this.#inFlight--;}
  }
  #select(target) {
    const pathname = new URL(target, 'https://control-plane.invalid').pathname;
    for (const route of this.#routes) {
      const match = route.pattern.exec(route.query ? pathname : target);
      if (match) return {route, parameters: match.groups || {}};
    }
    return null;
  }
  async #authenticate(route, request, response) {
    if (route.authentication === 'management') {await this.#management.Require(request, response); return;}
    if (route.authentication === 'proxy-command') {this.#authorizeProxy(request); return;}
    if (route.authentication !== 'proxy') return; // Database and compute verification belong to their commands.
    if (request.method !== 'GET' || request.headers['transfer-encoding'] || Number(request.headers['content-length'] || 0) !== 0) {
      throw Object.assign(Error('GET without request body required'), {status: 405, publicMessage: 'GET without request body required'});
    }
    this.#authorizeProxy(request);
  }
  #presentError(response, error) {
    if ([401, 403, 405, 409, 413, 414, 422, 429].includes(error.status)) return SendJson(response, error.status, {error: error.publicMessage || error.code || 'REQUEST_REJECTED'});
    if (error.status === 404) return SendJson(response, 404, {error: error.publicMessage || 'Resource not found'});
    if (error.code === 'INVALID_SPEC') return SendJson(response, 422, {error: error.code});
    if (ConflictCodes.has(error.code)) return SendJson(response, 409, {error: error.code});
    this.#unavailable(error.code || 'OPERATION_FAILED');
    SendJson(response, 503, {error: 'Endpoint temporarily unavailable', status: {code: 'UNAVAILABLE', message: 'Retry request',
      details: {error_info: {reason: 'RUNNING_OPERATIONS'}, retry_info: {retry_delay_ms: 250}}}});
  }
}
