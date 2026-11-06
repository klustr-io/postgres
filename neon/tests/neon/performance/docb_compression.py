#!/usr/bin/env python3
"""Small local DOCB compression sensitivity screen, run in a private container.

Uses only its temporary RAM directory. Writes no external storage or host files.
The GIN samples use opposite type order and retain ordinary durable local commits.
"""
import hashlib
import json
from pathlib import Path
import re
import subprocess

PG = '/opt/postgres/v18/bin/'
ROOT = Path('/var/lib/neon/compression')
ROOT.mkdir()

def run(args):
    result = subprocess.run(args, text=True, capture_output=True, timeout=45)
    if result.returncode:
        raise RuntimeError(result.stderr[-3000:])
    return result.stdout.strip()

def sql(query):
    return run([PG+'psql','-XqAt','-h','/tmp','-U','tester','-d','postgres',
                '-v','ON_ERROR_STOP=1','-c',query])

run([PG+'initdb','-D',str(ROOT/'data'),'-A','trust','-U','tester','--locale=C.UTF-8'])
(ROOT/'data/postgresql.conf').write_text("listen_addresses=''\nunix_socket_directories='/tmp'\n"
    "shared_buffers=128MB\nmax_wal_size=128MB\nmin_wal_size=80MB\ncheckpoint_timeout=30min\n"
    "fsync=on\nsynchronous_commit=on\nfull_page_writes=on\njit=off\n")
run([PG+'pg_ctl','-D',str(ROOT/'data'),'-l',str(ROOT/'postgres.log'),'-w','start'])
report={'scope':'Local fork only, durable commits, RAM-backed, 8 total CPUs, 32 documents, 64 KiB payload, GIN path index, 4 clients, 512 updates/sample. Compression sensitivity screen, not Neon capacity or production IO qualification.', 'samples':[]}
report['source_sha256']={
    'core':hashlib.sha256(Path('/pgsource/v18/src/backend/utils/adt/docb.c').read_bytes()).hexdigest(),
    'extension_sql':hashlib.sha256(Path('/opt/postgres/v18/share/extension/docb--0.1.sql').read_bytes()).hexdigest(),
    'probe':hashlib.sha256(Path(__file__).read_bytes()).hexdigest()}
try:
    sql('CREATE EXTENSION docb')
    for shape, payload in [('poorly-compressible',"(SELECT string_agg(md5(i::text),'') FROM generate_series(1,2048) i)"),
                           ('compressible',"repeat('0123456789abcdef',4096)")]:
        for kind in ('jsonb','docb'):
            policy = ' WITH (jsonb_storage=jsonb)' if kind == 'jsonb' else ''
            sql(f'CREATE TABLE docs_{kind}(id int PRIMARY KEY,body {kind}){policy}; '
                f"INSERT INTO docs_{kind} SELECT i,jsonb_build_object('counter',0,'payload',{payload})::{kind} FROM generate_series(1,32) i; "
                f'CREATE INDEX ON docs_{kind} USING gin(body {kind}_path_ops)')
        for kind in ('jsonb','docb','docb','jsonb'):
            sql('CHECKPOINT')
            before = sql('SELECT pg_current_wal_insert_lsn()')
            script = ROOT/'update.sql'
            script.write_text('\\set id random(1,32)\n\\set value random(1,1000000)\n'
                f"UPDATE docs_{kind} SET body=jsonb_set(body,'{{counter}}',to_jsonb(:value::int)) WHERE id=:id;\n")
            output=run([PG+'pgbench','-n','-M','prepared','-h','/tmp','-U','tester','-d','postgres',
                        '-c','4','-j','4','-t','128','-f',str(script)])
            assert int(re.search(r'number of failed transactions: (\d+)',output)[1]) == 0
            assert sql(f"SELECT bool_and(length(body->>'payload')=65536) FROM docs_{kind}") == 't'
            wal=int(sql(f"SELECT pg_wal_lsn_diff(pg_current_wal_insert_lsn(),'{before}')::bigint"))
            report['samples'].append({'shape':shape,'type':kind,'tps':float(re.search(r'tps = ([\d.]+)',output)[1]),
                                      'wal_bytes_per_update':wal/512})
        report.setdefault('storage',{})[shape]={}
        for kind in ('jsonb','docb'):
            sql(f'VACUUM docs_{kind}')
            report['storage'][shape][kind]=json.loads(sql(f"SELECT json_build_object('total_relation_bytes',pg_total_relation_size('docs_{kind}'),"
                f"'stored_value_bytes_mean',(SELECT avg(pg_column_size(body)) FROM docs_{kind}))"))
        sql('DROP TABLE docs_jsonb,docs_docb')
    report['status']='PASS'
finally:
    print(json.dumps(report,indent=2))
    run([PG+'pg_ctl','-D',str(ROOT/'data'),'-m','fast','-w','stop'])
