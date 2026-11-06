"""Diagnostic workload on an owned retained fixture; never a TPS acceptance run."""
import json
import os
from pathlib import Path
import subprocess
import select
import sys
import time

request = json.loads(sys.stdin.readline())
config = request['config']
os.environ.update(NEON_REPO_DIR='/var/lib/neon/comparison/neon', POSTGRES_DISTRIB_DIR='/opt/postgres',
                  AWS_ACCESS_KEY_ID=config['access_key'], AWS_SECRET_ACCESS_KEY=config['secret_key'],
                  AWS_REGION=config['region'], AWS_EC2_METADATA_DISABLED='true',
                  LANG='C.UTF-8', LC_ALL='C.UTF-8')


def run(command):
    result = subprocess.run(command, capture_output=True, text=True, timeout=180)
    assert result.returncode == 0, f'Owned profiling command {Path(command[0]).name} failed ({result.returncode})'
    return result.stdout.strip()


def sql(statement):
    return run(['/opt/upstream/v18/bin/psql', '-XqAt', '-v', 'ON_ERROR_STOP=1', '-h', '127.0.0.1',
                '-p', '55432', '-U', 'cloud_admin', '-d', 'postgres', '-c', statement])


try:
    run(['neon_local', 'start', '--start-timeout', '90s'])
    run(['neon_local', 'endpoint', 'start', 'bench', '--dev'])
    policy = json.loads(sql('SELECT neon.bounded_commit_guard_status()'))
    assert policy['enabled'] and not policy['draining'], 'Profile the bounded native candidate only'
    sql("SELECT sum((doc->'metrics'->>'score')::bigint) FROM benchmark_json")
    env = {**os.environ, 'PGOPTIONS': '-c synchronous_commit=off', 'PGAPPNAME': 'neon-perf-workload'}
    workload = subprocess.Popen(['/opt/upstream/v18/bin/pgbench', '-h', '127.0.0.1', '-p', '55432',
        '-U', 'cloud_admin', 'postgres', '-n', '-M', 'prepared', '-c', '64', '-j', '4', '-T', '35',
        '-D', 'documents=100000', '-f', '/var/lib/neon/comparison/jsonb-write.sql'],
        env=env, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
    time.sleep(15)
    pids = [int(value) for value in sql("SELECT pid FROM pg_stat_activity WHERE application_name='neon-perf-workload'").splitlines()]
    assert len(pids) == 64, 'Expected only the owned workload backends'
    parent = Path('/var/lib/neon/comparison/neon/endpoints/bench/pgdata/postmaster.pid').read_text().splitlines()[0]
    for pid in pids:
        assert Path(f'/proc/{pid}/stat').read_text().rsplit(')', 1)[1].split()[1] == parent
    print(json.dumps({'event': 'PROFILE-READY', 'backend_pids': pids}), flush=True)
    out, err = workload.communicate(timeout=60)
    assert workload.returncode == 0 and 'number of failed transactions: 0' in out
    print(json.dumps({'event': 'WORKLOAD-PASS', 'comparative_timing': False}), flush=True)
    # Keep the isolated namespace/tmpfs alive until aggregate symbol reporting
    # finishes. Never race report generation against container shutdown.
    assert select.select([sys.stdin], [], [], 120)[0], 'Profiler controller did not finish'
    assert sys.stdin.readline().strip() == 'finish'
finally:
    subprocess.run(['neon_local', 'endpoint', 'stop', 'bench'], capture_output=True, timeout=150)
    subprocess.run(['neon_local', 'stop'], capture_output=True, timeout=150)
