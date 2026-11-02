import {ReadJson, SendJson} from '../http/HttpJson.mjs';
/**
 * @typedef {Object} BranchControllerDependencies
 * @property {import('../../application/database/BranchDatabase.mjs').BranchDatabase} branch - Copy-on-write branch command.
 */
/** HTTP adapter for copy-on-write branch creation. */
export class BranchController {
  #branch;
  /** @param {BranchControllerDependencies} dependencies - Branch application command. */
  constructor({branch}) {this.#branch = branch;}
  /**
   * Submit branch selection and overrides to the branch command.
   * Requires fleet-admin or database-operator authorization; side effects persist the child definition and request reconciliation.
   * @param {import('node:http').IncomingMessage} request - Authorized JSON request.
   * @param {import('node:http').ServerResponse} response - HTTP response.
   * @param {import('./DatabaseController.mjs').DatabaseRouteParameters} parameters - Parent database name.
   * @returns {Promise<void>} Sends accepted child identity.
   * @throws {Error} On malformed input, denied source access, unavailable history or persistence failure.
   */
  async Create(request, response, {name}) {SendJson(response, 202, await this.#branch.Execute(name, await ReadJson(request)));}
}
