"""Ensure the fault fixture cannot forward access outside its fresh S3 prefix."""
from unittest.mock import patch
import urllib.error
import urllib.request
from s3_client import S3Client
from s3_fault_proxy import S3FaultProxy

config = {'endpoint': 'https://example.invalid', 'access_key': 'test-only',
          'secret_key': 'test-only', 'region': 'test', 'bucket': 'test-bucket',
          'prefix': 'qualification/this-run'}
with patch.object(S3Client, 'request', return_value=(200, b'ok', {})) as upstream:
    proxy = S3FaultProxy(config, port=0)
    try:
        attempts = [
            ('/another-bucket/qualification/this-run/key', {}),
            ('/test-bucket/qualification/another-run/key', {}),
            ('/test-bucket/qualification/this-run-adjacent/key', {}),
            ('/test-bucket?list-type=2', {}),
            ('/test-bucket?list-type=2&prefix=qualification/another-run/', {}),
            ('/test-bucket/qualification/this-run/key',
             {'x-amz-copy-source': '/test-bucket/qualification/another-run/private'}),
        ]
        for path, headers in attempts:
            try:
                urllib.request.urlopen(urllib.request.Request(proxy.endpoint + path, headers=headers), timeout=5)
            except urllib.error.HTTPError as error:
                assert error.code == 403
            else:
                raise AssertionError('Cross-prefix request was accepted')
            upstream.assert_not_called()
        with urllib.request.urlopen(proxy.endpoint + '/test-bucket/qualification/this-run/key', timeout=5) as response:
            assert response.read() == b'ok'
        assert upstream.call_count == 1
        print('PASS S3 fixture: six cross-bucket/prefix/copy attempts blocked; in-prefix access works')
    finally:
        proxy.close()
