#!/usr/bin/env python3
"""Test only fresh objects under a unique qualification prefix."""
import hashlib
import json
import os
import sys
from s3_client import S3Client

config = json.load(sys.stdin)
report = {'status': 'RUNNING', 'prefix': config['prefix'],
          'tls_verified': config['endpoint'].startswith('https://'), 'operations': []}
try:
    client = S3Client(config)
    key = config['prefix'] + '/connectivity.bin'
    payload = os.urandom(256 * 1024)
    client.request('PUT', key, payload)
    report['operations'].append('signed PUT')
    _, actual, _ = client.request('GET', key)
    assert hashlib.sha256(actual).digest() == hashlib.sha256(payload).digest(), 'Object digest mismatch'
    report['operations'].append('signed GET and SHA-256')
    status, part, _ = client.request('GET', key, extra_headers={'Range': 'bytes=1024-4095'})
    assert status == 206 and part == payload[1024:4096], 'Range response mismatch'
    report['operations'].append('range GET')
    assert any(item['key'] == key for item in client.objects(config['prefix'])), 'Fresh object absent from listing'
    report['operations'].append('prefix LIST')
    # Delete exactly the newly created probe object, never a pre-existing key.
    client.request('DELETE', key)
    assert not client.objects(config['prefix']), 'Deleted probe remains listed'
    report['operations'].append('owned-object DELETE and absence verification')
    report['status'] = 'PASS'
except Exception as error:
    report.update(status='FAIL', error_type=type(error).__name__)
    if type(error).__name__ == 'S3Error':
        report['error'] = str(error)
print(json.dumps(report))
sys.exit(0 if report['status'] == 'PASS' else 1)
