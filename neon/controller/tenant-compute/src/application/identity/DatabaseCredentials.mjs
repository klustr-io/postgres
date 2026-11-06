// OIDC access-token exchange for ordinary TLS/SCRAM PostgreSQL clients.
import {randomBytes, pbkdf2Sync, createHmac, createHash, randomUUID} from 'node:crypto';
import {SecretText as secretText} from '../../domain/compute/ComputeSpecification.mjs';
import {IdentityError as identityError} from '../../domain/identity/IdentityPolicy.mjs';
function verifier(password) {
  const salt = randomBytes(16), salted = pbkdf2Sync(password, salt, 4096, 32, 'sha256');
  return `SCRAM-SHA-256$4096:${salt.toString('base64')}$${createHash('sha256').update(createHmac('sha256', salted).update('Client Key').digest()).digest('base64')}:${createHmac('sha256', salted).update('Server Key').digest('base64')}`;
}
/**
 * @typedef {Object} DatabaseCredentialRequest
 * @property {string} [role] - Requested restricted SQL role; omission is rejected before authentication or wake.
 */
/**
 * @typedef {Object} ExchangedDatabaseCredential
 * @property {string} user - Generated oidc-prefixed SQL login.
 * @property {string} password - Plaintext one-time response credential; never persist or log this response.
 * @property {string} expiresAt - UTC expiry, bounded by the access token and fifteen minutes.
 * @property {string} database - Primary SQL database name.
 * @property {string} host - Endpoint DNS name for SNI routing through the proxy.
 * @property {5432} port - PostgreSQL proxy port.
 * @property {'verify-full'} sslmode - Required client certificate and hostname verification.
 */
/**
 * @typedef {Object} DatabaseCredentialDependencies
 * @property {import('../../infrastructure/kubernetes/Kubernetes.mjs').Kubernetes} api - Namespace-scoped credential Secret repository.
 * @property {import('../../infrastructure/kubernetes/Kubernetes.mjs').Leadership} leader - Active lease guard for role and Secret mutations.
 * @property {import('../../infrastructure/identity/Identity.mjs').Identity} identity - Database-audience token and tenant/project/role authorization.
 * @property {import('../../infrastructure/compute/Lifecycle.mjs').Lifecycle} lifecycle - Serialized compute wake and administrative SQL operations.
 * @property {() => Map<string, import('../../domain/compute/ComputeSpecification.mjs').ComputeEndpoint>} getEndpoints - Current copied endpoint inventory.
 * @property {(event: string, fields: Record<string, unknown>) => void} emit - Bounded token-free credential audit sink.
 * @property {import('../database/Databases.mjs').Databases['assertAvailable']} requireDatabase - Serving-fleet and database admission guard.
 * @property {import('../database/Databases.mjs').Databases['beginConnection']} beginConnection - Reserve a pending connection and return its release callback.
 * @property {import('../database/Databases.mjs').Databases['event']} recordEvent - Hold compute demand during exchange.
 * @property {() => Promise<void>} ensureStorageActive - Wait for active storage before compute wake.
 * @property {import('../database/Databases.mjs').Databases['connectionPolicy']} connectionPolicy - Current domain and identity policy snapshot.
 * @property {(client: import('pg').Client) => import('../../infrastructure/postgres/PostgresLoginRoles.mjs').PostgresLoginRoles} rolesForClient - Role operations bound to the connected administrative client.
 */
/**
 * Exchange an authorized database access token for a bounded-lived SCRAM login and retire expired issued logins.
 * Native OAuth does not use this password-minting path; revoking the source token does not revoke an already issued credential.
 */
export class DatabaseCredentials {
  /** @param {DatabaseCredentialDependencies} dependencies - Explicit identity, database admission, compute, role and credential persistence ports. */
  constructor({api, leader, identity, lifecycle, getEndpoints, emit, requireDatabase, beginConnection,
    recordEvent, ensureStorageActive, connectionPolicy, rolesForClient}) {
    Object.assign(this, {api, leader, identity, lifecycle, getEndpoints, emit, requireDatabase, beginConnection,
      recordEvent, ensureStorageActive, connectionPolicy, rolesForClient}); this.busy = false; this.lastCleanup = 0;
  }
  /**
   * Authenticate the database token and authorize resource binding and role before any wake.
   * Rechecks authorization under endpoint serialization and an active lease before issuing a login.
   * Side effects reserve demand, wake storage/compute, prepare restricted SQL grants, persist only the verifier and identity correlation, and emit issuance audit facts.
   * A failed publication attempts SQL rollback; cleanup failures are retained as bounded audit evidence.
   * @param {import('node:http').IncomingMessage} request - Bearer-authenticated database-audience request, never a management token.
   * @param {string} name - Managed database resource name.
   * @param {DatabaseCredentialRequest} [input] - Explicit restricted role selection.
   * @returns {Promise<ExchangedDatabaseCredential>} Sensitive credential response, valid for at most fifteen minutes.
   * @throws {Error} On invalid token/binding/role, retirement, stale database UID, unavailable compute, login limit, near expiry or SQL/Secret failure.
   */
  async exchange(request, name, {role} = {}) {
    if (typeof role !== 'string' || !/^[a-z][a-z0-9_]{0,62}$/.test(role)) throw identityError('INVALID_ROLE', 422);
    await this.identity.authenticate(request, 'database');
    const resource = await this.requireDatabase(name);
    let actor = await this.identity.database(request, resource, role); // Authenticate before any wake.
    const complete = this.beginConnection(name);
    try {
      await this.ensureStorageActive();
      const endpoint = [...this.getEndpoints().values()].find(endpoint => endpoint.databaseResource === name);
      if (!endpoint) throw identityError('DATABASE_NOT_READY', 503);
      await this.recordEvent(name, {id: 'identity-' + randomUUID(), holdSeconds: 5});
      await this.lifecycle.wake(endpoint);
      return await this.lifecycle.serialized(endpoint, async () => {
        this.leader.require(); const current = await this.requireDatabase(name);
        if (current.metadata.uid !== resource.metadata.uid) throw identityError('DATABASE_NOT_READY', 503);
        actor = await this.identity.database(request, current, role);
        const existing = await this.api.list('secrets', 'neon.klustr.io/oidc-login=true');
        if (existing.filter(row => row.metadata.labels['neon.klustr.io/endpoint-uid'] === endpoint.uid && Date.parse(JSON.parse(secretText(row, 'login')).expiresAt) > Date.now()).length >= 128) throw identityError('LOGIN_LIMIT', 429);
        const pods = await this.lifecycle.pods(endpoint);
        if (pods.length !== 1 || !this.lifecycle.ready(pods[0])) throw identityError('DATABASE_NOT_READY', 503);
        const client = await this.lifecycle.admin(endpoint, pods[0], resource.spec.database || 'app');
        const suffix = randomBytes(12).toString('hex'), user = 'oidc_' + suffix, password = randomBytes(32).toString('base64url');
        const expires = Math.min(actor.expires, Math.floor(Date.now() / 1000) + 900), expiresAt = new Date(expires * 1000).toISOString();
        if (expires <= Math.floor(Date.now() / 1000) + 5) {await client.end(); throw identityError('TOKEN_NEAR_EXPIRY');}
        const secret = name + '-oidc-' + suffix, scram = verifier(password);
        const roles = this.rolesForClient(client);
        let created = false;
        try {
          await roles.PrepareTarget({role, database: resource.spec.database || 'app', owner: resource.spec.user || 'app_user', managedRole: actor.config.database.managedRole || 'app_runtime'});
          await roles.Create({user, verifier: scram, expiresAt, role}); created = true;
          this.leader.require();
          await this.api.create('secrets', {apiVersion: 'v1', kind: 'Secret', type: 'Opaque', metadata: {name: secret,
            labels: {'neon.klustr.io/oidc-login': 'true', 'neon.klustr.io/endpoint-uid': endpoint.uid}},
            stringData: {login: JSON.stringify({user, verifier: scram, expiresAt, database: name, databaseUID: resource.metadata.uid, endpointUID: endpoint.uid, targetRole: role,
              issuer: actor.issuer, subject: actor.subject, credentialId: secret,
              binding: current.spec.identity, policyRevision: createHash('sha256').update(JSON.stringify(actor.config)).digest('hex')})}});
          this.emit('oidc_database_login_issued', {database: name, databaseUID: resource.metadata.uid, endpointUID: endpoint.uid,
            issuer: actor.issuer, subject: actor.subject, user, credentialId: secret, role, expiresAt});
          return {user, password, expiresAt, database: resource.spec.database || 'app', host: endpoint.endpointId + '.' + this.connectionPolicy().domain, port: 5432, sslmode: 'verify-full'};
        } catch (error) {
          if (created) {
            try {await roles.Drop(user);}
            catch (cleanupError) {this.emit('oidc_login_rollback_deferred', {database: name, user, reason: cleanupError.code || 'ROLE_IN_USE'});}
          }
          throw error;
        } finally {await client.end();}
      });
    } finally {complete();}
  }
  /**
   * Resolve a previously issued SCRAM verifier for the authenticated internal proxy boundary.
   * Requires proxy service authorization by the caller; repository reads have no mutation or wake side effects.
   * Rejects changed database identity, expired credentials and policy revisions rather than reusing stale grants.
   * @param {import('../../domain/compute/ComputeSpecification.mjs').ComputeEndpoint} endpoint - Current managed endpoint identity.
   * @param {string} role - Generated SQL login being authenticated.
   * @returns {Promise<string | null>} Sensitive verifier for a current issued login, or null for a mismatch.
   * @throws {Error} When stored credential JSON, repository reads or serving-database admission fail.
   */
  async roleSecret(endpoint, role) {
    if (!/^oidc_[a-f0-9]{24}$/.test(role)) return null;
    const secret = await this.api.optional('secrets', endpoint.databaseResource + '-oidc-' + role.slice(5));
    if (!secret || secret.metadata.labels?.['neon.klustr.io/endpoint-uid'] !== endpoint.uid) return null;
    const login = JSON.parse(secretText(secret, 'login'));
    const database = await this.requireDatabase(endpoint.databaseResource);
    const policyRevision = createHash('sha256').update(JSON.stringify(this.connectionPolicy().identity || null)).digest('hex');
    if (!this.#identityMatches(login, database) || login.user !== role || login.endpointUID !== endpoint.uid || login.policyRevision !== policyRevision) return null;
    return login.verifier;
  }
  #identityMatches(login, database) {
    const expires = Date.parse(login.expiresAt);
    return Number.isFinite(expires) && expires > Date.now() && login.databaseUID === database.metadata.uid &&
      login.binding?.tenant === database.spec.identity?.tenant && login.binding?.project === database.spec.identity?.project;
  }
  /**
   * Retire expired issued logins on already-running computes, at most once per minute.
   * Requires active lease authorization; skips sleeping, missing and unready endpoints without waking them.
   * Side effects revoke/drop safe generated SQL logins and delete their UID-bound Secrets; customer-owned objects are never reassigned.
   * Provider and dependency failures emit deferred-cleanup facts and preserve retry evidence.
   * @returns {Promise<void>} Resolves after a bounded inventory pass or a busy/lease/interval skip.
   * @throws {Error} Only if the injected audit sink itself throws while reporting deferred work.
   */
  async cleanup() {
    if (this.busy || !this.leader.active || Date.now() - this.lastCleanup < 60000) return;
    this.busy = true; this.lastCleanup = Date.now();
    try {
      for (const secret of await this.api.list('secrets', 'neon.klustr.io/oidc-login=true')) {
        const login = JSON.parse(secretText(secret, 'login'));
        if (Date.parse(login.expiresAt) > Date.now()) continue;
        const endpoint = [...this.getEndpoints().values()].find(endpoint => endpoint.uid === login.endpointUID);
        if (!endpoint) continue; // Retain cleanup evidence rather than mutating another endpoint.
        await this.lifecycle.serialized(endpoint, async () => {
          const deployment = await this.api.optional('deployments', endpoint.name);
          if (!deployment?.spec.replicas) return; // Cleanup never wakes a sleeping database.
          const pods = await this.lifecycle.pods(endpoint); if (pods.length !== 1 || !this.lifecycle.ready(pods[0])) return;
          const client = await this.lifecycle.admin(endpoint, pods[0]);
          try {
            this.leader.require(); await this.rolesForClient(client).RevokeExpired(login.user);
            this.leader.require(); await this.api.request('DELETE', this.api.path('secrets', secret.metadata.name), {preconditions: {uid: secret.metadata.uid}});
          } catch (error) {
            // Never reassign/drop objects owned by a customer's expired login.
            if (error.code !== '2BP01') this.emit('oidc_login_cleanup_deferred', {database: login.database, reason: error.code || 'ROLE_IN_USE'});
          } finally {await client.end();}
        });
      }
    } catch {this.emit('oidc_login_cleanup_deferred', {reason: 'CLEANUP_UNAVAILABLE'});} finally {this.busy = false;}
  }
}
