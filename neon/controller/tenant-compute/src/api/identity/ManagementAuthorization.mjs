import {randomUUID} from 'node:crypto';

/**
 * @typedef {Object} ManagementAuthorizationDependencies
 * @property {() => ReturnType<import('../../domain/identity/IdentityPolicy.mjs').IdentityConfiguration>} configuration - Current identity policy.
 * @property {import('../../infrastructure/identity/Identity.mjs').Identity} identity - OIDC verification and management authorization.
 * @property {(request: import('node:http').IncomingMessage) => boolean} authenticateStatic - Verify the explicitly configured break-glass credential.
 * @property {(event: string, fact: ManagementAuditFact) => void} emit - Append an audit fact to the configured log sink.
 */
/**
 * @typedef {Object} ManagementAuditFact
 * @property {string} operationId - Server-generated request correlation.
 * @property {string} method - HTTP operation.
 * @property {string} path - Resource path without query values.
 * @property {string} [subject] - Verified subject or shared break-glass principal.
 * @property {string} [issuer] - Verified issuer or local static-token authority.
 * @property {string} [authentication] - Authentication method.
 * @property {number} [status] - HTTP result.
 * @property {string} outcome - Accepted, completed, rejected or disconnected.
 */

/** Authenticate management requests and correlate their actual HTTP outcomes. */
export class ManagementAuthorization {
  #configuration;
  #identity;
  #authenticateStatic;
  #emit;
  /** @param {ManagementAuthorizationDependencies} dependencies - Explicit authentication and audit ports. */
  constructor({configuration, identity, authenticateStatic, emit}) {
    this.#configuration = configuration; this.#identity = identity; this.#authenticateStatic = authenticateStatic; this.#emit = emit;
  }

  /**
   * Resolve a verified management principal without performing application commands.
   * @param {import('node:http').IncomingMessage} request - Incoming authorization header and route.
   * @returns {Promise<{subject: string, issuer: string, authentication: string}>} Verified principal.
   * @throws {Error} On authentication or management RBAC failure.
   */
  async #principal(request) {
    const config = this.#configuration();
    if ((!config || config.management.allowStaticToken === true) && this.#authenticateStatic(request)) {
      return {subject: 'break-glass', issuer: 'local-controller', authentication: 'static-token'};
    }
    if (!config) throw Object.assign(Error('Unauthorized'), {code: 'UNAUTHORIZED', status: 401});
    const actor = await this.#identity.management(request);
    return {subject: actor.subject, issuer: actor.issuer, authentication: 'oidc'};
  }

  /**
   * Require a principal and register exactly one completion/disconnect audit fact.
   * Enforces configured management authorization; side effects attach outcome listeners and emit verified actor or rejection audit facts.
   * A 202 result records acceptance, not completion of asynchronous provisioning.
   * @param {import('node:http').IncomingMessage} request - Incoming management request.
   * @param {import('node:http').ServerResponse} response - Actual HTTP outcome boundary.
   * @returns {Promise<void>} Resolves only after authorization succeeds.
   * @throws {Error} On authentication failure; no application command is executed.
   */
  async Require(request, response) {
    const operation = {operationId: randomUUID(), method: request.method, path: request.url.split('?')[0]};
    let actor;
    try {actor = await this.#principal(request);}
    catch (error) {
      this.#emit('management_request_rejected', {...operation, outcome: 'rejected', status: error.status || 503});
      throw error;
    }
    const finish = () => {
      let outcome = 'completed';
      if (response.statusCode === 202) outcome = 'accepted';
      if (response.statusCode >= 400) outcome = 'rejected';
      this.#emit('management_request_finished', {...operation, ...actor, status: response.statusCode, outcome});
    };
    response.once('finish', finish);
    response.once('close', () => {
      if (!response.writableFinished) this.#emit('management_request_disconnected', {...operation, ...actor, outcome: 'disconnected'});
    });
  }
}
