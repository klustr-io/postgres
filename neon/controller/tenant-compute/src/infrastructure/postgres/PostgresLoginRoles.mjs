const Identifier = text => '"' + text.replaceAll('"', '""') + '"';
const Literal = text => "'" + text.replaceAll("'", "''") + "'";
/**
 * @typedef {Object} LoginRoleTarget
 * @property {string} role - Restricted target role.
 * @property {string} database - SQL database name.
 * @property {string} owner - SQL owner role for default privileges.
 * @property {string} managedRole - Explicit provider-managed runtime role.
 * @property {boolean} [nativeLogin] - Require direct OAuth LOGIN permission with no managed-role password.
 */
/**
 * @typedef {Object} LoginRoleDefinition
 * @property {string} user - Generated login identity.
 * @property {string} verifier - SCRAM verifier, never a plaintext password.
 * @property {string} expiresAt - Login expiry timestamp.
 * @property {string} role - Approved restricted target role.
 */
/**
 * @typedef {Object} LoginRoleCleanupFailure
 * @property {string} user - Generated SQL login whose cleanup was deferred.
 * @property {string} reason - Stable SQL cleanup failure code, never provider credentials.
 */
/**
 * @typedef {Object} PostgresLoginRolesDependencies
 * @property {import('pg').Client} client - Connected administrative SQL client.
 * @property {(event: string, fields: LoginRoleCleanupFailure) => void} emit - Bounded cleanup audit sink.
 */
/** PostgreSQL adapter for restricted ephemeral logins and provider-managed grants. */
export class PostgresLoginRoles {
  #client; #emit;
  /** @param {PostgresLoginRolesDependencies} dependencies - Connected SQL and audit ports. */
  constructor({client, emit}) {this.#client = client; this.#emit = emit;}
  /**
   * Prepare the managed role when selected and reject privileged role inheritance.
   * Requires role authorization by the owning application boundary; side effects create provider-owned grants and may enable passwordless native LOGIN.
   * @param {LoginRoleTarget} target - Authorized target role and ownership policy.
   * @returns {Promise<void>} Resolves only when the target is safe to grant.
   * @throws {Error} DATABASE_ROLE_NOT_AVAILABLE or provider failure.
   */
  async PrepareTarget({role, database, owner, managedRole, nativeLogin = false}) {
    const providerOwned = role === managedRole && await this.#prepareManagedRole(role, database, owner);
    const target = (await this.#client.query('SELECT rolname, rolcanlogin FROM pg_roles WHERE rolname=$1 AND NOT (rolsuper OR rolcreatedb OR rolcreaterole OR rolreplication OR rolbypassrls)', [role])).rows[0];
    const inherited = (await this.#client.query(`SELECT EXISTS (SELECT 1 FROM pg_roles privileged
      WHERE (rolsuper OR rolcreatedb OR rolcreaterole OR rolreplication OR rolbypassrls OR rolname IN ('neon_superuser','pg_read_server_files','pg_write_server_files','pg_execute_server_program'))
        AND pg_has_role($1::name, privileged.oid, 'MEMBER')) AS unsafe`, [role])).rows[0];
    if (!target || inherited?.unsafe !== false) throw Object.assign(Error('Restricted target role unavailable'), {code: 'DATABASE_ROLE_NOT_AVAILABLE', status: 403});
    if (nativeLogin && providerOwned) await this.#client.query(`ALTER ROLE ${Identifier(role)} LOGIN PASSWORD NULL`);
    else if (nativeLogin && target.rolcanlogin !== true) throw Object.assign(Error('OAuth role requires LOGIN'), {code: 'DATABASE_ROLE_NOT_AVAILABLE', status: 403});
  }
  async #prepareManagedRole(role, database, owner) {
    const existing = (await this.#client.query("SELECT shobj_description(oid,'pg_authid') AS marker FROM pg_roles WHERE rolname=$1", [role])).rows[0];
    if (!existing) {
      await this.#client.query(`CREATE ROLE ${Identifier(role)} NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS INHERIT`);
      await this.#client.query(`COMMENT ON ROLE ${Identifier(role)} IS 'klustr managed runtime data role'`);
    }
    if (existing && existing.marker !== 'klustr managed runtime data role') return false;
    await this.#client.query(`GRANT CONNECT ON DATABASE ${Identifier(database)} TO ${Identifier(role)}`);
    await this.#client.query(`GRANT USAGE ON SCHEMA public TO ${Identifier(role)}`);
    await this.#client.query(`GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO ${Identifier(role)}`);
    await this.#client.query(`GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO ${Identifier(role)}`);
    await this.#client.query(`ALTER DEFAULT PRIVILEGES FOR ROLE ${Identifier(owner)} IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO ${Identifier(role)}`);
    await this.#client.query(`ALTER DEFAULT PRIVILEGES FOR ROLE ${Identifier(owner)} IN SCHEMA public GRANT USAGE, SELECT ON SEQUENCES TO ${Identifier(role)}`);
    return true;
  }
  /**
   * Create an expiring login and grant only the approved inherited role.
   * Requires a previously authorized restricted target; side effects persist the expiring login and compensate failed grants by dropping it.
   * @param {LoginRoleDefinition} definition - Generated login and verifier.
   * @returns {Promise<void>} Resolves after the login and grant exist.
   * @throws {Error} On SQL failure; attempts compensating deletion if the grant fails.
   */
  async Create({user, verifier, expiresAt, role}) {
    await this.#client.query(`CREATE ROLE ${Identifier(user)} LOGIN INHERIT PASSWORD ${Literal(verifier)} VALID UNTIL ${Literal(expiresAt)}`);
    try {await this.#client.query(`GRANT ${Identifier(role)} TO ${Identifier(user)} WITH INHERIT TRUE, SET FALSE`);}
    catch (error) {
      try {await this.Drop(user);}
      catch (cleanupError) {this.#emit('oidc_login_rollback_deferred', {user, reason: cleanupError.code || 'ROLE_IN_USE'});}
      throw error;
    }
  }
  /**
   * Delete a generated login after failed credential publication.
   * Requires the owning application's authorization for its generated login; side effects execute DROP ROLE without reassigning owned objects.
   * @param {string} user - Generated SQL login.
   * @returns {Promise<void>} Resolves after role deletion.
   * @throws {Error} On SQL dependency conflicts or connection failure.
   */
  async Drop(user) {await this.#client.query(`DROP ROLE ${Identifier(user)}`);}
  /**
   * Revoke expired login access before attempting deletion; never reassign owned objects.
   * Requires cleanup authorization for an expired generated identity; side effects persist NOLOGIN before dropping the role or retaining cleanup evidence.
   * @param {string} user - Generated SQL login.
   * @returns {Promise<void>} Resolves after revocation and deletion.
   * @throws {Error} SQL dependency errors retain the NOLOGIN role for reviewed cleanup.
   */
  async RevokeExpired(user) {
    if (!/^oidc_[a-f0-9]{24}$/.test(user)) throw Error('Invalid login identity');
    await this.#client.query(`ALTER ROLE ${Identifier(user)} NOLOGIN`);
    await this.Drop(user);
  }
}
