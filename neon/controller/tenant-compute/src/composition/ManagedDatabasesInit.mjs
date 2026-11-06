import {Databases} from '../application/database/Databases.mjs';
import {Recovery} from '../application/recovery/Recovery.mjs';
import {StorageFleet} from '../application/storage/StorageFleet.mjs';
import {StorageRouting} from '../infrastructure/storage/StorageRouting.mjs';
import {Identity} from '../infrastructure/identity/Identity.mjs';
import {DatabaseCredentials} from '../application/identity/DatabaseCredentials.mjs';
import {PostgresLoginRoles} from '../infrastructure/postgres/PostgresLoginRoles.mjs';
import {NativeOAuth} from '../application/identity/NativeOAuth.mjs';
import {NativeRolePreparation} from '../application/identity/NativeRolePreparation.mjs';
import {ComputePeerIdentity} from '../infrastructure/identity/ComputePeerIdentity.mjs';
import {ConfigurationSnapshot} from '../infrastructure/configuration/ConfigurationSnapshot.mjs';
/**
 * @typedef {Object} ManagedDatabasesDependencies
 * @property {import('../infrastructure/kubernetes/Kubernetes.mjs').Kubernetes} api - Namespace Kubernetes adapter.
 * @property {import('../infrastructure/kubernetes/Kubernetes.mjs').Leadership} leader - Namespace lease guard.
 * @property {import('../infrastructure/compute/Lifecycle.mjs').Lifecycle} lifecycle - Compute lifecycle adapter.
 * @property {() => Map<string, ReturnType<import('../domain/compute/ComputeSpecification.mjs').EndpointConfig>>} getEndpoints - Endpoint snapshot query.
 * @property {string} configFile - Deployment configuration path.
 * @property {(event: string, fields: Record<string, unknown>) => void} emit - Bounded event sink.
 * @property {boolean} enableFleet - Whether shared storage is a KEDA target.
 * @property {(name: string, active: boolean) => void} publishDemand - KEDA demand publication port.
 * @property {(desired: ReturnType<import('../infrastructure/configuration/ConfigurationFile.mjs').ConfigurationFile>) => Promise<void>} provision - Deployment provisioning port.
 */
/**
 * @typedef {Object} ManagedDatabasesRuntime
 * @property {Databases} databases - Database commands and reconciliation.
 * @property {Recovery} recovery - Retained recovery point commands.
 * @property {StorageFleet | null} fleet - Optional storage lifecycle worker.
 * @property {StorageRouting} storage - Authenticated storage adapter.
 * @property {Identity} identity - OIDC authorization.
 * @property {DatabaseCredentials} credentials - Ephemeral credential exchange.
 * @property {NativeOAuth} nativeOAuth - Native token authorization and compute validation.
 */

/**
 * Wire managed capabilities with named ports; no consumer receives this graph.
 * Deferred closures break construction cycles without mutating constructed services.
 * @param {ManagedDatabasesDependencies} dependencies - Concrete runtime adapters selected by the host.
 * @returns {ManagedDatabasesRuntime} Capabilities for the composition owner only.
 */
export function ManagedDatabasesInit({api, leader, lifecycle, getEndpoints, configFile, emit, enableFleet, publishDemand, provision}) {
  let recovery, fleet = null;
  const configuration = new ConfigurationSnapshot({file: configFile});
  const ensureStorageActive = async () => {if (fleet) await fleet.ensureActive();};
  const databases = new Databases({api, leader, lifecycle, getEndpoints, readConfiguration: configuration.Read.bind(configuration), emit, ensureStorageActive, publishDemand, provision,
    prepareBranch: (resource, tenant) => recovery.prepareBranch(resource, tenant), listBackupReferences: () => recovery.backupReferences(),
    withStorage: operation => recovery.storage(operation), storageRequest: (...args) => storage.request(...args)});
  const storage = new StorageRouting({api, leader, lifecycle, getEndpoints, getConfig: databases.desired.bind(databases)});
  recovery = new Recovery({routing: storage, api, leader, lifecycle, getEndpoints, emit, ensureStorageActive,
    reloadDatabases: databases.load.bind(databases), databaseDefinitions: databases.definitions.bind(databases), findDatabase: databases.definition.bind(databases),
    resolveTenant: databases.resolve.bind(databases), recordDatabaseStatus: databases.status.bind(databases), requireServingFleet: databases.requireServingFleet.bind(databases)});
  if (enableFleet) fleet = new StorageFleet({api, leader, routing: storage, getEndpoints, emit, publishDemand,
    getStorageConfiguration: () => databases.base().storage, hasDatabaseDemand: databases.storageDemand.bind(databases),
    isDatabaseDeleted: databases.isDeleted.bind(databases), getBackupTimelines: recovery.timelineReferences.bind(recovery), hasPendingRecovery: recovery.hasPendingWork.bind(recovery)});
  const identity = new Identity({configuration: () => databases.connectionPolicy().identity});
  const credentials = new DatabaseCredentials({api, leader, identity, lifecycle, getEndpoints, emit, ensureStorageActive,
    requireDatabase: databases.assertAvailable.bind(databases), beginConnection: databases.beginConnection.bind(databases), recordEvent: databases.event.bind(databases),
    connectionPolicy: databases.connectionPolicy.bind(databases), rolesForClient: client => new PostgresLoginRoles({client, emit})});
  const peer = new ComputePeerIdentity(api.namespace);
  const nativeRoles = new NativeRolePreparation({requireDatabase: databases.assertAvailable.bind(databases),
    beginConnection: databases.beginConnection.bind(databases), recordEvent: databases.event.bind(databases), ensureStorageActive,
    findEndpoint: name => [...getEndpoints().values()].find(endpoint => endpoint.databaseResource === name), lifecycle,
    rolesForClient: client => new PostgresLoginRoles({client, emit}), requireLeader: () => leader.require()});
  const nativeOAuth = new NativeOAuth({requireDatabase: databases.assertAvailable.bind(databases), identity,
    roles: nativeRoles, requireComputeIdentity: peer.Require.bind(peer), emit});
  return Object.freeze({databases, recovery, fleet, storage, identity, credentials, nativeOAuth});
}
