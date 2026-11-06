import unittest
from replay_drain import wait_for_replay


def metric(value):
    return f'pageserver_last_record_lsn{{tenant_id="test",timeline_id="owned"}} {value}\n'


class ReplayDrainTests(unittest.TestCase):
    def test_reports_backlog_and_wait_outside_the_timed_interval(self):
        values = iter([metric(16), metric(32)])
        moments = iter([0, 0, .25])
        pauses = []
        result = wait_for_replay(lambda _: '0/20', read_metrics=lambda: next(values),
                                 clock=lambda: next(moments), pause=pauses.append)
        self.assertEqual(result['initial_replay_lag_bytes'], 16)
        self.assertEqual(result['seconds'], .25)
        self.assertEqual(pauses, [.25])

    def test_stalled_replay_remains_a_failure(self):
        moments = iter([0, 0, 61])
        with self.assertRaisesRegex(AssertionError, 'did not catch up'):
            wait_for_replay(lambda _: '0/20', read_metrics=lambda: metric(1),
                            clock=lambda: next(moments), pause=lambda _: None)

    def test_multiple_timelines_cannot_silently_satisfy_the_wrong_frontier(self):
        with self.assertRaisesRegex(AssertionError, 'unambiguous'):
            wait_for_replay(lambda _: '0/20', read_metrics=lambda: metric(1)+metric(100))


if __name__ == '__main__':
    unittest.main()
