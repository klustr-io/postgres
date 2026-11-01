#!/bin/sh
set -eu
initdb -D /tmp/minimal-pg -A trust --data-checksums --locale=C.UTF-8 > /tmp/initdb.log 2>&1
pg_ctl -D /tmp/minimal-pg -l /tmp/postgres.log -o "-c listen_addresses='' -c unix_socket_directories=/tmp -c shared_preload_libraries=neon,pg_stat_statements" -w start
trap 'pg_ctl -D /tmp/minimal-pg -m immediate -w stop >/dev/null 2>&1 || true' EXIT
psql -h /tmp -d postgres -v ON_ERROR_STOP=1 <<'SQL'
CREATE EXTENSION pg_stat_statements;
CREATE EXTENSION pgcrypto;
CREATE EXTENSION xml2;
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
CHECKPOINT;
SQL
pg_ctl -D /tmp/minimal-pg -m fast -w stop
trap - EXIT
echo 'PASS minimal image: non-root initdb, preloaded Neon, SQL, crypto, XML/XSLT and clean shutdown'
