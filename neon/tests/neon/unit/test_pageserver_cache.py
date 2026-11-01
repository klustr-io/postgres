import unittest
from unittest.mock import patch
import io
import json
from types import SimpleNamespace
from urllib.error import HTTPError
from pathlib import Path
import tempfile
import tomllib
from pageserver_cache import critical_layer,uploaded_through_disk,warm_critical_cache,configure_remote_concurrency,select_safekeeper_metric,safekeeper_status_state,wait_for_stopped_replay

class CacheMetadataRetentionTests(unittest.TestCase):
    def test_authenticated_status_rejects_other_timeline_and_malformed_lsn(self):
        info={'tenant_id':'2'*32,'timeline_id':'3'*32,'commit_lsn':'1/20','flush_lsn':'1/20','walreceivers':[]}
        self.assertEqual(safekeeper_status_state(info,'2'*32,'3'*32)['commit_lsn'],(1<<32)+32)
        with self.assertRaisesRegex(AssertionError,'identity mismatch'):safekeeper_status_state(info,'2'*32,'4'*32)
        with self.assertRaisesRegex(AssertionError,'Invalid safekeeper LSN'):safekeeper_status_state({**info,'flush_lsn':'-1/20'},'2'*32,'3'*32)

    def stopped_status_barrier(self,flushes=(100,100,0),receivers=(),replay=100,missing_first=False):
        tenant='2'*32;timeline='3'*32;calls=[]
        spec=json.dumps({'spec':{'tenant_id':tenant,'timeline_id':timeline,'storage_auth_token':'synthetic'}})
        def request(req,timeout):
            self.assertEqual(req.get_header('Authorization'),'Bearer synthetic');calls.append(req.full_url)
            if missing_first and len(calls)==1:raise HTTPError(req.full_url,404,'not ready',None,io.BytesIO())
            if ':9898/' in req.full_url:return io.BytesIO(json.dumps({'last_record_lsn':'0/'+format(replay,'X')}).encode())
            port=int(req.full_url.split(':')[2].split('/')[0]);index=port-7676
            return io.BytesIO(json.dumps({'tenant_id':tenant,'timeline_id':timeline,'commit_lsn':'0/64',
                'flush_lsn':'0/'+format(flushes[index],'X'),'walreceivers':list(receivers)}).encode())
        with patch('pageserver_cache.Path.read_text',return_value=spec),patch('pageserver_cache.urllib.request.urlopen',side_effect=request),patch('pageserver_cache.time.sleep'),patch('pageserver_cache.time.monotonic',side_effect=[0,0,2,3]):
            return wait_for_stopped_replay(timeout=1)

    def test_inactive_status_requires_majority_flush_and_replay(self):
        result=self.stopped_status_barrier();self.assertEqual(result['status'],'PASS');self.assertEqual(result['quorum_target_lsn_bytes'],100)
        self.assertTrue(all(s['source']=='authenticated_timeline_status' for s in result['safekeepers']))

    def test_one_flushed_copy_cannot_authorize_eviction(self):
        with self.assertRaisesRegex(AssertionError,'did not reach durable quorum/replay'):self.stopped_status_barrier(flushes=(100,0,0))

    def test_lagging_pageserver_cannot_authorize_eviction(self):
        with self.assertRaisesRegex(AssertionError,'did not reach durable quorum/replay'):self.stopped_status_barrier(replay=99)

    def test_active_wal_receiver_cannot_authorize_eviction(self):
        with self.assertRaisesRegex(AssertionError,'did not reach durable quorum/replay'):self.stopped_status_barrier(receivers=({'connection':'synthetic'},))

    def test_startup_not_found_is_bounded_and_does_not_skip_the_barrier(self):
        with self.assertRaisesRegex(AssertionError,'did not reach durable quorum/replay'):self.stopped_status_barrier(flushes=(100,0,0),missing_first=True)

    def test_stopped_replay_selects_the_exact_safekeeper_timeline(self):
        target='safekeeper_commit_lsn{tenant_id="'+('2'*32)+'",timeline_id="'+('3'*32)+'"} 1234567890123'
        other=target.replace('3'*32,'4'*32).replace('1234567890123','9999999999999')
        self.assertEqual(select_safekeeper_metric(other+'\n'+target,'2'*32,'3'*32,'commit_lsn'),1234567890123)
        with self.assertRaisesRegex(AssertionError,'Expected one exact'):
            select_safekeeper_metric(target+'\n'+target,'2'*32,'3'*32,'commit_lsn')
    def test_concurrency_change_preserves_remote_configuration_and_original_bytes(self):
        original=b'listen_http_addr="127.0.0.1:9898"\nremote_storage = {endpoint="https://synthetic.invalid",bucket_name="test",prefix_in_bucket="preserve",concurrency_limit=100}\n'
        with tempfile.TemporaryDirectory() as folder:
            path=Path(folder)/'pageserver.toml';path.write_bytes(original)
            with patch('pageserver_cache.Path',return_value=path):
                result=configure_remote_concurrency('20261031172000000')
                again=configure_remote_concurrency('20261031172000001')
            expected=tomllib.loads(original.decode());expected['remote_storage']['concurrency_limit']=8
            self.assertEqual(tomllib.loads(path.read_text()),expected)
            self.assertEqual(path.with_name('pageserver-before-concurrency-20261031172000000.private').read_bytes(),original)
            self.assertEqual(result['previous_limit'],100)
            self.assertEqual(again['previous_limit'],8)
            self.assertNotIn('synthetic.invalid',json.dumps(result))

    def test_compacted_layer_starting_in_user_data_can_still_contain_control_and_aux_metadata(self):
        layer={'layer_file_name':'000000067F0005C0000005E0CD0000000014-62000002016EDDA516966767E71378F278C2__00000002541C5F49-0000000272DB1FF9','l0':False}
        self.assertTrue(critical_layer(layer))

    def test_relation_only_partition_can_be_evicted_but_l0_cannot(self):
        layer={'layer_file_name':'000000067F00036000000360050300000000-000000067F00036000000380500200000000__00000001BC941E59','l0':False}
        self.assertFalse(critical_layer(layer))
        self.assertTrue(critical_layer({**layer,'l0':True}))

    def test_zero_start_image_and_control_namespace_stay_resident(self):
        self.assertTrue(critical_layer({'layer_file_name':'000000000000000000000000000000000000-000000067F00006000000060120100000000__00000000A9F44871'}))
        self.assertTrue(critical_layer({'layer_file_name':'030000000000000000000000000000000000-040000000000000000000000000000000000__00000000A9F44871'}))

    def test_restart_uses_generation_validated_frontier_even_before_new_upload(self):
        self.assertTrue(uploaded_through_disk({'remote_consistent_lsn':'0/0','remote_consistent_lsn_visible':'2/20','disk_consistent_lsn':'2/20'}))

    def test_unvalidated_or_incomplete_upload_cannot_authorize_eviction(self):
        self.assertFalse(uploaded_through_disk({'remote_consistent_lsn':'3/0','remote_consistent_lsn_visible':'2/10','disk_consistent_lsn':'2/20'}))
        self.assertFalse(uploaded_through_disk({'remote_consistent_lsn':'3/0','disk_consistent_lsn':'2/20'}))

    def prewarm_race(self,still_present):
        layer={'layer_file_name':'030000000000000000000000000000000000-040000000000000000000000000000000000__00000000A9F44871',
          'layer_file_size':1024,'remote':True}
        calls=0
        def request(req,timeout):
            nonlocal calls
            if req.full_url.endswith('/layer'):
                calls+=1
                return io.BytesIO(json.dumps({'historic_layers':[layer] if calls==1 or still_present else []}).encode())
            raise HTTPError(req.full_url,400,'not found',None,io.BytesIO())
        spec=json.dumps({'spec':{'tenant_id':'2'*32,'timeline_id':'3'*32,'storage_auth_token':'synthetic-test-token'}})
        with patch('pageserver_cache.Path.read_text',return_value=spec), \
             patch('pageserver_cache.os.statvfs',return_value=SimpleNamespace(f_bavail=64*1024**3,f_frsize=1)), \
             patch('pageserver_cache.urllib.request.urlopen',side_effect=request):
            return warm_critical_cache()

    def test_compaction_race_skips_only_a_confirmed_removed_layer(self):
        result=self.prewarm_race(False)
        self.assertEqual(result['status'],'PASS')
        self.assertEqual(result['compacted_before_download'],1)
        self.assertEqual(result['layers'],0)

    def test_http400_for_a_still_referenced_layer_is_not_ignored(self):
        with self.assertRaisesRegex(AssertionError,'Critical cache download failed: 400'):
            self.prewarm_race(True)

if __name__=='__main__':unittest.main()
