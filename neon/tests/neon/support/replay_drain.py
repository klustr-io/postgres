"""Measure post-load pageserver replay separately from foreground throughput."""
import re
import time
import urllib.request


def metrics():
    with urllib.request.urlopen('http://127.0.0.1:9898/metrics', timeout=10) as response:
        return response.read().decode()


def wait_for_replay(execute, timeout=60, read_metrics=metrics, clock=time.monotonic, pause=time.sleep):
    target_text = execute('SELECT pg_current_wal_insert_lsn()')
    high, low = target_text.split('/')
    target = (int(high, 16) << 32) + int(low, 16)
    began = clock()
    before = None
    observations = 0
    while True:
        # This isolated benchmark has exactly one pageserver timeline. Never
        # guess which timeline a metric belongs to when that invariant changes.
        values = [int(value) for value in re.findall(r'^pageserver_last_record_lsn\{[^\n]*\} ([0-9]+)$', read_metrics(), re.M)]
        assert len(values) == 1, 'Expected one unambiguous pageserver replay frontier'
        observed = values[0]
        before = observed if before is None else before
        observations += 1
        elapsed = clock() - began
        assert elapsed <= timeout, 'Post-load pageserver replay did not catch up within the bounded qualification budget'
        if observed >= target:
            return {'status': 'PASS', 'target_lsn': target_text, 'target_lsn_bytes': target,
                    'initial_replay_lsn_bytes': before, 'final_replay_lsn_bytes': observed,
                    'initial_replay_lag_bytes': max(0, target - before), 'seconds': elapsed,
                    'timeout_seconds': timeout, 'observations': observations,
                    'scope': 'Explicit post-load catch-up BEFORE fault probes. Excluded from timed TPS; not an immediate post-load wake claim.'}
        pause(.25)
