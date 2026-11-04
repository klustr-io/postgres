import {IdentityConfiguration as identityConfiguration} from '../identity/IdentityPolicy.mjs';
import {RecoveryPolicy as recoveryPolicy} from '../recovery/RecoveryPolicy.mjs';
import {ComputeSizes as sizes, StorageTiers as tiers} from '../database/DatabaseCatalog.mjs';
import {SuspendPolicy as policy} from '../compute/Activity.mjs';
import {IsDnsDomain} from '../configuration/DnsDomain.mjs';

const SafeName = value => typeof value === 'string' && /^[a-z][a-z0-9-]{0,62}$/.test(value);

/**
 * @typedef {Object} FleetStorageSpecification
 * @property {string} objectStoreSecretRef - Namespace object-storage Secret.
 * @property {string} storageClass - Durable CSI storage class.
 * @property {string} [metadataDatabaseSecretRef] - External metadata DSN Secret.
 */
/**
 * @typedef {Object} FleetReplicationSpecification
 * @property {'availability-zones'} scope - Physical failure scope.
 * @property {'synchronous-quorum'} mode - Safekeeper durability mode.
 * @property {number} safekeepers - Safekeeper count, exactly three.
 * @property {string[]} zones - Three distinct physical zones.
 */
/**
 * @typedef {Object} FleetSpecification
 * @property {string} domain - Client DNS domain.
 * @property {ReturnType<typeof identityConfiguration>} identity - OIDC authentication policy.
 * @property {FleetStorageSpecification} storage - Provider-owned storage references.
 * @property {FleetReplicationSpecification} replication - Physical replication policy.
 * @property {import('../database/DatabasePolicy.mjs').DatabaseDefaults} [defaults] - Inherited database defaults.
 * @property {string[]} [clientCIDRs] - Allowed client networks.
 * @property {boolean} [allowAsyncCommits] - Allow databases to explicitly select loss-tolerant acknowledgement policies.
 */
/**
 * @typedef {Object} FleetObservedState
 * @property {string} [storageIdentity] - Persisted hash protecting provider storage identity and topology.
 * @property {'Pending' | 'Provisioning' | 'Provisioned' | 'Rejected' | 'Retaining'} [phase] - Observed reconciliation/lifecycle state.
 * @property {string | null} [reason] - Stable deferred-work or qualification reason.
 * @property {string} [message] - Bounded prerequisite explanation without credential values.
 * @property {number} [observedGeneration] - Last reconciled desired generation.
 * @property {string} [appliedRevision] - Hash of the applied packaged resource plan.
 * @property {boolean} [zonePlacementConfigured] - Whether zone constraints were applied, not an HA certification.
 * @property {string} [lastVerifiedZonePlacementAt] - Last UTC observation of actual running storage placement.
 * @property {false} [automaticFailoverReady] - Current implementation never claims automatic writer failover.
 */
/**
 * @typedef {Object} FleetResource
 * @property {string} apiVersion - Resource API version.
 * @property {'NeonFleet'} kind - Resource kind.
 * @property {import('../database/DatabaseContracts.mjs').ResourceIdentity} metadata - Kubernetes identity and concurrency token.
 * @property {FleetSpecification} spec - Desired fleet policy.
 * @property {FleetObservedState} [status] - Observed fleet state.
 */

/**
 * Validate fleet identity, policy and provider references before any side effects.
 * @param {FleetResource} resource - Untrusted desired fleet configuration.
 * @returns {FleetSpecification} Validated specification.
 * @throws {Error} If identity, replication, storage or defaults violate fleet policy.
 */
export function ValidateFleet(resource) {
  const spec = resource.spec;
  if (!SafeName(resource.metadata.name) || resource.metadata.name.length > 39 || !spec || !IsDnsDomain(spec.domain)) throw Error('Invalid fleet identity/domain');
  if (Object.keys(spec).some(key => !['domain', 'identity', 'storage', 'replication', 'defaults', 'clientCIDRs', 'allowAsyncCommits'].includes(key))) throw Error('Unsupported fleet field');
  if (spec.allowAsyncCommits !== undefined && typeof spec.allowAsyncCommits !== 'boolean') throw Error('allowAsyncCommits must be boolean');
  identityConfiguration(spec.identity);
  if (!spec.identity) throw Error('Enterprise fleets require identity configuration');
  ValidateReplication(spec.replication);
  ValidateStorage(spec);
  ValidateDefaults(spec.defaults);
  return spec;
}

/** Validate physical quorum placement independently of transport defaults. */
function ValidateReplication(replication) {
  if (replication?.scope !== 'availability-zones' || replication.mode !== 'synchronous-quorum' || replication.safekeepers !== 3 ||
      replication.zones?.length !== 3 || new Set(replication.zones).size !== 3 || replication.zones.some(zone => typeof zone !== 'string' || !/^[A-Za-z0-9](?:[-A-Za-z0-9_.]{0,61}[A-Za-z0-9])?$/.test(zone))) throw Error('Three distinct zones and three synchronous safekeepers are required');
  if (Object.keys(replication).some(key => !['scope', 'mode', 'zones', 'safekeepers'].includes(key))) throw Error('Unsupported replication policy');
}

/** Validate provider-owned Secret references and durable storage placement. */
function ValidateStorage(spec) {
  if (!SafeName(spec.storage?.objectStoreSecretRef) || !SafeName(spec.storage.storageClass) ||
      spec.storage.metadataDatabaseSecretRef && !SafeName(spec.storage.metadataDatabaseSecretRef) ||
      spec.identity.caSecretRef && !SafeName(spec.identity.caSecretRef)) throw Error('Explicit storage/identity Secret references and storage class required');
}

/** Validate inherited database defaults before accepting a fleet revision. */
function ValidateDefaults(defaults) {
  if (defaults && Object.keys(defaults).some(key => !['size', 'tier', 'suspend', 'backup'].includes(key))) throw Error('Unsupported fleet database default');
  recoveryPolicy(defaults?.backup);
  if (defaults?.suspend) policy(defaults.suspend);
  if (defaults?.size && !sizes[defaults.size] || defaults?.tier && !tiers[defaults.tier]) throw Error('Unknown fleet size/tier default');
}
