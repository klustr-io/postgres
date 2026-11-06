CREATE FUNCTION bounded_commit_guard_status() RETURNS text
AS 'MODULE_PATHNAME', 'bounded_commit_guard_status' LANGUAGE C STRICT PARALLEL UNSAFE;
REVOKE ALL ON FUNCTION bounded_commit_guard_status() FROM PUBLIC;
CREATE FUNCTION bounded_commit_guard_drain() RETURNS pg_lsn
AS 'MODULE_PATHNAME', 'bounded_commit_guard_drain' LANGUAGE C STRICT PARALLEL UNSAFE;
REVOKE ALL ON FUNCTION bounded_commit_guard_drain() FROM PUBLIC;
