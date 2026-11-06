import {ReadJson, SendJson} from '../http/HttpJson.mjs';
/** Transport adapter for proxy native OAuth and endpoint-bound PostgreSQL validation. */
export class NativeOAuthController {
  #authorization; #findEndpoint;
  /**
   * @param {import('../../application/identity/NativeOAuth.mjs').NativeOAuth} authorization - Native authorization command.
   * @param {(id: string) => ReturnType<import('../../domain/compute/ComputeSpecification.mjs').EndpointConfig> | undefined} findEndpoint - Endpoint lookup.
   */
  constructor(authorization, findEndpoint) {this.#authorization = authorization; this.#findEndpoint = findEndpoint;}
  #endpoint(id) {
    const endpoint = this.#findEndpoint(id);
    if (!endpoint) throw Object.assign(Error('Endpoint unavailable'), {status: 404});
    return endpoint;
  }
  /**
   * Require proxy authorization; side effects prepare the restricted role after token verification.
   * @param {import('node:http').IncomingMessage} request - Authenticated proxy request.
   * @param {import('node:http').ServerResponse} response - Bounded response.
   * @returns {Promise<void>} Sends authorization result.
   * @throws {Error} On invalid request or authorization failure.
   */
  async Authorize(request, response) {
    const id = new URL(request.url, 'https://control-plane.invalid').searchParams.get('endpointish') || '';
    SendJson(response, 200, await this.#authorization.Authorize(this.#endpoint(id.replace(/-pooler$/, '')), await ReadJson(request)));
  }
  /**
   * Require endpoint mTLS authorization; side effects emit token-free audit facts.
   * @param {import('node:http').IncomingMessage} request - Compute validator request.
   * @param {import('node:http').ServerResponse} response - Bounded response.
   * @param {import('../database/DatabaseController.mjs').DatabaseRouteParameters} parameters - Database resource name.
   * @returns {Promise<void>} Sends native PostgreSQL validator result.
   * @throws {Error} On invalid peer, token, or resource authorization.
   */
  async Validate(request, response, parameters) {
    SendJson(response, 200, await this.#authorization.Validate(request, this.#endpoint(parameters.name), await ReadJson(request)));
  }
}
/**
 * Declare native OAuth transport and authorization boundaries; no side effects.
 * @param {NativeOAuthController} controller - Native OAuth delivery adapter.
 * @returns {import('../http/ControlPlaneRouter.mjs').ControlPlaneRoute[]} Declared routes.
 */
export function NativeOAuthRoutes(controller) {
  return [{pattern: /^\/authorize_oauth$/, query: true, authentication: 'proxy-command', methods: {POST: controller.Authorize.bind(controller)}},
    {pattern: /^\/v1\/databases\/(?<name>[a-z][a-z0-9-]{0,38})\/oauth\/validate$/, authentication: 'compute', methods: {POST: controller.Validate.bind(controller)}}];
}
