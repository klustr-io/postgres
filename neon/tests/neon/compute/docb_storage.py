#!/usr/bin/env python3
"""Native DOCB correctness and bounded RAM-only JSONB comparison.

The fixture owns only its temporary directory. No external storage or volumes.
Run in the source-built diagnostic image; results are not durability qualification.
"""
import json
import hashlib
import os
from pathlib import Path
import re
import signal
import socket
import subprocess
import time
import tomllib

PG = '/opt/postgres/v18/bin/'
RAW = '/opt/upstream/v18/bin/'
ROOT = Path('/var/lib/neon/docb')
ROOT.mkdir(parents=True)
DATA = ROOT / 'pgdata'
PORT = '15432'
ephemeral_low, ephemeral_high = map(int, Path('/proc/sys/net/ipv4/ip_local_port_range').read_text().split())
assert all(not ephemeral_low <= port <= ephemeral_high for port in range(15432,15438)), 'Fixture listeners must avoid ephemeral client ports'
ENGINE = os.environ.get('DOCB_ENGINE', 'native')
assert ENGINE in ('native', 'neon')
PROFILE = os.environ.get('DOCB_COMMIT_PROFILE', 'durable')
assert PROFILE in ('durable', 'best-effort') and (PROFILE == 'durable' or ENGINE == 'neon')
FAST = PROFILE == 'best-effort'
USER = 'cloud_admin' if ENGINE == 'neon' else 'tester'
checks = []


def command(args, timeout=90, check=True):
    result = subprocess.run(args, capture_output=True, text=True, timeout=timeout)
    if check and result.returncode:
        raise RuntimeError(f'{args[:3]}: {result.stdout[-1500:]} {result.stderr[-3000:]}')
    return result


def sql(statement):
    return command([PG+'psql', '-XqAt', '-v', 'ON_ERROR_STOP=1', '-h', '127.0.0.1',
                    '-p', PORT, '-U', USER, '-d', 'postgres', '-c', statement]).stdout.strip()


def expect(statement, expected='t'):
    actual = sql(statement)
    assert actual == expected, (statement, actual, expected)


BASE = """
listen_addresses='127.0.0.1'
port=15432
shared_buffers=256MB
max_connections=32
wal_level=logical
max_wal_size=128MB
min_wal_size=80MB
checkpoint_timeout=30min
fsync=on
synchronous_commit=on
full_page_writes=on
jit=off
"""


def local(*args):
    return command(['neon_local', *args])


def neon_config():
    return BASE+"neon.max_file_cache_size='128MB'\nneon.file_cache_size_limit='128MB'\n"+(
        'fsync=off\nsynchronous_commit=off\nneon.bounded_async_commit=on\nneon.best_effort_commit=on\n' if FAST else '')


def sync_barrier():
    if FAST:
        sql("SET synchronous_commit=on; SELECT pg_logical_emit_message(true,'docb-fixture-barrier','quorum')")


def start():
    if ENGINE == 'native':
        command([PG+'initdb', '-D', str(DATA), '-U', USER, '-A', 'trust', '--locale=C.UTF-8'])
        with (DATA/'postgresql.conf').open('a') as config:
            config.write(BASE)
        command([PG+'pg_ctl', '-D', str(DATA), '-l', str(ROOT/'postgres.log'), '-w', 'start'])
    else:
        os.environ.update(NEON_REPO_DIR=str(ROOT/'neon'), POSTGRES_DISTRIB_DIR='/opt/postgres',
                          LANG='C.UTF-8', LC_ALL='C.UTF-8', TZ='UTC')
        config = ROOT/'init.toml'
        config.write_text('''pg_distrib_dir="/opt/postgres"
neon_distrib_dir="/usr/local/bin"
default_tenant_id="20000000000000000000000000000001"
generate_local_ssl_certs=false
control_plane_api="http://127.0.0.1:1234/upcall/v1/"
[broker]
listen_addr="127.0.0.1:15051"
[endpoint_storage]
listen_addr="127.0.0.1:9993"
[[pageservers]]
id=1
listen_pg_addr="127.0.0.1:6400"
listen_http_addr="127.0.0.1:9898"
pg_auth_type="NeonJWT"
http_auth_type="NeonJWT"
grpc_auth_type="NeonJWT"
no_sync=false
virtual_file_io_engine="std-fs"
page_cache_size=32768
disk_usage_based_eviction={enabled=false}
''' + '\n'.join(f'''[[safekeepers]]
id={i}
pg_port={5453+i}
http_port={7675+i}
sync=true
auth_enabled=true
''' for i in (1, 2, 3)))
        local('init', '--config', str(config))
        generated = tomllib.loads((ROOT/'neon/pageserver_1/pageserver.toml').read_text())
        assert generated['disk_usage_based_eviction']['enabled'] is False
        local('start', '--start-timeout', '60s')
        local('tenant', 'create', '--pg-version', '18', '--set-default',
              '-c', 'checkpoint_distance:67108864', '-c', 'checkpoint_timeout:300s')
        local('endpoint', 'create', 'bench', '--branch-name', 'main', '--pg-version', '18',
              '--pg-port', PORT, '--external-http-port', '15433', '--internal-http-port', '15434', '--update-catalog')
        with (ROOT/'neon/endpoints/bench/postgresql.conf').open('a') as output:
            output.write(neon_config())
        # Reproduce the observed bind failure with a reserved, non-listening port.
        # The runtime must exit before starting Postgres, not detach a panicking task.
        occupied = socket.socket(socket.AF_INET6, socket.SOCK_STREAM)
        occupied.bind(('::',15433))
        failed_started = time.monotonic()
        try:
            failed = command(['neon_local','endpoint','start','bench','--dev','--start-timeout','2s'],timeout=10,check=False)
            assert failed.returncode != 0
            assert 'failed to bind compute_ctl external HTTP server' in (ROOT/'neon/endpoints/bench/compute.log').read_text()
            assert not (ROOT/'neon/endpoints/bench/pgdata/postmaster.pid').exists()
        finally:
            occupied.close()
        report['listener_bind_failure_ms'] = (time.monotonic()-failed_started)*1000
        checks.append('Occupied control port fails startup before PostgreSQL rather than hanging readiness')
        local('endpoint', 'start', 'bench', '--dev')
        assert 'walproposer' in sql('SHOW synchronous_standby_names')


class Session:
    def __init__(self):
        self.process = subprocess.Popen([PG+'psql','-XqAt','-v','ON_ERROR_STOP=1',
            '-h','127.0.0.1','-p',PORT,'-U',USER,'postgres'], stdin=subprocess.PIPE,
            stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True, bufsize=1)

    def run(self, statement):
        self.process.stdin.write(statement+';\n\\echo _DOCB_DONE_\n')
        self.process.stdin.flush()
        output = []
        while True:
            line = self.process.stdout.readline()
            assert line, output
            if line.strip() == '_DOCB_DONE_':
                return '\n'.join(output).strip()
            output.append(line.strip())

    def close(self):
        self.process.stdin.close()
        self.process.wait(timeout=5)


report = {'status':'RUNNING','engine':ENGINE,'commit_profile':PROFILE,'checks':checks,'results':[],'projections':[],
          'wake_samples':[],
          'guard_source_sha256':hashlib.sha256(Path('/source/pgxn/neon/bounded_commit_guard.c').read_bytes()).hexdigest(),
          'docb_source_sha256':hashlib.sha256(Path('/pgsource/v18/src/backend/utils/adt/docb.c').read_bytes()).hexdigest(),
          'docb_module_sha256':hashlib.sha256(Path('/pgsource/v18/contrib/docb/docb.c').read_bytes()).hexdigest(),
          'docb_sql_sha256':hashlib.sha256(Path('/opt/postgres/v18/share/extension/docb--0.1.sql').read_bytes()).hexdigest()}
try:
    start()
    sql("CREATE TABLE legacy_compression(p text COMPRESSION pglz,l text COMPRESSION lz4); "
        "INSERT INTO legacy_compression SELECT repeat('compressible-payload',1000),repeat('compressible-payload',1000)")
    expect("SELECT pg_column_compression(p)='pglz' AND pg_column_compression(l)='lz4' "
           "AND length(p)=20000 AND l=p FROM legacy_compression")
    sql('DROP TABLE legacy_compression')
    sql('CREATE EXTENSION docb')
    expect("SELECT pg_column_compression('{}'::docb) IS NULL")
    expect("SELECT pg_typeof(jsonb_set('{}','{x}','1'))='jsonb'::regtype")
    expect("SELECT jsonb('{\"x\":1}') = '{\"x\":1}'::jsonb")
    expect("SELECT (to_jsonb('{\"x\":1}'::docb)->>'x')='1' AND "
           "(jsonb_build_object('d','{\"x\":1}'::docb)#>>'{d,x}')='1'")
    expect("SELECT '{\"a\":1,\"b\":[null,true,\"hi\",{\"c\":2}]}'::docb::jsonb = "
           "'{\"a\":1,\"b\":[null,true,\"hi\",{\"c\":2}]}'::jsonb")
    sql("CREATE TABLE docs(id int PRIMARY KEY, body docb); "
        "CREATE TABLE reference(id int PRIMARY KEY, body jsonb); "
        "CREATE TEMP TABLE seed AS SELECT jsonb_build_object('counter',0,'nested',"
        "jsonb_build_object('score',7,'list',jsonb_build_array(null,true,'text',1.5)),"
        "'payload',string_agg(md5(i::text),'') ) b FROM generate_series(1,2048) i; "
        "INSERT INTO docs SELECT i,b::docb FROM seed CROSS JOIN generate_series(1,64) i; "
        "INSERT INTO reference SELECT id,body::jsonb FROM docs;")
    checks.append('Canonical JSON text input and explicit JSONB casts')
    sql("CREATE TABLE relational(body docb PRIMARY KEY); "
        "INSERT INTO relational VALUES ('{\"x\":1}'),('{\"x\":2}'); "
        "CREATE INDEX relational_hash ON relational USING hash(body); "
        "CREATE INDEX relational_gin ON relational USING gin(body)")
    expect("SET enable_seqscan=off; SELECT count(*)=2 FROM relational WHERE body ? 'x'")
    expect("SET enable_seqscan=off; SELECT count(*)=1 FROM relational WHERE body @? '$.x ? (@ == 2)'")
    expect("SELECT count(DISTINCT body)=2 FROM relational")
    expect("SELECT jsonb_array_length('[1,2]'::docb)=2 AND jsonb_typeof('{}'::docb)='object'")
    sql('DROP TABLE relational')
    checks.append('B-tree, hash, GIN, JSONPath and existing JSON functions accept DOCB without literal ambiguity')
    expect("SELECT bool_and(d.body::jsonb = r.body) FROM docs d JOIN reference r USING(id)")
    for path in ('{counter}', '{nested,score}', '{nested,list,0}', '{nested,list,-1}',
                 '{nested,list,2}', '{missing}', '{}', '{nested,missing}', '{nested,list,x}'):
        expect(f"SELECT bool_and((d.body #> '{path}')::jsonb IS NOT DISTINCT FROM "
               f"(r.body #> '{path}')) FROM docs d JOIN reference r USING(id)")
        expect(f"SELECT bool_and((d.body #>> '{path}') IS NOT DISTINCT FROM "
               f"(r.body #>> '{path}')) FROM docs d JOIN reference r USING(id)")
    checks.append('Selective paths match JSONB for objects, arrays, nulls, scalars and missing keys')
    sql("CREATE TABLE varied AS SELECT value AS expected,value::docb AS body FROM "
        "(SELECT jsonb_build_object('many',jsonb_object_agg('key'||lpad(i::text,3,'0'),i::numeric/7),"
        "'payload',repeat('0123456789abcdef',4096)) value FROM generate_series(1,160) i) s")
    for path, replacement in (('{many,key001}', '\"Unicode café 😀 and a longer string\"'),
                              ('{many,key120}', '[1,2,null,{\"nested\":true}]'),
                              ('{many,newkey}', '{\"added\":3}'),
                              ('{many,key079}', 'false')):
        sql(f"UPDATE varied SET body=jsonb_set(body,'{path}','{replacement}'::jsonb),"
            f"expected=jsonb_set(expected,'{path}','{replacement}'::jsonb,true)")
        expect('SELECT body::jsonb=expected FROM varied')
        expect("SELECT bool_and((body #> ARRAY['many','key'||lpad(i::text,3,'0')])::jsonb "
               "IS NOT DISTINCT FROM (expected #> ARRAY['many','key'||lpad(i::text,3,'0')])) "
               "FROM varied CROSS JOIN generate_series(1,160) i")
    sql('DROP TABLE varied')
    checks.append('Wide metadata, length-changing edits, Unicode, arrays and added keys match JSONB')
    sql("CREATE TABLE tail_edits AS SELECT value::docb body,value expected FROM "
        "(SELECT jsonb_build_object('payload',string_agg(md5(i::text),''),'zzzzzz_tail','old') value "
        "FROM generate_series(1,2048) i) s")
    sql('CHECKPOINT')
    tail_start = sql('SELECT pg_current_wal_insert_lsn()')
    for number in range(1, 26):
        replacement = 'changed-'+str(number)+'-'+'x'*(number*7%193)
        sql(f"UPDATE tail_edits SET body=jsonb_set(body,'{{zzzzzz_tail}}','\"{replacement}\"'::jsonb)")
        expect("SELECT body->>'zzzzzz_tail' FROM tail_edits", replacement)
        expect("SELECT body->>'payload'=expected->>'payload' FROM tail_edits")
    tail_wal = int(sql(f"SELECT pg_wal_lsn_diff(pg_current_wal_insert_lsn(),'{tail_start}')::bigint"))/25
    expect("SELECT pg_column_compression(body)='docb_delta' FROM tail_edits")
    assert tail_wal < 16384, tail_wal
    sql('DROP TABLE tail_edits')
    checks.append('Length-changing tail edits reuse the intervening 64 KiB payload; amortized WAL stays below 16 KiB/update')
    expect("SELECT bool_and((body['nested']['list'][2])::jsonb = '\"text\"'::jsonb) FROM docs")
    expect("SELECT bool_and((body->'nested'->'list'->2)::jsonb = '\"text\"'::jsonb "
           "AND body->'nested'->'list'->>-1 = '1.5') FROM docs")
    expect("SELECT ('{\"a\":{\"0\":7}}'::docb->'a'->0) IS NULL")
    expect("SELECT ('{\"a\":[7]}'::docb->'a'->'0') IS NULL")
    plan = sql("EXPLAIN (VERBOSE, COSTS OFF) SELECT body->'nested'->'list'->>-1 FROM docs")
    assert 'docb_project_chain_text' in plan, plan
    checks.append('Planner fuses ordinary operator chains while preserving object/array step semantics')
    sql("UPDATE docs SET body['counter']='1'::jsonb")
    sql("UPDATE reference SET body['counter']='1'::jsonb")
    for iteration in range(1, 20):
        sql(f"UPDATE docs SET body=jsonb_set(body,'{{counter}}','{iteration}'::jsonb) WHERE id=1; "
            f"UPDATE reference SET body=jsonb_set(body,'{{counter}}','{iteration}'::jsonb,true) WHERE id=1")
        expect("SELECT bool_and(d.body::jsonb = r.body AND d.body->>'counter'=r.body->>'counter') "
               "FROM docs d JOIN reference r USING(id)")
    expect("SELECT bool_and(pg_column_compression(body)='docb_delta') FROM docs")
    checks.append('Delta updates, projection from deltas and consolidated base reuse')
    original_chunk = sql('SELECT pg_column_toast_chunk_id(body) FROM docs WHERE id=1')
    sql("UPDATE docs SET body=jsonb_set(body,'{counter}','19'::jsonb) WHERE id=1")
    expect('SELECT pg_column_toast_chunk_id(body) FROM docs WHERE id=1', original_chunk)
    session = Session()
    try:
        session.run('BEGIN ISOLATION LEVEL REPEATABLE READ')
        before = session.run('SELECT md5(body::text) FROM docs WHERE id=1')
        for number in range(20, 40):
            sql(f"UPDATE docs SET body=jsonb_set(body,'{{counter}}','{number}'::jsonb) WHERE id=1")
        sql('VACUUM docs')
        assert session.run('SELECT md5(body::text) FROM docs WHERE id=1') == before
        session.run('COMMIT')
        sql("UPDATE reference SET body=jsonb_set(body,'{counter}','39'::jsonb,true) WHERE id=1")
        session.run('BEGIN; DECLARE held CURSOR WITH HOLD FOR SELECT body FROM docs ORDER BY id; COMMIT')
        sql("UPDATE docs SET body='{}'::docb WHERE id=1")
        sql('VACUUM docs')
        assert 'payload' in session.run('FETCH 1 FROM held')
        session.run('CLOSE held')
        sql('UPDATE docs SET body=reference.body::docb FROM reference WHERE docs.id=reference.id')
    finally:
        session.close()
    checks.append('Old snapshot and held cursor survive concurrent rebase, deletion and VACUUM')
    sql("BEGIN; SAVEPOINT s; UPDATE docs SET body=jsonb_set(body,'{counter}','999'::jsonb); "
        "ROLLBACK TO s; COMMIT")
    sql("VACUUM docs")
    expect("SELECT bool_and(d.body::jsonb = r.body) FROM docs d JOIN reference r USING(id)")
    sql("CREATE TABLE copies AS SELECT * FROM docs; "
        "CREATE TABLE arrays AS SELECT array_agg(body ORDER BY id) bodies FROM docs; "
        "BEGIN; DECLARE held CURSOR WITH HOLD FOR SELECT body FROM docs; COMMIT; "
        "FETCH 1 FROM held; CLOSE held")
    sql("UPDATE docs SET body='{}'::docb")
    sql("VACUUM docs")
    expect("SELECT bool_and(d.body::jsonb = r.body) FROM copies d JOIN reference r USING(id)")
    expect("SELECT bool_and(b::jsonb = r.body) FROM arrays,unnest(bodies) WITH ORDINALITY u(b,id) "
           "JOIN reference r USING(id)")
    sql("TRUNCATE docs; INSERT INTO docs SELECT * FROM copies; DROP TABLE copies; DROP TABLE arrays")
    checks.append('Rollback/savepoints and cross-row/array copies survive source reclamation')
    sql("COPY docs TO '/var/lib/neon/docb/copy.bin' (FORMAT binary); "
        "CREATE TABLE imported(LIKE docs INCLUDING ALL); "
        "COPY imported FROM '/var/lib/neon/docb/copy.bin' (FORMAT binary)")
    expect("SELECT bool_and(d.body::jsonb = r.body) FROM imported d JOIN reference r USING(id)")
    sql("DROP TABLE imported; CLUSTER docs USING docs_pkey")
    sql("VACUUM FULL docs")
    expect("SELECT bool_and(d.body::jsonb = r.body) FROM docs d JOIN reference r USING(id)")
    checks.append('Binary COPY and CLUSTER/VACUUM FULL preserve values')
    sql('CREATE TABLE gc_probe AS SELECT body FROM docs WHERE id=1')
    base_chunk = sql('SELECT pg_column_toast_chunk_id(body) FROM gc_probe')
    base_counter = sql("SELECT body->>'counter' FROM gc_probe")
    for number in range(25):
        sql(f"UPDATE gc_probe SET body=jsonb_set(body,'{{counter}}','{number}'::jsonb)")
    sql('VACUUM (FREEZE) gc_probe')
    expect("SELECT body->>'counter' FROM gc_probe", '24')
    toast_table = sql("SELECT reltoastrelid::regclass::text FROM pg_class WHERE oid='gc_probe'::regclass")
    expect('SELECT count(DISTINCT chunk_id) FROM '+toast_table, '2')
    expect('SELECT count(*)>0 FROM '+toast_table+' WHERE chunk_id='+base_chunk)
    sql(f"UPDATE gc_probe SET body=jsonb_set(body,'{{counter}}','{base_counter}'::jsonb)")
    expect('SELECT pg_column_toast_chunk_id(body) FROM gc_probe', base_chunk)
    expect('SELECT count(DISTINCT chunk_id) FROM '+toast_table, '1')
    sql("UPDATE gc_probe SET body=(SELECT jsonb_build_object('counter',25,'payload',"
        "string_agg(md5('replacement-'||i::text),''))::docb FROM generate_series(1,2048) i)")
    expect('SELECT pg_column_compression(body) IS NULL FROM gc_probe')
    expect('SELECT count(*) FROM '+toast_table+' WHERE chunk_id='+base_chunk, '0')
    expect('SELECT count(DISTINCT chunk_id) FROM '+toast_table, '1')
    sql('DELETE FROM gc_probe')
    sql('VACUUM gc_probe')
    expect('SELECT count(*) FROM '+toast_table, '0')
    sql('DROP TABLE gc_probe')
    checks.append('One-base consolidation, revert-to-base reuse, full rebase, freeze and final dependency reclamation')
    if ENGINE == 'native':
        standby = ROOT/'standby'
        command([PG+'pg_basebackup','-h','127.0.0.1','-p',PORT,'-U',USER,
                 '-D',str(standby),'-X','stream','-R','--checkpoint=fast'])
        with (standby/'postgresql.conf').open('a') as config:
            config.write('\nport=15435\nshared_buffers=64MB\n')
        command([PG+'pg_ctl','-D',str(standby),'-l',str(ROOT/'standby.log'),'-w','start'])
        try:
            for number in range(40, 45):
                sql(f"UPDATE docs SET body=jsonb_set(body,'{{counter}}','{number}'::jsonb) WHERE id=1")
            target = sql('SELECT pg_current_wal_insert_lsn()')
            deadline = time.monotonic()+10
            while True:
                result = command([PG+'psql','-XqAt','-h','127.0.0.1','-p','15435','-U',USER,
                    '-d','postgres','-c',f"SELECT pg_last_wal_replay_lsn()>='{target}'::pg_lsn"]).stdout.strip()
                if result == 't':
                    break
                assert time.monotonic()<deadline
                time.sleep(.05)
            expect("SELECT body->>'counter' FROM docs WHERE id=1", '44')
            result = command([PG+'psql','-XqAt','-h','127.0.0.1','-p','15435','-U',USER,
                '-d','postgres','-c',"SELECT body->>'counter' FROM docs WHERE id=1"]).stdout.strip()
            assert result == '44', result
        finally:
            command([PG+'pg_ctl','-D',str(standby),'-m','fast','-w','stop'])
        checks.append('Physical WAL replay reconstructs native delta records on a separate standby')
        before = sql('SELECT md5(string_agg(body::text,\'\' ORDER BY id)) FROM docs')
        writer = Session()
        writer.run("BEGIN; UPDATE docs SET body=jsonb_set(body,'{counter}','999999'::jsonb)")
        command([PG+'pg_ctl','-D',str(DATA),'-m','immediate','-w','stop'])
        writer.process.stdin.close()
        writer.process.wait(timeout=5)
        command([PG+'pg_ctl','-D',str(DATA),'-l',str(ROOT/'postgres.log'),'-w','start'])
        expect("SELECT md5(string_agg(body::text,'' ORDER BY id)) FROM docs", before)
        sql('VACUUM docs')
        checks.append('Immediate crash restart preserves committed roots and discards uncommitted deltas')
    results = report['results']
    projections = report['projections']
    for indexed in (False, True):
      if indexed:
        sql('CREATE INDEX docs_gin ON docs USING gin(body docb_path_ops); '
            'CREATE INDEX reference_gin ON reference USING gin(body jsonb_path_ops)')
        match = sql("SELECT body->>'counter' FROM docs WHERE id=1")
        expect(f"SET enable_seqscan=off; SELECT "
               f"(SELECT count(*) FROM docs WHERE body @> '{{\"counter\":{match}}}'::docb) = "
               f"(SELECT count(*) FROM docs WHERE body::jsonb @> '{{\"counter\":{match}}}'::jsonb)")
      for table in ('reference', 'docs', 'docs', 'reference'):
        path = ROOT / (table+'.sql')
        extra = ',true' if table == 'reference' else ''
        path.write_text('\\set id random(1,64)\n\\set value random(1,1000000)\n'
                        f"UPDATE {table} SET body=jsonb_set(body,'{{counter}}',to_jsonb(:value::int){extra}) WHERE id=:id;\n")
        sql('CHECKPOINT')
        sync_barrier()
        capacity = os.statvfs(ROOT)
        assert (capacity.f_blocks-capacity.f_bfree)*capacity.f_frsize < 3*1024**3, 'Stop before fixture RAM storage fills'
        start = sql('SELECT pg_current_wal_insert_lsn()')
        bench = command([PG+'pgbench','-n','-M','prepared','-c','8','-j','4','-t','128',
                         '-h','127.0.0.1','-p',PORT,'-U',USER,'-f',str(path),'postgres']).stdout
        wal = int(sql(f"SELECT pg_wal_lsn_diff(pg_current_wal_insert_lsn(),'{start}')::bigint"))
        tps = float(re.search(r'tps = ([\d.]+)', bench)[1])
        failures = int(re.search(r'number of failed transactions: (\d+)', bench)[1])
        assert failures == 0, bench
        results.append({'type':'docb' if table=='docs' else 'jsonb','gin':indexed,'tps':tps,
                        'updates':1024,'wal_bytes':wal,'wal_bytes_per_update':wal/1024})
        size = int(sql("SELECT sum(pg_total_relation_size(oid)) FROM pg_class WHERE relkind IN ('r','t','i')"))
        assert size < 1536*1024*1024, size
      for table in ('reference', 'docs'):
        plan = json.loads(sql(f"EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) "
            f"SELECT sum(length(body #>> '{{nested,score}}')) FROM generate_series(1,2048) g "
            f"JOIN {table} ON id=1+g%64"))[0]
        projections.append({'type':'docb' if table=='docs' else 'jsonb', 'gin':indexed,
                            'execution_ms':plan['Execution Time'],
                            'buffer_hits':plan['Plan']['Shared Hit Blocks'],
                            'buffer_reads':plan['Plan']['Shared Read Blocks']})
    # Slot creation must fence pre-existing delta writers, not reinterpret them.
    sql('CREATE PUBLICATION docb_pub FOR TABLE docs')
    writer = Session()
    slot = None
    try:
        writer.run("BEGIN; UPDATE docs SET body=jsonb_set(body,'{counter}','77777'::jsonb) WHERE id=1")
        slot = subprocess.Popen([PG+'psql','-XqAt','-v','ON_ERROR_STOP=1','-h','127.0.0.1',
            '-p',PORT,'-U',USER,'postgres','-c',
            "SELECT slot_name FROM pg_create_logical_replication_slot('docb_slot','pgoutput')"],
            stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
        time.sleep(.15)
        assert slot.poll() is None, 'Logical slot did not fence the existing writer'
        writer.run('COMMIT')
        output, error = slot.communicate(timeout=15)
        assert slot.returncode == 0, (output, error)
    finally:
        writer.close()
        if slot and slot.poll() is None:
            slot.kill()
            slot.communicate(timeout=5)
    sql("UPDATE docs SET body=jsonb_set(body,'{counter}','99999'::jsonb) WHERE id=1")
    expect('SELECT pg_column_compression(body) IS NULL FROM docs WHERE id=1')
    sql('VACUUM docs')
    sync_barrier()
    expect("SELECT bool_or(position(convert_to((SELECT body::text FROM docs WHERE id=1),'UTF8') IN data)>0) "
           "FROM pg_logical_slot_get_binary_changes('docb_slot',NULL,NULL,'proto_version','1','publication_names','docb_pub')")
    sql("SELECT pg_drop_replication_slot('docb_slot'); DROP PUBLICATION docb_pub")
    sql("UPDATE docs SET body=jsonb_set(body,'{counter}','100000'::jsonb) WHERE id=1")
    expect("SELECT pg_column_compression(body)='docb_delta' FROM docs WHERE id=1")
    checks.append('Logical slot creation fences writers; CDC emits full JSON after VACUUM; dropping slot restores deltas')
    if ENGINE == 'neon':
        sync_barrier()
        capacity = os.statvfs(ROOT)
        report['tmpfs_bytes_before_wake'] = (capacity.f_blocks-capacity.f_bfree)*capacity.f_frsize
        before = sql("SELECT md5(string_agg(body::text,'' ORDER BY id)) FROM docs")
        local('timeline','branch','--branch-name','docb_branch','--ancestor-branch-name','main')
        sql("UPDATE docs SET body='{\"counter\":200000}'::docb WHERE id=1")
        sql('VACUUM docs')
        local('endpoint','stop','bench')
        local('endpoint','create','wake','--branch-name','docb_branch','--pg-version','18',
              '--pg-port',PORT,'--external-http-port','15436','--internal-http-port','15437','--update-catalog')
        with (ROOT/'neon/endpoints/wake/postgresql.conf').open('a') as output:
            output.write(neon_config())
        wake_started = time.monotonic()
        local('endpoint','start','wake','--dev')
        report['wake_samples'].append({'endpoint':'wake','startup_ms':(time.monotonic()-wake_started)*1000})
        expect("SELECT md5(string_agg(body::text,'' ORDER BY id)) FROM docs", before)
        sql("UPDATE docs SET body=jsonb_set(body,'{counter}','300000'::jsonb) WHERE id=1")
        expect("SELECT body->>'counter' FROM docs WHERE id=1", '300000')
        sync_barrier()
        child_state = sql("SELECT md5(string_agg(body::text,'' ORDER BY id)) FROM docs")
        local('endpoint','stop','wake')
        # Exercise the asynchronous startup path that once timed out in this screen.
        for attempt in range(2, 4) if FAST else ():
            name = 'wake'+str(attempt)
            local('endpoint','create',name,'--branch-name','docb_branch','--pg-version','18',
                  '--pg-port',PORT,'--external-http-port','15436','--internal-http-port','15437','--update-catalog')
            with (ROOT/f'neon/endpoints/{name}/postgresql.conf').open('a') as output:
                output.write(neon_config())
            wake_started = time.monotonic()
            local('endpoint','start',name,'--dev')
            report['wake_samples'].append({'endpoint':name,'startup_ms':(time.monotonic()-wake_started)*1000})
            expect("SELECT md5(string_agg(body::text,'' ORDER BY id)) FROM docs", child_state)
            local('endpoint','stop',name)
        local('endpoint','start','bench','--dev')
        expect("SELECT body->>'counter' FROM docs WHERE id=1", '200000')
        checks.append('A fresh compute wakes a Neon branch; parent/branch updates and base reclamation remain isolated')
    raw_results = []
    if ENGINE == 'native':
        # The external control uses unmodified upstream PostgreSQL, not the fork.
        command([PG+'pg_ctl','-D',str(DATA),'-m','fast','-w','stop'])
        rawdata = ROOT/'raw-postgres'
        command([RAW+'initdb','-D',str(rawdata),'-U',USER,'-A','trust','--locale=C.UTF-8'])
        with (rawdata/'postgresql.conf').open('a') as config:
            config.write(BASE)
        command([RAW+'pg_ctl','-D',str(rawdata),'-l',str(ROOT/'raw-postgres.log'),'-w','start'])
        try:
            sql("CREATE TABLE reference(id int PRIMARY KEY,body jsonb); "
                "INSERT INTO reference SELECT id,jsonb_build_object('counter',0,'nested',"
                "jsonb_build_object('score',7,'list',jsonb_build_array(null,true,'text',1.5)),"
                "'payload',(SELECT string_agg(md5(i::text),'') FROM generate_series(1,2048) i)) "
                "FROM generate_series(1,64) id")
            for indexed in (False, True):
                if indexed:
                    sql('CREATE INDEX reference_gin ON reference USING gin(body jsonb_path_ops)')
                for repetition in range(2):
                    sql('CHECKPOINT')
                    start_lsn = sql('SELECT pg_current_wal_insert_lsn()')
                    bench = command([RAW+'pgbench','-n','-M','prepared','-c','8','-j','4','-t','128',
                        '-h','127.0.0.1','-p',PORT,'-U',USER,'-f',str(ROOT/'reference.sql'),'postgres']).stdout
                    assert int(re.search(r'number of failed transactions: (\d+)',bench)[1]) == 0
                    raw_results.append({'type':'jsonb','gin':indexed,'repetition':repetition+1,
                        'tps':float(re.search(r'tps = ([\d.]+)',bench)[1]),
                        'wal_bytes_per_update':int(sql(f"SELECT pg_wal_lsn_diff(pg_current_wal_insert_lsn(),'{start_lsn}')::bigint"))/1024})
        finally:
            command([RAW+'pg_ctl','-D',str(rawdata),'-m','fast','-w','stop'])
        command([PG+'pg_ctl','-D',str(DATA),'-l',str(ROOT/'postgres.log'),'-w','start'])
    report = {'status':'PASS','checks':checks,'results':results,'projections':projections,'engine':ENGINE,'commit_profile':PROFILE,
              'upstream_postgres_control':raw_results,
              'wake_samples':report['wake_samples'],
              'listener_bind_failure_ms':report.get('listener_bind_failure_ms'),
              'tmpfs_bytes_before_wake':report.get('tmpfs_bytes_before_wake'),
              'fixture_disk_eviction':'disabled: mock remote store shares the four-GiB tmpfs; production cache reserve is not meaningful here',
              'length_changing_tail_wal_bytes_per_update':tail_wal,
              'guard_source_sha256':hashlib.sha256(Path('/source/pgxn/neon/bounded_commit_guard.c').read_bytes()).hexdigest(),
              'docb_source_sha256':hashlib.sha256(Path('/pgsource/v18/src/backend/utils/adt/docb.c').read_bytes()).hexdigest(),
              'docb_module_sha256':hashlib.sha256(Path('/pgsource/v18/contrib/docb/docb.c').read_bytes()).hexdigest(),
              'docb_sql_sha256':hashlib.sha256(Path('/opt/postgres/v18/share/extension/docb--0.1.sql').read_bytes()).hexdigest(),
              'workload':{'documents':64,'payload_bytes':65536,'clients':8,'transactions_per_sample':1024,
                         'total_cpu_limit':8,'memory_limit_gib':6},
              'resources':{'container_block_io':Path('/sys/fs/cgroup/io.stat').read_text(),
                           'swap_current_bytes':int(Path('/sys/fs/cgroup/memory.swap.current').read_text()),
                           'note':'Temporary RAM storage: these are not persistent-disk IOPS measurements'},
              'scope':'RAM-only prototype; '+PROFILE+' acknowledgement; wal_level=logical; GIN labelled per sample; no CDC slot during timing',
              'settings':json.loads(sql("SELECT json_object_agg(name,setting) FROM pg_settings WHERE name IN "
                  "('fsync','synchronous_commit','synchronous_standby_names','wal_level','full_page_writes','neon.best_effort_commit','neon.bounded_async_commit')")),
              'postgresql':sql('SELECT version()')}
    print(json.dumps(report, indent=2), flush=True)
except Exception as error:
    report['status'] = 'FAIL'
    report['error'] = repr(error)
    report['resources_at_failure'] = {'memory_bytes':Path('/sys/fs/cgroup/memory.current').read_text(),
        'memory_events':Path('/sys/fs/cgroup/memory.events').read_text(),
        'tmpfs_bytes':(os.statvfs(ROOT).f_blocks-os.statvfs(ROOT).f_bfree)*os.statvfs(ROOT).f_frsize}
    report['logs'] = {}
    for file in list(ROOT.rglob('*.log'))[:20]:
        lines = [line for line in file.read_text(errors='replace').splitlines() if 'BatchSpanProcessor.ExportError' not in line]
        text = '\n'.join(lines)
        if len(text) > 16000:
            text = text[:4000]+'\n[...snip...]\n'+text[-12000:]
        report['logs'][str(file.relative_to(ROOT))] = re.sub(r'eyJ[A-Za-z0-9_.-]+','[fixture-token-redacted]',text)
    raise
finally:
    if ENGINE == 'native':
        command([PG+'pg_ctl','-D',str(DATA),'-m','fast','-w','stop'], check=False)
    else:
        for name in ('bench','wake','wake2','wake3'):
            command(['neon_local','endpoint','stop',name],check=False)
        command(['neon_local','stop'],check=False)
    if report:
        destination = Path(os.environ.get('DOCB_REPORT_FILE', str(ROOT/('docb-storage-'+ENGINE+'.json'))))
        destination.write_text(json.dumps(report, indent=2)+'\n')
