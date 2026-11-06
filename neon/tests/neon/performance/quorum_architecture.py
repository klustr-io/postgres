#!/usr/bin/env python3
"""Small RAM-only attribution screen; never a persistent-media durability claim.

Run through run-quorum-architecture.mjs. No S3, volumes or host tuning. Fault
checks exercise process suspension/restarts only, never persistent-media loss.
Policies are labelled explicitly. Asynchronous profiles change acknowledgement
guarantees; the safekeeper no-sync control is unsafe and diagnostic only.
"""
import hashlib
import json
import os
from pathlib import Path
import re
import resource
import signal
import shutil
import subprocess
import time
import urllib.request
import concurrent.futures
import xml.etree.ElementTree as ET

ROOT = Path('/var/lib/neon')
FIXTURE_ID = os.environ.get('QUORUM_FIXTURE_ID','local-quorum-fixture')
assert re.fullmatch(r'[a-z0-9-]{1,80}',FIXTURE_ID)
CASE_FILTER = os.environ.get('QUORUM_CASE_FILTER','all')
NATIVE_WINDOW = os.environ.get('QUORUM_NATIVE_WINDOW','1')
NATIVE_TRANSPORT = os.environ.get('QUORUM_NATIVE_TRANSPORT','http')
NATIVE_SENDER_OWNED = os.environ.get('QUORUM_NATIVE_SENDER_OWNED') == '1'
NATIVE_SHARED_COMPLETION = os.environ.get('QUORUM_NATIVE_SHARED_COMPLETION') == '1'
NATIVE_SPIN_US = os.environ.get('QUORUM_NATIVE_SPIN_US','0')
assert NATIVE_SPIN_US.isdecimal() and 0 <= int(NATIVE_SPIN_US) <= 100
SK_RUNTIME_THREADS = os.environ.get('QUORUM_SK_RUNTIME_THREADS','0')
assert SK_RUNTIME_THREADS.isdecimal() and 0 <= int(SK_RUNTIME_THREADS) <= 16
NATIVE_STREAM_WINDOW = os.environ.get('QUORUM_NATIVE_STREAM_WINDOW','0')
assert NATIVE_STREAM_WINDOW.isdecimal() and 0 <= int(NATIVE_STREAM_WINDOW) <= 8
PREFLIGHT_NEGATIVE = os.environ.get('QUORUM_PREFLIGHT_NEGATIVE') == '1'
NATIVE_DEDICATED = os.environ.get('QUORUM_NATIVE_DEDICATED') == '1'
CANDIDATE_IO = os.environ.get('QUORUM_CANDIDATE_IO','tokio')
assert CANDIDATE_IO in ('tokio','owned','direct')
NATIVE_GROUP_DELAY_US = os.environ.get('QUORUM_NATIVE_GROUP_DELAY_US','0')
assert NATIVE_GROUP_DELAY_US.isdecimal() and 0 <= int(NATIVE_GROUP_DELAY_US) <= 1000
assert NATIVE_TRANSPORT in ('http','copy')
assert NATIVE_WINDOW in ('1','2','3','4')
assert CASE_FILTER in ('all','wal32','wal64')
LOCAL_COMMIT_DELAY_US = os.environ.get('QUORUM_LOCAL_COMMIT_DELAY_US','0')
assert LOCAL_COMMIT_DELAY_US.isdecimal() and 0 <= int(LOCAL_COMMIT_DELAY_US) <= 10000
STORAGE_BATCH_DELAY_US = os.environ.get('QUORUM_STORAGE_BATCH_DELAY_US','0')
assert STORAGE_BATCH_DELAY_US.isdecimal() and 0 <= int(STORAGE_BATCH_DELAY_US) <= 1000
COMMIT_PUBLICATION_MS = os.environ.get('QUORUM_COMMIT_PUBLICATION_MS')
if COMMIT_PUBLICATION_MS is not None:
    assert COMMIT_PUBLICATION_MS.isdecimal() and 0 <= int(COMMIT_PUBLICATION_MS) <= 10
PROFILE_PREFIX = FIXTURE_ID+'-kernel'
KERNEL_PROFILE = os.environ.get('QUORUM_KERNEL_PROFILE') == '1'
KERNEL_SCOPE = os.environ.get('QUORUM_KERNEL_SCOPE','storage')
assert KERNEL_SCOPE in ('storage','compute')
if KERNEL_PROFILE:
    assert os.geteuid() == 0, 'Kernel profiling needs the private fixture profiler capabilities'
    profiler_pid = os.fork()
    if profiler_pid == 0:
        # Only the profiler retains capabilities. All database services and the
        # fixture controller run as the image's normal unprivileged UID below.
        destination = Path('/profile-output')
        try:
            request = Path('/tmp/kernel-profile-request.json')
            deadline = time.monotonic()+90
            while not request.exists():
                if time.monotonic() >= deadline:
                    raise TimeoutError('No kernel profile requested')
                time.sleep(.05)
            pids = json.loads(request.read_text())
            assert 1 <= len(pids) <= 128 and all(isinstance(pid,int) and pid>1 for pid in pids)
            expected = 'safekeeper' if KERNEL_SCOPE == 'storage' else 'postgres'
            assert all(Path(f'/proc/{pid}/comm').read_text().strip() == expected for pid in pids)
            if KERNEL_SCOPE == 'storage':
                assert len(pids) == 3
            # perf's data mappings are not supported by every Windows bind
            # mount implementation. Record on private tmpfs, then export.
            perf_data = Path('/tmp')/(PROFILE_PREFIX+'.data')
            call_graph = 'dwarf,4096' if KERNEL_SCOPE == 'compute' else 'fp'
            record = subprocess.run(['perf','record','-e','cpu-clock','-F','199','-g','--call-graph',call_graph,
                '-p',','.join(map(str,pids)),'-o',str(perf_data),'--','sleep','2' if KERNEL_SCOPE == 'compute' else '3'],
                capture_output=True,text=True,timeout=12)
            (destination/(PROFILE_PREFIX+'-record.log')).write_text(record.stderr)
            assert record.returncode == 0, record.stderr
            with (destination/(PROFILE_PREFIX+'-report.txt')).open('w') as output:
                report_process = subprocess.run(['perf','report','--stdio','--no-children','--percent-limit','1',
                    '--sort','dso,symbol','-i',str(perf_data)],
                    stdout=output,stderr=subprocess.PIPE,text=True,timeout=12)
            assert report_process.returncode == 0, report_process.stderr
            shutil.copyfile(perf_data,destination/(PROFILE_PREFIX+'.data'))
            status = {'status':'PASS','pids':pids,'file_prefix':PROFILE_PREFIX,'call_graph':call_graph,
                'scope':KERNEL_SCOPE+' processes in this private PID namespace'}
        except Exception as error:
            status = {'status':'FAIL','error':str(error)}
        (destination/(PROFILE_PREFIX+'-status.json')).write_text(json.dumps(status))
        os._exit(0 if status['status']=='PASS' else 1)
    os.setgroups([])
    os.setgid(10002)
    os.setuid(10002)
PG = '/opt/postgres/v18/bin/'
RAW = '/opt/upstream/v18/bin/'
USER = 'cloud_admin'
PORT = '15432'
ephemeral_low, ephemeral_high = map(int, Path('/proc/sys/net/ipv4/ip_local_port_range').read_text().split())
assert all(not ephemeral_low <= port <= ephemeral_high for port in (15051,15432,15433,15434,15441,15442,15443)), 'Fixture listeners must avoid ephemeral client ports'
REPORT = ROOT / 'quorum-architecture.json'
GROUP = os.environ.get('QUORUM_TEST_GROUP', 'baseline')
assert GROUP in ('baseline', 'controls', 'safekeeper-nosync', 'tokio-one', 'native-quorum', 'bounded-async', 'best-effort', 'native-reference', 'jsonb-storage', 'quorum-io-tokio', 'quorum-io-inline', 'quorum-io-owned', 'quorum-io-direct', 'quorum-io-uring', 'quorum-io-uring-single', 'ordered-wait-ab')
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
        if argv[:3] == ['neon_local','endpoint','start']:
            log=ROOT/'neon/endpoints/bench/compute.log'
            if log.exists():
                report['compute_start_failure_log']=[line for line in log.read_text().splitlines()
                    if '/status' not in line and not any(secret in line.lower()
                        for secret in ('token','password','secret','authorization','eyj'))][-60:]
        raise RuntimeError(f'{argv[0:3]}: {result.stdout[-1500:]} {result.stderr[-1500:]}')
    return result.stdout.strip()


def sql(text):
    return command([RAW + 'psql', '-XqAt', '-v', 'ON_ERROR_STOP=1', '-h', '127.0.0.1',
                    '-p', PORT, '-U', USER, '-d', 'postgres', '-c', text])


def local(*args):
    return command(['neon_local', *args])


def process_commands(name):
    found=[]
    for proc in Path('/proc').iterdir():
        if not proc.name.isdigit(): continue
        try:
            if (proc/'comm').read_text().strip()!=name: continue
            arguments=(proc/'cmdline').read_bytes().split(b'\0')
            if arguments and (proc/'comm').read_text().strip()==name:
                found.append((proc,arguments))
        except (FileNotFoundError,ProcessLookupError):
            continue # Unrelated short-lived clients can exit during /proc traversal.
    return found


def start_io_safekeeper(node, engine=None):
    if engine is None:
        engine = CANDIDATE_IO if GROUP == 'ordered-wait-ab' else GROUP.removeprefix('quorum-io-').removesuffix('-single')
    extra = ['-e=--current-thread-runtime'] if GROUP.endswith('-single') else []
    if int(STORAGE_BATCH_DELAY_US):
        extra += ['-e=--wal-batch-delay-us='+STORAGE_BATCH_DELAY_US]
    if not PREFLIGHT_NEGATIVE and (os.environ.get('QUORUM_NATIVE_WAL_API_CHECK') == '1' or os.environ.get('QUORUM_NATIVE_PROVIDER') == '1'):
        extra += ['-e=--enable-native-wal-api']
    if NATIVE_DEDICATED:
        extra += ['-e=--listen-native-wal=127.0.0.1:'+str(7453+node)]
    return local('safekeeper','start',str(node),'-e=--wal-io-engine='+engine,*extra)


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
                if line.startswith(('safekeeper_native_wal_', 'safekeeper_wal_replay_cache_', 'safekeeper_flush_wal_seconds_sum', 'safekeeper_flush_wal_seconds_count',
                                    'safekeeper_proposer_acceptor_messages_total', 'safekeeper_write_wal_bytes_count',
                                    'safekeeper_write_wal_bytes_sum', 'safekeeper_pg_io_bytes_total')):
                    key, value = line.rsplit(' ', 1)
                    values[str(port) + ':' + key] = float(value)
    return values


def profile_safekeeper(port):
    with urllib.request.urlopen(f'http://127.0.0.1:{port}/profile/cpu?seconds=3&frequency=99&format=svg',timeout=10) as response:
        svg = response.read()
    name = f'safekeeper-{port}.svg'
    Path('/profile-output',name).write_bytes(svg)
    counts = {}
    for entry in ET.fromstring(svg).iter():
        if entry.tag.endswith('title') and entry.text:
            match = re.fullmatch(r'(.+) \(([\d,]+) samples?, ([\d.]+)%\)',entry.text)
            if match:
                function = match[1]
                counts[function] = counts.get(function,0)+int(match[2].replace(',',''))
    return {'file':name,'sha256':hashlib.sha256(svg).hexdigest(),
            'inclusive_frames':sorted(counts.items(),key=lambda item:item[1],reverse=True)[:80]}


def benchmark(engine, policy, workload, clients, repetition):
    original_wait = policy in ('quorum-original-wait','quorum-release-baseline')
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
    profilers = None
    kernel_sample = KERNEL_PROFILE and engine == 'neon' and workload == 'wal' and clients == (64 if CASE_FILTER=='wal64' else 32) and repetition == 1
    if kernel_sample and KERNEL_SCOPE == 'storage':
        pids = [int(p.name) for p in Path('/proc').iterdir() if p.name.isdigit()
                and p.joinpath('comm').exists() and p.joinpath('comm').read_text().strip() == 'safekeeper']
        request = Path('/tmp/kernel-profile-request.json')
        request.write_text(json.dumps(pids))
        request.chmod(0o644)
    if os.environ.get('QUORUM_CPU_PROFILE') == '1' and engine == 'neon' and workload == 'wal' and clients == 32 and repetition == 1:
        profilers = concurrent.futures.ThreadPoolExecutor(max_workers=3)
        profiles = [profilers.submit(profile_safekeeper,port) for port in (7676,7677,7678)]
    try:
        client_before = resource.getrusage(resource.RUSAGE_CHILDREN)
        timed_command = cmd + (['-t', '16' if JSON_CASE == 'large' else '512'] if GROUP == 'jsonb-storage' else
                              ['-T', '5' if GROUP in ('ordered-wait-ab','native-reference') else ('2' if FAST_GROUP else '3')])
        if kernel_sample and KERNEL_SCOPE == 'compute':
            child = subprocess.Popen(timed_command,stdout=subprocess.PIPE,stderr=subprocess.PIPE,text=True)
            time.sleep(.15)  # Attach after pgbench has created its persistent server backends.
            parent = int((ROOT/'neon/endpoints/bench/pgdata/postmaster.pid').read_text().splitlines()[0])
            pids = [int(p.name) for p in Path('/proc').iterdir() if p.name.isdigit()
                    and p.joinpath('comm').exists() and p.joinpath('comm').read_text().strip() == 'postgres'
                    and (int(p.name)==parent or p.joinpath('stat').read_text().rsplit(')',1)[1].split()[1]==str(parent))]
            request = Path('/tmp/kernel-profile-request.json')
            request.write_text(json.dumps(pids))
            request.chmod(0o644)
            text, stderr = child.communicate(timeout=30)
            assert child.returncode == 0, stderr
        else:
            text = command(timed_command, timeout=30)
    finally:
        if profilers:
            profilers.shutdown(wait=True)
    if profilers:
        report['cpu_profiles'] = [future.result() for future in profiles]
    if kernel_sample:
        status_file = Path('/profile-output')/(PROFILE_PREFIX+'-status.json')
        deadline = time.monotonic()+15
        while not status_file.exists():
            assert time.monotonic()<deadline, 'Kernel profiler did not finish'
            time.sleep(.05)
        report['kernel_profile'] = json.loads(status_file.read_text())
        assert report['kernel_profile']['status'] == 'PASS', report['kernel_profile']
    client_after = resource.getrusage(resource.RUSAGE_CHILDREN)
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
              'client_cpu_seconds': (client_after.ru_utime-client_before.ru_utime) +
                                    (client_after.ru_stime-client_before.ru_stime),
              'service_cpu_seconds': {k: v - before['services_cpu_seconds'].get(k, 0)
                                      for k, v in after['services_cpu_seconds'].items()},
              'native_batch_metrics': {k:v-m0.get(k,0) for k,v in m1.items() if 'safekeeper_native_wal_' in k},
              'wal_delta': {k: float(w1[k]) - float(w0[k]) for k in ('wal_bytes', 'wal_records', 'wal_fpi')},
              'guard_before': g0, 'guard_after': g1,
              'safekeeper_flush_delta': {k: v - m0.get(k, 0) for k, v in m1.items()},
              'resources_before': before, 'resources_after': after,
              'storage_before': storage_before, 'storage_after': storage_after}
    if engine == 'neon' and policy.startswith('quorum'):
        assert g1['fast_acks'] == g0['fast_acks'], 'Durable control must not use bounded async acknowledgements'
        if os.environ.get('QUORUM_ORDERED_WAIT_CHECK') == '1' and not original_wait:
            assert g1['waits'] == g0['waits'], 'Normal durable commits must use the ordered replication queue'
        if os.environ.get('QUORUM_NATIVE_PROVIDER') == '1' and not original_wait:
            if NATIVE_SENDER_OWNED and not NATIVE_SHARED_COMPLETION:
                assert g1['native_provider_commits'] == g0['native_provider_commits'], 'Sender mode unexpectedly used foreground owners'
            else:
                assert g1['native_provider_commits'] > g0['native_provider_commits'], 'Candidate did not use the native quorum provider'
            assert g1['native_quorum_lsn'] != '0/0', 'Candidate has no complete-record quorum proof'
            if not NATIVE_SENDER_OWNED and int(NATIVE_WINDOW)>1 and int(NATIVE_GROUP_DELAY_US)==0:
                assert g1['native_inflight_highwater']>=2, 'Candidate did not exercise concurrent group ownership'
            if not NATIVE_SENDER_OWNED and int(NATIVE_GROUP_DELAY_US)>0:
                assert g1['native_cohort_delays']>g0['native_cohort_delays'], 'Candidate did not form source cohorts'
            if NATIVE_TRANSPORT == 'copy':
                assert g1['native_copy_submissions']>g0['native_copy_submissions'], 'Candidate did not submit WAL over COPY'
            if NATIVE_SENDER_OWNED and int(NATIVE_STREAM_WINDOW)>1:
                assert g1['native_pipelined_submissions']>g0['native_pipelined_submissions'], 'Candidate did not queue new WAL before earlier replies'
            if NATIVE_DEDICATED and (GROUP=='quorum-io-owned' or (GROUP=='ordered-wait-ab' and CANDIDATE_IO=='owned')):
                assert sum(v-m0.get(k,0) for k,v in m1.items() if 'native_wal_inline_writes_total' in k)>0, 'Dedicated owned I/O was not exercised'
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
        (data / 'postgresql.conf').write_text(BASE + "listen_addresses='127.0.0.1'\nport=15432\n")
        command([RAW + 'pg_ctl', '-D', str(data), '-l', str(ROOT / 'upstream.log'), '-w', 'start'])
    else:
        distribution = Path('/usr/local/bin')
        if int(SK_RUNTIME_THREADS):
            # neon_local deliberately scrubs its child's environment. Set the
            # validated runtime knob inside this fixture-owned executable, so
            # only safekeepers inherit it. Never alter installed binaries.
            distribution = Path('/opt/fixture-bin')
            distribution.mkdir(exist_ok=True)
            for original in Path('/usr/local/bin').iterdir():
                if original.name != 'safekeeper' and original.is_file():
                    (distribution/original.name).symlink_to(original)
            wrapper = distribution/'safekeeper'
            wrapper.write_text('#!/bin/sh\nexport TOKIO_WORKER_THREADS='+SK_RUNTIME_THREADS+
                '\nexec /usr/local/bin/safekeeper "$@"\n')
            wrapper.chmod(0o700)
        config = ROOT / 'init.toml'
        config.write_text('pg_distrib_dir='+json.dumps(os.environ['POSTGRES_DISTRIB_DIR'])+'\n'+
            'neon_distrib_dir='+json.dumps(str(distribution))+'\n'+'''default_tenant_id="20000000000000000000000000000001"
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
''' + '\n'.join(f'''[[safekeepers]]
id={i}
pg_port={5453+i}
http_port={7675+i}
sync={'false' if GROUP == 'safekeeper-nosync' else 'true'}
auth_enabled=true
''' for i in (1, 2, 3)))
        local('init', '--config', str(config))
        local('start', '--start-timeout', '90s')
        if int(SK_RUNTIME_THREADS):
            pids = [p for p in Path('/proc').iterdir() if p.name.isdigit()
                    and (p/'comm').exists() and (p/'comm').read_text().strip() == 'safekeeper']
            assert len(pids)==3
            expected = ('TOKIO_WORKER_THREADS='+SK_RUNTIME_THREADS).encode()
            assert all(expected in (p/'environ').read_bytes().split(b'\0') for p in pids), 'Safekeeper runtime setting was not applied'
            report['safekeeper_runtime_environment_verified'] = True
        if GROUP.startswith('quorum-io-') or GROUP == 'ordered-wait-ab':
            engine_name = 'tokio' if GROUP == 'ordered-wait-ab' else GROUP.removeprefix('quorum-io-').removesuffix('-single')
            for node in (1, 2, 3):
                local('safekeeper', 'stop', str(node))
                start_io_safekeeper(node,engine_name)
            arguments = [args for _,args in process_commands('safekeeper')]
            assert len(arguments) == 3
            if os.environ.get('QUORUM_NATIVE_PROVIDER') == '1':
                assert all((b'--enable-native-wal-api' in argv) != PREFLIGHT_NEGATIVE for argv in arguments), 'Native transport enablement was not applied'
            assert all(('--wal-io-engine='+engine_name).encode() in argv and b'--no-sync' not in argv for argv in arguments)
            report['safekeeper_io'] = {'engine':engine_name,'nodes':3,'flushing_enabled':True}
        local('tenant', 'create', '--pg-version', '18', '--set-default', '-c', 'checkpoint_distance:67108864', '-c', 'checkpoint_timeout:300s')
        local('endpoint', 'create', 'bench', '--branch-name', 'main', '--pg-version', '18', '--pg-port', PORT,
              '--external-http-port', '15433', '--internal-http-port', '15434', '--update-catalog')
        with (ROOT / 'neon/endpoints/bench/postgresql.conf').open('a') as output:
            output.write(BASE + "neon.bounded_async_commit=on\nneon.max_file_cache_size='128MB'\nneon.file_cache_size_limit='128MB'\n")
            output.write('commit_delay='+LOCAL_COMMIT_DELAY_US+'\ncommit_siblings=5\n')
            if os.environ.get('QUORUM_NATIVE_PROVIDER') == '1':
                output.write("neon.experimental_native_quorum=on\nneon.native_quorum_endpoints='"+
                    ','.join(f'{i}='+ ('postgresql://127.0.0.1:'+str((7453 if NATIVE_DEDICATED else 5453)+i) if NATIVE_TRANSPORT=='copy' else 'http://127.0.0.1:'+str(7675+i)) for i in (1,2,3))+"'\n")
                output.write('neon.native_quorum_inflight_groups='+NATIVE_WINDOW+'\n')
                output.write('neon.native_quorum_group_delay_us='+NATIVE_GROUP_DELAY_US+'\n')
                if NATIVE_SENDER_OWNED:
                    assert NATIVE_TRANSPORT == 'copy'
                    output.write('neon.native_quorum_sender_owned=on\n')
                    output.write('neon.native_quorum_sender_spin_us='+NATIVE_SPIN_US+'\n')
                    if int(NATIVE_STREAM_WINDOW):
                        output.write('neon.native_quorum_stream_window='+NATIVE_STREAM_WINDOW+'\n')
                    if NATIVE_SHARED_COMPLETION:
                        output.write('neon.native_quorum_shared_completion=on\n')
                if os.environ.get('QUORUM_NATIVE_RECONNECT_CHECK') == '1':
                    output.write('neon.safekeeper_connect_timeout=200\nneon.safekeeper_reconnect_timeout=50\n')
            if COMMIT_PUBLICATION_MS is not None:
                output.write('neon.commit_broadcast_interval='+COMMIT_PUBLICATION_MS+'\n')
        local('endpoint', 'start', 'bench', '--dev')
        assert 'walproposer' in sql('SHOW synchronous_standby_names')
        if os.environ.get('QUORUM_NATIVE_PROVIDER') == '1':
            if PREFLIGHT_NEGATIVE:
                sql("SELECT pg_logical_emit_message(true,'preflight-fallback','legacy-durable')")
                state=guard()
                assert state['native_quorum_lsn']=='0/0' and state['native_provider_commits']==0
                assert state['native_copy_submissions']==0 and state['quorum_lsn']!='0/0'
                report['native_preflight_fallback_check']={'status':'PASS','native_api_disabled':True,
                    'legacy_durable_writes_continue':True,'native_data_ownership_not_transferred':True}
            else:
                deadline = time.monotonic()+5
                while guard()['native_quorum_lsn'] == '0/0':
                    assert time.monotonic()<deadline, 'Native append ownership did not activate at a drained boundary'
                    time.sleep(.02)
            report['native_provider'] = {
                'enabled':sql('SHOW neon.experimental_native_quorum'),
                'window':int(sql('SHOW neon.native_quorum_inflight_groups')),
                'transport':NATIVE_TRANSPORT,
                'group_delay_us':int(NATIVE_GROUP_DELAY_US),
                'sender_owned':sql('SHOW neon.native_quorum_sender_owned') if NATIVE_SENDER_OWNED else 'off',
                'shared_completion':sql('SHOW neon.native_quorum_shared_completion') if NATIVE_SHARED_COMPLETION else 'off',
                'sender_spin_us':int(NATIVE_SPIN_US),
                'stream_window':int(NATIVE_STREAM_WINDOW) if int(NATIVE_STREAM_WINDOW) else 'image default',
                'dedicated_ingest':NATIVE_DEDICATED,
                'source_sha256':hashlib.sha256(Path('/source/pgxn/neon/native_quorum.c').read_bytes()).hexdigest(),
                'claim':'Experimental direct commit-group transport; power loss, remote repair and production lifecycle not qualified'}
        if COMMIT_PUBLICATION_MS is not None:
            assert sql("SELECT setting FROM pg_settings WHERE name='neon.commit_broadcast_interval'") == COMMIT_PUBLICATION_MS
    report['settings'][engine] = json.loads(sql("SELECT json_object_agg(name,setting) FROM pg_settings WHERE name IN "
        "('fsync','synchronous_commit','synchronous_standby_names','wal_compression','wal_level','shared_preload_libraries')"))
    if GROUP == 'jsonb-storage' and engine == 'neon':
        local('endpoint', 'stop', 'bench')
        with (ROOT / 'neon/endpoints/bench/postgresql.conf').open('a') as output:
            output.write('\nfsync=off\nsynchronous_commit=off\nneon.best_effort_commit=on\n')
        local('endpoint', 'start', 'bench', '--dev')
    sql("CREATE TABLE documents (id int PRIMARY KEY, doc jsonb NOT NULL); ")
    if engine != 'upstream':
        # Keep the quorum/standard-JSONB control independent of DOCB defaults.
        sql('ALTER TABLE documents SET (jsonb_storage=jsonb)')
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
            output.write(f'\nport={15440+i}\nshared_buffers=64MB\n')
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


def durable_io_checks():
    """Only this private fixture: one-node loss, quorum blocking and process restart."""
    pids = [int(p.name) for p in Path('/proc').iterdir() if p.name.isdigit()
            and p.joinpath('comm').exists() and p.joinpath('comm').read_text().strip() == 'safekeeper']
    assert len(pids) == 3
    if os.environ.get('QUORUM_NATIVE_PROVIDER') == '1' and not PREFLIGHT_NEGATIVE:
        native_idle_tail_check()
    sql("CREATE TABLE durable_io_probe(id int PRIMARY KEY, value text); INSERT INTO durable_io_probe VALUES(1,'acknowledged')")
    reconnect_before = guard().get('native_control_reconnects',0)
    pending = None
    try:
        os.kill(pids[0], signal.SIGSTOP)
        if os.environ.get('QUORUM_NATIVE_RECONNECT_CHECK') == '1':
            if NATIVE_SENDER_OWNED:
                # Keep native socket events flowing across the short control
                # deadline; otherwise an idle timeout could conceal starvation
                # of control maintenance in the replacement event loop.
                command([RAW+'pgbench','-h','127.0.0.1','-p',PORT,'-U',USER,'-d','postgres',
                    '-n','-M','prepared','-c','8','-j','2','-T','1','-f',str(ROOT/'wal.sql')],timeout=5)
            else:
                time.sleep(.4)
        # Keep a broken candidate's availability check bounded and retain its
        # protocol diagnostics. The statement timeout alone cannot interrupt a
        # post-commit durability wait, so also bound the private client process.
        try:
            command([RAW+'psql','-XqAt','-v','ON_ERROR_STOP=1','-h','127.0.0.1','-p',PORT,
                '-U',USER,'-d','postgres','-c',"INSERT INTO durable_io_probe VALUES(2,'one-node-unavailable')"],timeout=5)
        except subprocess.TimeoutExpired:
            report['native_failure_status'] = guard()
            lines = (ROOT/'neon/endpoints/bench/compute.log').read_text().splitlines()
            report['native_failure_log'] = [line for line in lines if 'native quorum response rejected:' in line][-5:]
            raise
        os.kill(pids[1], signal.SIGSTOP)
        pending = subprocess.Popen([RAW+'psql','-XqAt','-v','ON_ERROR_STOP=1','-h','127.0.0.1',
            '-p',PORT,'-U',USER,'-d','postgres','-c',"INSERT INTO durable_io_probe VALUES(3,'waited-for-quorum')"],
            env={**os.environ,'PGAPPNAME':'quorum-io-blocked','PGOPTIONS':'-c synchronous_commit=on'},
            stdout=subprocess.PIPE,stderr=subprocess.PIPE,text=True)
        deadline = time.monotonic()+3
        while sql("SELECT count(*) FROM pg_stat_activity WHERE application_name='quorum-io-blocked' "
                  "AND wait_event='SyncRep'") != '1':
            assert pending.poll() is None, 'Write acknowledged without durable quorum'
            assert time.monotonic()<deadline, 'Pending write never reached its durability wait'
            time.sleep(.02)
        time.sleep(.1)
        assert pending.poll() is None, 'Write bypassed the durable quorum barrier'
    finally:
        for pid in pids:
            os.kill(pid, signal.SIGCONT)
        if pending is not None:
            stdout, stderr = pending.communicate(timeout=8)
            assert pending.returncode == 0, (stdout,stderr)
    if os.environ.get('QUORUM_NATIVE_RECONNECT_CHECK') == '1':
        deadline = time.monotonic()+4
        while guard().get('native_control_reconnects',0)<=reconnect_before:
            assert time.monotonic()<deadline, 'No successful native control reconnect after the forced deadline'
            time.sleep(.02)
        report['native_control_reconnect_check'] = {'status':'PASS','control_deadline_ms':200,
            'storage_pause_ms':1000 if NATIVE_SENDER_OWNED else 400,
            'continuous_native_writes_during_pause':NATIVE_SENDER_OWNED,
            'valid_feedback_after_reconnect':True}
    if os.environ.get('QUORUM_ORDERED_WAIT_CHECK') == '1':
        ordered_wait_checks(pids)
    sql('SELECT neon.bounded_commit_guard_drain()')
    local('endpoint','stop','bench','--mode','immediate')
    for node in (1,2,3):
        local('safekeeper','stop',str(node),'-m','immediate')
    for node in (1,2,3):
        start_io_safekeeper(node)
    local('endpoint','start','bench','--dev')
    assert sql('SELECT string_agg(id::text,\',\' ORDER BY id) FROM durable_io_probe') == '1,2,3'
    report['durable_io_checks'] = {'one_node_unavailable':True,'no_quorum_blocks_ack':True,
        'pending_write_completed_after_resume':True,'acknowledged_rows_after_immediate_process_restarts':3,
        'restart_io_engine':CANDIDATE_IO if GROUP=='ordered-wait-ab' else GROUP.removeprefix('quorum-io-').removesuffix('-single'),
        'scope':'Process restarts on temporary RAM storage, not host power-loss or multi-zone qualification'}


def native_idle_tail_check():
    """An idle, multi-frame asynchronous tail must drain without another write."""
    parent = int((ROOT/'neon/endpoints/bench/pgdata/postmaster.pid').read_text().splitlines()[0])
    children = [p for p in Path('/proc').iterdir() if p.name.isdigit() and (p/'stat').exists() and
        (p/'stat').read_text().rsplit(')',1)[1].split()[1] == str(parent) and
        b'walproposer' in (p/'cmdline').read_bytes().lower().replace(b' ',b'')]
    assert len(children)==1, 'Expected the private compute WAL proposer'
    pid = int(children[0].name)
    deadline = time.monotonic()+3
    while not 0 <= guard()['age_ms'] < 100:
        assert time.monotonic()<deadline, 'No fresh asynchronous admission frontier'
        time.sleep(.01)
    os.kill(pid,signal.SIGSTOP)
    try:
        sql("SET synchronous_commit=local; SELECT pg_logical_emit_message(true,'idle-native-tail',repeat('x',350000))")
        target = sql('SELECT pg_current_wal_flush_lsn()')
        def number(value):
            high,low = value.split('/')
            return (int(high,16)<<32)+int(low,16)
        assert number(guard()['native_quorum_lsn']) < number(target), 'Tail was not isolated from its background owner'
    finally:
        os.kill(pid,signal.SIGCONT)
    deadline = time.monotonic()+2
    while number(guard()['native_quorum_lsn']) < number(target):
        assert time.monotonic()<deadline, 'Idle native owner did not drain a multi-frame tail without another write'
        time.sleep(.01)
    report['native_idle_tail_check'] = {'status':'PASS','bytes':350000,
        'foreground_policy':'synchronous_commit=local with bounded admission',
        'background_drained_without_new_writes':True}


def ordered_wait_checks(pids):
    """The native wait queue may exit without replication; the guard must not."""
    checks = {}
    for scenario in ('cancel', 'configuration'):
        pending = None
        changed = False
        try:
            for pid in pids[:2]:
                os.kill(pid, signal.SIGSTOP)
            before = guard()['waits']
            pending = subprocess.Popen([RAW+'psql','-XqAt','-v','ON_ERROR_STOP=1','-h','127.0.0.1',
                '-p',PORT,'-U',USER,'-d','postgres','-c',
                "SELECT pg_logical_emit_message(true,'ordered-wait-check','unacknowledged')"],
                env={**os.environ,'PGAPPNAME':'ordered-wait-blocked','PGOPTIONS':'-c synchronous_commit=on'},
                stdout=subprocess.PIPE,stderr=subprocess.PIPE,text=True)
            deadline = time.monotonic()+3
            while sql("SELECT count(*) FROM pg_stat_activity WHERE application_name='ordered-wait-blocked' AND wait_event='SyncRep'") != '1':
                assert pending.poll() is None, 'Write acknowledged without a quorum'
                assert time.monotonic()<deadline, 'Write never entered its replication wait'
                time.sleep(.02)
            if scenario == 'cancel':
                assert sql("SELECT pg_cancel_backend(pid) FROM pg_stat_activity WHERE application_name='ordered-wait-blocked'") == 't'
                stdout, stderr = pending.communicate(timeout=5)
                assert pending.returncode != 0, ('Cancellation acknowledged an unreplicated commit',stdout,stderr)
                pending = None
                checks['cancel_disconnects_without_success'] = True
            else:
                sql("ALTER SYSTEM SET synchronous_standby_names=''")
                changed = True
                sql('SELECT pg_reload_conf()')
                deadline = time.monotonic()+4
                while guard()['waits'] <= before:
                    assert pending.poll() is None, 'Configuration change bypassed quorum durability'
                    assert time.monotonic()<deadline, 'Guard did not take over after native queue release'
                    time.sleep(.02)
                time.sleep(.1)
                assert pending.poll() is None, 'Guard returned before replication recovered'
                checks['configuration_change_still_requires_quorum'] = True
        finally:
            if changed:
                sql("ALTER SYSTEM SET synchronous_standby_names='walproposer'")
                sql('SELECT pg_reload_conf()')
            for pid in pids:
                os.kill(pid, signal.SIGCONT)
            if pending is not None:
                stdout, stderr = pending.communicate(timeout=8)
                assert pending.returncode == 0, (stdout,stderr)
    report['ordered_wait_checks'] = checks


def select_comparison_core(source):
    # Pageserver WAL redo can retain the old executable while compute is down.
    # Replace the fixture path atomically; never truncate a mapped executable.
    staged = PG+'postgres.next'
    shutil.copy2(source, staged)
    os.replace(staged, PG+'postgres')


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
          'safekeeper_runtime_workers':int(SK_RUNTIME_THREADS) if int(SK_RUNTIME_THREADS) else 'default',
          'versions': {e: command([p + 'postgres', '--version']) for e, p in [('upstream', RAW), ('neon', PG)]},
          'configure': {e: command([p + 'pg_config', '--configure']) for e, p in [('upstream', RAW), ('neon', PG)]},
          'guard_source_sha256': hashlib.sha256(Path('/source/pgxn/neon/bounded_commit_guard.c').read_bytes()).hexdigest()}
report['syncrep_source_sha256'] = hashlib.sha256(Path('/pgsource/v18/src/backend/replication/syncrep.c').read_bytes()).hexdigest()
scripts = {'wal': "SELECT pg_logical_emit_message(true,'quorum-probe',repeat('x',64));\n",
           'wal-batch16': "SELECT pg_logical_emit_message(true,'quorum-probe',repeat('x',64)) FROM generate_series(1,16);\n",
           'jsonb': "\\set id random(1,1000)\nBEGIN;\nUPDATE documents SET doc=jsonb_set(doc,'{metrics,score}',to_jsonb((doc->'metrics'->>'score')::int+1)) WHERE id=:id;\nCOMMIT;\n"}
for name, script in scripts.items():
    (ROOT / (name + '.sql')).write_text(script)
if GROUP == 'ordered-wait-ab':
    distribution = Path('/opt/pgcomparison')
    shutil.copytree('/comparison/bin',distribution/'v18/bin',symlinks=True)
    for component in ('lib','share','include'):
        (distribution/'v18'/component).symlink_to('/opt/postgres/v18/'+component)
    PG = str(distribution/'v18/bin')+'/'
    os.environ['POSTGRES_DISTRIB_DIR'] = str(distribution)
try:
    for engine in (('upstream', 'neon') if GROUP in ('baseline', 'jsonb-storage') else (('upstream',) if GROUP in ('native-quorum', 'native-reference') else ('neon',))):
        setup(engine)
        if GROUP == 'native-quorum':
            native_replicas()
        policy = 'local-durable' if engine == 'upstream' else ('UNSAFE-safekeeper-nosync' if GROUP == 'safekeeper-nosync' else ('quorum-tokio-one' if GROUP == 'tokio-one' else 'quorum'))
        if GROUP.startswith('quorum-io-'):
            policy = GROUP
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
        if GROUP == 'ordered-wait-ab':
            report['core_comparison'] = {'order':['original','ordered','ordered','original'],
                'note':'Only compute restarts; clients, three safekeepers, pageserver and fixture stay identical.',
                'original_binary_sha256':hashlib.sha256(Path('/comparison/postgres-original').read_bytes()).hexdigest(),
                'ordered_binary_sha256':hashlib.sha256(Path('/comparison/bin/postgres').read_bytes()).hexdigest()}
            report['core_comparison']['storage_io_modes']={'original':'tokio','ordered':CANDIDATE_IO}
            if CANDIDATE_IO!='tokio':
                report['core_comparison']['note']='Same clients, CPU budget, three storage services/data and image; compute restarts and storage I/O mode changes are outside timing intervals.'
            baseline_source=Path('/comparison/syncrep-original.c')
            if baseline_source.exists():
                text=baseline_source.read_text()
                shim='\n\n/* Inert ABI export for the experimental extension; no provider is called. */\nSyncRepCommitProvider_hook_type SyncRepCommitProvider_hook = NULL;'
                assert text.count(shim)==1
                report['core_comparison']['original_source_sha256']=hashlib.sha256(text.encode()).hexdigest()
                report['core_comparison']['original_implementation_sha256']=hashlib.sha256(text.replace(shim,'').encode()).hexdigest()
                report['core_comparison']['native_candidate']=os.environ.get('QUORUM_NATIVE_PROVIDER')=='1'
            active_io='tokio'
            for repetition, variant in enumerate(('original','ordered','ordered','original'),1):
                local('endpoint','stop','bench')
                wanted_io=CANDIDATE_IO if variant=='ordered' else 'tokio'
                if active_io!=wanted_io:
                    for node in (1,2,3): local('safekeeper','stop',str(node))
                    for node in (1,2,3): start_io_safekeeper(node,wanted_io)
                    active_io=wanted_io
                select_comparison_core('/comparison/postgres-original' if variant == 'original' else '/comparison/bin/postgres')
                if os.environ.get('QUORUM_NATIVE_PROVIDER') == '1':
                    with (ROOT/'neon/endpoints/bench/postgresql.conf').open('a') as output:
                        output.write('\nneon.experimental_native_quorum='+('on' if variant=='ordered' else 'off')+'\n')
                local('endpoint','start','bench','--dev')
                if os.environ.get('QUORUM_NATIVE_PROVIDER') == '1':
                    assert sql('SHOW neon.experimental_native_quorum') == ('on' if variant=='ordered' else 'off')
                postmaster_pid = int((ROOT/'neon/endpoints/bench/pgdata/postmaster.pid').read_text().splitlines()[0])
                executable_hash = hashlib.sha256(Path(f'/proc/{postmaster_pid}/exe').read_bytes()).hexdigest()
                assert executable_hash == report['core_comparison'][variant+'_binary_sha256'], 'Comparison launched the wrong PostgreSQL binary'
                assert sql('SHOW synchronous_commit') == 'on'
                assert sql('SHOW synchronous_standby_names') == 'walproposer'
                node_arguments=[args for _,args in process_commands('safekeeper')]
                assert len(node_arguments)==3 and all(('--wal-io-engine='+active_io).encode() in args
                    for args in node_arguments), 'Storage I/O comparison did not apply its engine'
                policy_name=('quorum-release-baseline' if variant=='original' else 'quorum-native-stream') if os.environ.get('QUORUM_NATIVE_PROVIDER')=='1' else 'quorum-'+variant+'-wait'
                benchmark(engine,policy_name,'wal',64 if CASE_FILTER == 'wal64' else 32,repetition)
                report['samples'][-1]['running_postgres_sha256'] = executable_hash
                report['samples'][-1]['storage_io_engine'] = active_io
                report['samples'][-1]['storage_io_cli_verified'] = True
                report['samples'][-1]['native_provider_enabled'] = sql('SHOW neon.experimental_native_quorum')
                if variant == 'original':
                    sample = report['samples'][-1]
                    assert sample['guard_after']['waits'] > sample['guard_before']['waits'], 'Control did not exercise the original guard wait'
            local('endpoint','stop','bench')
            if active_io!=CANDIDATE_IO:
                for node in (1,2,3): local('safekeeper','stop',str(node))
                for node in (1,2,3): start_io_safekeeper(node,CANDIDATE_IO)
            select_comparison_core('/comparison/bin/postgres')
            if os.environ.get('QUORUM_NATIVE_PROVIDER') == '1':
                with (ROOT/'neon/endpoints/bench/postgresql.conf').open('a') as output:
                    output.write('\nneon.experimental_native_quorum=on\n')
            local('endpoint','start','bench','--dev')
            durable_io_checks()
        if os.environ.get('QUORUM_NATIVE_WAL_API_CHECK') == '1':
            from native_wal_api import verify_native_wal_api
            cache_before = metrics()
            report['native_wal_api_source_sha256'] = hashlib.sha256(Path('/source/safekeeper/src/native_wal.rs').read_bytes()).hexdigest()
            report['native_wal_api_checks'] = verify_native_wal_api(sql,ROOT)
            if Path('/source/safekeeper/src/wal_storage/recent_wal.rs').exists():
                cache_after = metrics()
                hits = sum(value-cache_before.get(key,0) for key,value in cache_after.items() if 'safekeeper_wal_replay_cache_hits_total' in key)
                assert hits>=6, 'New-tail duplicate/conflict checks did not use the recent-byte window on all three nodes'
                report['native_wal_api_checks']['replay_cache_comparisons'] = hits
        for repetition in (() if GROUP in ('controls','ordered-wait-ab') or FAST_GROUP or os.environ.get('QUORUM_NATIVE_WAL_API_CHECK') == '1' or os.environ.get('QUORUM_PROTOCOL_ONLY') == '1' else (1, 2)):
            cases = [('wal', 1), ('wal', 8), ('wal', 32), ('wal-batch16', 16), ('jsonb', 16)] if GROUP == 'baseline' else ([('wal', 32), ('jsonb', 16)] if GROUP == 'native-reference' else [('wal', 1), ('wal', 32), ('jsonb', 16)])
            if GROUP == 'jsonb-storage':
                cases = [('jsonb', 16)]
            if CASE_FILTER == 'wal32':
                cases = [('wal',32)]
            elif CASE_FILTER == 'wal64':
                cases = [('wal',64)]
            for workload, clients in cases if repetition == 1 else reversed(cases):
                benchmark(engine, policy, workload, clients, repetition)
        if engine == 'neon':
            if GROUP.startswith('quorum-io-'):
                durable_io_checks()
                if os.environ.get('QUORUM_NATIVE_WAL_API_CHECK') == '1':
                    assert sql('SELECT value FROM native_api_witness WHERE id=1') == 'native-append'
                    report['native_wal_api_checks']['native_row_survived_compute_and_storage_process_restarts'] = True
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
