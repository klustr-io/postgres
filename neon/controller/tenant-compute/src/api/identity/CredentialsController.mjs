import {ReadJson, SendJson} from '../http/HttpJson.mjs';
/**
 * @typedef {Object} CredentialsControllerDependencies
 * @property {import('../../application/identity/DatabaseCredentials.mjs').DatabaseCredentials['exchange']} exchange - OIDC database credential command.
 */
/** Adapt database token exchange without handling SQL or wake sequencing. */
export class CredentialsController {
  #exchange;
  /** @param {CredentialsControllerDependencies} dependencies - Database identity command port. */
  constructor({exchange}) {this.#exchange = exchange;}
  /**
   * Validate transport shape and exchange the database audience token.
   * Requires token authorization for the database and mapped SQL role; side effects wake dependencies and create expiring login roles/Secrets.
   * @param {import('node:http').IncomingMessage} request - Database access-token request.
   * @param {import('node:http').ServerResponse} response - Secret-bearing no-store response.
   * @param {import('../database/DatabaseController.mjs').DatabaseRouteParameters} parameters - Database name.
   * @returns {Promise<void>} Sends the expiring SQL credential once.
   * @throws {Error} On invalid roles/tokens, unsafe grants, retiring resources or dependency failure.
   */
  async Exchange(request, response, {name}) {
    const input = await ReadJson(request);
    if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).some(key => key !== 'role')) {
      throw Object.assign(Error('Invalid role request'), {code: 'INVALID_ROLE', status: 422});
    }
    SendJson(response, 201, await this.#exchange(request, name, input));
  }
}

/**
 * Bind token exchange to its database-audience authentication boundary.
 * @param {CredentialsController} controller - Database credential HTTP adapter.
 * @returns {import('../http/ControlPlaneRouter.mjs').ControlPlaneRoute[]} Credential route registry.
 */
export function CredentialsRoutes(controller) {
  return [{pattern: /^\/v1\/databases\/(?<name>[a-z][a-z0-9-]{0,38})\/credentials$/, authentication: 'database', methods: {POST: controller.Exchange.bind(controller)}}];
}
