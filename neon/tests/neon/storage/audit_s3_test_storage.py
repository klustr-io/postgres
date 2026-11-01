"""Read-only inventory of explicitly supplied generated-test S3 prefixes."""
import concurrent.futures
import json
import sys
import xml.etree.ElementTree as ET
from s3_client import S3Client, S3Error

request = json.loads(sys.stdin.readline())
config, targets = request['config'], request['targets']
client = S3Client(config)
_, body, _ = client.request('GET', query={'versioning': ''})
versioning = ET.fromstring(body).findtext('{*}Status') or 'Disabled'
assert versioning in ['Enabled', 'Suspended', 'Disabled']


def inspect(target):
    prefix = target['prefix']
    assert prefix.startswith('neon-pg18-benchmark/') and prefix.endswith('/') and '..' not in prefix
    rows = []
    query = {'prefix': prefix, 'max-keys': '1000'}
    query.update({'versions': ''} if versioning != 'Disabled' else {'list-type': '2'})
    for _ in range(1000):
        _, body, _ = client.request('GET', query=query)
        root = ET.fromstring(body)
        if versioning == 'Disabled':
            for item in root.findall('{*}Contents'):
                rows.append({'key': item.findtext('{*}Key'), 'size': int(item.findtext('{*}Size')),
                             'etag': item.findtext('{*}ETag'), 'version_id': None, 'delete_marker': False})
        else:
            for kind in ['Version', 'DeleteMarker']:
                for item in root.findall('{*}'+kind):
                    rows.append({'key': item.findtext('{*}Key'), 'size': int(item.findtext('{*}Size') or 0),
                                 'etag': item.findtext('{*}ETag'), 'version_id': item.findtext('{*}VersionId'),
                                 'delete_marker': kind == 'DeleteMarker', 'is_latest': item.findtext('{*}IsLatest') == 'true'})
        assert all(row['key'].startswith(prefix) for row in rows)
        if root.findtext('{*}IsTruncated') != 'true':
            break
        if versioning == 'Disabled':
            token = root.findtext('{*}NextContinuationToken')
            assert token
            query['continuation-token'] = token
        else:
            marker = root.findtext('{*}NextKeyMarker')
            assert marker
            query['key-marker'] = marker
            token = root.findtext('{*}NextVersionIdMarker')
            if token:
                query['version-id-marker'] = token
    else:
        raise RuntimeError('Test-prefix pagination exceeded safety bound')
    print(f"Inventoried generated test prefix: {len(rows)} entries, {sum(row['size'] for row in rows)} bytes", file=sys.stderr, flush=True)
    return {**target, 'objects': rows, 'object_versions_and_markers': len(rows),
            'bytes': sum(row['size'] for row in rows), 'versioning': versioning}


with concurrent.futures.ThreadPoolExecutor(max_workers=4) as pool:
    results = list(pool.map(inspect, targets))
print(json.dumps({'status': 'READ-ONLY-INVENTORY', 'versioning': versioning, 'targets': results,
                  'total_bytes': sum(row['bytes'] for row in results),
                  'total_entries': sum(row['object_versions_and_markers'] for row in results),
                  'remote_deletions': False}))
