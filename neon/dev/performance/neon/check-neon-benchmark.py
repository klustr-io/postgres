#!/usr/bin/env python3
"""Audit the executed benchmark against raw logs, samples and evidence hashes."""
import gzip
import hashlib
import json
import math
from pathlib import Path
import re
import statistics

root = Path(__file__).resolve().parents[4]
reports = root / 'neon/tests/reports/local'
read = lambda file: json.loads(file.read_text(encoding='utf-8-sig'))
record = read(reports / 'neon-performance-comparison.json')
assert record['status'] == 'PASS'
assert re.fullmatch(r'neon-pg18-benchmark-[0-9a-f]{8}', record['container'])
directory = reports / record['container']
data = read(directory / 'benchmark.json')
summary = read(directory / 'comparison.json')
manifest = read(directory / 'benchmark-evidence.json')
for name, expected in manifest['files'].items():
    file = (directory / name).resolve()
    assert file.is_relative_to(directory.resolve())
    assert hashlib.sha256(file.read_bytes()).hexdigest() == expected, name
assert hashlib.sha256((directory / 'benchmark.json').read_bytes()).hexdigest() == summary['provenance']['raw_json_sha256']
assert data['status'] == summary['status'] == 'PASS'
assert data['engines']['upstream']['source']['neon_patches_applied'] is False
assert data['engines']['upstream']['settings']['shared_preload_libraries'] == ''
assert data['environment']['cpu_max'] == '800000 100000'
assert int(data['environment']['memory_max']) == 8 * 1024**3
assert len(data['integrity_checks']) == 2 * data['parameters']['repeats']
assert all(row['status'] == 'PASS' for row in data['integrity_checks'])
scenarios = data['parameters']['scenarios'].split(',')
assert len(data['samples']) == len(scenarios) * 2 * data['parameters']['repeats']
seen = set()
latency_samples = transactions = 0
for sample in data['samples']:
    key = (sample['engine'], sample['repetition'], sample['scenario'])
    assert key not in seen
    seen.add(key)
    assert sample['failed_transactions'] == 0
    prefix = f"{sample['engine']}-r{sample['repetition']}-{sample['scenario']}"
    log = (directory / 'logs' / (prefix + '.log')).read_text()
    assert int(re.search(r'number of transactions actually processed:\s*(\d+)', log)[1]) == sample['transactions']
    assert float(re.search(r'tps = ([\d.]+)', log)[1]) == sample['tps']
    assert int(re.search(r'number of failed transactions:\s*(\d+)', log)[1]) == 0
    values = []
    for file in (directory / 'logs').glob(prefix + '.*.gz'):
        with gzip.open(file, 'rt') as source:
            values.extend(int(line.split()[2]) / 1000 for line in source)
    values.sort()
    assert len(values) == sample['latency_ms']['sample_count'] > 0
    for name, percentile in [('p50', .5), ('p95', .95), ('p99', .99)]:
        expected = values[math.ceil(len(values) * percentile) - 1]
        assert expected == sample['latency_ms'][name], (key, name)
    io = sample['block_io']
    for counter, total, rate in [('rios','read_operations','read_iops'),('wios','write_operations','write_iops')]:
        assert sum(io['per_device'][device].get(counter, 0) for device in io['aggregate_devices']) == io[total]
        assert math.isclose(io[total] / io['interval_seconds'], io[rate], rel_tol=1e-12, abs_tol=1e-12)
    latency_samples += len(values)
    transactions += sample['transactions']
for scenario in scenarios:
    for engine in ('upstream', 'neon'):
        rows = [row for row in data['samples'] if row['scenario'] == scenario and row['engine'] == engine]
        assert len(rows) == data['parameters']['repeats']
        actual = summary['scenarios'][scenario][engine]
        assert actual['tps']['median'] == statistics.median(row['tps'] for row in rows)
        for name in ('read_iops', 'write_iops'):
            assert actual['block_io'][name] == statistics.median(row['block_io'][name] for row in rows)
audit = {'status': 'PASS', 'measured_runs': len(data['samples']), 'transactions': transactions,
         'raw_latency_samples_verified': latency_samples, 'integrity_checks': len(data['integrity_checks']),
         'evidence_files_verified': len(manifest['files']), 'zero_failed_transactions': True}
(directory / 'audit.json').write_text(json.dumps(audit, indent=2) + '\n')
(reports / 'neon-benchmark-audit.json').write_text(json.dumps(audit, indent=2) + '\n')
manifest['files']['audit.json'] = hashlib.sha256((directory / 'audit.json').read_bytes()).hexdigest()
(directory / 'benchmark-evidence.json').write_text(json.dumps(manifest, indent=2) + '\n')
print(json.dumps(audit))
