/**
 * @typedef {Object} DatabaseIdentityBinding
 * @property {string} tenant - Verified tenant claim required for this database.
 * @property {string} project - Verified project claim required within that tenant.
 */
/**
 * @typedef {Object} DatabaseActivityHold
 * @property {string} id - Most recently accepted activity identifier.
 * @property {string} until - UTC expiry of that activity hold.
 */
/**
 * @typedef {Object} DatabaseBranchAncestry
 * @property {string} database - Parent managed database name.
 * @property {string} databaseUID - Immutable parent Kubernetes identity.
 * @property {string} tenantId - Shared native storage tenant.
 * @property {string} timelineId - Source native timeline.
 * @property {string} lsn - Retained WAL boundary used to create the branch.
 */
/**
 * @typedef {Object} DatabaseIdentitySpecification
 * @property {string} [database] - SQL database name.
 * @property {string} [user] - SQL owner role.
 * @property {DatabaseIdentityBinding} [identity] - OIDC resource binding.
 * @property {'durable' | 'bounded-async'} [profile] - Commit durability profile.
 * @property {string[]} [allowedIps] - Client network allowlist.
 * @property {number} [shards] - Storage shard count.
 * @property {number} [replicas] - Requested compute count, zero or one.
 * @property {string[]} [preloadLibraries] - Packaged TimescaleDB, Anonymizer and BM25 startup libraries; enabled per SQL database separately.
 * @property {'active' | 'suspended' | 'retired'} [lifecycle] - Operator lifecycle state.
 * @property {'Retain' | 'Delete'} [deletionPolicy] - Explicit data retention intent.
 * @property {import('../recovery/RecoveryPolicy.mjs').BranchSelection} [branchFrom] - Immutable branch source.
 * @property {Record<string, import('./DatabasePolicy.mjs').DatabaseDefaults['suspend']>} [databasePolicies] - Per-SQL-database idle overrides.
 */
/** @typedef {import('./DatabasePolicy.mjs').DatabaseDefaults & DatabaseIdentitySpecification} DatabaseSpecification */
/**
 * @typedef {Object} ResourceIdentity
 * @property {string} name - Namespace resource name.
 * @property {string} [namespace] - Namespace.
 * @property {string} [uid] - Immutable Kubernetes resource identity.
 * @property {string} [resourceVersion] - Optimistic concurrency token.
 * @property {number} [generation] - Desired generation.
 * @property {string} [deletionTimestamp] - Retirement timestamp.
 * @property {string[]} [finalizers] - Retention guards.
 * @property {string} [creationTimestamp] - Creation timestamp.
 */
/**
 * @typedef {Object} DatabaseStatus
 * @property {string} [phase] - Observed lifecycle phase.
 * @property {string | null} [reason] - Bounded reconciliation reason.
 * @property {number} [replicas] - Observed compute count.
 * @property {string} [provisioningRevision] - Applied storage and compute policy.
 * @property {DatabaseActivityHold} [event] - Bounded external activity hold.
 * @property {string} [drainedLSN] - Last durable compute frontier.
 * @property {DatabaseBranchAncestry} [source] - Recorded branch ancestry.
 */
/**
 * @typedef {Object} DatabaseResource
 * @property {string} [apiVersion] - Kubernetes API version.
 * @property {string} [kind] - Resource kind.
 * @property {ResourceIdentity} metadata - Identity and concurrency token.
 * @property {DatabaseSpecification} spec - Explicit database overrides.
 * @property {DatabaseStatus} [status] - Observed state.
 */
/**
 * @typedef {Object} DatabaseView
 * @property {string} name - Database name.
 * @property {DatabaseSpecification} spec - Explicit database overrides.
 * @property {DatabaseStatus} status - Observed state.
 */
/**
 * @typedef {Object} AcceptedDatabase
 * @property {string} name - Accepted resource name.
 * @property {boolean} accepted - Whether the asynchronous command was accepted.
 */
/**
 * @typedef {Object} DatabaseEvent
 * @property {string} id - Idempotency identifier.
 * @property {number} [holdSeconds] - Activity hold duration.
 */
/**
 * @typedef {Object} DatabaseRetirement
 * @property {'retain' | 'purge'} [mode] - Explicit retention intent.
 * @property {string} [confirm] - Exact name required for purge.
 */
export {};
