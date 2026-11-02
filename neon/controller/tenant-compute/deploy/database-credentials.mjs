// OIDC access-token exchange for ordinary TLS/SCRAM PostgreSQL clients.
import {randomBytes, pbkdf2Sync, createHmac, createHash, randomUUID} from 'node:crypto';
import {secretText} from '../config.mjs';
import {identityError} from './identity.mjs';
const identifier = text => '"' + text.replaceAll('"', '""') + '"';
const literal = text => "'" + text.replaceAll("'", "''") + "'";
function verifier(password) {
  const salt = randomBytes(16), salted = pbkdf2Sync(password, salt, 4096, 32, 'sha256');
  return `SCRAM-SHA-256$4096:${salt.toString('base64')}$${createHash('sha256').update(createHmac('sha256', salted).update('Client Key').digest()).digest('base64')}:${createHmac('sha256', salted).update('Server Key').digest('base64')}`;
}
export class DatabaseCredentials {
  constructor({api, leader, databases, identity, lifecycle, getEndpoints, emit}) {Object.assign(this, {api, leader, databases, identity, lifecycle, getEndpoints, emit}); this.busy = false; this.issued = 0; this.lastCleanup = 0;}
  async exchange(request, name, {role} = {}) {
    if (typeof role !== 'string' || !/^[a-z][a-z0-9_]{0,62}$/.test(role)) throw identityError('INVALID_ROLE', 422);
    await this.identity.authenticate(request, 'database');
    const resource = await this.databases.assertAvailable(name);
    let actor = await this.identity.database(request, resource, role); // Authenticate before any wake.
    const complete = this.databases.beginConnection(name);
    try {
      if (this.databases.fleet) await this.databases.fleet.ensureActive();
      const endpoint = [...this.getEndpoints().values()].find(endpoint => endpoint.databaseResource === name);
      if (!endpoint) throw identityError('DATABASE_NOT_READY', 503);
      await this.databases.event(name, {id: 'identity-' + randomUUID(), holdSeconds: 5});
      await this.lifecycle.wake(endpoint);
      return await this.lifecycle.serialized(endpoint, async () => {
        this.leader.require(); await this.databases.assertAvailable(name);
        actor = await this.identity.database(request, await this.api.get('neondatabases', name), role);
        const existing = await this.api.list('secrets', 'neon.klustr.io/oidc-login=true');
        if (existing.filter(row => row.metadata.labels['neon.klustr.io/endpoint-uid'] === endpoint.uid && Date.parse(JSON.parse(secretText(row, 'login')).expiresAt) > Date.now()).length >= 128) throw identityError('LOGIN_LIMIT', 429);
        const pods = await this.lifecycle.pods(endpoint);
        if (pods.length !== 1 || !this.lifecycle.ready(pods[0])) throw identityError('DATABASE_NOT_READY', 503);
        const client = await this.lifecycle.admin(endpoint, pods[0], resource.spec.database || 'app');
        const suffix = randomBytes(12).toString('hex'), user = 'oidc_' + suffix, password = randomBytes(32).toString('base64url');
        const expires = Math.min(actor.expires, Math.floor(Date.now() / 1000) + 900), expiresAt = new Date(expires * 1000).toISOString();
        if (expires <= Math.floor(Date.now() / 1000) + 5) {await client.end(); throw identityError('TOKEN_NEAR_EXPIRY');}
        const secret = name + '-oidc-' + suffix, scram = verifier(password);
        let created = false;
        try {
          const managedRole = actor.config.database.managedRole || 'app_runtime';
          if (role === managedRole) {
            const existing = (await client.query("SELECT shobj_description(oid,'pg_authid') AS marker FROM pg_roles WHERE rolname=$1", [role])).rows[0];
            if (!existing) {
              await client.query(`CREATE ROLE ${identifier(role)} NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS INHERIT`);
              await client.query(`COMMENT ON ROLE ${identifier(role)} IS 'klustr managed runtime data role'`);
            }
            if (!existing || existing.marker === 'klustr managed runtime data role') {
              await client.query(`GRANT CONNECT ON DATABASE ${identifier(resource.spec.database || 'app')} TO ${identifier(role)}`);
              await client.query(`GRANT USAGE ON SCHEMA public TO ${identifier(role)}`);
              await client.query(`GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO ${identifier(role)}`);
              await client.query(`GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO ${identifier(role)}`);
              const owner = identifier(resource.spec.user || 'app_user');
              await client.query(`ALTER DEFAULT PRIVILEGES FOR ROLE ${owner} IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO ${identifier(role)}`);
              await client.query(`ALTER DEFAULT PRIVILEGES FOR ROLE ${owner} IN SCHEMA public GRANT USAGE, SELECT ON SEQUENCES TO ${identifier(role)}`);
            }
          }
          const target = (await client.query('SELECT rolname FROM pg_roles WHERE rolname=$1 AND NOT (rolsuper OR rolcreaterole OR rolreplication OR rolbypassrls)', [role])).rows[0];
          if (!target) throw identityError('DATABASE_ROLE_NOT_AVAILABLE', 403);
          const inherited = (await client.query(`SELECT EXISTS (SELECT 1 FROM pg_roles privileged
            WHERE (rolsuper OR rolcreaterole OR rolreplication OR rolbypassrls OR rolname IN ('neon_superuser','pg_read_server_files','pg_write_server_files','pg_execute_server_program'))
              AND pg_has_role($1::name, privileged.oid, 'MEMBER')) AS unsafe`, [role])).rows[0];
          if (inherited.unsafe) throw identityError('DATABASE_ROLE_NOT_AVAILABLE', 403);
          await client.query(`CREATE ROLE ${identifier(user)} LOGIN INHERIT PASSWORD ${literal(scram)} VALID UNTIL ${literal(expiresAt)}`); created = true;
          await client.query(`GRANT ${identifier(role)} TO ${identifier(user)} WITH INHERIT TRUE, SET FALSE`);
          this.leader.require();
          await this.api.create('secrets', {apiVersion: 'v1', kind: 'Secret', type: 'Opaque', metadata: {name: secret,
            labels: {'neon.klustr.io/oidc-login': 'true', 'neon.klustr.io/endpoint-uid': endpoint.uid}},
            stringData: {login: JSON.stringify({user, verifier: scram, expiresAt, database: name, databaseUID: resource.metadata.uid, endpointUID: endpoint.uid, targetRole: role,
              binding: resource.spec.identity, policyRevision: createHash('sha256').update(JSON.stringify(actor.config)).digest('hex')})}});
          this.emit('oidc_database_login_issued', {database: name, subject: actor.subject, role, expiresAt});
          return {user, password, expiresAt, database: resource.spec.database || 'app', host: endpoint.endpointId + '.' + this.databases.base().domain, port: 5432, sslmode: 'verify-full'};
        } catch (error) {
          if (created) try {await client.query(`DROP ROLE ${identifier(user)}`);} catch {}
          throw error;
        } finally {await client.end();}
      });
    } finally {complete();}
  }
  async roleSecret(endpoint, role) {
    if (!/^oidc_[a-f0-9]{24}$/.test(role)) return null;
    const secret = await this.api.optional('secrets', endpoint.databaseResource + '-oidc-' + role.slice(5));
    if (!secret || secret.metadata.labels?.['neon.klustr.io/endpoint-uid'] !== endpoint.uid) return null;
    const login = JSON.parse(secretText(secret, 'login'));
    const database = await this.databases.assertAvailable(endpoint.databaseResource);
    const policyRevision = createHash('sha256').update(JSON.stringify(this.databases.base().identity || null)).digest('hex');
    if (login.user !== role || login.endpointUID !== endpoint.uid || login.databaseUID !== database.metadata.uid || Date.parse(login.expiresAt) <= Date.now() || login.policyRevision !== policyRevision ||
        login.binding?.tenant !== database.spec.identity?.tenant || login.binding?.project !== database.spec.identity?.project) return null;
    return login.verifier;
  }
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
            if (!/^oidc_[a-f0-9]{24}$/.test(login.user)) throw Error('Invalid login identity');
            this.leader.require(); await client.query(`ALTER ROLE ${identifier(login.user)} NOLOGIN`);
            await client.query(`DROP ROLE ${identifier(login.user)}`);
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
