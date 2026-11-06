import {ReadJson, SendJson} from '../http/HttpJson.mjs';
/**
 * @typedef {Object} DatabaseControllerDependencies
 * @property {(name: string) => Promise<import('../../domain/database/DatabaseContracts.mjs').DatabaseView>} getDatabase - Public database query.
 * @property {(name: string, spec: import('../../domain/database/DatabaseContracts.mjs').DatabaseSpecification) => Promise<import('../../domain/database/DatabaseContracts.mjs').DatabaseResource>} putDatabase - Database definition command.
 * @property {(name: string, input: import('../../domain/database/DatabaseContracts.mjs').DatabaseEvent) => Promise<void>} recordEvent - External activity command.
 * @property {(name: string, action: string, input?: import('../../domain/database/DatabaseContracts.mjs').DatabaseRetirement) => Promise<import('../../domain/database/DatabaseContracts.mjs').DatabaseResource>} changeLifecycle - Explicit lifecycle command.
 * @property {() => void} requestReconcile - Schedule desired-state reconciliation.
 * @property {() => void} requestPoll - Schedule compute lifecycle observation.
 */
/**
 * @typedef {Object} DatabaseRouteParameters
 * @property {string} name - Database resource name.
 */

/** Translate database HTTP requests into explicit database commands and queries. */
export class DatabaseController {
  #getDatabase; #putDatabase; #recordEvent; #changeLifecycle; #requestReconcile; #requestPoll;
  /** @param {DatabaseControllerDependencies} dependencies - Named database application ports. */
  constructor({getDatabase, putDatabase, recordEvent, changeLifecycle, requestReconcile, requestPoll}) {
    this.#getDatabase = getDatabase; this.#putDatabase = putDatabase; this.#recordEvent = recordEvent;
    this.#changeLifecycle = changeLifecycle; this.#requestReconcile = requestReconcile; this.#requestPoll = requestPoll;
  }
  /**
   * Present desired policy and observed state.
   * Requires a management read permission; side effects read the repository and write the HTTP response without changing desired state.
   * @param {import('node:http').IncomingMessage} request - Authorized request.
   * @param {import('node:http').ServerResponse} response - HTTP response.
   * @param {DatabaseRouteParameters} parameters - Validated resource name.
   * @returns {Promise<void>} Sends the database view.
   * @throws {Error} On missing resources or repository/transport failure.
   */
  async Get(request, response, {name}) {SendJson(response, 200, await this.#getDatabase(name));}
  /**
   * Submit desired database policy without implementing policy resolution in HTTP.
   * Requires fleet-admin or database-operator authorization; side effects persist accepted overrides and schedule reconciliation.
   * @param {import('node:http').IncomingMessage} request - Authorized JSON request.
   * @param {import('node:http').ServerResponse} response - HTTP response.
   * @param {DatabaseRouteParameters} parameters - Validated resource name.
   * @returns {Promise<void>} Sends the accepted generation.
   * @throws {Error} On invalid overrides, retired identity, conflicting ownership or persistence failure.
   */
  async Put(request, response, {name}) {
    const resource = await this.#putDatabase(name, await ReadJson(request));
    this.#requestReconcile(); SendJson(response, 202, {name, generation: resource.metadata.generation});
  }
  /**
   * Submit bounded external activity.
   * Requires fleet-admin or database-operator authorization; side effects persist a bounded activity hold and publish scaling demand.
   * @param {import('node:http').IncomingMessage} request - Authorized JSON request.
   * @param {import('node:http').ServerResponse} response - HTTP response.
   * @param {DatabaseRouteParameters} parameters - Validated resource name.
   * @returns {Promise<void>} Sends activity acceptance.
   * @throws {Error} On invalid holds, unavailable database lifecycle or persistence failure.
   */
  async Event(request, response, {name}) {await this.#recordEvent(name, await ReadJson(request)); SendJson(response, 202, {name, accepted: true});}
  /**
   * Suspend a database through its lifecycle command.
   * Requires fleet-admin or database-operator authorization; side effects persist suspension and request compute reconciliation.
   * @param {import('node:http').IncomingMessage} request - Authorized request.
   * @param {import('node:http').ServerResponse} response - HTTP response.
   * @param {DatabaseRouteParameters} parameters - Validated resource name.
   * @returns {Promise<void>} Sends command acceptance.
   * @throws {Error} On absent/retired databases, leadership loss or persistence failure.
   */
  async Suspend(request, response, {name}) {await this.#changeLifecycle(name, 'suspend'); this.#requestPoll(); SendJson(response, 202, {name, accepted: true});}
  /**
   * Resume a database through its fleet-aware lifecycle command.
   * Requires fleet-admin or database-operator authorization; side effects persist active lifecycle and publish wake demand.
   * @param {import('node:http').IncomingMessage} request - Authorized request.
   * @param {import('node:http').ServerResponse} response - HTTP response.
   * @param {DatabaseRouteParameters} parameters - Validated resource name.
   * @returns {Promise<void>} Sends command acceptance.
   * @throws {Error} On retiring fleets, retired identities, leadership loss or persistence failure.
   */
  async Resume(request, response, {name}) {await this.#changeLifecycle(name, 'resume'); this.#requestPoll(); SendJson(response, 202, {name, accepted: true});}
  /**
   * Submit explicit retirement and retention intent.
   * Requires fleet-admin authorization; side effects persist retirement intent and schedule safe drain and retention processing.
   * @param {import('node:http').IncomingMessage} request - Authorized JSON request.
   * @param {import('node:http').ServerResponse} response - HTTP response.
   * @param {DatabaseRouteParameters} parameters - Validated resource name.
   * @returns {Promise<void>} Sends command acceptance.
   * @throws {Error} On invalid purge confirmation, dependent recovery data or persistence failure.
   */
  async Delete(request, response, {name}) {await this.#changeLifecycle(name, 'delete', await ReadJson(request)); this.#requestPoll(); SendJson(response, 202, {name, accepted: true});}
}
