import {SendJson} from '../http/HttpJson.mjs';
/**
 * @typedef {Object} ProxyControllerDependencies
 * @property {(id: string) => ReturnType<import('../../domain/compute/ComputeSpecification.mjs').EndpointConfig> | undefined} findEndpoint - Endpoint snapshot read port.
 * @property {import('../../application/identity/ProxyAccess.mjs').ProxyAccess} access - Role access query.
 * @property {import('../../application/compute/WakeCompute.mjs').WakeCompute} wake - Connection wake command.
 */
/** Adapt the upstream proxy protocol to access queries and compute wake commands. */
export class ProxyController {
  #findEndpoint; #access; #wake;
  /** @param {ProxyControllerDependencies} dependencies - Endpoint query and application commands. */
  constructor({findEndpoint, access, wake}) {this.#findEndpoint = findEndpoint; this.#access = access; this.#wake = wake;}
  #selection(request) {
    const url = new URL(request.url, 'https://control-plane.invalid');
    const id = (url.searchParams.get('endpointish') || url.pathname.match(/^\/endpoints\/([^/]+)\/jwks$/)?.[1] || '').replace(/-pooler$/, '');
    const endpoint = this.#findEndpoint(id);
    if (!endpoint) throw Object.assign(Error('Endpoint not found'), {status: 404, publicMessage: 'Endpoint not found'});
    return {endpoint, url};
  }
  /**
   * Present access control without waking the database.
   * Requires proxy service authorization; side effects read allowed role authentication policy and write the response, with no demand publication.
   * @param {import('node:http').IncomingMessage} request - Authenticated proxy request.
   * @param {import('node:http').ServerResponse} response - JSON response.
   * @returns {Promise<void>} Sends the upstream access contract.
   * @throws {Error} On unknown endpoints, unavailable roles or policy/provider failure.
   */
  async AccessControl(request, response) {const {endpoint, url} = this.#selection(request); SendJson(response, 200, await this.#access.Get(endpoint, url.searchParams.get('role') || ''));}
  /**
   * Invoke connection wake after proxy authentication.
   * Requires proxy service authorization; side effects reserve demand, activate storage/compute and return verified routing.
   * @param {import('node:http').IncomingMessage} request - Authenticated proxy request.
   * @param {import('node:http').ServerResponse} response - JSON response.
   * @returns {Promise<void>} Sends ready compute routing information.
   * @throws {Error} On retirement, unsafe wake, leadership loss or dependency failure.
   */
  async Wake(request, response) {const {endpoint} = this.#selection(request); SendJson(response, 200, await this.#wake.Execute(endpoint));}
  /**
   * Present the empty legacy JWKS contract for an existing endpoint.
   * Requires proxy service authorization; side effects write only the legacy response and never publish demand or IdP signing keys.
   * @param {import('node:http').IncomingMessage} request - Authenticated proxy request.
   * @param {import('node:http').ServerResponse} response - JSON response.
   * @returns {Promise<void>} Sends the upstream legacy contract.
   * @throws {Error} On an unknown endpoint or response transport failure.
   */
  async Jwks(request, response) {this.#selection(request); SendJson(response, 200, {jwks: []});}
}
