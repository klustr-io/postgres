import {ReadJson, SendJson} from '../http/HttpJson.mjs';

/**
 * @typedef {Object} FleetControllerDependencies
 * @property {import('../../application/fleet/FleetConfiguration.mjs').FleetConfiguration} configuration - Fleet commands and queries.
 */
/** HTTP adapter for fleet configuration; authentication is route middleware. */
export class FleetController {
  #configuration;
  /** @param {FleetControllerDependencies} dependencies - Fleet application boundary. */
  constructor({configuration}) {this.#configuration = configuration;}

  /**
   * Present current fleet configuration to an authenticated operator.
   * Requires management read authorization; side effects read the established owner and write the HTTP view.
   * @param {import('node:http').IncomingMessage} request - Authorized HTTP request.
   * @param {import('node:http').ServerResponse} response - JSON response boundary.
   * @returns {Promise<void>} Sends the fleet view.
   * @throws {Error} On missing/conflicting owners, leadership loss or repository failure.
   */
  async Get(request, response) {SendJson(response, 200, await this.#configuration.Get());}

  /**
   * Submit replacement policy to the fleet command boundary.
   * Requires fleet-admin authorization; side effects persist a complete desired spec and return its accepted generation.
   * @param {import('node:http').IncomingMessage} request - Authorized JSON policy request.
   * @param {import('node:http').ServerResponse} response - JSON response boundary.
   * @returns {Promise<void>} Sends the accepted generation.
   * @throws {Error} On invalid policy, retirement, conflicting resource versions or persistence failure.
   */
  async Revise(request, response) {SendJson(response, 202, await this.#configuration.Revise(await ReadJson(request, 131072)));}
}
