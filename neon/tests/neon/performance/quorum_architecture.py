#!/usr/bin/env python3
"""Small RAM-only attribution screen; never a persistent-media durability claim.

Run through run-quorum-architecture.mjs. No S3, volumes, host tuning or fault tests.
Policies are labelled explicitly. Asynchronous profiles change acknowledgement
guarantees; the safekeeper no-sync control is unsafe and diagnostic only.
"""
import hashlib
import json
import os
from pathlib import Path
import re
import signal
import subprocess
import time
import urllib.request

ROOT = Path('/var/lib/neon')
PG = '/opt/postgres/v18/bin/'
RAW = '/opt/upstream/v18/bin/'
USER = 'cloud_admin'
PORT = '55432'
REPORT = ROOT / 'quorum-architecture.json'
GROUP = os.environ.get('QUORUM_TEST_GROUP', 'baseline')
assert GROUP in ('baseline', 'controls', 'safekeeper-nosync', 'tokio-one', 'native-quorum', 'bounded-async', 'best-effort', 'native-reference', 'jsonb-storage')
JSON_CASE = os.environ.get('JSON_STORAGE_CASE', 'default')
assert JSON_CASE in ('default', 'inline', 'lz4', 'external', 'no-gin', 'large')
FAST_GROUP = GROUP in ('bounded-async', 'best-effort')
if GROUP == 'tokio-one':
    os.environ['TOKIO_WORKER_THREADS'] = '1'
BASE = """
shared_buffers=256MB
max_connections=100
wal_level=logical
wal_buffers=16MB
fsync=on
synchronous_commit=on
full_page_writes=on
wal_compression=zstd
checkpoint_timeout=30min
max_wal_size=256MB
min_wal_size=80MB
jit=off
track_wal_io_timing=on
"""
os.environ.update(NEON_REPO_DIR=str(ROOT / 'neon'), POSTGRES_DISTRIB_DIR='/opt/postgres',
                  LANG='C.UTF-8', LC_ALL='C.UTF-8', TZ='UTC')


def command(argv, timeout=120):
    result = subprocess.run(argv, capture_output=True, text=True, timeout=timeout)
    if result.returncode:
        raise RuntimeError(f'{argv[0:3]}: {result.stdout[-1500:]} {result.stderr[-1500:]}')
    return result.stdout.strip()


def sql(text):
    return command([RAW + 'psql', '-XqAt', '-v', 'ON_ERROR_STOP=1', '-h', '127.0.0.1',
                    '-p', PORT, '-U', USER, '-d', 'postgres', '-c', text])


def local(*args):
    return command(['neon_local', *args])


def counters():
    cpu = dict((k, int(v)) for k, v in (s.split() for s in Path('/sys/fs/cgroup/cpu.stat').read_text().splitlines()))
    services = {}
    threads = {}
    switches = {}
    for entry in Path('/proc').iterdir():
        if not entry.name.isdigit():
            continue
        try:
            name = (entry / 'comm').read_text().strip()
            if name not in ('postgres', 'safekeeper', 'pageserver', 'storage_broker'):
                continue
            fields = (entry / 'stat').read_text().rsplit(')', 1)[1].split()
            services[name] = services.get(name, 0) + (int(fields[11]) + int(fields[12])) / os.sysconf('SC_CLK_TCK')
            for task in (entry / 'task').iterdir():
                threads[name] = threads.get(name, 0) + 1
                for line in (task / 'status').read_text().splitlines():
                    if line.startswith(('voluntary_ctxt_switches:', 'nonvoluntary_ctxt_switches:')):
                        key, value = line.split()
                        identity = name + ':' + key.rstrip(':')
                        switches[identity] = switches.get(identity, 0) + int(value)
        except (FileNotFoundError, ProcessLookupError):
            pass
    capacity = os.statvfs(ROOT)
    used = (capacity.f_blocks - capacity.f_bfree) * capacity.f_frsize
    assert used < 3 * 1024**3, 'Stop before the bounded RAM fixture fills'
    return {'cpu': cpu, 'services_cpu_seconds': services, 'service_thread_counts': threads,
            'service_context_switches': switches, 'tmpfs_used_bytes': used,
            'block_io': Path('/sys/fs/cgroup/io.stat').read_text(),
            'memory_bytes': int(Path('/sys/fs/cgroup/memory.current').read_text()),
            'host_load': os.getloadavg(),
            'swap_current_bytes': int(Path('/sys/fs/cgroup/memory.swap.current').read_text()),
            'memory_events': Path('/sys/fs/cgroup/memory.events').read_text(),
            'memory_pressure': Path('/sys/fs/cgroup/memory.pressure').read_text(),
            'guest_vmstat': {k: int(v) for k, v in (line.split() for line in Path('/proc/vmstat').read_text().splitlines())
                             if k in ('pswpin', 'pswpout', 'pgmajfault')}}


def wal():
    return json.loads(sql("SELECT row_to_json(w) FROM pg_stat_wal w"))


def guard():
    return json.loads(sql('SELECT neon.bounded_commit_guard_status()'))


def storage_snapshot(engine):
    value = json.loads(sql("SELECT json_build_object('table_bytes',pg_relation_size('documents'),"
        "'total_bytes',pg_total_relation_size('documents'),'toast_bytes',pg_total_relation_size(reltoastrelid),"
        "'heap_stats',(SELECT row_to_json(t) FROM pg_stat_user_tables t WHERE relname='documents'),"
        "'database',(SELECT row_to_json(t) FROM pg_stat_database t WHERE datname=current_database())) "
        "FROM pg_class WHERE oid='documents'::regclass"))
    if engine == 'neon':
        value['page_metrics'] = json.loads(sql("SELECT json_object_agg(metric,value) FROM neon.neon_perf_counters "
            "WHERE metric IN ('getpage_wait_seconds_sum','getpage_sync_requests_total','pageserver_requests_sent_total',"
            "'file_cache_hits_total','file_cache_read_wait_seconds_sum')"))
        value['backpressure_us'] = int(sql('SELECT neon.backpressure_throttling_time()'))
    return value


def metrics():
    values = {}
    for port in (7676, 7677, 7678):
        with urllib.request.urlopen(f'http://127.0.0.1:{port}/metrics', timeout=3) as response:
            for line in response.read().decode().splitlines():
                if line.startswith(('safekeeper_flush_wal_seconds_sum', 'safekeeper_flush_wal_seconds_count')):
                    key, value = line.rsplit(' ', 1)
                    values[str(port) + ':' + key] = float(value)
    return values


def benchmark(engine, policy, workload, clients, repetition):
    script = ROOT / (workload + '.sql')
    cmd = [RAW + 'pgbench', '-h', '127.0.0.1', '-p', PORT, '-U', USER, '-d', 'postgres',
           '-n', '-M', 'prepared', '-c', str(clients), '-j', str(min(4, clients)), '-f', str(script)]
    command(cmd + (['-t', '16'] if GROUP == 'jsonb-storage' else ['-T', '1']))
    storage_before = storage_snapshot(engine) if GROUP == 'jsonb-storage' else None
    time.sleep(.15)
    w0 = wal()
    g0 = guard() if engine == 'neon' else {}
    m0 = metrics() if engine == 'neon' else {}
    before = counters()
    text = command(cmd + (['-t', '16' if JSON_CASE == 'large' else '512'] if GROUP == 'jsonb-storage' else
                         ['-T', '2' if FAST_GROUP or GROUP == 'native-reference' else '3']), timeout=30)
    after = counters()
    g1 = guard() if engine == 'neon' else {}
    m1 = metrics() if engine == 'neon' else {}
    time.sleep(.3)  # PostgreSQL's cumulative stats can be published after a backend exits.
    w1 = wal()
    storage_after = storage_snapshot(engine) if GROUP == 'jsonb-storage' else None
    tx = int(re.search(r'number of transactions actually processed:\s*(\d+)', text)[1])
    assert 'number of failed transactions: 0' in text, text
    sample = {'engine': engine, 'policy': policy, 'workload': workload, 'clients': clients,
              'repetition': repetition, 'transactions': tx,
              'tps': float(re.search(r'tps = ([\d.]+)', text)[1]),
              'latency_mean_ms': float(re.search(r'latency average = ([\d.]+)', text)[1]),
              'cpu_ms_per_transaction': (after['cpu']['usage_usec'] - before['cpu']['usage_usec']) / 1000 / tx,
              'service_cpu_seconds': {k: v - before['services_cpu_seconds'].get(k, 0)
                                      for k, v in after['services_cpu_seconds'].items()},
              'wal_delta': {k: float(w1[k]) - float(w0[k]) for k in ('wal_bytes', 'wal_records', 'wal_fpi')},
              'guard_before': g0, 'guard_after': g1,
              'safekeeper_flush_delta': {k: v - m0.get(k, 0) for k, v in m1.items()},
              'resources_before': before, 'resources_after': after,
              'storage_before': storage_before, 'storage_after': storage_after}
    if engine == 'neon' and policy == 'quorum':
        assert g1['fast_acks'] == g0['fast_acks'], 'Durable control must not use bounded async acknowledgements'
    if policy in ('bounded-async', 'best-effort'):
        assert g1['fast_acks'] > g0['fast_acks'], 'Fast profile did not exercise bounded async acknowledgements'
        assert g1['enabled'] and g1['max_age_ms'] == 750 and g1['max_wal_bytes'] == 64 * 1024**2
        assert g1.get('best_effort', False) == (policy == 'best-effort')
    report['samples'].append(sample)
    REPORT.write_text(json.dumps(report, indent=2) + '\n')
    print(json.dumps({k: sample[k] for k in ('engine', 'policy', 'workload', 'clients', 'repetition', 'tps', 'cpu_ms_per_transaction')}), flush=True)


def setup(engine):
    if engine == 'upstream':
        data = ROOT / 'upstream'
        command([RAW + 'initdb', '-D', str(data), '-A', 'trust', '-U', USER, '--no-data-checksums', '--locale=C.UTF-8'])
        (data / 'postgresql.conf').write_text(BASE + "listen_addresses='127.0.0.1'\nport=55432\n")
        command([RAW + 'pg_ctl', '-D', str(data), '-l', str(ROOT / 'upstream.log'), '-w', 'start'])
    else:
        config = ROOT / 'init.toml'
        config.write_text('''pg_distrib_dir="/opt/postgres"
neon_distrib_dir="/usr/local/bin"
default_tenant_id="20000000000000000000000000000001"
generate_local_ssl_certs=false
control_plane_api="http://127.0.0.1:1234/upcall/v1/"
[broker]
listen_addr="127.0.0.1:50051"
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
''' + '\n'.join(f'''[[safekeepers]]
id={i}
pg_port={5453+i}
http_port={7675+i}
sync={'false' if GROUP == 'safekeeper-nosync' else 'true'}
auth_enabled=true
''' for i in (1, 2, 3)))
        local('init', '--config', str(config))
        local('start', '--start-timeout', '90s')
        local('tenant', 'create', '--pg-version', '18', '--set-default', '-c', 'checkpoint_distance:67108864', '-c', 'checkpoint_timeout:300s')
        local('endpoint', 'create', 'bench', '--branch-name', 'main', '--pg-version', '18', '--pg-port', PORT,
              '--external-http-port', '55433', '--internal-http-port', '55434', '--update-catalog')
        with (ROOT / 'neon/endpoints/bench/postgresql.conf').open('a') as output:
            output.write(BASE + "neon.bounded_async_commit=on\nneon.max_file_cache_size='128MB'\nneon.file_cache_size_limit='128MB'\n")
        local('endpoint', 'start', 'bench', '--dev')
        assert 'walproposer' in sql('SHOW synchronous_standby_names')
    report['settings'][engine] = json.loads(sql("SELECT json_object_agg(name,setting) FROM pg_settings WHERE name IN "
        "('fsync','synchronous_commit','synchronous_standby_names','wal_compression','wal_level','shared_preload_libraries')"))
    if GROUP == 'jsonb-storage' and engine == 'neon':
        local('endpoint', 'stop', 'bench')
        with (ROOT / 'neon/endpoints/bench/postgresql.conf').open('a') as output:
            output.write('\nfsync=off\nsynchronous_commit=off\nneon.best_effort_commit=on\n')
        local('endpoint', 'start', 'bench', '--dev')
    sql("CREATE TABLE documents (id int PRIMARY KEY, doc jsonb NOT NULL); ")
    if GROUP == 'jsonb-storage':
        if JSON_CASE == 'inline':
            sql('ALTER TABLE documents SET (toast_tuple_target=6000)')
        if JSON_CASE == 'external':
            sql('ALTER TABLE documents ALTER COLUMN doc SET STORAGE EXTERNAL')
        if JSON_CASE == 'lz4':
            sql('ALTER TABLE documents ALTER COLUMN doc SET COMPRESSION lz4')
    payload_chunks = (2048 if JSON_CASE == 'large' else 96) if GROUP == 'jsonb-storage' else 64
    sql(
        "INSERT INTO documents SELECT g,jsonb_build_object('metrics',jsonb_build_object('score',0),"
        f"'payload',(SELECT string_agg(md5(g::text||':'||n::text),'') FROM generate_series(1,{payload_chunks}) n)) FROM generate_series(1,1000) g")
    if GROUP != 'jsonb-storage' or JSON_CASE != 'no-gin':
        sql('CREATE INDEX documents_gin ON documents USING gin(doc jsonb_path_ops)')
    sql('VACUUM (ANALYZE);')
    sql('CHECKPOINT')
    if GROUP == 'jsonb-storage':
        sql('SELECT sum(octet_length(doc::text)) FROM documents')
        report.setdefault('json_fixture', {})[engine] = json.loads(sql("SELECT json_build_object("
            "'raw_document_bytes',(SELECT avg(octet_length(doc::text)) FROM documents),"
            "'stored_value_bytes',(SELECT avg(pg_column_size(doc)) FROM documents),"
            "'toast_heap_bytes',pg_relation_size(reltoastrelid),'table_options',reloptions) "
            "FROM pg_class WHERE oid='documents'::regclass"))


def native_replicas():
    # Same protocol-level fault model as two-of-three safekeepers: the primary
    # waits for flush feedback from any two of three independent replica processes.
    for i in (1, 2, 3):
        data = ROOT / f'standby{i}'
        command([RAW + 'pg_basebackup', '-h', '127.0.0.1', '-p', PORT, '-U', USER,
                 '-D', str(data), '-X', 'stream', '-R', '--checkpoint=fast'])
        with (data / 'postgresql.conf').open('a') as output:
            output.write(f'\nport={55440+i}\nshared_buffers=64MB\n')
        with (data / 'postgresql.auto.conf').open('a') as output:
            output.write(f"\nprimary_conninfo='host=127.0.0.1 port={PORT} user={USER} application_name=standby{i}'\n")
        command([RAW + 'pg_ctl', '-D', str(data), '-l', str(ROOT / f'standby{i}.log'), '-w', 'start'])
    sql("ALTER SYSTEM SET synchronous_standby_names='ANY 2 (standby1,standby2,standby3)'")
    sql('SELECT pg_reload_conf()')
    deadline = time.monotonic() + 20
    while int(sql("SELECT count(*) FROM pg_stat_replication WHERE state='streaming' AND sync_state='quorum'")) != 3:
        assert time.monotonic() < deadline, 'Native replicas did not join quorum'
        time.sleep(.1)
    report['settings']['upstream-quorum'] = {'synchronous_standby_names': sql('SHOW synchronous_standby_names'),
        'replicas': json.loads(sql('SELECT json_agg(t) FROM (SELECT application_name,state,sync_state FROM pg_stat_replication) t'))}


def best_effort_drain_check():
    """Tiny protocol check: no crash, restart, data load or persistent fixture."""
    safekeepers = [int(p.name) for p in Path('/proc').iterdir() if p.name.isdigit()
                   and (p / 'comm').exists() and (p / 'comm').read_text().strip() == 'safekeeper']
    assert len(safekeepers) == 3
    processes = []
    def pending(statement, sync='off'):
        process = subprocess.Popen([RAW + 'psql', '-XqAt', '-v', 'ON_ERROR_STOP=1', '-h', '127.0.0.1',
            '-p', PORT, '-U', USER, '-d', 'postgres', '-c', statement],
            env={**os.environ, 'PGOPTIONS': '-c synchronous_commit=' + sync + ' -c statement_timeout=5000'},
            stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
        processes.append(process)
        return process
    try:
        for pid in safekeepers:
            os.kill(pid, signal.SIGSTOP)
        # Best effort may acknowledge while replicas are unavailable.
        first = pending("SELECT pg_logical_emit_message(true,'best-effort-check','before-drain')")
        first.communicate(timeout=2)
        assert first.returncode == 0
        strict = pending("SELECT pg_logical_emit_message(true,'best-effort-check','strict')", 'on')
        time.sleep(.15)
        assert strict.poll() is None, 'Synchronous transaction bypassed quorum'
        drain = pending('SELECT neon.bounded_commit_guard_drain()')
        deadline = time.monotonic() + 2
        while not guard()['draining']:
            assert time.monotonic() < deadline
            time.sleep(.01)
        after = pending("SELECT pg_logical_emit_message(true,'best-effort-check','after-drain')")
        time.sleep(.15)
        assert drain.poll() is None and after.poll() is None, 'Drain allowed an unsafe acknowledgement'
    finally:
        for pid in safekeepers:
            os.kill(pid, signal.SIGCONT)
        for process in processes:
            process.communicate(timeout=8)
            assert process.returncode == 0
    report['best_effort_protocol_check'] = {'acknowledges_without_quorum': True,
        'explicit_sync_still_waits': True, 'drain_closes_fast_path': True, 'drain_completed_after_quorum_resumed': True}


report = {'status': 'RUNNING', 'samples': [], 'settings': {},
          'group': GROUP,
          'json_storage_case': JSON_CASE if GROUP == 'jsonb-storage' else None,
          'service_cpu_coverage': 'Persistent processes only; PostgreSQL CPU can omit exited client backends. Cgroup total includes every process.',
          'scope': 'RAM-only protocol/CPU screen. Not disk durability, disk IOPS, production capacity or multi-zone qualification.',
          'cpu_budget': '8 CPUs total including client and all storage services',
          'versions': {e: command([p + 'postgres', '--version']) for e, p in [('upstream', RAW), ('neon', PG)]},
          'configure': {e: command([p + 'pg_config', '--configure']) for e, p in [('upstream', RAW), ('neon', PG)]},
          'guard_source_sha256': hashlib.sha256(Path('/source/pgxn/neon/bounded_commit_guard.c').read_bytes()).hexdigest()}
scripts = {'wal': "SELECT pg_logical_emit_message(true,'quorum-probe',repeat('x',64));\n",
           'wal-batch16': "SELECT pg_logical_emit_message(true,'quorum-probe',repeat('x',64)) FROM generate_series(1,16);\n",
           'jsonb': "\\set id random(1,1000)\nBEGIN;\nUPDATE documents SET doc=jsonb_set(doc,'{metrics,score}',to_jsonb((doc->'metrics'->>'score')::int+1)) WHERE id=:id;\nCOMMIT;\n"}
for name, script in scripts.items():
    (ROOT / (name + '.sql')).write_text(script)
try:
    for engine in (('upstream', 'neon') if GROUP in ('baseline', 'jsonb-storage') else (('upstream',) if GROUP in ('native-quorum', 'native-reference') else ('neon',))):
        setup(engine)
        if GROUP == 'native-quorum':
            native_replicas()
        policy = 'local-durable' if engine == 'upstream' else ('UNSAFE-safekeeper-nosync' if GROUP == 'safekeeper-nosync' else ('quorum-tokio-one' if GROUP == 'tokio-one' else 'quorum'))
        if GROUP == 'native-quorum':
            policy = 'native-two-of-three-quorum'
        if GROUP == 'jsonb-storage' and engine == 'neon':
            policy = 'best-effort'
        if FAST_GROUP:
            for repetition, mode in enumerate(('quorum', GROUP, GROUP, 'quorum'), 1):
                local('endpoint', 'stop', 'bench')
                with (ROOT / 'neon/endpoints/bench/postgresql.conf').open('a') as output:
                    output.write('\nfsync=' + ('on' if mode == 'quorum' else 'off') +
                                 '\nsynchronous_commit=' + ('on' if mode == 'quorum' else 'off') +
                                 '\nneon.best_effort_commit=' + ('on' if mode == 'best-effort' else 'off') + '\n')
                local('endpoint', 'start', 'bench', '--dev')
                assert sql('SHOW neon.bounded_async_commit') == 'on'
                assert 'walproposer' in sql('SHOW synchronous_standby_names')
                assert sql('SHOW synchronous_commit') == ('on' if mode == 'quorum' else 'off')
                for workload, clients in [('wal', 32), ('jsonb', 16)]:
                    benchmark(engine, mode, workload, clients, repetition)
                if mode == 'best-effort' and repetition == 3:
                    best_effort_drain_check()
                else:
                    sql('SELECT neon.bounded_commit_guard_drain()')
        for repetition in (() if GROUP == 'controls' or FAST_GROUP else (1, 2)):
            cases = [('wal', 1), ('wal', 8), ('wal', 32), ('wal-batch16', 16), ('jsonb', 16)] if GROUP == 'baseline' else ([('wal', 32), ('jsonb', 16)] if GROUP == 'native-reference' else [('wal', 1), ('wal', 32), ('jsonb', 16)])
            if GROUP == 'jsonb-storage':
                cases = [('jsonb', 16)]
            for workload, clients in cases if repetition == 1 else reversed(cases):
                benchmark(engine, policy, workload, clients, repetition)
        if engine == 'neon':
            # Each change restarts only this disposable compute. Native sync
            # replication stays enabled, and all three safekeepers retain fsync.
            for label, setting in ([('no-compute-fsync', 'fsync=off'), ('native-sync-only', 'fsync=on\nneon.bounded_async_commit=off')] if GROUP == 'controls' else []):
                local('endpoint', 'stop', 'bench')
                with (ROOT / 'neon/endpoints/bench/postgresql.conf').open('a') as output:
                    output.write('\n' + setting + '\n')
                local('endpoint', 'start', 'bench', '--dev')
                assert sql('SHOW synchronous_commit') == 'on'
                assert 'walproposer' in sql('SHOW synchronous_standby_names')
                for repetition in (1, 2):
                    for workload, clients in [('wal', 1), ('wal', 32), ('jsonb', 16)]:
                        benchmark(engine, label, workload, clients, repetition)
            local('endpoint', 'stop', 'bench')
            local('stop')
        else:
            if GROUP == 'native-quorum':
                for i in (1, 2, 3):
                    command([RAW + 'pg_ctl', '-D', str(ROOT / f'standby{i}'), '-m', 'fast', '-w', 'stop'])
            command([RAW + 'pg_ctl', '-D', str(ROOT / 'upstream'), '-m', 'fast', '-w', 'stop'])
    report['status'] = 'PASS'
except Exception as error:
    report['status'] = 'FAIL'
    report['error'] = str(error)
    raise
finally:
    REPORT.write_text(json.dumps(report, indent=2) + '\n')
