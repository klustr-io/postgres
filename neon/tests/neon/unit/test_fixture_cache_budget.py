import tempfile
import io
import json
from pathlib import Path
import tomllib
import unittest
from unittest.mock import patch
from fixture_cache_budget import POLICY,configure_fixture_cache_budget,wait_fixture_storage_ready

class CacheBudget(unittest.TestCase):
    def test_preserves_other_settings_and_original(self):
        with tempfile.TemporaryDirectory() as directory:
            root=Path(directory);path=root/'pageserver.toml'
            original='id=1\nremote_storage={endpoint="https://example.invalid",bucket_name="fixture",concurrency_limit=8}\n[tenant_config]\ncheckpoint_distance=67108864\n'
            path.write_text(original)
            result=configure_fixture_cache_budget('20261101000000001',root)
            self.assertTrue(result['changed']);self.assertEqual(tomllib.loads(path.read_text())['disk_usage_based_eviction'],POLICY)
            self.assertEqual((root/'pageserver-before-cache-budget-20261101000000001.private').read_text(),original)
            self.assertEqual(tomllib.loads(path.read_text())['remote_storage'],tomllib.loads(original)['remote_storage'])
            before=path.read_bytes();self.assertFalse(configure_fixture_cache_budget('20261101000000002',root)['changed']);self.assertEqual(path.read_bytes(),before)
    def test_rejects_unreviewed_existing_policy_without_changes(self):
        with tempfile.TemporaryDirectory() as directory:
            root=Path(directory);path=root/'pageserver.toml';original='id=1\ndisk_usage_based_eviction={max_usage_pct=85,min_avail_bytes=2000000000,period="60s"}\n';path.write_text(original)
            with self.assertRaises(AssertionError):configure_fixture_cache_budget('20261101000000001',root)
            self.assertEqual(path.read_text(),original)
    def test_readiness_requires_the_durable_stopped_storage_barrier(self):
        spec=Path('/synthetic/spec.json');proof={'status':'PASS','seconds':.1}
        with patch('fixture_cache_budget.wait_for_stopped_replay',return_value=proof) as barrier:
            self.assertEqual(wait_fixture_storage_ready(timeout=7,spec_path=spec),proof)
        barrier.assert_called_once_with(timeout=7,spec_path=spec)
    def test_failed_barrier_cannot_become_ready(self):
        with patch('fixture_cache_budget.wait_for_stopped_replay',side_effect=AssertionError('no durable quorum')):
            with self.assertRaisesRegex(AssertionError,'no durable quorum'):wait_fixture_storage_ready()
if __name__=='__main__':unittest.main()
