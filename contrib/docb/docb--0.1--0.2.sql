/* Keep application columns, operators, indexes and wire types as JSONB. */
\echo Use "ALTER EXTENSION docb UPDATE TO '0.2'" to load this file. \quit

CREATE FUNCTION docb_is_delta(jsonb) RETURNS boolean
  AS 'MODULE_PATHNAME', 'docb_storage_is_delta'
  LANGUAGE C STABLE STRICT PARALLEL SAFE;

CREATE FUNCTION docb_is_jsonb_type(oid) RETURNS boolean
  AS 'MODULE_PATHNAME', 'docb_storage_is_jsonb_type'
  LANGUAGE C STABLE STRICT PARALLEL SAFE;

CREATE FUNCTION docb_rewrite_relation(regclass) RETURNS void
  AS 'MODULE_PATHNAME', 'docb_storage_rewrite_relation'
  LANGUAGE C VOLATILE STRICT PARALLEL UNSAFE;

/*
 * A table migration is atomic, including its write policy.  Taking the normal
 * rewrite lock prevents concurrent writers from reintroducing delta values
 * during a reverse migration.  The heap swap also removes old TOAST versions;
 * merely updating live rows or disabling a GUC would not establish that.
 */
CREATE PROCEDURE docb_migrate_table(
  target_table regclass,
  target_format text DEFAULT 'docb',
  include_descendants boolean DEFAULT true
)
LANGUAGE plpgsql
AS $procedure$
DECLARE
  target record;
  physical record;
  migrated integer := 0;
BEGIN
  IF target_table IS NULL OR target_format IS NULL OR
     target_format NOT IN ('docb', 'jsonb') OR include_descendants IS NULL THEN
    RAISE EXCEPTION 'Specify a table and target format docb or jsonb'
      USING ERRCODE = '22023';
  END IF;

  SELECT c.oid, c.relkind, n.nspname, c.relname INTO STRICT target
    FROM pg_catalog.pg_class c
    JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
    WHERE c.oid = target_table;
  IF target.relkind NOT IN ('r', 'p', 'm') OR
     target.nspname = 'information_schema' OR
     target.nspname LIKE 'pg\_%' ESCAPE '\' THEN
    RAISE EXCEPTION 'DOCB migration requires a user table or materialized view'
      USING ERRCODE = '0A000';
  END IF;

  /* The ALTER below locks materialized views; LOCK TABLE covers table trees. */
  IF target.relkind <> 'm' THEN
    EXECUTE pg_catalog.format('LOCK TABLE %s%I.%I IN ACCESS EXCLUSIVE MODE',
      CASE WHEN include_descendants THEN '' ELSE 'ONLY ' END,
      target.nspname, target.relname);
  END IF;

  FOR physical IN
    WITH RECURSIVE descendants(oid) AS (
      SELECT target_table::oid
      UNION
      SELECT i.inhrelid FROM pg_catalog.pg_inherits i
        JOIN descendants d ON d.oid = i.inhparent
        WHERE include_descendants
    )
    SELECT c.oid, c.relkind, c.relam, n.nspname, c.relname
      FROM descendants d JOIN pg_catalog.pg_class c ON c.oid = d.oid
      JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
      WHERE c.relkind <> 'p'
        AND EXISTS (SELECT 1 FROM pg_catalog.pg_attribute a
          WHERE a.attrelid = c.oid AND a.attnum > 0 AND NOT a.attisdropped
            AND pg_catalog.docb_is_jsonb_type(a.atttypid))
      ORDER BY c.oid
  LOOP
    IF physical.relkind NOT IN ('r', 'm') OR physical.relam <>
       (SELECT oid FROM pg_catalog.pg_am WHERE amname = 'heap') THEN
      RAISE EXCEPTION 'Unsupported access method for %.%', physical.nspname, physical.relname
        USING ERRCODE = '0A000';
    END IF;
    EXECUTE pg_catalog.format('ALTER %s %I.%I SET (jsonb_storage = %L)',
      CASE WHEN physical.relkind = 'm' THEN 'MATERIALIZED VIEW' ELSE 'TABLE ONLY' END,
      physical.nspname, physical.relname, target_format);
    PERFORM pg_catalog.docb_rewrite_relation(physical.oid::regclass);
    migrated := migrated + 1;
    RAISE NOTICE 'Migrated %.% to % storage', physical.nspname, physical.relname, target_format;
  END LOOP;
  IF migrated = 0 THEN
    RAISE NOTICE 'No physical JSONB tables found for %', target_table;
  END IF;
END
$procedure$;

/*
 * Invoke as a top-level CALL.  Each physical table is its own transaction;
 * completed tables remain complete if a later table fails or is cancelled.
 * Ownership checks remain those of the caller, never SECURITY DEFINER.
 */
CREATE PROCEDURE docb_migrate_database(
  target_format text DEFAULT 'docb',
  resume_after regclass DEFAULT NULL
)
LANGUAGE plpgsql
AS $procedure$
DECLARE
  physical record;
BEGIN
  IF target_format IS NULL OR target_format NOT IN ('docb', 'jsonb') THEN
    RAISE EXCEPTION 'Specify target format docb or jsonb' USING ERRCODE = '22023';
  END IF;
  EXECUTE pg_catalog.format('ALTER DATABASE %I SET docb.jsonb_storage = %L',
    pg_catalog.current_database(), target_format);
  PERFORM pg_catalog.set_config('docb.jsonb_storage', target_format, false);
  FOR physical IN
    SELECT c.oid, n.nspname, c.relname
      FROM pg_catalog.pg_class c
      JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
      JOIN pg_catalog.pg_am am ON am.oid = c.relam
      WHERE c.relkind IN ('r', 'm') AND c.relpersistence <> 't'
        AND (resume_after IS NULL OR c.oid > resume_after::oid)
        AND am.amname = 'heap'
        AND n.nspname <> 'information_schema'
        AND n.nspname NOT LIKE 'pg\_%' ESCAPE '\'
        AND EXISTS (SELECT 1 FROM pg_catalog.pg_attribute a
          WHERE a.attrelid = c.oid AND a.attnum > 0 AND NOT a.attisdropped
            AND pg_catalog.docb_is_jsonb_type(a.atttypid))
      ORDER BY c.oid
  LOOP
    CALL pg_catalog.docb_migrate_table(physical.oid::regclass, target_format, false);
    COMMIT;
    RAISE NOTICE 'Committed %.% (oid=%); resume_after can name this relation',
      physical.nspname, physical.relname, physical.oid;
  END LOOP;
END
$procedure$;
