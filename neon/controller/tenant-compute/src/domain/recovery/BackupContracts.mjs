/**
 * @typedef {Object} BackupResource
 * @property {import('../database/DatabaseContracts.mjs').ResourceIdentity} metadata - Persisted backup identity and concurrency metadata.
 * @property {BackupSpecification} spec - Source identity and requested retention.
 * @property {BackupStatus} [status] - Reconciled native recovery point, absent immediately after creation.
 */
/**
 * @typedef {Object} BackupSpecification
 * @property {string} database - Source database name.
 * @property {string} databaseUID - Immutable source identity.
 * @property {number} retentionSeconds - Retained lifetime.
 */
/**
 * @typedef {Object} BackupStatus
 * @property {string} phase - Observed recovery point state.
 * @property {string} [databaseUID] - Validated source identity.
 * @property {string} [tenantId] - Storage tenant identity.
 * @property {string} [timelineId] - Retained read-only timeline.
 * @property {string} [lsn] - Retained WAL boundary.
 * @property {string} [expiresAt] - Expiration timestamp.
 * @property {string | null} [reason] - Bounded reconciliation reason, cleared after successful progress.
 * @property {string} [readyAt] - UTC time remote durability was verified for this recovery point.
 */
/**
 * @typedef {Object} BackupView
 * @property {string} name - Backup resource name.
 * @property {BackupSpecification} spec - Desired recovery point policy.
 * @property {BackupStatus} status - Observed recovery point state.
 */
/**
 * @typedef {Object} BackupRequest
 * @property {string} name - New recovery point name.
 * @property {number} [retentionSeconds] - Retention override.
 */
export {};
