/**
 * Read bounded JSON transport input; malformed or oversized input is rejected.
 * @param {import('node:http').IncomingMessage} request - Incoming HTTP request.
 * @param {number} [limit] - Maximum body bytes.
 * @returns {Promise<unknown>} Parsed untrusted JSON value.
 * @throws {Error} INVALID_JSON or REQUEST_TOO_LARGE with HTTP status.
 */
export async function ReadJson(request, limit = 16384) {
  const chunks = []; let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > limit) throw Object.assign(Error('Request too large'), {code: 'REQUEST_TOO_LARGE', status: 413});
    chunks.push(chunk);
  }
  try {return JSON.parse(Buffer.concat(chunks).toString() || '{}');}
  catch {throw Object.assign(Error('Malformed JSON'), {code: 'INVALID_JSON', status: 422});}
}

/**
 * Serialize an HTTP result with credential-safe cache headers.
 * @param {import('node:http').ServerResponse} response - Outgoing HTTP response.
 * @param {number} status - HTTP status code.
 * @param {unknown} value - Public response value.
 * @returns {void}
 */
export function SendJson(response, status, value) {
  const payload = JSON.stringify(value);
  response.writeHead(status, {'Content-Type': 'application/json', 'Cache-Control': 'no-store'});
  response.end(payload);
}
