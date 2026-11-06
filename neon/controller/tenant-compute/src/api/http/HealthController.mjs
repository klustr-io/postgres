import {ReadJson, SendJson} from './HttpJson.mjs';
/**
 * @typedef {Object} StorageNotificationFailure
 * @property {string} reason - Stable storage-notification rejection code, without credentials or payload data.
 */
/**
 * @typedef {Object} ControllerMetricsSnapshot
 * @property {boolean} leader - Whether this process holds its lease.
 * @property {number} endpoints - Known endpoint count.
 * @property {Record<string, number>} events - Bounded lifecycle counters.
 */
/**
 * @typedef {Object} HealthControllerDependencies
 * @property {(request: import('node:http').IncomingMessage) => boolean} authorizeHook - Authenticate storage notifications.
 * @property {import('../../infrastructure/storage/StorageRouting.mjs').StorageRouting['notify'] | null} notify - Storage notification command, when configured.
 * @property {() => boolean} isLeader - Current lease observation.
 * @property {() => boolean} stopping - Whether this process is stopping.
 * @property {() => ControllerMetricsSnapshot} metrics - Telemetry snapshot query.
 * @property {(event: string, fields: StorageNotificationFailure) => void} emit - Bounded notification failure sink.
 */
/** Adapt health, metrics and authenticated storage-notification HTTP requests. */
export class HealthController {
  #authorizeHook; #notify; #isLeader; #stopping; #metrics; #emit;
  /** @param {HealthControllerDependencies} dependencies - Health observations and notification command. */
  constructor({authorizeHook, notify, isLeader, stopping, metrics, emit}) {
    this.#authorizeHook = authorizeHook; this.#notify = notify; this.#isLeader = isLeader;
    this.#stopping = stopping; this.#metrics = metrics; this.#emit = emit;
  }
  /**
   * Present bounded health/metrics or delegate an authenticated storage notification.
   * Health reads require no authorization; notifications require service authority and leadership. Side effects notify storage or emit bounded failure facts.
   * @param {import('node:http').IncomingMessage} request - Incoming health or hook request.
   * @param {import('node:http').ServerResponse} response - HTTP response.
   * @returns {Promise<void>} Sends health, metrics or notification acceptance.
   * @throws {Error} When the health observation or response transport fails outside handled notification rejections.
   */
  async Handle(request, response) {
    if (['/notify-attach', '/notify-safekeepers'].includes(request.url) && request.method === 'PUT' && this.#notify) return this.#notification(request, response);
    if (request.url === '/livez') return SendJson(response, 200, {status: 'ok'});
    if (request.url === '/readyz') return SendJson(response, this.#isLeader() && !this.#stopping() ? 200 : 503, {leader: this.#isLeader()});
    if (request.url === '/metrics') return this.#presentMetrics(response);
    SendJson(response, 404, {error: 'Not found'});
  }
  async #notification(request, response) {
    try {
      if (!this.#authorizeHook(request) || !this.#isLeader()) return SendJson(response, 503, {error: 'Hook unavailable'});
      await this.#notify(request.url === '/notify-attach' ? 'attach' : 'safekeepers', await ReadJson(request));
      SendJson(response, 200, {status: 'ok'});
    } catch (error) {
      this.#emit('storage_reconfigure_deferred', {reason: error.code || 'STORAGE_NOT_READY'});
      SendJson(response, 503, {error: 'Storage reconfiguration deferred'});
    }
  }
  #presentMetrics(response) {
    const snapshot = this.#metrics();
    response.writeHead(200, {'Content-Type': 'text/plain'});
    response.end(`neon_controller_leader ${snapshot.leader ? 1 : 0}\nneon_controller_endpoints ${snapshot.endpoints}\n` +
      Object.entries(snapshot.events).map(([key, value]) => `neon_controller_${key}_total ${value}\n`).join(''));
  }
}
