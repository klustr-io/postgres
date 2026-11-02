import {ReadJson, SendJson} from '../http/HttpJson.mjs';
/**
 * @typedef {Object} RecoveryControllerDependencies
 * @property {(name: string) => Promise<import('../../domain/recovery/BackupContracts.mjs').BackupView>} readBackup - Backup query port.
 * @property {(name: string) => Promise<import('../../domain/recovery/BackupContracts.mjs').BackupView[]>} listBackups - Database recovery-point query.
 * @property {(database: string, name: string, options: Pick<import('../../domain/recovery/BackupContracts.mjs').BackupRequest, 'retentionSeconds'>) => Promise<import('../../domain/recovery/BackupContracts.mjs').BackupResource>} createBackup - Recovery-point command.
 * @property {(name: string) => Promise<void>} deleteBackup - Recovery-point retirement command.
 * @property {(name: string) => ReturnType<import('../../application/recovery/Recovery.mjs').Recovery['history']>} history - Retained-history query.
 * @property {() => void} requestReconcile - Schedule recovery reconciliation.
 */
/** HTTP adapter for retained recovery points and history queries. */
export class RecoveryController {
  #readBackup; #listBackups; #createBackup; #deleteBackup; #history; #requestReconcile;
  /** @param {RecoveryControllerDependencies} dependencies - Named recovery command/query ports. */
  constructor({readBackup, listBackups, createBackup, deleteBackup, history, requestReconcile}) {
    this.#readBackup = readBackup; this.#listBackups = listBackups; this.#createBackup = createBackup;
    this.#deleteBackup = deleteBackup; this.#history = history; this.#requestReconcile = requestReconcile;
  }
  /**
   * Present one recovery point.
   * Requires management read authorization; side effects read the recovery repository and write its observed state.
   * @param {import('node:http').IncomingMessage} request - Authorized request.
   * @param {import('node:http').ServerResponse} response - JSON response.
   * @param {import('../database/DatabaseController.mjs').DatabaseRouteParameters} parameters - Recovery-point name.
   * @returns {Promise<void>} Sends the recovery-point view.
   * @throws {Error} On missing recovery points, leadership loss or provider failure.
   */
  async Get(request, response, {name}) {SendJson(response, 200, await this.#readBackup(name));}
  /**
   * Retire a recovery point through its command boundary.
   * Requires fleet-admin or backup-operator authorization; side effects request dependency-checked retirement of the retained recovery point.
   * @param {import('node:http').IncomingMessage} request - Authorized request.
   * @param {import('node:http').ServerResponse} response - JSON response.
   * @param {import('../database/DatabaseController.mjs').DatabaseRouteParameters} parameters - Recovery-point name.
   * @returns {Promise<void>} Sends command acceptance.
   * @throws {Error} On dependent branches, missing recovery points or persistence failure.
   */
  async Delete(request, response, {name}) {await this.#deleteBackup(name); SendJson(response, 202, {name, accepted: true});}
  /**
   * Present database recovery points.
   * Requires management read authorization; side effects read the repository and write a database-scoped backup list.
   * @param {import('node:http').IncomingMessage} request - Authorized request.
   * @param {import('node:http').ServerResponse} response - JSON response.
   * @param {import('../database/DatabaseController.mjs').DatabaseRouteParameters} parameters - Source database name.
   * @returns {Promise<void>} Sends recovery-point views.
   * @throws {Error} On database lookup, leadership or repository failure.
   */
  async List(request, response, {name}) {SendJson(response, 200, {backups: await this.#listBackups(name)});}
  /**
   * Validate recovery-point transport fields and invoke the create command.
   * Requires fleet-admin or backup-operator authorization; side effects persist a retained recovery-point request and schedule reconciliation.
   * @param {import('node:http').IncomingMessage} request - Authorized JSON request.
   * @param {import('node:http').ServerResponse} response - JSON response.
   * @param {import('../database/DatabaseController.mjs').DatabaseRouteParameters} parameters - Source database name.
   * @returns {Promise<void>} Sends command acceptance.
   * @throws {Error} On invalid retention, conflicting names, unavailable source or persistence failure.
   */
  async Create(request, response, {name}) {
    const input = await ReadJson(request);
    if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).some(key => !['name', 'retentionSeconds'].includes(key))) {
      throw Object.assign(Error('Invalid backup specification'), {code: 'INVALID_SPEC', status: 422});
    }
    const resource = await this.#createBackup(name, input.name, {retentionSeconds: input.retentionSeconds});
    this.#requestReconcile(); SendJson(response, 202, {name: resource.metadata.name, accepted: true});
  }
  /**
   * Present retained history through the recovery query.
   * Requires management read authorization; side effects may wake storage to query generation-validated history frontiers.
   * @param {import('node:http').IncomingMessage} request - Authorized request.
   * @param {import('node:http').ServerResponse} response - JSON response.
   * @param {import('../database/DatabaseController.mjs').DatabaseRouteParameters} parameters - Source database name.
   * @returns {Promise<void>} Sends retained-history state.
   * @throws {Error} On missing databases, unavailable storage or frontier validation failure.
   */
  async History(request, response, {name}) {SendJson(response, 200, await this.#history(name));}
}
