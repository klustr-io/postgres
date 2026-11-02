import {isDeepStrictEqual} from 'node:util';
import {ResourceName, DomainProblem, RecoveryPolicy} from '../recovery/RecoveryPolicy.mjs';
/** Allowed explicit database policy fields; physical placement remains provider-owned. @type {ReadonlyArray<string>} */
export const DatabaseFields = Object.freeze(['database', 'user', 'size', 'tier', 'profile', 'suspend', 'databasePolicies',
  'allowedIps', 'shards', 'replicas', 'lifecycle', 'deletionPolicy', 'backup', 'branchFrom', 'identity']);
/**
 * @typedef {Object} DatabaseDefinitionInput
 * @property {string} name - Immutable resource name.
 * @property {import('./DatabaseContracts.mjs').DatabaseResource | null} [resource] - Existing persisted definition.
 */
/** Aggregate policy protecting database identity, explicit overrides and irreversible retirement. */
export class DatabaseDefinition {
  #resource; #exists;
  /** @param {DatabaseDefinitionInput} input - Explicit identity and optional persisted state. */
  constructor({name, resource}) {
    if (!ResourceName(name) || resource && resource.metadata.name !== name) throw DomainProblem('INVALID_SPEC');
    this.#exists = Boolean(resource); this.#resource = structuredClone(resource || {metadata: {name}, spec: {}});
  }
  /**
   * Validate persisted policy independently of HTTP or Kubernetes entry points.
   * Authorization belongs to the owning command boundary; this invariant check has no mutation or persistence side effects.
   * @returns {void} Returns only when the stored field authority and lifecycle invariants hold.
   * @throws {Error} INVALID_SPEC when field authority or lifecycle invariants are invalid.
   */
  Validate() {
    const {spec} = this.#resource;
    for (const key of Object.keys(spec)) if (!DatabaseFields.includes(key)) throw DomainProblem('INVALID_SPEC', 'Unsupported tenant field: ' + key);
    if (!['active', 'suspended', 'retired'].includes(spec.lifecycle || 'active') || !['Retain', 'Delete'].includes(spec.deletionPolicy || 'Retain')) throw DomainProblem('INVALID_SPEC');
    if (spec.deletionPolicy === 'Delete' && spec.lifecycle !== 'retired') throw DomainProblem('INVALID_SPEC');
    RecoveryPolicy(spec.backup);
    if (spec.identity) this.#validateIdentity(spec.identity);
  }
  #validateIdentity(identity) {
    if (!identity.tenant || !identity.project || Object.values(identity).some(value => typeof value !== 'string' || !/^[a-z][a-z0-9-]{0,62}$/.test(value))) throw DomainProblem('INVALID_SPEC');
  }
  /**
   * Validate a desired-state revision without accepting lifecycle or retention commands.
   * Requires command authorization at the owning application boundary; side effects are limited to producing a copied candidate, never persisting it here.
   * @param {import('./DatabaseContracts.mjs').DatabaseSpecification} overrides - Explicit overrides.
   * @returns {import('./DatabaseContracts.mjs').DatabaseResource} Candidate definition for repository persistence.
   * @throws {Error} On retirement, immutable identity changes or command-field injection.
   */
  Revise(overrides) {
    if (!overrides || typeof overrides !== 'object' || Array.isArray(overrides) || 'deletionPolicy' in overrides || 'lifecycle' in overrides) throw DomainProblem('INVALID_SPEC');
    if (this.#exists) this.#validateRevision(overrides);
    const candidate = {...this.#resource, spec: {...this.#resource.spec, ...overrides}};
    new DatabaseDefinition({name: candidate.metadata.name, resource: candidate}).Validate();
    return candidate;
  }
  #validateRevision(overrides) {
    const {metadata, spec} = this.#resource;
    if (metadata.deletionTimestamp || spec.lifecycle === 'retired') throw DomainProblem('DATABASE_RETIRED');
    if (!isDeepStrictEqual(overrides.branchFrom ?? spec.branchFrom, spec.branchFrom)) throw DomainProblem('IMMUTABLE_BRANCH_SOURCE');
    if (['database', 'user'].some(key => overrides[key] !== undefined && overrides[key] !== spec[key])) throw DomainProblem('INVALID_SPEC');
  }
  /**
   * Require a database that can accept connection activity.
   * Caller authorization is separate from this lifecycle invariant; this check has no mutation side effects.
   * @returns {void} Returns only when the definition is available for connection demand.
   * @throws {Error} DATABASE_SUSPENDED or DATABASE_RETIRED for unavailable definitions.
   */
  AssertAvailable() {
    const {metadata, spec} = this.#resource;
    if (metadata.deletionTimestamp || ['suspended', 'retired'].includes(spec.lifecycle)) throw DomainProblem(spec.lifecycle === 'suspended' ? 'DATABASE_SUSPENDED' : 'DATABASE_RETIRED');
  }
  /**
   * Produce an explicit lifecycle patch while preserving permanent retirement.
   * Requires lifecycle-command authorization at the owning application boundary; no persistence side effects occur until the caller applies the returned patch.
   * @param {'suspend' | 'resume' | 'delete'} action - Requested lifecycle command.
   * @param {import('./DatabaseContracts.mjs').DatabaseRetirement} [input] - Explicit retention intent.
   * @returns {import('./DatabaseContracts.mjs').DatabaseSpecification} Validated desired-state patch.
   * @throws {Error} On invalid command, forbidden reuse or missing purge confirmation.
   */
  Transition(action, input = {}) {
    if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).some(key => !['mode', 'confirm'].includes(key)) || !['suspend', 'resume', 'delete'].includes(action)) throw DomainProblem('INVALID_SPEC');
    if (action === 'delete') return this.#retirement(input);
    if (this.#resource.metadata.deletionTimestamp || this.#resource.spec.lifecycle === 'retired') throw DomainProblem('DATABASE_RETIRED');
    if (action === 'resume') return {lifecycle: 'active'};
    return {lifecycle: 'suspended', replicas: 0};
  }
  #retirement(input) {
    if (!['retain', 'purge'].includes(input.mode || 'retain')) throw DomainProblem('INVALID_SPEC');
    if (input.mode === 'purge' && input.confirm !== this.#resource.metadata.name) throw DomainProblem('PURGE_CONFIRMATION_REQUIRED');
    return {lifecycle: 'retired', replicas: 0, deletionPolicy: input.mode === 'purge' ? 'Delete' : 'Retain'};
  }
}
