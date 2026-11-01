import unittest
from target_replay import canonical_wal_end
from target_replay import select_timeline_metrics

class TargetReplayTests(unittest.TestCase):
    def test_empty_wal_headers_are_not_replay_or_quorum_targets(self):
        self.assertEqual(canonical_wal_end('A/C9002018',16*1024*1024),'A/C9002000')
        self.assertEqual(canonical_wal_end('A/C9000028',16*1024*1024),'A/C9000000')
        self.assertEqual(canonical_wal_end('A/C9002028',16*1024*1024),'A/C9002028')
    def test_selects_parent_instead_of_a_more_advanced_branch(self):
        tenant='2'*32;parent='3'*32;branch='4'*32
        wanted=f'pageserver_last_record_lsn{{tenant_id="{tenant}",timeline_id="{parent}"}} 16'
        other=f'pageserver_last_record_lsn{{tenant_id="{tenant}",timeline_id="{branch}"}} 9999'
        self.assertEqual(select_timeline_metrics(other+'\n'+wanted,tenant,parent),wanted+'\n')
    def test_missing_target_cannot_pass_using_another_timeline(self):
        with self.assertRaisesRegex(AssertionError,'exact'):
            select_timeline_metrics(f'pageserver_last_record_lsn{{tenant_id="{"2"*32}",timeline_id="{"4"*32}"}} 9999','2'*32,'3'*32)
    def test_ambiguous_target_is_rejected(self):
        line=f'pageserver_last_record_lsn{{tenant_id="{"2"*32}",timeline_id="{"3"*32}"}} 16'
        with self.assertRaisesRegex(AssertionError,'exact'):
            select_timeline_metrics(line+'\n'+line,'2'*32,'3'*32)

if __name__=='__main__':unittest.main()
