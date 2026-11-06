"""Dedicated executor for the separately reviewed single retired RC prefix."""
import base64
import hashlib
import json
import sys
import xml.etree.ElementTree as ET
from s3_client import S3Client
from remove_s3_test_storage import inventory,canary

RETIRED='neon-pg18-benchmark/20261031125913602-e38fc03f-ed72-4128-8932-e984e78f1068/'

def execute(client,plan,active_prefix,check_only=False):
    assert plan['status']=='PLAN-ONLY-AWAITING-EXPLICIT-REMOTE-DATA-DELETION-APPROVAL'
    assert len(plan['targets'])==1 and plan['targets'][0]['prefix']==RETIRED
    assert active_prefix.rstrip('/')+'/'!=RETIRED
    assert plan['total_entries']==8272 and plan['versioning']=='Disabled'
    rows=plan['targets'][0]['objects']
    assert len(rows)==8272 and len({r['key'] for r in rows})==8272
    assert all(r['key'].startswith(RETIRED) and '..' not in r['key'].split('/') and
               r['version_id'] is None and not r['delete_marker'] for r in rows)
    assert sum(r['size'] for r in rows)==plan['total_bytes']
    _,body,_=client.request('GET',query={'versioning':''})
    assert not ET.fromstring(body).findtext('{*}Status'),'Bucket versioning changed'
    expected=sorted((r['key'],r['size'],r['etag']) for r in rows)
    assert inventory(client,RETIRED)==expected,'Remote objects changed; obtain a fresh review'
    if check_only:return {'status':'PRECONDITIONS-PASS','objects_verified':len(rows),'remote_deletions':False}
    deleted=0
    for at in range(0,len(expected),200):
        batch=expected[at:at+200];root=ET.Element('Delete',xmlns='http://s3.amazonaws.com/doc/2006-03-01/')
        for key,_,_ in batch:ET.SubElement(ET.SubElement(root,'Object'),'Key').text=key
        ET.SubElement(root,'Quiet').text='false';payload=ET.tostring(root,encoding='utf8')
        _,body,_=client.request('POST',query={'delete':''},data=payload,
          extra_headers={'Content-MD5':base64.b64encode(hashlib.md5(payload).digest()).decode(),'Content-Type':'application/xml'})
        response=ET.fromstring(body);assert not response.findall('{*}Error'),'Approved deletion partially failed'
        assert sorted(x.findtext('{*}Key') for x in response.findall('{*}Deleted'))==sorted(x[0] for x in batch)
        deleted+=len(batch)
        print(f'Approved retired RC objects removed: {deleted}/8272',file=sys.stderr,flush=True)
    assert inventory(client,RETIRED)==[],'Retired prefix was not empty after removal'
    return {'status':'PASS','objects_removed':deleted,'inventoried_object_bytes_removed':plan['total_bytes'],
      'prefixes_verified_empty':1,'other_prefixes_deleted':False,'local_database_files_deleted':False}

if __name__=='__main__':
    r=json.loads(sys.stdin.readline());client=S3Client(r['config'])
    result=execute(client,r['plan'],r['active_prefix'],r.get('check_only',False))
    if not r.get('check_only',False):result['tls_write_read_canary']=canary(client)
    print(json.dumps(result),flush=True)
