import {SuspendPolicy as policy} from '../compute/Activity.mjs';
import {RecoveryPolicy as recoveryPolicy} from '../recovery/RecoveryPolicy.mjs';
/**
 * @typedef {Object} DatabaseSuspendOverride
 * @property {'idle' | 'never'} [mode] - Explicit idle behavior; omission inherits the enclosing default.
 * @property {number} [idleSeconds] - Idle interval in seconds when mode is idle.
 */

/**
 * @typedef {Object} DatabaseDefaults
 * @property {string} [size] - Provider compute size.
 * @property {string} [tier] - Provider storage tier.
 * @property {DatabaseSuspendOverride} [suspend] - Idle policy.
 * @property {import('../recovery/RecoveryPolicy.mjs').RecoveryPolicyInput} [backup] - Recovery policy.
 */

/**
 * Resolve effective policy without persisting inherited values as overrides.
 * Omitted fields follow current fleet defaults; explicit zero disables scheduling.
 * @param {DatabaseDefaults} defaults - Provider defaults.
 * @param {DatabaseDefaults} overrides - Explicit database policy.
 * @returns {DatabaseDefaults} Validated effective policy; neither input is mutated.
 * @throws {Error} When a policy has an invalid value or shape.
 */
export function ResolveDatabasePolicy(defaults = {}, overrides = {}) {
  for (const input of [defaults, overrides]) {
    for (const key of ['suspend', 'backup']) {
      if (input[key] !== undefined && (!input[key] || typeof input[key] !== 'object' || Array.isArray(input[key]))) {
        throw Error('Invalid database ' + key + ' policy');
      }
    }
  }
  return {...defaults, ...overrides,
    suspend: policy({...defaults.suspend, ...overrides.suspend}),
    backup: recoveryPolicy({...defaults.backup, ...overrides.backup})};
}
