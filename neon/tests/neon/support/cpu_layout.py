"""Private-namespace affinity for a disclosed compute-budget experiment."""
import os
from pathlib import Path

COMPUTE = set(range(8))
STORAGE = set(range(8, 16))
SERVICES = {'pageserver', 'safekeeper', 'storage_broker', 'storage_controller', 'endpoint_storage'}


def storage_process(pid, rows, seen=None):
    seen = set() if seen is None else seen
    if pid not in rows or pid in seen:
        return False
    seen.add(pid)
    row = rows[pid]
    if row['exe'] in SERVICES:
        return True
    if row['exe'].startswith('postgres'):
        if 'storage_controller_db' in ' '.join(row['args']):
            return True
        return storage_process(row['ppid'], rows, seen)
    return False


def configure_parent(engine):
    assert engine in ['neon', 'upstream']
    os.sched_setaffinity(0, COMPUTE)
    assert os.sched_getaffinity(0) == COMPUTE
    os.environ['NEON_BENCHMARK_CPU_LAYOUT'] = 'compute8-storage8'
    os.environ['NEON_BENCHMARK_CPU_LAYOUT_ENGINE'] = engine


def configure_services():
    if os.environ.get('NEON_BENCHMARK_CPU_LAYOUT') != 'compute8-storage8':
        return None
    rows = {}
    for directory in Path('/proc').glob('[0-9]*'):
        try:
            args = [value.decode(errors='replace') for value in (directory/'cmdline').read_bytes().split(b'\0') if value]
            fields = (directory/'stat').read_text().rsplit(')', 1)[1].split()
            uid_line = next(line for line in (directory/'status').read_text().splitlines() if line.startswith('Uid:'))
            rows[int(directory.name)] = {'args': args, 'exe': Path(args[0]).name if args else '', 'ppid': int(fields[1]),
                                         'uid': int(uid_line.split()[2])}
        except (FileNotFoundError, ProcessLookupError, PermissionError):
            continue
    counts = {'compute_threads': 0, 'storage_threads': 0}
    for pid, row in rows.items():
        if row['uid'] != os.getuid() or not row['args']:
            continue
        storage = storage_process(pid, rows)
        selected = STORAGE if storage else COMPUTE
        # Revisit the task list after changing all current creators; new
        # threads then inherit the correct affinity rather than escaping it.
        for _ in range(3):
            for thread in Path(f'/proc/{pid}/task').glob('[0-9]*'):
                try:
                    os.sched_setaffinity(int(thread.name), selected)
                except ProcessLookupError:
                    continue
        for thread in Path(f'/proc/{pid}/task').glob('[0-9]*'):
            try:
                assert os.sched_getaffinity(int(thread.name)) == selected, 'Unexpected diagnostic CPU affinity'
                counts['storage_threads' if storage else 'compute_threads'] += 1
            except ProcessLookupError:
                continue
    if os.environ['NEON_BENCHMARK_CPU_LAYOUT_ENGINE'] == 'upstream':
        assert counts['storage_threads'] == 0
    return {'status': 'PASS', 'compute_cpus': sorted(COMPUTE),
            'storage_cpus': sorted(STORAGE) if counts['storage_threads'] else [], **counts,
            'scope': 'Compute, WAL proposer, compute workers and load generator use CPUs 0-7. Storage/broker/controller and controller metadata PG use extra CPUs 8-15. Private container namespace only.'}
