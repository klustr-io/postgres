import {WalLsn} from '../storage/WalDurability.mjs';
/**
 * Validate a namespace resource name used by database and recovery commands.
 * @param {unknown} value - Untrusted name.
 * @returns {boolean} Whether the name is DNS-safe and fits generated resource names.
 */
export const ResourceName = value => typeof value === 'string' && /^[a-z][a-z0-9-]{0,38}$/.test(value);
/**
 * Construct a bounded domain error without embedding credentials or provider data.
 * @param {string} code - Stable domain reason.
 * @param {string} [message] - Internal explanation, defaulting to the reason.
 * @returns {Error & {code: string}} Domain error for transport presentation.
 */
export const DomainProblem = (code, message = code) => Object.assign(Error(message), {code});
/**
 * @typedef {Object} RecoveryPolicyInput
 * @property {number} [historySeconds] - Requested history window.
 * @property {number} [scheduleSeconds] - Snapshot interval; zero disables it.
 * @property {number} [retentionSeconds] - Snapshot lifetime.
 */
/**
 * @typedef {Object} RecoveryRetention
 * @property {number} historySeconds - Effective retained history window.
 * @property {number} scheduleSeconds - Effective snapshot interval.
 * @property {number} retentionSeconds - Effective snapshot lifetime.
 */
/**
 * Resolve built-in recovery defaults and enforce bounded, consistent retention.
 * @param {RecoveryPolicyInput} [value] - Explicit policy after fleet inheritance.
 * @returns {RecoveryRetention} Complete validated retention policy.
 * @throws {Error} INVALID_SPEC on malformed or contradictory policy.
 */
export function RecoveryPolicy(value = {}) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(key => !['historySeconds', 'scheduleSeconds', 'retentionSeconds'].includes(key))) throw DomainProblem('INVALID_SPEC');
  const policy = {historySeconds: 604800, scheduleSeconds: 0, retentionSeconds: 604800, ...value};
  for (const [key, min, max] of [['historySeconds', 0, 2592000], ['scheduleSeconds', 0, 2592000], ['retentionSeconds', 300, 31536000]]) {
    if (!Number.isInteger(policy[key]) || policy[key] < min || policy[key] > max) throw DomainProblem('INVALID_SPEC');
  }
  if (policy.scheduleSeconds && (policy.scheduleSeconds < 300 || policy.retentionSeconds < policy.scheduleSeconds)) throw DomainProblem('INVALID_SPEC');
  return policy;
}
/**
 * @typedef {Object} BranchSelection
 * @property {string} database - Source database name.
 * @property {string} [backup] - Retained recovery point name.
 * @property {string} [lsn] - Explicit WAL boundary.
 * @property {string} [timestamp] - Explicit recovery timestamp.
 */
/**
 * Validate immutable ancestry selection without substituting recovery boundaries.
 * @param {BranchSelection} value - Untrusted ancestry selection.
 * @returns {BranchSelection} Validated selection.
 * @throws {Error} INVALID_SPEC on conflicting or invalid selection.
 */
export function BranchSource(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(key => !['database', 'backup', 'lsn', 'timestamp'].includes(key)) || !ResourceName(value.database)) throw DomainProblem('INVALID_SPEC');
  if (value.backup !== undefined && !ResourceName(value.backup)) throw DomainProblem('INVALID_SPEC');
  if ([value.backup, value.lsn, value.timestamp].filter(value => value !== undefined).length > 1) throw DomainProblem('INVALID_SPEC');
  if (value.lsn !== undefined) try {WalLsn(value.lsn);} catch {throw DomainProblem('INVALID_SPEC');}
  if (value.timestamp !== undefined) ValidateRecoveryTimestamp(value.timestamp);
  return value;
}
function ValidateRecoveryTimestamp(timestamp) {
  if (typeof timestamp !== 'string' || !/^\d{4}-\d\d-\d\dT.*(?:Z|[+-]\d\d:\d\d)$/.test(timestamp) || !Number.isFinite(Date.parse(timestamp)) || Date.parse(timestamp) > Date.now()) throw DomainProblem('INVALID_SPEC');
}
