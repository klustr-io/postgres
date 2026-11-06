import unittest
from cpu_layout import storage_process


class CpuLayoutTests(unittest.TestCase):
    def test_controller_metadata_children_are_storage_but_compute_workers_are_not(self):
        rows = {
            10: {'exe': 'postgres', 'args': ['postgres','-D','/neon/storage_controller_db'], 'ppid': 1},
            11: {'exe': 'postgres: checkpointer', 'args': ['postgres: checkpointer'], 'ppid': 10},
            20: {'exe': 'postgres', 'args': ['postgres','-D','/neon/endpoints/bench/pgdata'], 'ppid': 1},
            21: {'exe': 'postgres: walproposer', 'args': ['postgres: walproposer'], 'ppid': 20},
            22: {'exe': 'pgbench', 'args': ['pgbench'], 'ppid': 1}}
        self.assertTrue(storage_process(11, rows))
        self.assertFalse(storage_process(21, rows))
        self.assertFalse(storage_process(22, rows))

    def test_missing_and_recycled_parent_cycles_cannot_grant_storage_cpus(self):
        self.assertFalse(storage_process(99, {}))
        self.assertFalse(storage_process(1, {1: {'exe': 'postgres', 'args': ['postgres'], 'ppid': 1}}))


if __name__ == '__main__':
    unittest.main()
