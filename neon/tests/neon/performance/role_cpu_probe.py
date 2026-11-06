"""Read-only two-second CPU attribution inside an owned benchmark namespace."""
import json
import os
from pathlib import Path
import time
import subprocess

if os.environ.get('NEON_CPU_PROBE_PIN_COMPUTE') == '1':
    os.sched_setaffinity(0, set(range(8)))
    assert os.sched_getaffinity(0) == set(range(8))


def snapshot():
    rows = {}
    for directory in Path('/proc').iterdir():
        if not directory.name.isdigit():
            continue
        try:
            fields = (directory/'stat').read_text().rsplit(')', 1)[1].split()
            args = (directory/'cmdline').read_bytes().split(b'\0')
            args = [value.decode(errors='replace') for value in args if value]
            rows[int(directory.name)] = {'ppid': int(fields[1]), 'ticks': int(fields[11])+int(fields[12]),
                'start': int(fields[19]), 'args': args, 'exe': Path(args[0]).name if args else ''}
        except (FileNotFoundError, ProcessLookupError, PermissionError):
            pass
    usage = dict(line.split() for line in Path('/sys/fs/cgroup/cpu.stat').read_text().splitlines())
    return time.monotonic(), rows, int(usage['usage_usec'])


def phase(rows):
    for row in rows.values():
        if row['exe'] == 'pgbench' and '-l' in row['args'] and '-f' in row['args']:
            return Path(row['args'][row['args'].index('-f')+1]).stem
    return None


def role(pid, rows, seen=None):
    seen = set() if seen is None else seen
    if pid in seen or pid not in rows:
        return 'other'
    seen.add(pid)
    row = rows[pid]
    if row['exe'].startswith('postgres'):
        title = ' '.join(row['args']).lower()
        if 'communicator' in title:
            return 'compute_communicator'
        if 'walproposer' in title.replace(' ', ''):
            return 'compute_walproposer'
        if 'bounded commit guard' in title:
            return 'compute_guard'
    if row['exe'] == 'postgres' and '-D' in row['args']:
        return 'compute_postgres' if '/endpoints/bench/pgdata' in ' '.join(row['args']) else 'metadata_postgres'
    if row['exe'].startswith('postgres'):
        return role(row['ppid'], rows, seen)
    if row['exe'] == 'safekeeper':
        return 'safekeepers'
    if row['exe'] in ['pgbench', 'pageserver', 'storage_controller', 'storage_broker', 'endpoint_storage', 'compute_ctl']:
        return row['exe']
    return 'other'


def waits():
    if os.environ.get('NEON_CPU_PROBE_WAITS') != '1':
        return None
    query = ("SELECT json_build_object('waits',(SELECT json_agg(t) FROM "
             "(SELECT state,wait_event_type,wait_event,count(*) AS sessions FROM pg_stat_activity "
             "WHERE application_name='pgbench' GROUP BY state,wait_event_type,wait_event) t),"
             "'throttling_us',neon.backpressure_throttling_time(),"
             "'lsns',(SELECT row_to_json(t) FROM neon.backpressure_lsns() t))")
    began = time.monotonic()
    result = subprocess.run(['/opt/upstream/v18/bin/psql','-XqAt','-v','ON_ERROR_STOP=1',
        '-h','127.0.0.1','-p','55432','-U','cloud_admin','-d','postgres','-c',query],
        env={**os.environ,'PGOPTIONS':'-c default_transaction_read_only=on -c statement_timeout=1000'},
        capture_output=True,text=True,timeout=3)
    assert result.returncode == 0, 'Read-only wait snapshot failed'
    observation = {'query_seconds':time.monotonic()-began,**json.loads(result.stdout)}
    available = subprocess.run(['/opt/upstream/v18/bin/psql','-XqAt','-h','127.0.0.1','-p','55432',
        '-U','cloud_admin','-d','postgres','-c',"SELECT to_regclass('pg_buffercache') IS NOT NULL"],
        capture_output=True,text=True,timeout=3)
    if available.returncode == 0 and available.stdout.strip() == 't':
        query = ("SELECT coalesce(json_agg(t),'[]') FROM (SELECT c.oid::regclass::text AS relation,"
                 "b.relfilenode,b.relforknumber,b.relblocknumber,b.pinning_backends,b.usagecount "
                 "FROM pg_buffercache b LEFT JOIN pg_class c ON c.relfilenode=b.relfilenode "
                 "WHERE b.reldatabase=(SELECT oid FROM pg_database WHERE datname=current_database()) "
                 "AND b.pinning_backends>=4 ORDER BY b.pinning_backends DESC LIMIT 12) t")
        pinned = subprocess.run(['/opt/upstream/v18/bin/psql','-XqAt','-v','ON_ERROR_STOP=1',
            '-h','127.0.0.1','-p','55432','-U','cloud_admin','-d','postgres','-c',query],
            env={**os.environ,'PGOPTIONS':'-c default_transaction_read_only=on -c statement_timeout=3000'},
            capture_output=True,text=True,timeout=5)
        assert pinned.returncode == 0, 'Read-only buffer-pin observation failed'
        observation['hot_pinned_buffers']=json.loads(pinned.stdout)
    return observation


deadline = time.monotonic()+180
requested = os.environ.get('NEON_CPU_PROBE_SCENARIO')
assert requested in [None, 'relational-write', 'jsonb-write']
while True:
    began, before, cpu_before = snapshot()
    selected = phase(before)
    if selected and (requested is None or selected == requested):
        break
    assert time.monotonic() < deadline, 'No timed pgbench interval observed; no CPU attribution claimed'
    time.sleep(.25)
waits_before = waits()
time.sleep(2)
ended, after, cpu_after = snapshot()
assert phase(after) == selected, 'Timed interval ended during the diagnostic window'
waits_after = waits()
elapsed = ended-began
totals = {}
for pid, row in after.items():
    old = before.get(pid)
    if old is not None and old['start'] == row['start']:
        category = role(pid, after)
        totals[category] = totals.get(category, 0)+(row['ticks']-old['ticks'])/os.sysconf('SC_CLK_TCK')/elapsed
print(json.dumps({'status': 'DIAGNOSTIC', 'scenario': selected, 'seconds': elapsed,
    'waits_before':waits_before,'waits_after':waits_after,
    'cgroup_cpu_cores': (cpu_after-cpu_before)/1e6/elapsed, 'role_cpu_cores': totals,
    'coverage': 'Two-second live-process tick deltas; excludes processes that exit or start during the window. Optional read-only catalog wait snapshots; observer CPU included. No environment values or user row data read.'}))
