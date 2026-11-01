"""Explicit integration test in a disposable, sixteen-CPU Docker namespace."""
import os
from pathlib import Path
import subprocess
import sys
import unittest
from cpu_layout import COMPUTE, STORAGE, configure_parent, configure_services


@unittest.skipUnless(os.environ.get('NEON_CPU_AFFINITY_TEST') == '1', 'Explicit isolated-container test only')
class AffinityIntegration(unittest.TestCase):
    def test_unprivileged_thread_groups_and_inheritance(self):
        self.assertEqual(os.getuid(), 10001)
        self.assertIn(Path('/proc/1/comm').read_text().strip(), ['docker-init', 'tini'])
        before = os.sched_getaffinity(0)
        child = None
        try:
            configure_parent('neon')
            child = subprocess.Popen(['pageserver','-c','import time; time.sleep(20)'], executable=sys.executable)
            self.assertEqual(os.sched_getaffinity(child.pid), COMPUTE)
            proof = configure_services()
            self.assertGreater(proof['storage_threads'], 0)
            self.assertEqual(os.sched_getaffinity(child.pid), STORAGE)
            self.assertEqual(os.sched_getaffinity(0), COMPUTE)
        finally:
            if child is not None:
                child.terminate()
                child.wait(timeout=3)
            os.sched_setaffinity(0, before)


if __name__ == '__main__':
    unittest.main()
