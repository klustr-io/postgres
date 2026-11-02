import fs from 'node:fs';
import {timingSafeEqual} from 'node:crypto';
/**
 * @typedef {Object} TokenFileAuthorizationDependencies
 * @property {string} file - Projected token file, read on every request for rotation.
 */
/** Constant-time verification of explicitly configured controller tokens. */
export class TokenFileAuthorization {
  #file;
  /** @param {TokenFileAuthorizationDependencies} dependencies - Projected credential path. */
  constructor({file}) {this.#file = file;}
  /**
   * Verify a bearer token without logging or caching its value.
   * Implements the service/static authorization check; side effects read the projected credential afresh and never persist supplied token values.
   * @param {import('node:http').IncomingMessage} request - Incoming authorization header.
   * @returns {boolean} Whether the configured token matches.
   * @throws {Error} On credential-provider failure; callers must fail closed.
   */
  Authenticate(request) {
    const expected = Buffer.from('Bearer ' + fs.readFileSync(this.#file, 'utf8').trim());
    const actual = Buffer.from(request.headers.authorization || '');
    return expected.length > 30 && expected.length === actual.length && timingSafeEqual(expected, actual);
  }
  /**
   * Require the explicit controller bearer token.
   * Enforces service/static authorization; side effects read the credential file through Authenticate without caching or logging it.
   * @param {import('node:http').IncomingMessage} request - Incoming authorization header.
   * @returns {void} Returns only for the current configured credential.
   * @throws {Error} UNAUTHORIZED with HTTP status 401 when verification fails.
   */
  Require(request) {if (!this.Authenticate(request)) throw Object.assign(Error('Unauthorized'), {code: 'UNAUTHORIZED', status: 401, publicMessage: 'Unauthorized'});}
}
