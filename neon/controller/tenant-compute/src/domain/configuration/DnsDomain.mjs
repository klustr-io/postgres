/**
 * Validate a lowercase DNS domain before deriving endpoints, certificates or identity.
 * @param {string} value - Domain without wildcard, trailing dot, port or scheme.
 * @returns {boolean} Whether every label and total domain length meet DNS bounds.
 */
export function IsDnsDomain(value) {
  return typeof value === 'string' && value.length > 0 && value.length <= 253 &&
    value.split('.').every(label => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label));
}
