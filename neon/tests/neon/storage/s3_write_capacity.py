"""New-key-only TLS S3 write/read/delete preflight, before allocating fixtures."""
import json
import sys
import uuid
import xml.etree.ElementTree as ET
from s3_client import S3Client, S3Error

request = json.loads(sys.stdin.readline())
client = S3Client(request['config'])
key = 'neon-pg18-qualification/capacity-preflight-' + str(uuid.uuid4()) + '/canary'
payload = b'neon-capacity-preflight'
result = {'status': 'RUNNING', 'tls_verified': True, 'bytes': len(payload),
          'scope': 'Only one new random canary key; no existing database objects modified'}
try:
    client.request('PUT', key, payload)
    _, actual, _ = client.request('GET', key)
    assert actual == payload, 'Canary read differs from written bytes'
    result['status'] = 'PASS'
except S3Error as error:
    result.update(status='FAIL', http_status=error.status)
    try:
        code = ET.fromstring(error.body).findtext('{*}Code')
        # Expose only a constrained service error code, never response bodies.
        if code and code.replace('_', '').isalnum() and len(code) < 80:
            result['service_error_code'] = code
    except ET.ParseError:
        pass
except Exception as error:
    result.update(status='FAIL', error_type=type(error).__name__)
finally:
    try:
        client.request('DELETE', key)
        result['new_canary_cleanup'] = 'PASS'
    except S3Error:
        result['new_canary_cleanup'] = 'FAIL'
        result['status'] = 'FAIL'
print(json.dumps(result))
sys.exit(0 if result['status'] == 'PASS' else 1)
