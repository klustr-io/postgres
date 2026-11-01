"""Observe external interface bytes during an owned timed pgbench process."""
import json
import os
from pathlib import Path
import time

scenario = os.environ['NEON_NETWORK_PROBE_SCENARIO']
assert scenario in ['relational-write', 'jsonb-write']
if os.environ.get('NEON_CPU_PROBE_PIN_COMPUTE') == '1':
    os.sched_setaffinity(0, set(range(8)))


def counters():
    result = {}
    for line in Path('/proc/net/dev').read_text().splitlines()[2:]:
        interface, values = line.split(':', 1)
        interface = interface.strip()
        if interface == 'lo':
            continue
        fields = values.split()
        result[interface] = {'received_bytes': int(fields[0]), 'sent_bytes': int(fields[8])}
    return result


def identity(pid):
    try:
        fields = Path(f'/proc/{pid}/stat').read_text().rsplit(')', 1)[1].split()
        return fields[0], fields[19]
    except FileNotFoundError:
        return None


deadline = time.monotonic() + 240
target = None
while target is None:
    for directory in Path('/proc').glob('[0-9]*'):
        try:
            args = [value.decode() for value in (directory/'cmdline').read_bytes().split(b'\0') if value]
            if args and Path(args[0]).name == 'pgbench' and '-l' in args and '-f' in args and Path(args[args.index('-f')+1]).stem == scenario:
                target = int(directory.name)
                break
        except (FileNotFoundError, ProcessLookupError, PermissionError):
            continue
    assert time.monotonic() < deadline, 'No matching timed workload observed'
    if target is None:
        time.sleep(.1)
original = identity(target)
assert original and original[0] != 'Z'
before, began = counters(), time.monotonic()
while True:
    state = identity(target)
    if state is None or state[0] == 'Z' or state[1] != original[1]:
        break
    assert time.monotonic() - began < 120, 'Timed workload exceeded network observation bound'
    time.sleep(.1)
after, elapsed = counters(), time.monotonic() - began
assert elapsed > 5, 'Too little timed workload remains for an interval observation'
delta = {interface: {key: after[interface][key] - values[key] for key in values}
         for interface, values in before.items()}
assert all(value >= 0 for row in delta.values() for value in row.values())
print(json.dumps({'status': 'DIAGNOSTIC', 'scenario': scenario, 'seconds': elapsed,
    'per_interface_bytes': delta,
    'sent_mib_per_second': sum(row['sent_bytes'] for row in delta.values())/elapsed/1048576,
    'received_mib_per_second': sum(row['received_bytes'] for row in delta.values())/elapsed/1048576,
    'coverage': 'Private network namespace, non-loopback interfaces only; observed timed-process window with 100-ms polling. Excludes in-namespace PG/WAL TCP and is not remote device IOPS or proof of link saturation.'}))
