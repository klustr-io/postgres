"""Exact-body TLS probe. Clean up only fresh non-database objects created here."""
import concurrent.futures
import hashlib
import json
import random
import sys
import time
from s3_client import S3Client,S3Error

r=json.loads(sys.stdin.readline());c=r['config'];client=S3Client(c)
assert c['endpoint'].startswith('https://') and c['prefix'].startswith('neon-pg18-qualification/')
prefix=c['prefix']+'/transport-capacity-probe/'
payload=random.Random(180006).randbytes(64*1024*1024);digest=hashlib.sha256(payload).hexdigest()
result={'status':'RUNNING','object_bytes':len(payload),'parallel_uploads':8,'checks':[],
        'fresh_probe_prefix':prefix,'existing_database_objects_deleted':False}
created=[];began=time.monotonic()
def one(number):
    key=prefix+'object-'+str(number)
    try:client.request('HEAD',key);raise AssertionError('Probe key already exists')
    except S3Error as e:assert e.status==404,'Fresh probe key precondition failed'
    client.request('PUT',key,payload);created.append(key)
    _,body,_=client.request('GET',key)
    assert len(body)==len(payload) and hashlib.sha256(body).hexdigest()==digest
    return {'object':number,'bytes':len(body),'sha256':digest,'status':'PASS'}
try:
    with concurrent.futures.ThreadPoolExecutor(max_workers=8) as pool:
        result['checks']=list(pool.map(one,range(8)))
    result['status']='PASS'
except S3Error as error:
    result.update(status='FAIL',error='TLS S3 probe failed',http_status=error.status)
finally:
    deleted=[]
    for key in created:
        # Only this run's successful PUTs are candidates; no prefix-wide delete.
        assert key.startswith(prefix)
        client.request('DELETE',key);deleted.append(key)
    result['fresh_probe_objects_removed']=len(deleted)
    result['elapsed_seconds']=time.monotonic()-began
    print(json.dumps(result),flush=True)
assert result['status']=='PASS'
