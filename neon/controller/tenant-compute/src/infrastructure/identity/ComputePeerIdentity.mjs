import {X509Certificate} from 'node:crypto';
import {IdentityError} from '../../domain/identity/IdentityPolicy.mjs';
/** Endpoint-bound mTLS identity. Authorization uses a deployment CA and exact DNS SAN; no token is persisted. */
export class ComputePeerIdentity {
  #namespace;
  /** @param {string} namespace - Provider-owned Kubernetes namespace. */
  constructor(namespace) {this.#namespace = namespace;}
  /**
   * Authorize a compute validator request without side effects.
   * @param {import('node:http').IncomingMessage} request - TLS request.
   * @param {ReturnType<import('../../domain/compute/ComputeSpecification.mjs').EndpointConfig>} endpoint - Expected endpoint.
   * @returns {void} Returns only for a verified endpoint client certificate.
   * @throws {Error} When the peer chain or exact endpoint identity is invalid.
   */
  Require(request, endpoint) {
    const socket = request.socket, raw = socket.getPeerCertificate?.().raw;
    if (!socket.authorized || !raw) throw IdentityError('COMPUTE_IDENTITY_REQUIRED', 403);
    const certificate = new X509Certificate(raw), expected = `${endpoint.name}.${this.#namespace}.svc.cluster.local`;
    if (certificate.checkHost(expected, {wildcards: false, subject: 'never'}) !== expected) throw IdentityError('COMPUTE_IDENTITY_REQUIRED', 403);
  }
}
