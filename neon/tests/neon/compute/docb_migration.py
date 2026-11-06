#!/usr/bin/env python3
"""Bounded reversible JSONB storage check: disposable tmpfs, no network or S3."""
import json
import os
from pathlib import Path
import subprocess
import tempfile

PG = os.environ.get('DOCB_MIGRATION_PG_BIN', '/opt/postgres/v18/bin/').rstrip('/') + '/'
FIXTURE = tempfile.TemporaryDirectory(prefix='docb-migration-',
    dir=os.environ.get('DOCB_MIGRATION_TMPDIR', '/var/lib/neon'))
ROOT = Path(FIXTURE.name)


def run(args, check=True):
    result = subprocess.run(args, text=True, capture_output=True, timeout=90)
    if check and result.returncode:
        raise RuntimeError(result.stderr[-4000:])
    return result


def sql(query, check=True):
    return run([PG+'psql', '-XqAt', '-h', '/tmp', '-U', 'tester', '-d', 'postgres',
                '-v', 'ON_ERROR_STOP=1', '-v', 'VERBOSITY=sqlstate', '-c', query], check)


def expect(query, result):
    actual = sql(query).stdout.strip()
    assert actual == result, (query, actual, result)


run([PG+'initdb', '-D', str(ROOT/'data'), '-A', 'trust', '-U', 'tester', '--no-locale'])
(ROOT/'data/postgresql.conf').write_text(
    "listen_addresses=''\nunix_socket_directories='/tmp'\nshared_buffers=32MB\n"
    "max_wal_size=128MB\nmin_wal_size=80MB\nfsync=on\nfull_page_writes=on\n")
run([PG+'pg_ctl', '-D', str(ROOT/'data'), '-l', str(ROOT/'postgres.log'), '-w', 'start'])
checks = []
try:
    sql("CREATE TABLE no_extension_documents(body jsonb); "
        "INSERT INTO no_extension_documents SELECT jsonb_build_object('n',0,'payload',"
        "string_agg(md5(i::text),'')) FROM generate_series(1,1024) i; "
        "UPDATE no_extension_documents SET body=jsonb_set(body,'{n}','1')")
    expect("SELECT body->>'n' FROM no_extension_documents", '1')
    sql("CREATE EXTENSION docb")
    expect("SELECT extversion FROM pg_extension WHERE extname='docb'", '0.2')
    expect('SELECT docb_is_delta(body) FROM no_extension_documents', 't')
    sql("DROP EXTENSION docb; CREATE EXTENSION docb VERSION '0.1'; "
        "ALTER EXTENSION docb UPDATE TO '0.2'")
    expect("SELECT extversion FROM pg_extension WHERE extname='docb'", '0.2')
    expect('SHOW docb.jsonb_storage', 'docb')
    checks.append('DOCB-backed JSONB without extension activation; fresh administrator extension and upgrade')
    sql("""
      CREATE TABLE documents(id int PRIMARY KEY, body jsonb) WITH (jsonb_storage=jsonb);
      INSERT INTO documents SELECT i, jsonb_build_object('n',0,'nested',
        jsonb_build_object('text','hello','items',jsonb_build_array(1,2,3)),
        'payload',(SELECT string_agg(md5(j::text),'') FROM generate_series(1,1024) j))
        FROM generate_series(1,4) i;
      CREATE INDEX documents_gin ON documents USING gin(body jsonb_path_ops);
      CREATE VIEW documents_view AS SELECT id,body->>'payload' AS payload FROM documents;
      CREATE TABLE expected AS SELECT id,md5(body::text) AS digest FROM documents;
      CREATE TABLE old_toast(oid oid, filenode oid);
      CREATE TABLE default_documents(id int, body jsonb);
      INSERT INTO default_documents SELECT * FROM documents;
      UPDATE default_documents SET body=jsonb_set(body,'{n}','1');
      CREATE SEQUENCE explain_probe;
    """)
    expect('SELECT bool_and(docb_is_delta(body)) FROM default_documents', 't')
    checks.append('new JSONB tables automatically use deltas on eligible updates')
    plan = json.loads(sql("EXPLAIN (VERBOSE, FORMAT JSON) SELECT nextval('explain_probe'), "
                          "body->>'n' FROM documents").stdout)[0]['Plan']
    assert plan['JSONB Write Storage'] == 'jsonb (table override)', plan
    assert 'docb_migrate_table' in plan['JSONB Storage Hint'], plan
    assert 'Not inspected' in plan['JSONB Stored Format'], plan
    expect('SELECT is_called FROM explain_probe', 'f')
    plain = sql("EXPLAIN SELECT body->>'n' FROM documents").stdout
    assert 'JSONB Storage Hint' not in plain, plain
    enabled = json.loads(sql("EXPLAIN (VERBOSE, FORMAT JSON) SELECT body->>'n' "
                             "FROM default_documents").stdout)[0]['Plan']
    assert 'JSONB Storage Hint' not in enabled, enabled
    inherited = json.loads(sql("SET docb.jsonb_storage='jsonb'; "
        "EXPLAIN (VERBOSE, FORMAT JSON) SELECT body->>'n' FROM default_documents").stdout)[0]['Plan']
    assert inherited['JSONB Write Storage'] == 'jsonb (session/database default)', inherited
    checks.append('EXPLAIN hints identify policy without executing queries or claiming physical migration state')
    sql("""
      CALL docb_migrate_table('documents','docb');
    """)
    expect("SELECT bool_and(pg_typeof(body)='jsonb'::regtype AND md5(body::text)=digest) "
           "FROM documents JOIN expected USING(id)", 't')
    sql("UPDATE documents SET body=jsonb_set(body,'{n}','1')")
    expect('SELECT bool_and(docb_is_delta(body)) FROM documents', 't')
    expect("SET docb.jsonb_storage='jsonb'; SELECT bool_and(body->'n'='1'::jsonb "
           "AND body#>>'{nested,text}'='hello' AND body['nested']['items'][2]='3'::jsonb "
           "AND body#>'{nested,items}'='[1,2,3]'::jsonb AND body->>'n'='1') FROM documents", 't')
    expect('SELECT bool_and(length(payload)=32768) FROM documents_view', 't')
    expect("SET enable_seqscan=off; SELECT count(*) FROM documents WHERE body @> '{\"n\":1}'", '4')
    checks.append('JSONB type, operators, subscripts, GIN and dependent view preserved')
    sql("BEGIN; CALL docb_migrate_table('documents','jsonb'); ROLLBACK")
    expect('SELECT bool_and(docb_is_delta(body)) FROM documents', 't')
    checks.append('rollback preserves delta storage and table policy')
    sql("INSERT INTO old_toast SELECT t.oid,t.relfilenode FROM pg_class c "
        "JOIN pg_class t ON t.oid=c.reltoastrelid WHERE c.oid='documents'::regclass; "
        "CALL docb_migrate_table('documents','jsonb')")
    expect('SELECT bool_and(NOT docb_is_delta(body)) FROM documents', 't')
    expect('SELECT bool_and(NOT EXISTS(SELECT 1 FROM pg_class c WHERE c.oid=o.oid '
           'AND c.relfilenode=o.filenode)) FROM old_toast o', 't')
    sql("SET docb.jsonb_storage='docb'; UPDATE documents SET body=jsonb_set(body,'{n}','2')")
    expect('SELECT bool_and(NOT docb_is_delta(body)) FROM documents', 't')
    checks.append('reverse rewrite replaces old TOAST storage and overrides enabled session default')
    sql("CREATE ROLE reader; GRANT SELECT ON documents TO reader")
    denied = sql("SET ROLE reader; CALL docb_migrate_table('documents','docb')", False)
    assert denied.returncode and '42501' in denied.stderr, denied.stderr
    invalid = sql("CALL docb_migrate_table('documents','invalid')", False)
    assert invalid.returncode and '22023' in invalid.stderr, invalid.stderr
    checks.append('unauthorized owner and invalid format rejected')
    sql("""
      CREATE TABLE partitioned(id int,body jsonb) PARTITION BY RANGE(id);
      CREATE TABLE partition_a PARTITION OF partitioned FOR VALUES FROM(0) TO(10);
      CREATE TABLE partition_b PARTITION OF partitioned FOR VALUES FROM(10) TO(20);
      INSERT INTO partitioned SELECT id,body FROM documents;
      INSERT INTO partitioned SELECT id+10,body FROM documents;
      CALL docb_migrate_table('partitioned','docb');
      UPDATE partitioned SET body=jsonb_set(body,'{n}','3');
      CREATE DOMAIN document_domain AS jsonb;
      CREATE TABLE domain_documents(id int,body document_domain);
      INSERT INTO domain_documents SELECT id,body FROM documents;
      CREATE MATERIALIZED VIEW document_cache AS SELECT * FROM documents;
    """)
    expect('SELECT bool_and(docb_is_delta(body)) FROM partitioned', 't')
    checks.append('partition-root migration')
    sql("CALL docb_migrate_database('docb')")
    sql("UPDATE domain_documents SET body=jsonb_set(body::jsonb,'{n}','4')")
    expect('SELECT bool_and(docb_is_delta(body::jsonb)) FROM domain_documents', 't')
    sql("CALL docb_migrate_database('docb','document_cache')")
    expect('SELECT bool_and(docb_is_delta(body::jsonb)) FROM domain_documents', 't')
    sql("CALL docb_migrate_database('jsonb')")
    expect('SHOW docb.jsonb_storage', 'jsonb')
    expect('SELECT bool_and(NOT docb_is_delta(body)) FROM partitioned', 't')
    expect('SELECT bool_and(NOT docb_is_delta(body::jsonb)) FROM domain_documents', 't')
    expect('SELECT bool_and(NOT docb_is_delta(body)) FROM document_cache', 't')
    checks.append('database migration both ways and explicit resume checkpoint, including domains and materialized views')
    run([PG+'pg_ctl', '-D', str(ROOT/'data'), '-m', 'immediate', '-w', 'stop'])
    run([PG+'pg_ctl', '-D', str(ROOT/'data'), '-l', str(ROOT/'postgres.log'), '-w', 'start'])
    expect("SELECT bool_and(body->>'n'='2') FROM documents", 't')
    checks.append('immediate restart after reverse migration')
    print(json.dumps({'status':'PASS','checks':checks,
                      'scope':'Small local tmpfs fixture; no Neon storage, S3, performance or production qualification'}, indent=2))
finally:
    run([PG+'pg_ctl', '-D', str(ROOT/'data'), '-m', 'immediate', '-w', 'stop'], False)
    FIXTURE.cleanup()
