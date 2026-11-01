"""Execute only an approved, immutable old-test-object manifest."""
import base64
import concurrent.futures
import hashlib
import json
import re
import sys
import uuid
import xml.etree.ElementTree as ET
from s3_client import S3Client


def inventory(client, prefix):
    query = {'list-type': '2', 'prefix': prefix, 'max-keys': '1000'}
    rows = []
    for _ in range(1000):
        _, body, _ = client.request('GET', query=query)
        root = ET.fromstring(body)
        for item in root.findall('{*}Contents'):
            key = item.findtext('{*}Key')
            assert key.startswith(prefix), 'Object outside approved prefix'
            rows.append((key, int(item.findtext('{*}Size')), item.findtext('{*}ETag')))
        if root.findtext('{*}IsTruncated') != 'true':
            return sorted(rows)
        query['continuation-token'] = root.findtext('{*}NextContinuationToken')
        assert query['continuation-token']
    raise RuntimeError('Pagination safety bound exceeded')


def execute(client, plan):
    assert plan['status'] == 'PLAN-ONLY-AWAITING-EXPLICIT-REMOTE-DATA-DELETION-APPROVAL'
    assert plan['versioning'] == 'Disabled', 'Versioned storage requires a separately reviewed executor'
    assert len(plan['targets']) == 38
    _, body, _ = client.request('GET', query={'versioning': ''})
    assert not ET.fromstring(body).findtext('{*}Status'), 'Bucket versioning changed; abort'
    expected = {}
    for target in plan['targets']:
        prefix = target['prefix']
        assert re.fullmatch(r'neon-pg18-benchmark/[0-9]{17}-[a-f0-9-]{36}/', prefix)
        assert prefix not in expected
        rows = target['objects']
        assert all(row['key'].startswith(prefix) and row['version_id'] is None
                   and not row['delete_marker'] for row in rows)
        expected[prefix] = sorted((row['key'], row['size'], row['etag']) for row in rows)
        assert len(set(row[0] for row in expected[prefix])) == len(rows)
    assert sum(len(rows) for rows in expected.values()) == plan['total_entries']
    assert sum(row[1] for rows in expected.values() for row in rows) == plan['total_bytes']

    # Verify EVERY prefix before any mutation. Never expand a reviewed manifest.
    def verify(prefix):
        assert inventory(client, prefix) == expected[prefix], 'Remote objects changed; obtain a fresh review'
    with concurrent.futures.ThreadPoolExecutor(max_workers=4) as pool:
        list(pool.map(verify, expected))
    deleted = 0
    for prefix, rows in expected.items():
        for offset in range(0, len(rows), 200):
            batch = rows[offset:offset + 200]
            root = ET.Element('Delete', xmlns='http://s3.amazonaws.com/doc/2006-03-01/')
            for key, _, _ in batch:
                ET.SubElement(ET.SubElement(root, 'Object'), 'Key').text = key
            ET.SubElement(root, 'Quiet').text = 'false'
            payload = ET.tostring(root, encoding='utf-8')
            digest = base64.b64encode(hashlib.md5(payload).digest()).decode()
            _, body, _ = client.request('POST', query={'delete': ''}, data=payload,
                                       extra_headers={'Content-MD5': digest, 'Content-Type': 'application/xml'})
            result = ET.fromstring(body)
            assert not result.findall('{*}Error'), 'S3 rejected an approved object deletion; inspect result before retry'
            returned = sorted(item.findtext('{*}Key') for item in result.findall('{*}Deleted'))
            assert returned == sorted(row[0] for row in batch), 'Unexpected deletion acknowledgement'
            deleted += len(batch)
            print(f'Approved old S3 test objects removed: {deleted}/{plan["total_entries"]}', file=sys.stderr, flush=True)
    for prefix in expected:
        assert inventory(client, prefix) == [], 'Approved prefix is not empty after removal'
    return {'status': 'PASS', 'prefixes_verified_empty': len(expected), 'objects_removed': deleted,
            'inventoried_object_bytes_removed': plan['total_bytes'], 'other_prefixes_deleted': False}


def canary(client):
    # Only this newly created random canary key may be deleted here.
    key = 'neon-pg18-qualification/storage-recovery-' + str(uuid.uuid4()) + '/canary'
    payload = b'neon-s3-write-capacity-canary'
    try:
        client.request('PUT', key, payload)
        _, actual, _ = client.request('GET', key)
        assert actual == payload
        return {'status': 'PASS', 'tls_verified': True, 'bytes': len(payload)}
    finally:
        client.request('DELETE', key)


if __name__ == '__main__':
    request = json.loads(sys.stdin.readline())
    client = S3Client(request['config'])
    result = execute(client, request['plan'])
    result['tls_write_read_canary'] = canary(client)
    print(json.dumps(result))
