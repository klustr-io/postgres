#!/usr/bin/env python3
"""Matched upstream PG18 / real Neon benchmark in one isolated cgroup.

All databases and cache advice are restricted to the caller's NEW volume.
No host cache drop, existing database, cluster workload or volume is changed.
"""
import argparse
import gzip
import hashlib
import json
import math
import os
from pathlib import Path
import re
import signal
import shutil
import statistics
import subprocess
import sys
import tarfile
import time
import tomllib
import urllib.request

ROOT = Path('/var/lib/neon')
RUN = ROOT / 'comparison'
LOGS = RUN / 'logs'
PUBLIC = RUN / 'public'
UPSTREAM = '/opt/upstream/v18/bin/'
NEON = '/opt/postgres/v18/bin/'
PORT = 55432
USER = 'cloud_admin'
SETTINGS = {'shared_buffers': '256MB', 'effective_cache_size': '4GB', 'work_mem': '4MB',
            'maintenance_work_mem': '128MB', 'max_connections': '100', 'wal_buffers': '16MB',
            'fsync': 'on', 'synchronous_commit': 'on', 'full_page_writes': 'on',
            'wal_level': 'logical', 'track_io_timing': 'on', 'track_wal_io_timing': 'on',
            'checkpoint_timeout': '5min', 'max_wal_size': '1GB', 'min_wal_size': '128MB',
            'effective_io_concurrency': '16', 'io_method': 'worker', 'jit': 'off'}
parser = argparse.ArgumentParser()
parser.add_argument('--seconds', type=int, default=30)
parser.add_argument('--warmup', type=int, default=5)
parser.add_argument('--repeats', type=int, default=3)
parser.add_argument('--clients', type=int, default=8)
parser.add_argument('--scale', type=int, default=10)
parser.add_argument('--json-rows', type=int, default=100000)
parser.add_argument('--engine', choices=['both','upstream','neon'], default='both')
parser.add_argument('--wal-compression', choices=['off','pglz','lz4','zstd'], default='off')
parser.add_argument('--batch-size', type=int, default=1)
parser.add_argument('--toast-storage', choices=['extended','external'], default='extended')
parser.add_argument('--commit-policy', choices=['synchronous','bounded-local','bounded-async','native-async'], default='synchronous',
                    help='bounded-local uses compute-local WAL fsync plus native bounded remote admission; raw PG uses local WAL fsync')
parser.add_argument('--verify-recovery', action='store_true')
parser.add_argument('--probe-index-checkpoint', action='store_true')
parser.add_argument('--compute-local-fsync', choices=['on','off'], default='on')
parser.add_argument('--verify-compute-storage-loss', action='store_true')
parser.add_argument('--verify-scale-zero', action='store_true')
parser.add_argument('--wake-cycles', type=int, default=1)
parser.add_argument('--rates', default='', help='Comma-separated Poisson arrival rates; empty means closed-loop')
parser.add_argument('--trace-waits', action='store_true', help='Sample wait/backpressure/flush metrics once per second; includes observer overhead')
parser.add_argument('--latency-sampling',type=float,default=.1)
parser.add_argument('--pageserver-checkpoint-mib',type=int,default=64)
parser.add_argument('--pageserver-checkpoint-seconds',type=int,default=30)
parser.add_argument('--verify-pageserver-crash',action='store_true')
parser.add_argument('--empty-compute-on-wake',action='store_true')
parser.add_argument('--compute-storage',choices=['disk','tmpfs'],default='disk')
parser.add_argument('--resource-profile',choices=['total8','compute8-storage8'],default='total8')
parser.add_argument('--scenarios', default='relational-read,jsonb-read,jsonb-containment,relational-cold-read,jsonb-cold-read,relational-write,relational-mixed,jsonb-write')
args = parser.parse_args()
assert min(args.seconds, args.warmup, args.repeats, args.clients, args.scale, args.json_rows, args.batch_size) > 0
assert args.batch_size <= 100
assert 1 <= args.wake_cycles <= 100
assert not args.verify_scale_zero or args.verify_recovery, 'Wake durability checks require the recovery fixture'
assert not args.verify_compute_storage_loss or args.verify_recovery, 'Storage-loss checks require the recovery fixture'
rates = [float(value) for value in args.rates.split(',')] if args.rates else [None]
assert all(rate is None or math.isfinite(rate) and rate > 0 for rate in rates)
assert len(set(rates)) == len(rates)
assert 0 < args.latency_sampling <= 1
assert min(args.pageserver_checkpoint_mib,args.pageserver_checkpoint_seconds)>0
assert not args.verify_pageserver_crash or args.engine=='neon' and args.verify_recovery
if args.compute_storage=='tmpfs':
    assert args.engine=='neon' and args.compute_local_fsync=='off'
    assert args.verify_recovery and args.verify_compute_storage_loss and args.verify_scale_zero and args.empty_compute_on_wake
SETTINGS['wal_compression'] = args.wal_compression
SETTINGS['fsync'] = args.compute_local_fsync
if args.commit_policy == 'bounded-local':
    assert args.compute_local_fsync == 'on', 'Bounded local profile requires local WAL durability'
    SETTINGS['synchronous_commit'] = 'local'
elif args.commit_policy == 'bounded-async':
    assert args.engine == 'neon' and args.compute_local_fsync == 'off', 'Ephemeral bounded profile is Neon-only'
    SETTINGS['synchronous_commit'] = 'off'
elif args.commit_policy == 'native-async':
    assert args.engine == 'upstream' and args.compute_local_fsync == 'on'
    SETTINGS['synchronous_commit'] = 'off'
if args.compute_local_fsync == 'off':
    assert args.engine == 'neon', 'Ephemeral compute profile is Neon-only'
    assert args.verify_recovery and args.verify_compute_storage_loss and args.verify_scale_zero, 'Native profile requires quorum, storage-loss and wake qualification'
assert not RUN.exists(), 'A new named volume is mandatory'
LOGS.mkdir(parents=True)
PUBLIC.mkdir()
os.environ.update(NEON_REPO_DIR=str(RUN / 'neon'), POSTGRES_DISTRIB_DIR='/opt/postgres',
                 LANG='C.UTF-8', LC_ALL='C.UTF-8', TZ='UTC')


def run(command, name, timeout=300):
    result = subprocess.run(command, capture_output=True, text=True, timeout=timeout)
    (LOGS / (name + '.log')).write_text(result.stdout + result.stderr)
    assert result.returncode == 0, f'{name} failed; inspect retained private log'
    return result.stdout.strip()


def sql(statement, name='sql', timeout=300):
    return run([UPSTREAM + 'psql', '-XqAt', '-v', 'ON_ERROR_STOP=1', '-h', '127.0.0.1',
                '-p', str(PORT), '-U', USER, '-d', 'postgres', '-c', statement], name, timeout)


def local(*arguments):
    return run(['neon_local', *arguments], 'local-' + '-'.join(arguments[:2]) + '-' + str(time.time_ns()))


def snapshot():
    devices = {}
    for line in Path('/sys/fs/cgroup/io.stat').read_text().splitlines():
        device, *fields = line.split()
        devices[device] = {key: int(value) for key, value in (item.split('=') for item in fields)}
    cpu = {key: int(value) for key, value in
           (line.split() for line in Path('/sys/fs/cgroup/cpu.stat').read_text().splitlines())}
    return {'monotonic': time.monotonic(), 'epoch_seconds':time.time(), 'devices': devices, 'cpu': cpu,
            'memory_bytes': int(Path('/sys/fs/cgroup/memory.current').read_text()),
            'host_load_average': list(os.getloadavg()), 's3': dict(proxy.counts) if proxy else {}}


def subtract(after, before):
    return {key: after.get(key, 0) - before.get(key, 0) for key in set(after) | set(before)}


def io_delta(before, after):
    devices = {device: subtract(after['devices'].get(device, {}), before['devices'].get(device, {}))
               for device in set(after['devices']) | set(before['devices'])}
    # Device stacks can count one request at multiple levels. Preserve per-device
    # counters and use the observed leaf disk (no slaves) for the aggregate.
    selected = []
    for device in devices:
        slaves = Path('/sys/dev/block') / device / 'slaves'
        assert slaves.exists(), 'Cannot establish block-device hierarchy'
        if not list(slaves.iterdir()):
            selected.append(device)
    totals = {key: sum(devices[device].get(key, 0) for device in selected)
              for key in ['rios', 'wios', 'rbytes', 'wbytes']}
    assert all(value >= 0 for value in totals.values()), 'Block counters reset'
    elapsed = after['monotonic'] - before['monotonic']
    return {'interval_seconds': elapsed, 'per_device': devices, 'aggregate_devices': sorted(selected),
            'read_operations': totals['rios'], 'write_operations': totals['wios'],
            'read_bytes': totals['rbytes'], 'write_bytes': totals['wbytes'],
            'read_iops': totals['rios'] / elapsed, 'write_iops': totals['wios'] / elapsed,
            'read_mib_per_second': totals['rbytes'] / elapsed / 1048576,
            'write_mib_per_second': totals['wbytes'] / elapsed / 1048576}


def pg_snapshot(engine):
    value = sql("SELECT json_build_object('io', (SELECT json_agg(t) FROM pg_stat_io t), "
                "'wal', (SELECT row_to_json(t) FROM pg_stat_wal t), "
                "'database', (SELECT row_to_json(t) FROM pg_stat_database t WHERE datname='postgres'))")
    data = json.loads(value)
    if engine == 'neon':
        data['neon_backpressure'] = json.loads(sql("SELECT json_build_object('throttling_us',neon.backpressure_throttling_time(),"
            "'lsns',(SELECT row_to_json(t) FROM neon.backpressure_lsns() t),"
            "'limits',(SELECT json_object_agg(name,setting) FROM pg_settings WHERE name IN "
            "('max_replication_write_lag','max_replication_flush_lag','max_replication_apply_lag','databricks.max_wal_mb_per_second')))"))
    return data


def wait_snapshot(engine):
    assert engine == 'neon', 'Wait diagnosis is currently Neon-only'
    query = ("SELECT json_build_object('throttling_us',neon.backpressure_throttling_time(),"
        "'compute_flush_lsn',pg_current_wal_flush_lsn(),"
        "'lsns',(SELECT row_to_json(t) FROM neon.backpressure_lsns() t),"
        "'waits',(SELECT json_agg(t) FROM (SELECT state,wait_event_type,wait_event,count(*) AS sessions "
        "FROM pg_stat_activity WHERE application_name='pgbench' GROUP BY state,wait_event_type,wait_event) t))")
    command = [UPSTREAM+'psql','-XqAt','-v','ON_ERROR_STOP=1','-h','127.0.0.1','-p',str(PORT),'-U',USER,'-d','postgres','-c',query]
    began = time.monotonic()
    sampled = subprocess.run(command,capture_output=True,text=True,timeout=10)
    assert sampled.returncode == 0, 'Wait sampler failed'
    return {'monotonic':time.monotonic(),'query_seconds':time.monotonic()-began,
        **json.loads(sampled.stdout),'durability_metrics':durability_counters(engine)}


def remote_counters(engine):
    if engine != 'neon' or not s3:
        return {}
    values = {}
    for port in (9898, 7676, 7677, 7678):
        with urllib.request.urlopen(f'http://127.0.0.1:{port}/metrics', timeout=10) as response:
            text = response.read().decode()
        for line in text.splitlines():
            if line.startswith('remote_storage_s3_request_seconds_count{'):
                identity, count = line.rsplit(' ', 1)
                values[str(port) + ':' + identity] = float(count)
    return values


def durability_counters(engine):
    if engine != 'neon':
        return {}
    values = {}
    for port in (7676,7677,7678):
        with urllib.request.urlopen(f'http://127.0.0.1:{port}/metrics',timeout=10) as response:
            metrics = response.read().decode()
        for line in metrics.splitlines():
            if line.startswith(('safekeeper_flush_wal_seconds_', 'safekeeper_write_wal_seconds_',
                                'safekeeper_write_wal_bytes_', 'safekeeper_wal_receiver_queue_depth_',
                                'safekeeper_wal_storage_operation_seconds_', 'safekeeper_persist_control_file_seconds_')):
                identity, value = line.rsplit(' ',1)
                values[str(port)+':'+identity] = float(value)
    return values


def settings_text():
    return '\n'.join(key + "='" + value + "'" for key, value in SETTINGS.items()) + '\n'


proxy = None
s3 = json.loads(sys.stdin.readline())
if s3:
    os.environ.update(AWS_ACCESS_KEY_ID=s3['access_key'], AWS_SECRET_ACCESS_KEY=s3['secret_key'],
                      AWS_REGION=s3['region'], AWS_EC2_METADATA_DISABLED='true')


def remote(role):
    values = {'bucket_name': s3['bucket'], 'bucket_region': s3['region'],
              'prefix_in_bucket': s3['prefix'] + '/' + role, 'endpoint': s3['endpoint']}
    return '{' + ','.join(key + '=' + json.dumps(value) for key, value in values.items()) + '}'


def start(engine, initialize=False):
    if args.resource_profile == 'compute8-storage8':
        from cpu_layout import configure_parent
        configure_parent(engine)
    if engine == 'upstream':
        folder = RUN / 'upstream'
        if initialize:
            run([UPSTREAM + 'initdb', '-D', str(folder), '-A', 'trust', '-U', USER,
                 '--no-data-checksums', '--locale=C.UTF-8'], 'upstream-initdb')
            with (folder / 'postgresql.conf').open('a') as output:
                output.write(settings_text() + "listen_addresses='127.0.0.1'\nport=55432\n")
        run([UPSTREAM + 'pg_ctl', '-D', str(folder), '-l', str(LOGS / 'upstream-server.log'),
             '-w', 'start'], 'upstream-start')
    else:
        if initialize:
            storage = ('remote_storage = ' + remote('pageserver') + '\n') if s3 else ''
            sk_storage = ('remote_storage = ' + json.dumps(remote('safekeeper')) + '\n') if s3 else ''
            config = RUN / 'neon-init.toml'
            config.write_text('''pg_distrib_dir = "/opt/postgres"
neon_distrib_dir = "/usr/local/bin"
default_tenant_id = "20000000000000000000000000000001"
generate_local_ssl_certs = false
control_plane_api = "http://127.0.0.1:1234/upcall/v1/"
[broker]
listen_addr = "127.0.0.1:50051"
[endpoint_storage]
listen_addr = "127.0.0.1:9993"
[[pageservers]]
id = 1
listen_pg_addr = "127.0.0.1:6400"
listen_http_addr = "127.0.0.1:9898"
pg_auth_type = "NeonJWT"
http_auth_type = "NeonJWT"
grpc_auth_type = "NeonJWT"
no_sync = false
virtual_file_io_engine = "std-fs"
page_cache_size = 32768
''' + storage + '\n'.join(f'''[[safekeepers]]
id = {number}
pg_port = {5453 + number}
http_port = {7675 + number}
sync = true
auth_enabled = true
''' + sk_storage for number in range(1, 4)))
            local('init', '--config', str(config))
            if args.compute_storage=='tmpfs':
                # Only disposable compute data moves to memory. Safekeeper and
                # pageserver paths stay on the caller's persistent new volume.
                assert os.path.ismount('/compute')
                capacity=os.statvfs('/compute')
                assert capacity.f_blocks*capacity.f_frsize==2*1024**3
                assert os.stat('/compute').st_dev!=os.stat(RUN).st_dev
                mounts=Path('/proc/mounts').read_text().splitlines()
                assert any(line.split()[1:3]==['/compute','tmpfs'] for line in mounts)
                memory_endpoints=Path('/compute/endpoints')
                memory_endpoints.mkdir(mode=0o700)
                endpoints=RUN/'neon/endpoints'
                if endpoints.exists():
                    assert endpoints.is_dir() and not endpoints.is_symlink() and not any(endpoints.iterdir())
                    endpoints.rename(RUN/'neon/endpoints-initial-empty')
                endpoints.symlink_to(memory_endpoints,target_is_directory=True)
        local('start', '--start-timeout', '90s')
        if initialize:
            local('tenant', 'create', '--pg-version', '18', '--set-default',
                  '-c', f'checkpoint_distance:{args.pageserver_checkpoint_mib*1048576}',
                  '-c', f'checkpoint_timeout:{args.pageserver_checkpoint_seconds}s')
            local('endpoint', 'create', 'bench', '--branch-name', 'main', '--pg-version', '18',
                  '--pg-port', str(PORT), '--external-http-port', '55433', '--internal-http-port', '55434',
                  '--update-catalog')
            with (RUN / 'neon/endpoints/bench/postgresql.conf').open('a') as output:
                output.write(settings_text() + "neon.max_file_cache_size='512MB'\n"
                             "neon.file_cache_size_limit='512MB'\n"
                             "neon.file_cache_path='/var/lib/neon/comparison/lfc.cache'\n")
                if args.commit_policy != 'synchronous':
                    output.write('neon.bounded_async_commit=on\nneon.bounded_async_max_age=750ms\n')
        local('endpoint', 'start', 'bench', '--dev')
    if args.resource_profile == 'compute8-storage8':
        from cpu_layout import configure_services
        observation = configure_services()
        assert observation['status'] == 'PASS'
        if engine == 'neon':
            assert observation['storage_threads'] > 0
        result.setdefault('cpu_layout_observations', []).append({'engine':engine, **observation})
    assert sql('SHOW server_version').startswith('18.6')
    actual = json.loads(sql("SELECT json_object_agg(name,setting) FROM pg_settings WHERE name = ANY(ARRAY[" +
                            ','.join("'" + name + "'" for name in SETTINGS) + ",'data_checksums','ignore_checksum_failure','shared_preload_libraries'])"))
    assert actual['fsync'] == args.compute_local_fsync
    assert actual['synchronous_commit'] == SETTINGS['synchronous_commit']
    assert actual['full_page_writes'] == 'on'
    assert actual['data_checksums'] == actual['ignore_checksum_failure'] == 'off'
    assert actual['wal_compression'] == args.wal_compression
    if engine == 'upstream':
        assert actual['shared_preload_libraries'] == ''
        assert sql("SELECT count(*) FROM pg_settings WHERE name LIKE 'neon.%'") == '0'
    else:
        assert sql("SELECT current_setting('neon.pageserver_connstring') <> ''") == 't'
        if args.commit_policy != 'synchronous':
            assert sql('SHOW neon.bounded_async_commit') == 'on'
            assert json.loads(sql('SELECT neon.bounded_commit_guard_status()'))['max_age_ms'] == 750
        standby_names = sql('SHOW synchronous_standby_names')
        assert 'walproposer' in standby_names, 'Missing safekeeper synchronous commit barrier'
        result['engines']['neon']['synchronous_standby_names'] = standby_names
    prior = result['engines'][engine].get('settings')
    assert prior is None or prior == actual, 'Settings changed between engine restarts'
    result['engines'][engine]['settings'] = actual
    result['engines'][engine]['server_version'] = sql('SELECT version()')
    if engine == 'neon':
        configs = list((RUN/'neon/pageserver_1/tenants').glob('*/config-v1'))
        assert len(configs)==1
        configured = tomllib.loads(configs[0].read_text())['tenant_conf']
        timeout = re.fullmatch(r'(\d+)\s*(s|m|h)',configured['checkpoint_timeout'])
        assert configured['checkpoint_distance']==args.pageserver_checkpoint_mib*1048576
        assert timeout and int(timeout[1])*{'s':1,'m':60,'h':3600}[timeout[2]]==args.pageserver_checkpoint_seconds
        result['engines'][engine]['neon_storage_settings'] = {
            'pageserver_page_cache_bytes': 256 * 1048576, 'compute_lfc_bytes': 512 * 1048576,
            'pageserver_checkpoint_distance_bytes': args.pageserver_checkpoint_mib * 1048576,
            'pageserver_checkpoint_timeout_seconds': args.pageserver_checkpoint_seconds,
            'pageserver_checkpoint_configuration_observed':True,
            'compute_data_storage':args.compute_storage,
            'compute_tmpfs_limit_bytes':2*1024**3 if args.compute_storage=='tmpfs' else None,
            'compute_tmpfs_separate_from_shared_storage':args.compute_storage=='tmpfs',
            'safekeepers': 3, 'safekeeper_sync': True}


def stop(engine):
    if engine == 'upstream':
        run([UPSTREAM + 'pg_ctl', '-D', str(RUN / 'upstream'), '-m', 'fast', '-w', 'stop'], 'upstream-stop')
    else:
        if args.commit_policy != 'synchronous':
            sql('SELECT neon.bounded_commit_guard_drain()', 'planned-stop-drain')
        local('endpoint', 'stop', 'bench')
        local('stop')


def cold(engine):
    stop(engine)
    if engine == 'neon' and (RUN / 'lfc.cache').exists():
        # This is this benchmark's explicitly named, disposable LFC file.
        (RUN / 'lfc.cache').unlink()
    folder = RUN / ('upstream' if engine == 'upstream' else 'neon')
    count = size = 0
    for file in folder.rglob('*'):
        if file.is_file() and not file.is_symlink():
            with file.open('rb') as data:
                os.posix_fadvise(data.fileno(), 0, 0, os.POSIX_FADV_DONTNEED)
            count += 1
            size += file.stat().st_size
    start(engine)
    return {'files_advised': count, 'bytes_advised': size,
            'method': 'Clean full engine stop; fixture-only POSIX_FADV_DONTNEED; fresh Neon LFC; no global cache drop',
            'limits': 'Advisory Linux cache eviction; local PS layers remain. Remote S3 cache is uncontrolled.'}


scripts = {
    'relational-read': '\\set id random(1, :accounts)\nSELECT abalance FROM pgbench_accounts WHERE aid=:id;\n',
    'relational-write': '\\set id random(1, :accounts)\nBEGIN;\nUPDATE pgbench_accounts SET abalance=abalance+1 WHERE aid=:id;\nCOMMIT;\n',
    'jsonb-read': "\\set id random(1, :documents)\nSELECT doc->'metrics'->>'score',doc->>'kind' FROM benchmark_json WHERE id=:id;\n",
    'jsonb-write': "\\set id random(1, :documents)\nBEGIN;\nUPDATE benchmark_json SET doc=jsonb_set(doc,'{metrics,score}',to_jsonb((doc->'metrics'->>'score')::int+1)) WHERE id=:id;\nCOMMIT;\n",
    'jsonb-containment': "\\set tenant random(0,999)\nSELECT count(*) FROM benchmark_json WHERE doc @> jsonb_build_object('tenant',:tenant::integer,'kind','event');\n",
}
if args.batch_size > 1:
    variables = '\n'.join(f'\\set id{index} random(1, :limit)' for index in range(args.batch_size)) + '\n'
    ids = ','.join(f':id{index}' for index in range(args.batch_size))
    changes = f'WITH changes AS MATERIALIZED (SELECT id,count(*) AS delta FROM unnest(ARRAY[{ids}]::integer[]) id GROUP BY id), '
    # Lock distinct target rows in key order before updating them. Repeated
    # random keys retain their multiplicity, so each commit applies exactly N
    # mutations without introducing cross-transaction lock-order deadlocks.
    scripts['relational-write'] = variables.replace(':limit', ':accounts') + 'BEGIN;\n' + changes + (
        'locked AS MATERIALIZED (SELECT a.aid FROM pgbench_accounts a JOIN changes c ON a.aid=c.id '
        'ORDER BY a.aid FOR UPDATE OF a) UPDATE pgbench_accounts a SET abalance=a.abalance+c.delta '
        'FROM changes c JOIN locked l ON l.aid=c.id WHERE a.aid=c.id;\nCOMMIT;\n')
    scripts['jsonb-write'] = variables.replace(':limit', ':documents') + 'BEGIN;\n' + changes + (
        'locked AS MATERIALIZED (SELECT j.id FROM benchmark_json j JOIN changes c ON j.id=c.id '
        'ORDER BY j.id FOR UPDATE OF j) UPDATE benchmark_json j SET doc=jsonb_set(j.doc,\'{metrics,score}\','
        'to_jsonb((j.doc->\'metrics\'->>\'score\')::bigint+c.delta)) '
        'FROM changes c JOIN locked l ON l.id=c.id WHERE j.id=c.id;\nCOMMIT;\n')
for name, text in scripts.items():
    (RUN / (name + '.sql')).write_text(text)
scenarios = args.scenarios.split(',')
assert set(scenarios) <= set(scripts) | {'relational-mixed', 'relational-cold-read', 'jsonb-cold-read'}
assert not args.rates or set(scenarios) <= {'relational-write','jsonb-write'}, 'Offered-rate suite uses independently accounted write workloads'


def bench_command(scenario, seconds, prefix=None, rate=None):
    actual = scenario.replace('-cold-read', '-read')
    command = [UPSTREAM + 'pgbench', '-h', '127.0.0.1', '-p', str(PORT), '-U', USER,
               'postgres', '-n', '-M', 'prepared', '-c', str(args.clients), '-j', str(min(4, args.clients)),
               '-T', str(seconds), '-D', 'accounts=' + str(args.scale * 100000),
               '-D', 'documents=' + str(args.json_rows), '--random-seed=20261030']
    if actual == 'relational-mixed':
        command += ['-b', 'tpcb-like']
    else:
        command += ['-f', str(RUN / (actual + '.sql'))]
    if prefix:
        command += ['-l', '--sampling-rate='+str(args.latency_sampling), '--log-prefix=' + prefix]
    if rate is not None:
        command += ['--rate',str(rate)]
    return command


def processed(text):
    match = re.search(r'number of transactions actually processed:\s*(\d+)', text)
    assert match, 'pgbench did not report transaction count'
    failures = re.search(r'number of failed transactions:\s*(\d+)', text)
    assert failures and int(failures[1]) == 0, 'Failed benchmark transactions'
    return int(match[1])


def seed_accounts(engine, repetition):
    run([UPSTREAM + 'pgbench', '-i', '-s', str(args.scale), '-h', '127.0.0.1', '-p', str(PORT),
         '-U', USER, 'postgres'], f'{engine}-{repetition}-seed-pgbench-{time.time_ns()}')


def index_checkpoint_probe(engine, repetition):
    # GIN's metapage is dirty before its final full-page WAL logging. Force a
    # different process to flush it while the builder is paused in heap scan.
    sql("DROP TABLE IF EXISTS index_checkpoint_probe; "
        "CREATE TABLE index_checkpoint_probe AS SELECT jsonb_build_object('id',g) doc FROM generate_series(1,100) g; "
        "CREATE OR REPLACE FUNCTION index_checkpoint_slow(doc jsonb) RETURNS jsonb "
        "LANGUAGE plpgsql IMMUTABLE AS $$BEGIN IF doc->>'id'='1' THEN PERFORM pg_sleep(8); END IF; RETURN doc; END$$;")
    client_env = dict(os.environ, PGAPPNAME='index-checkpoint-probe')
    pending = subprocess.Popen([UPSTREAM+'psql','-XqAt','-v','ON_ERROR_STOP=1',
        '-h','127.0.0.1','-p',str(PORT),'-U',USER,'-d','postgres','-c',
        'CREATE INDEX index_checkpoint_gin ON index_checkpoint_probe USING gin(index_checkpoint_slow(doc) jsonb_path_ops)'],
        stdout=subprocess.PIPE,stderr=subprocess.PIPE,text=True,env=client_env)
    deadline = time.monotonic()+30
    try:
        while sql("SELECT count(*) FROM pg_stat_activity WHERE application_name='index-checkpoint-probe' AND wait_event='PgSleep'") != '1':
            assert pending.poll() is None, 'Index builder exited before checkpoint probe'
            assert time.monotonic()<deadline, 'Index builder never entered controlled pause'
            time.sleep(.05)
        sql('CHECKPOINT', 'index-build-concurrent-checkpoint')
        stdout, stderr = pending.communicate(timeout=45)
        (PUBLIC/f'{engine}-r{repetition}-index-checkpoint.log').write_text(stdout+stderr)
        assert pending.returncode == 0, 'Index build failed after concurrent checkpoint'
        # Remove the intentional delay before verifying index contents.
        sql('CREATE OR REPLACE FUNCTION index_checkpoint_slow(doc jsonb) RETURNS jsonb LANGUAGE plpgsql IMMUTABLE AS $$BEGIN RETURN doc; END$$;')
        predicate = "index_checkpoint_slow(doc) @> '{\"id\":42}'"
        plan = sql('SET enable_seqscan=off; EXPLAIN (FORMAT JSON) SELECT count(*) FROM index_checkpoint_probe WHERE '+predicate)
        assert 'index_checkpoint_gin' in plan, 'Checkpoint probe did not use the completed index'
        assert sql('SET enable_seqscan=off; SELECT count(*) FROM index_checkpoint_probe WHERE '+predicate) == '1'
        sql('DROP TABLE index_checkpoint_probe; DROP FUNCTION index_checkpoint_slow(jsonb);')
        result.setdefault('index_checkpoint_checks', []).append({'engine':engine,'repetition':repetition,
            'status':'PASS','check':'Concurrent checkpoint during unlogged GIN build, followed by indexed content check'})
        print(f'PASS {engine}-r{repetition}: concurrent index-build checkpoint',flush=True)
    finally:
        if pending.poll() is None:
            pending.terminate()
            pending.communicate(timeout=10)


def seed(engine, repetition):
    seed_accounts(engine, repetition)
    sql('DROP TABLE IF EXISTS benchmark_json; CREATE TABLE benchmark_json (id int PRIMARY KEY, doc jsonb NOT NULL); '
        f'ALTER TABLE benchmark_json ALTER COLUMN doc SET STORAGE {args.toast_storage.upper()}; '
        'INSERT INTO benchmark_json SELECT g, jsonb_build_object(\'tenant\',g%1000,\'kind\', '
        "CASE WHEN g%3=0 THEN 'event' ELSE 'order' END,'metrics',jsonb_build_object('score',0),"
        "'payload',(SELECT string_agg(md5(g::text||':'||n::text),'') FROM generate_series(1,64) n)) "
        f'FROM generate_series(1,{args.json_rows}) g; '
        'CREATE INDEX benchmark_json_gin ON benchmark_json USING gin(doc jsonb_path_ops);', 'seed-json', timeout=600)
    sql('VACUUM (ANALYZE)')
    initial = digest()
    assert initial['json_rows'] == args.json_rows and initial['account_rows'] == args.scale * 100000
    assert initial['json_score_sum'] == initial['account_balance'] == initial['history_balance'] == 0
    previous = result.get('initial_fixture')
    assert previous is None or previous == initial, 'Engine input datasets differ'
    result['initial_fixture'] = initial
    result['engines'][engine]['database_bytes'] = int(sql('SELECT pg_database_size(current_database())'))
    result['engines'][engine]['json_average_bytes'] = float(sql('SELECT avg(octet_length(doc::text)) FROM benchmark_json'))
    result['engines'][engine]['containment_plan'] = json.loads(sql(
        "EXPLAIN (FORMAT JSON) SELECT count(*) FROM benchmark_json WHERE doc @> '{\"tenant\":42,\"kind\":\"event\"}'"))
    if args.json_rows >= 10000:
        assert 'benchmark_json_gin' in json.dumps(result['engines'][engine]['containment_plan'])


def process_state(pid):
    try:
        fields = Path(f'/proc/{pid}/stat').read_text().rsplit(') ',1)[1].split()
        return fields[0], int(fields[1])
    except FileNotFoundError:
        return None


def archive_compute_files(label):
    endpoint = RUN/'neon/endpoints/bench'
    pgdata = endpoint/'pgdata'
    assert_compute_path(pgdata)
    if args.compute_storage=='tmpfs':
        # Persist evidence as one file, then free ONLY this new fixture's
        # disposable RAM directory. The archive is never a startup input.
        directory=RUN/'compute-memory-evidence'
        directory.mkdir(mode=0o700,exist_ok=True)
        archive=directory/f'pgdata-{label}.tar'
        assert not archive.exists()
        with tarfile.open(archive,'x') as output:
            output.add(pgdata,arcname='pgdata',recursive=True)
        archive.chmod(0o600)
        with archive.open('rb') as evidence:
            os.fsync(evidence.fileno())
            digest=hashlib.file_digest(evidence,'sha256').hexdigest()
        result.setdefault('compute_memory_archives',[]).append({'label':label,'path':str(archive.relative_to(RUN)),
            'bytes':archive.stat().st_size,'sha256':digest,'excluded_from_restart':True})
        assert pgdata.resolve()==Path('/compute/endpoints/bench/pgdata') and os.path.ismount('/compute')
        shutil.rmtree(pgdata)
    else:
        archive = endpoint/f'pgdata-{label}'
        assert not archive.exists()
        pgdata.rename(archive)
    cache = RUN/'lfc.cache'
    if cache.exists():
        destination = RUN/f'lfc-{label}.cache'
        assert not destination.exists()
        cache.rename(destination)
    assert not pgdata.exists() and not cache.exists()


def assert_compute_path(pgdata):
    assert not pgdata.is_symlink()
    if args.compute_storage=='tmpfs':
        assert os.path.ismount('/compute') and pgdata.resolve()==Path('/compute/endpoints/bench/pgdata')
    else:
        assert pgdata.resolve().is_relative_to(RUN.resolve())


def lose_compute_storage(repetition, expected, suffix='', extra_probe=None, result_group=None):
    endpoint = RUN / 'neon/endpoints/bench'
    pgdata = endpoint / 'pgdata'
    assert_compute_path(pgdata)
    ctl = int((endpoint/'compute_ctl.pid').read_text().strip())
    pg = int((pgdata/'postmaster.pid').read_text().splitlines()[0])
    for pid, executable in [(ctl,'compute_ctl'),(pg,'postgres')]:
        command = Path(f'/proc/{pid}/cmdline').read_bytes().split(b'\0')
        assert Path(command[0].decode()).name == executable
        assert str(pgdata).encode() in command, 'Refusing to kill a process outside this new fixture'
    # Prevent compute_ctl from performing its normal shutdown/WAL sync cleanup.
    os.kill(ctl,signal.SIGSTOP)
    os.kill(pg,signal.SIGSTOP)
    states = {int(item.name):process_state(int(item.name)) for item in Path('/proc').iterdir() if item.name.isdigit()}
    targets = {ctl}
    while True:
        descendants = {pid for pid,state in states.items() if state and state[1] in targets}
        if descendants.issubset(targets):
            break
        targets |= descendants
    assert pg in targets
    for pid in targets-{ctl}:
        try:
            os.kill(pid,signal.SIGKILL)
        except ProcessLookupError:
            pass
    os.kill(ctl,signal.SIGKILL)
    deadline = time.monotonic()+15
    while any((state:=process_state(pid)) and state[0]!='Z' for pid in targets):
        assert time.monotonic()<deadline, 'Compute processes did not die'
        time.sleep(.05)
    archive_compute_files(f'lost-r{repetition}{suffix}')
    began = time.monotonic()
    local('endpoint','start','bench','--dev')
    wake_seconds = time.monotonic()-began
    assert digest() == expected, 'Acknowledged data changed after losing compute PGDATA and cache'
    assert sql(f'SELECT count(*) FROM optimization_durability_probe WHERE id IN ({repetition*10+1},{repetition*10+2})') == '2'
    if extra_probe is not None:
        assert sql(f'SELECT count(*) FROM optimization_durability_probe WHERE id={extra_probe}') == '1', 'First post-wake acknowledged write lost'
    acknowledged = sorted([probe for row in result.get('recovery_checks',[]) if row['engine']=='neon'
                           for probe in (row['repetition']*10+1,row['repetition']*10+2)] +
                          [row['acknowledged_probe_id'] for row in result.get('scale_zero_checks',[])])
    recovered = json.loads(sql('SELECT coalesce(json_agg(id ORDER BY id),\'[]\'::json) FROM optimization_durability_probe'))
    assert recovered == acknowledged, 'Acknowledged probe history changed after losing compute-local storage'
    group = result_group or ('post_wake_storage_loss_checks' if suffix else 'compute_storage_loss_checks')
    result.setdefault(group,[]).append({'repetition':repetition,'status':'PASS','archive_suffix':suffix,
        'additional_acknowledged_probe_id':extra_probe,
        'acknowledged_probe_ids_verified':acknowledged,
        'hard_killed_compute_processes':len(targets),'old_pgdata_retained_outside_restart_path':True,
        'old_lfc_removed_from_restart_path':True,'reconstruct_seconds':wake_seconds,
        'scope':'Compute process tree killed with SIGKILL; all old compute files excluded. Shared pageserver/safekeepers remain running. Not an OS power-failure test.'})
    print(f'PASS neon-r{repetition}: compute-local storage loss and remote reconstruction ({wake_seconds:.2f}s)',flush=True)


def scale_zero_wake(repetition, expected, cycle=1):
    endpoint = RUN/'neon/endpoints/bench'
    pids = [int((endpoint/'compute_ctl.pid').read_text().strip()),
            int((endpoint/'pgdata/postmaster.pid').read_text().splitlines()[0])]
    if args.commit_policy != 'synchronous':
        frontier = sql('SELECT neon.bounded_commit_guard_drain()', 'planned-sleep-drain')
        assert frontier
        result.setdefault('planned_sleep_frontiers', []).append(frontier)
    local('endpoint','stop','bench')
    time.sleep(1)
    assert not (RUN/'neon/endpoints/bench/pgdata/postmaster.pid').exists()
    assert all((state:=process_state(pid)) is None or state[0]=='Z' for pid in pids), 'Compute still running during supposed zero interval'
    if args.empty_compute_on_wake:
        archive_compute_files(f'idle-r{repetition}-wake{cycle}')
        time.sleep(1)  # Observe a genuinely empty compute-data interval too.
    wake_started = time.monotonic()
    local('endpoint','start','bench','--dev')
    ready_seconds = time.monotonic()-wake_started
    # This is the first client operation after readiness: measure through a real
    # independently committed write, including the client connection.
    probe = 1000000000 + repetition*10000 + cycle
    sql(f'SET synchronous_commit=on; INSERT INTO optimization_durability_probe VALUES ({probe})', f'wake-r{repetition}-c{cycle}-commit')
    durable_write_seconds = time.monotonic()-wake_started
    assert sql('SHOW fsync') == args.compute_local_fsync
    assert sql('SHOW synchronous_commit') == SETTINGS['synchronous_commit']
    assert sql('SHOW full_page_writes') == 'on'
    assert 'walproposer' in sql('SHOW synchronous_standby_names')
    began = time.monotonic()
    assert sql('SELECT abalance IS NOT NULL FROM pgbench_accounts WHERE aid=42') == 't'
    relational_ms = (time.monotonic()-began)*1000
    began = time.monotonic()
    assert sql("SELECT length(doc->>'payload') FROM benchmark_json WHERE id=42") == '2048'
    json_ms = (time.monotonic()-began)*1000
    assert digest() == expected
    result.setdefault('scale_zero_checks',[]).append({'repetition':repetition,'cycle':cycle,'status':'PASS',
        'idle_compute_processes':0,'wake_to_ready_seconds':ready_seconds,
        'old_compute_files_excluded_before_wake':args.empty_compute_on_wake,
        'wake_to_first_durable_write_seconds':durable_write_seconds,'acknowledged_probe_id':probe,
        'first_relational_query_ms_including_client_connect':relational_ms,
        'first_json_query_ms_including_client_connect':json_ms,
        'scope':'Manual tenant compute stop/wake with shared storage online; no Kubernetes scheduling, request proxy or autoscaler claim'})
    print(f'PASS neon-r{repetition}-c{cycle}: zero compute to durable write ({durable_write_seconds:.2f}s)',flush=True)
    if args.verify_compute_storage_loss:
        lose_compute_storage(repetition,expected,suffix=f'-wake{cycle}',extra_probe=probe)


def digest():
    return json.loads(sql("SELECT json_build_object('json_rows',(SELECT count(*) FROM benchmark_json),"
        "'account_rows',(SELECT count(*) FROM pgbench_accounts),"
        "'json_score_sum',(SELECT sum((doc->'metrics'->>'score')::bigint) FROM benchmark_json),"
        "'payload_digest',(SELECT md5(string_agg(id::text||':'||md5(doc->>'payload'),',' ORDER BY id)) FROM benchmark_json),"
        "'account_balance',(SELECT sum(abalance) FROM pgbench_accounts),"
        "'teller_balance',(SELECT sum(tbalance) FROM pgbench_tellers),"
        "'branch_balance',(SELECT sum(bbalance) FROM pgbench_branches),"
        "'history_balance',(SELECT coalesce(sum(delta),0) FROM pgbench_history))", 'digest', timeout=600))


def sample(engine, repetition, scenario, rate=None):
    label = f'{engine}-r{repetition}-{scenario}'
    if rate is not None:
        label += f'-rate{rate:g}'
    if '-cold-' in scenario:
        cache = cold(engine)
    else:
        # Flush this fixture's prior writes before a read-only measurement, so
        # deferred writes from the previous case do not dominate its IOPS.
        stop(engine)
        start(engine)
        cache = {'method': 'Clean full engine restart; full-value warm scan and configured workload warmup'}
    warm_transactions = 0
    if '-cold-' not in scenario:
        # Warm full JSON values rather than only TOAST pointers.
        sql('SELECT sum(octet_length(doc::text)) FROM benchmark_json' if scenario.startswith('jsonb') else
            'SELECT sum(abalance) FROM pgbench_accounts', 'warm-data')
        warm_transactions = processed(run(bench_command(scenario, args.warmup,rate=rate), label + '-warmup'))
    time.sleep(1.1)
    pg_before = pg_snapshot(engine)
    remote_before = remote_counters(engine)
    durability_before = durability_counters(engine)
    remote_started = time.monotonic()
    prefix = '/tmp/' + label
    before = snapshot()
    process = subprocess.Popen(bench_command(scenario, args.seconds, prefix, rate=rate), stdout=subprocess.PIPE,
                               stderr=subprocess.STDOUT, text=True)
    resources = [before]
    while True:
        try:
            process.wait(timeout=1)
            break
        except subprocess.TimeoutExpired:
            observation = snapshot()
            if args.trace_waits:
                observation['diagnostic'] = wait_snapshot(engine)
            resources.append(observation)
    text = process.communicate(timeout=10)[0]
    after = snapshot()
    durability_after = durability_counters(engine)
    remote_after = remote_counters(engine)
    remote_elapsed = time.monotonic() - remote_started
    assert process.returncode == 0, label + ' pgbench process failed'
    (PUBLIC / (label + '.log')).write_text(text)
    transactions = processed(text)
    tps = float(re.search(r'tps = ([\d.]+)', text)[1])
    average = float(re.search(r'latency average = ([\d.]+) ms', text)[1])
    time.sleep(1.1)
    pg_after = pg_snapshot(engine)
    latency = []
    schedule_lag = []
    execution_latency = []
    for file in sorted(Path('/tmp').glob(label + '.*')):
        with file.open() as source, gzip.open(PUBLIC / (file.name + '.gz'), 'wt') as target:
            for line in source:
                target.write(line)
                fields = line.split()
                assert len(fields) >= 6 and fields[2].isdigit(), 'Unexpected pgbench transaction sample'
                latency.append(int(fields[2]) / 1000)
                if rate is not None:
                    assert len(fields) == 7 and fields[6].isdigit()
                    lag = int(fields[6])/1000
                    assert lag <= int(fields[2])/1000
                    schedule_lag.append(lag)
                    execution_latency.append(int(fields[2])/1000-lag)
        file.unlink()
    assert latency, 'Missing latency samples'
    latency.sort()
    elapsed = after['monotonic'] - before['monotonic']
    keys = ['reads','read_bytes','writes','write_bytes','extends','extend_bytes','hits','fsyncs']
    totals = lambda value: {key: sum(row.get(key) or 0 for row in value['io']) for key in keys}
    pg_delta = subtract(totals(pg_after), totals(pg_before))
    cpu = subtract(after['cpu'], before['cpu'])
    item = {'engine': engine, 'repetition': repetition, 'scenario': scenario, 'clients': args.clients,
            'sample_label':label,'requested_rate':rate,
            'latency_origin':'Scheduled arrival including queue delay' if rate is not None else 'Actual transaction start (closed-loop)',
            'requested_seconds': args.seconds, 'measured_seconds': elapsed, 'transactions': transactions,
            'warmup_transactions': warm_transactions, 'failed_transactions': 0, 'tps': tps,
            'latency_ms': {'mean': average, 'sample_count': len(latency),
                           **{name: latency[min(len(latency)-1, math.ceil(p*len(latency))-1)]
                              for name,p in [('p50',.5),('p95',.95),('p99',.99),('p999',.999)]},'max':latency[-1]},
            'block_io': io_delta(before, after), 'pg_io': {'delta': pg_delta,
                'read_calls_per_second': pg_delta['reads']/elapsed,
                'write_calls_per_second': pg_delta['writes']/elapsed,
                'coverage': 'Compute PostgreSQL core I/O calls, not physical disk or Neon page-service RPCs'},
            'pg_stats_before': pg_before, 'pg_stats_after': pg_after,
            'wal_bytes': int(pg_after['wal']['wal_bytes'])-int(pg_before['wal']['wal_bytes']),
            'cpu': {**cpu, 'cpu_seconds_per_transaction': cpu['usage_usec']/1e6/transactions},
            'memory_peak_observed_bytes': max(row['memory_bytes'] for row in resources),
            's3': {'native_operation_delta': subtract(remote_after, remote_before),
                'interval_seconds': remote_elapsed,
                'remote_device_iops': None,
                'coverage': 'Native completed object-storage operations; remote S3 disk IOPS are not observable'},
            'cache': cache}
    item['durability_metrics'] = {'before':durability_before,'after':durability_after,
        'delta':subtract(durability_after,durability_before),
        'coverage':'Safekeeper histogram deltas sampled just outside the foreground block-I/O interval; not end-to-end quorum latency'}
    if rate is not None:
        distribution = lambda values: {'sample_mean':statistics.mean(values),
            **{name:sorted(values)[math.ceil(p*len(values))-1] for name,p in [('p50',.5),('p95',.95),('p99',.99)]}}
        item['schedule_lag_ms'] = distribution(schedule_lag)
        item['execution_latency_ms'] = distribution(execution_latency)
        reported = re.search(r'schedule lag: avg ([\d.]+) \(max:? ([\d.]+)\) ms',text)
        assert reported, 'Missing offered-rate queue lag statistics'
        item['schedule_lag_ms'].update(reported_mean=float(reported[1]),reported_max=float(reported[2]))
    (PUBLIC / (label + '-resources.json')).write_text(json.dumps(resources, indent=2))
    result['samples'].append(item)
    save()
    print(f"PASS {label}: {tps:.1f} TPS, p95 {item['latency_ms']['p95']:.2f} ms, "
          f"block read/write {item['block_io']['read_iops']:.1f}/{item['block_io']['write_iops']:.1f} IOPS", flush=True)
    return transactions + warm_transactions


def save():
    (RUN / 'benchmark.json').write_text(json.dumps(result, indent=2) + '\n')


result = {'schema_version': 1, 'status': 'RUNNING', 'parameters': vars(args), 'samples': [], 'engines': {
    'upstream': {'source': json.loads(Path('/usr/local/share/neon/benchmark/upstream-source.json').read_text()),
                 'durability': 'One local PostgreSQL WAL copy; fsync and synchronous_commit on'},
    'neon': {'durability': 'Three synchronous safekeepers, broker, pageserver, controller metadata PG and compute',
             'object_storage': 'external HTTPS S3 (direct SDK connection; no test proxy)' if s3 else 'local filesystem'}},
    'methodology': {'scope': 'Single-host sequential engines, entire stack plus client within identical cgroup CPU/RAM limits',
        'case_preparation': 'Each case cleanly restarts the full engine to flush prior fixture writes; startup is outside the measurement',
        'dataset_order': 'Default read cases precede mutations. pgbench tables are reinitialized before mixed writes to avoid prior update-volume differences.',
        'block_iops': 'Linux cgroup v2 io.stat leaf-device delta/time, guest virtual block I/O after merging; excludes remote S3 disks',
        'pg_io': 'PostgreSQL pg_stat_io API calls can be satisfied from OS cache; not hardware IOPS',
        'write_window': 'Foreground measurement only, includes synchronous WAL and concurrent background I/O; deferred writeback may follow',
        'latency': f'pgbench mean and {args.latency_sampling*100:g}% raw transaction sample percentiles; logs on tmpfs during measurement',
        'limits': ['Shared Docker Desktop/WSL host with other workloads', 'No multi-zone or production capacity claim',
                   'Cold cache eviction is per-fixture advice; remote S3 caches are uncontrolled',
                   'Checksums explicitly off on both engines to match the supported Neon profile']},
    'environment': {'cpu_max': Path('/sys/fs/cgroup/cpu.max').read_text().strip(),
                    'memory_max': Path('/sys/fs/cgroup/memory.max').read_text().strip(),
                    'kernel': os.uname().release},
    's3_prefix': s3['prefix'] if s3 else None}
if args.commit_policy in ('bounded-local','bounded-async'):
    result['engines']['upstream']['durability'] = 'Local PostgreSQL WAL fsync before acknowledgement; no remote replica'
    result['engines']['neon']['durability'] = ('Compute-local WAL fsync before acknowledgement; native 750ms age/64MB byte '
        'admission bound relative to verified remote quorum, live-quorum gating, synchronous safekeeper disks; '
        'planned sleep drains remote quorum. Accepted compute-loss or one-storage-node failure scope only.')
    if args.commit_policy == 'bounded-async':
        result['engines']['neon']['durability'] = ('Ephemeral compute WAL; native 750ms age/64MB byte admission bound '
            'relative to verified remote quorum; live-quorum gating and synchronous safekeeper disks. Planned sleep '
            'drains remote quorum. Accepted loss window up to one second for compute loss or one storage-node failure; '
            'not equivalent to durable native-PG per-commit acknowledgement.')
elif args.commit_policy == 'native-async':
    result['engines']['upstream']['durability'] = ('Native asynchronous commit; fsync stays on; '
        'default PostgreSQL WAL writer flush schedule. This is an asynchronous control, not a hard one-second RPO qualification.')
save()
active = None
initialized = set()
try:
    for repetition in range(1, args.repeats + 1):
        order = ['upstream','neon'] if repetition % 2 else ['neon','upstream']
        order = [engine for engine in order if args.engine in ('both', engine)]
        for engine in order:
            print(f'RUN repetition {repetition}/{args.repeats}: {engine}', flush=True)
            start(engine, initialize=engine not in initialized)
            active = engine
            initialized.add(engine)
            if args.probe_index_checkpoint:
                index_checkpoint_probe(engine,repetition)
            # Require identical normalized compute settings, excluding preload.
            if all('settings' in value for value in result['engines'].values()):
                for key in SETTINGS:
                    assert result['engines']['upstream']['settings'][key] == result['engines']['neon']['settings'][key], key
            seed(engine, repetition)
            writes = {'relational-write': 0, 'jsonb-write': 0}
            account_offset = 0
            for rate in rates:
                for scenario in scenarios:
                    if scenario == 'relational-mixed':
                        seed_accounts(engine, repetition)
                        account_offset = 0
                    count = sample(engine, repetition, scenario,rate=rate)
                    if scenario in writes:
                        writes[scenario] += count * args.batch_size
                    if scenario == 'relational-write':
                        account_offset += count * args.batch_size
                        assert int(sql('SELECT sum(abalance) FROM pgbench_accounts')) == account_offset
            final = digest()
            if engine == 'neon' and args.commit_policy != 'synchronous':
                guard_status = json.loads(sql('SELECT neon.bounded_commit_guard_status()'))
                assert guard_status['enabled'] and guard_status['fast_acks'] > 0
                result.setdefault('native_guard_observations', []).append(guard_status)
            assert final['json_rows'] == args.json_rows
            assert final['payload_digest'] == result['initial_fixture']['payload_digest']
            assert final['json_score_sum'] == writes['jsonb-write']
            assert final['account_balance'] == final['history_balance'] + account_offset
            assert final['teller_balance'] == final['branch_balance'] == final['history_balance']
            result.setdefault('integrity_checks', []).append({'engine': engine, 'repetition': repetition,
                'status': 'PASS', 'digest': final, 'write_transactions': writes})
            if args.verify_recovery and engine == 'neon':
                sql('CREATE TABLE IF NOT EXISTS optimization_durability_probe(id int PRIMARY KEY)')
                local('safekeeper', 'stop', '3', '-m', 'immediate')
                sql(f'INSERT INTO optimization_durability_probe VALUES ({repetition*10+1})')
                local('safekeeper', 'stop', '2', '-m', 'immediate')
                pending = subprocess.Popen([UPSTREAM+'psql','-XqAt','-v','ON_ERROR_STOP=1',
                    '-h','127.0.0.1','-p',str(PORT),'-U',USER,'-d','postgres','-c',
                    f'INSERT INTO optimization_durability_probe VALUES ({repetition*10+2})'],
                    stdout=subprocess.PIPE,stderr=subprocess.PIPE,text=True)
                time.sleep(3)
                assert pending.poll() is None, 'Commit completed without a durable safekeeper majority'
                local('safekeeper', 'start', '2')
                pending.communicate(timeout=90)
                assert pending.returncode == 0, 'Commit failed after quorum restoration'
                local('safekeeper', 'start', '3')
                local('endpoint', 'stop', 'bench', '--mode', 'immediate')
                local('endpoint', 'start', 'bench', '--dev')
                assert digest() == final, 'Acknowledged benchmark mutations changed after compute crash/reconstruction'
                assert sql(f'SELECT count(*) FROM optimization_durability_probe WHERE id IN ({repetition*10+1},{repetition*10+2})') == '2'
                result.setdefault('recovery_checks', []).append({'engine':engine,'repetition':repetition,
                    'status':'PASS','checks':['one safekeeper loss permits commit','majority loss blocks commit',
                        'restoring quorum completes commit','compute crash preserves acknowledged data and JSON payload digest']})
                print(f'PASS {engine}-r{repetition}: majority-acknowledgement blocking and compute crash recovery',flush=True)
            if args.verify_pageserver_crash and engine == 'neon':
                local('pageserver','stop','-m','immediate')
                began = time.monotonic()
                local('pageserver','start','--start-timeout','90s')
                ready_seconds = time.monotonic()-began
                lose_compute_storage(repetition,final,suffix='-pageserver',result_group='pageserver_crash_checks')
                result['pageserver_crash_checks'][-1]['pageserver_restart_ready_seconds'] = ready_seconds
                print(f'PASS neon-r{repetition}: pageserver crash plus complete compute-file exclusion',flush=True)
            if args.verify_compute_storage_loss and engine == 'neon':
                lose_compute_storage(repetition,final)
            if args.verify_scale_zero and engine == 'neon':
                for cycle in range(1,args.wake_cycles+1):
                    scale_zero_wake(repetition,final,cycle)
            stop(engine)
            active = None
            if engine == 'neon' and s3:
                from s3_client import S3Client
                objects = S3Client(s3).objects(s3['prefix'] + '/')
                layers = [item for item in objects if '/pageserver/' in item['key']]
                wal = [item for item in objects if '/safekeeper/' in item['key'] and item['size'] >= 16 * 1048576]
                assert layers, 'Direct S3 backing did not receive pageserver layers'
                result['engines']['neon'].setdefault('s3_offload_proofs', []).append({
                    'repetition': repetition, 'tls_verified': True, 'pageserver_objects': len(layers),
                    'full_wal_objects': len(wal), 'total_prefix_bytes': sum(item['size'] for item in objects)})
            save()
    result['status'] = 'PASS'
except BaseException as error:
    result['status'] = 'FAIL'
    result['error'] = type(error).__name__ + ': ' + str(error)
    raise
finally:
    try:
        save()
        if active:
            stop(active)
        if proxy:
            proxy.close()
    finally:
        if args.compute_storage=='tmpfs' and Path('/compute/endpoints').exists():
            try:
                directory=RUN/'compute-memory-evidence'
                directory.mkdir(mode=0o700,exist_ok=True)
                archive=directory/'endpoints-final.tar'
                assert not archive.exists()
                with tarfile.open(archive,'x') as output:
                    output.add('/compute/endpoints',arcname='endpoints',recursive=True)
                archive.chmod(0o600)
                with archive.open('rb') as evidence:
                    os.fsync(evidence.fileno())
                    digest=hashlib.file_digest(evidence,'sha256').hexdigest()
                result['compute_endpoint_memory_archive']={'path':str(archive.relative_to(RUN)),
                    'bytes':archive.stat().st_size,'sha256':digest,
                    'scope':'Private endpoint configuration/log/data evidence preserved on the fixture volume; never a startup input'}
            except BaseException as error:
                result['status']='FAIL'
                result['error']='RAM endpoint evidence preservation: '+type(error).__name__
                raise
            finally:
                save()
