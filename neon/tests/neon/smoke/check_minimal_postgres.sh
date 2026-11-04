#!/bin/sh
set -eu
initdb -D /tmp/minimal-pg -A trust --data-checksums --locale=C.UTF-8 > /tmp/initdb.log 2>&1
start() {
  pg_ctl -D /tmp/minimal-pg -l /tmp/postgres.log -o "-c listen_addresses='' -c unix_socket_directories=/tmp -c max_worker_processes=32 -c shared_preload_libraries=neon,timescaledb,anon,pg_textsearch,pg_stat_statements" -w start || { cat /tmp/postgres.log; exit 1; }
}
start
trap 'pg_ctl -D /tmp/minimal-pg -m immediate -w stop >/dev/null 2>&1 || true' EXIT
psql -h /tmp -d postgres -v ON_ERROR_STOP=1 <<'SQL'
CREATE EXTENSION IF NOT EXISTS pg_stat_statements;
CREATE EXTENSION pgcrypto;
CREATE EXTENSION xml2;
CREATE EXTENSION anon;
CREATE EXTENSION datasketches;
CREATE EXTENSION vector;
CREATE EXTENSION timescaledb;
CREATE EXTENSION pg_textsearch;
SELECT anon.init();
ALTER DATABASE postgres SET anon.transparent_dynamic_masking = on;
CREATE TABLE masked_people (email text);
INSERT INTO masked_people VALUES ('private@example.test');
SECURITY LABEL FOR anon ON COLUMN masked_people.email IS 'MASKED WITH VALUE $$hidden$$';
CREATE ROLE masked_reader LOGIN;
GRANT SELECT ON masked_people TO masked_reader;
SECURITY LABEL FOR anon ON ROLE masked_reader IS 'MASKED';

CREATE TABLE search_documents (id integer PRIMARY KEY, content text);
INSERT INTO search_documents VALUES (1, 'PostgreSQL searchable database'), (2, 'vector similarity'), (3, 'time series');
CREATE INDEX documents_fts ON search_documents USING gin (to_tsvector('english', content));
CREATE INDEX documents_bm25 ON search_documents USING bm25 (content) WITH (text_config='english');
CREATE TABLE embeddings (id integer PRIMARY KEY, embedding vector(3));
INSERT INTO embeddings SELECT n, ARRAY[n::real,0,0]::vector FROM generate_series(1,100) n;
CREATE INDEX embeddings_hnsw ON embeddings USING hnsw (embedding vector_l2_ops);
CREATE TABLE events (time timestamptz NOT NULL, value integer);
SELECT create_hypertable('events', by_range('time'));
INSERT INTO events VALUES ('2026-01-01T00:00:00Z', 10), ('2026-01-01T00:01:00Z', 20);
SET enable_seqscan = off;
EXPLAIN SELECT id FROM search_documents WHERE to_tsvector('english',content) @@ plainto_tsquery('english','database');
EXPLAIN SELECT id FROM search_documents ORDER BY content <@> 'database' LIMIT 1;
EXPLAIN SELECT id FROM embeddings ORDER BY embedding <-> '[3,0,0]' LIMIT 1;
CREATE TABLE minimal_runtime_probe (id integer PRIMARY KEY, payload text);
INSERT INTO minimal_runtime_probe SELECT n, repeat(md5(n::text), 100) FROM generate_series(1,1000) n;
SELECT count(*) = 1000 AS data_verified FROM minimal_runtime_probe;
DO $$BEGIN
  IF (SELECT count(*) FROM minimal_runtime_probe) <> 1000 THEN
    RAISE EXCEPTION 'SQL data verification failed';
  END IF;
  IF encode(digest('abc', 'sha256'), 'hex') <>
      'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad' THEN
    RAISE EXCEPTION 'OpenSSL-backed digest failed';
  END IF;
  IF NOT xpath_exists('/root/item', '<root><item>ok</item></root>'::xml) THEN
    RAISE EXCEPTION 'XML parser unavailable';
  END IF;
  IF xslt_process('<root><item>verified</item></root>',
    '<xsl:stylesheet version="1.0" xmlns:xsl="http://www.w3.org/1999/XSL/Transform"><xsl:output method="text"/><xsl:template match="/"><xsl:value-of select="root/item"/></xsl:template></xsl:stylesheet>') <> 'verified' THEN
    RAISE EXCEPTION 'XSLT transform failed';
  END IF;
END$$;
DO $$BEGIN
  IF anon.is_initialized() IS DISTINCT FROM true OR anon.dummy_last_name() IS NULL THEN
    RAISE EXCEPTION 'Anonymizer data files unavailable';
  END IF;
  IF (SELECT id FROM search_documents WHERE to_tsvector('english',content) @@ plainto_tsquery('english','database')) IS DISTINCT FROM 1 THEN
    RAISE EXCEPTION 'Full-text search failed';
  END IF;
  IF (SELECT id FROM search_documents ORDER BY content <@> 'database' LIMIT 1) IS DISTINCT FROM 1 THEN
    RAISE EXCEPTION 'BM25 ranking failed';
  END IF;
  IF (SELECT id FROM embeddings ORDER BY embedding <-> '[3,0,0]' LIMIT 1) IS DISTINCT FROM 3 THEN
    RAISE EXCEPTION 'HNSW vector search failed';
  END IF;
  IF coalesce((SELECT hll_sketch_get_estimate(hll_sketch_build(n)) FROM generate_series(1,100) n), -1) NOT BETWEEN 95 AND 105 THEN
    RAISE EXCEPTION 'HLL sketch aggregation failed';
  END IF;
  IF coalesce((SELECT kll_float_sketch_get_quantile(kll_float_sketch_build(n::real),0.5) FROM generate_series(1,100) n), -1) NOT BETWEEN 45 AND 55 THEN
    RAISE EXCEPTION 'KLL sketch aggregation failed';
  END IF;
  IF (SELECT sum(value) FROM events WHERE time_bucket(INTERVAL '1 hour',time) = '2026-01-01T00:00:00Z'::timestamptz) IS DISTINCT FROM 30::bigint THEN
    RAISE EXCEPTION 'Hypertable time bucketing failed';
  END IF;
END$$;
DROP INDEX embeddings_hnsw;
CREATE INDEX embeddings_ivfflat ON embeddings USING ivfflat (embedding vector_l2_ops) WITH (lists=4);
DO $$BEGIN
  IF (SELECT id FROM embeddings ORDER BY embedding <-> '[3,0,0]' LIMIT 1) IS DISTINCT FROM 3 THEN
    RAISE EXCEPTION 'IVFFlat vector search failed';
  END IF;
END$$;
CHECKPOINT;
SQL
# Verify masking through an ordinary non-superuser connection, including restart.
test "$(psql -h /tmp -U masked_reader -d postgres -Atqc 'SELECT email FROM masked_people')" = hidden
pg_ctl -D /tmp/minimal-pg -m fast -w stop
start
test "$(psql -h /tmp -U masked_reader -d postgres -Atqc 'SELECT email FROM masked_people')" = hidden
test "$(psql -h /tmp -d postgres -Atqc "SET enable_seqscan=off; SELECT id FROM search_documents ORDER BY content <@> 'database' LIMIT 1")" = 1
test "$(psql -h /tmp -d postgres -Atqc "SET enable_seqscan=off; SELECT id FROM embeddings ORDER BY embedding <-> '[3,0,0]' LIMIT 1")" = 3
pg_ctl -D /tmp/minimal-pg -m fast -w stop
trap - EXIT
echo 'PASS minimal image: non-root Neon, masking, sketches, FTS, BM25, HNSW/IVFFlat, hypertables, crypto, XML/XSLT and restart'
