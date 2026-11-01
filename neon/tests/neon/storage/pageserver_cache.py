"""Reclaim only uploaded pageserver CACHE through the supported eviction API.

Never unlink layer files directly, delete timelines, or delete remote objects.
Call outside measured workloads with computes stopped. Remote-consistency
checks precede eviction; metadata and canonical S3 remain.
"""
import json
import os
from pathlib import Path
import re
import time
import urllib.error
import urllib.parse
import urllib.request
from concurrent.futures import ThreadPoolExecutor

def select_safekeeper_metric(body,tenant,timeline,kind):
    assert re.fullmatch(r'[a-f0-9]{32}',tenant) and re.fullmatch(r'[a-f0-9]{32}',timeline)
    assert kind in ('commit_lsn','flush_lsn','connected_computes')
    selected=[line for line in body.splitlines() if line.startswith('safekeeper_'+kind+'{')
      and f'tenant_id="{tenant}"' in line and f'timeline_id="{timeline}"' in line]
    assert len(selected)==1,'Expected one exact safekeeper tenant/timeline metric'
    return int(selected[0].rsplit(' ',1)[1])

def safekeeper_status_state(info,tenant,timeline):
    """Authenticated status remains available when inactive metrics are absent."""
    assert info['tenant_id']==tenant and info['timeline_id']==timeline,'Safekeeper status identity mismatch'
    assert isinstance(info['walreceivers'],list),'Expected explicit WAL receiver list'
    for name in ('commit_lsn','flush_lsn'):
        assert isinstance(info[name],str) and re.fullmatch(r'[0-9A-Fa-f]{1,8}/[0-9A-Fa-f]{1,8}',info[name]),'Invalid safekeeper LSN'
    return {'commit_lsn':lsn(info['commit_lsn']),'flush_lsn':lsn(info['flush_lsn']),
        'connected_computes':len(info['walreceivers']),'source':'authenticated_timeline_status'}

def wait_for_stopped_replay(timeout=180,spec_path=None):
    """Fence WAL replay before cache eviction or stopping shared storage.

    Disk/upload agreement alone can precede a later durable safekeeper tail.
    """
    root=Path('/var/lib/neon/comparison')
    spec=json.loads((spec_path or root/'neon/endpoints/bench/config.json').read_text())['spec']
    tenant,timeline=spec['tenant_id'],spec['timeline_id'];began=time.monotonic()
    assert all(re.fullmatch(r'[a-f0-9]{32}',v) for v in (tenant,timeline))
    headers={'Authorization':'Bearer '+spec['storage_auth_token']};not_ready=0
    request=urllib.request.Request('http://127.0.0.1:9898/v1/tenant/'+tenant+'/timeline/'+timeline,
      headers=headers)
    while True:
        states=[]
        try:
            for port in (7676,7677,7678):
                status=urllib.request.Request('http://127.0.0.1:'+str(port)+'/v1/tenant/'+tenant+'/timeline/'+timeline,headers=headers)
                with urllib.request.urlopen(status,timeout=15) as response:info=json.load(response)
                states.append(safekeeper_status_state(info,tenant,timeline))
            with urllib.request.urlopen(request,timeout=15) as response:info=json.load(response)
        except urllib.error.HTTPError as error:
            if error.code not in (404,503):raise
            assert time.monotonic()-began<timeout,'Stopped storage status did not become ready'
            not_ready+=1;time.sleep(.1);continue
        except urllib.error.URLError:
            assert time.monotonic()-began<timeout,'Stopped storage status did not become ready'
            not_ready+=1;time.sleep(.1);continue
        target=max(node['commit_lsn'] for node in states)
        replay=lsn(info['last_record_lsn']);elapsed=time.monotonic()-began
        if all(node['connected_computes']==0 for node in states) and sum(node['flush_lsn']>=target for node in states)>=2 and replay>=target:
            return {'status':'PASS','quorum_target_lsn_bytes':target,'pageserver_replay_lsn_bytes':replay,'seconds':elapsed,
              'safekeepers':states,'not_ready_observations':not_ready,
              'scope':'Authenticated exact-timeline status, no compute WAL receivers; committed tail flushed on a majority and replayed before cache eviction/storage stop'}
        assert elapsed<timeout,'Stopped compute WAL tail did not reach durable quorum/replay before cache maintenance'
        time.sleep(.1)

def configure_remote_concurrency(stamp, limit=8):
    """Bound endpoint pressure using the pinned runtime's supported S3 option.

    Call before services start in an exclusively owned fixture. Retain the
    original private configuration; never return endpoints, tokens or keys.
    """
    import hashlib
    import tomllib
    assert re.fullmatch(r'[0-9]{17}',stamp) and limit==8
    path=Path('/var/lib/neon/comparison/neon/pageserver_1/pageserver.toml')
    assert not path.is_symlink()
    original=path.read_bytes();text=original.decode();config=tomllib.loads(text)
    remote=config['remote_storage'];assert isinstance(remote,dict) and remote.get('endpoint')
    prior=remote.get('concurrency_limit',100)
    if prior!=limit:
        remote['concurrency_limit']=limit
        assert all(isinstance(v,(str,int,bool)) for v in remote.values())
        inline='{'+','.join(k+'='+json.dumps(v) for k,v in remote.items())+'}'
        replacement,count=re.subn(r'^remote_storage\s*=\s*\{[^\n]*\}\s*$',lambda _: 'remote_storage = '+inline,text,flags=re.M)
        assert count==1 and tomllib.loads(replacement)['remote_storage']==remote
        backup=path.with_name('pageserver-before-concurrency-'+stamp+'.private')
        assert not backup.exists();backup.write_bytes(original);path.write_text(replacement)
    assert tomllib.loads(path.read_text())['remote_storage']['concurrency_limit']==limit
    return {'status':'PASS','pageserver_s3_concurrency_limit':limit,'previous_limit':prior,
      'previous_private_config_sha256':hashlib.sha256(original).hexdigest(),
      'scope':'Per-pageserver supported S3 concurrency cap; TLS, retries, durability and zero-error qualification remain enabled'}

def critical_layer(layer):
    # L0 spans the whole keyspace. Evicting it forces metadata lookups to fetch
    # full remote delta files. Keep L0 and metadata-overlapping partitions.
    low,high=layer['layer_file_name'].split('__')[0].split('-')
    # Pinned runtime Key prefixes: 0x01 SLRU, 0x02 twophase, 0x03
    # control/checkpoint, and higher metadata/aux-file namespaces. A layer can
    # start in relation data (0x00) and still overlap these metadata keys.
    metadata_begin=1 << (4*(len(high)-2))
    return layer.get('l0',False) or int(low,16)==0 or int(high,16)>metadata_begin

def lsn(value):
    assert isinstance(value,str) and re.fullmatch(r'[0-9A-Fa-f]+/[0-9A-Fa-f]+',value)
    high,low=value.split('/');return (int(high,16)<<32)+int(low,16)

def uploaded_through_disk(info):
    # The visible frontier is generation-validated and cannot move backward.
    # The projected frontier can be zero after restart until a NEW upload.
    visible=info.get('remote_consistent_lsn_visible')
    return visible is not None and lsn(visible)>=lsn(info['disk_consistent_lsn'])


def evict_uploaded_cache():
    root=Path('/var/lib/neon/comparison')
    spec=json.loads((root/'neon/endpoints/bench/config.json').read_text())['spec']
    tenant=spec['tenant_id'];assert re.fullmatch(r'[a-f0-9]{32}',tenant)
    selected_timeline=spec['timeline_id'];assert re.fullmatch(r'[a-f0-9]{32}',selected_timeline)
    token=spec['storage_auth_token'];assert isinstance(token,str) and token
    def api(method,path):
        request=urllib.request.Request('http://127.0.0.1:9898'+path,method=method,headers={'Authorization':'Bearer '+token})
        try:
            with urllib.request.urlopen(request,timeout=300) as response:
                raw=response.read();return json.loads(raw) if raw else None
        except urllib.error.HTTPError as error:
            code=error.code;error.close()
            raise AssertionError('Pageserver cache API failed: '+str(code)) from None
    stopped=wait_for_stopped_replay()
    before=os.statvfs(root);rows=[]
    prefix='/v1/tenant/'+tenant+'/timeline'
    # Retired branch records can expose a zero newly-uploaded frontier until
    # they receive new WAL. They are outside this active endpoint's cache scope.
    timelines=[api('GET',prefix+'/'+selected_timeline)]
    for timeline in timelines:
        tid=timeline['timeline_id'];assert re.fullmatch(r'[a-f0-9]{32}',tid)
        path=prefix+'/'+tid
        deadline=time.monotonic()+180
        while True:
            info=api('GET',path)
            if uploaded_through_disk(info):break
            assert time.monotonic()<deadline,'Remote layers not durable through disk frontier'
            time.sleep(.25)
        layers=api('GET',path+'/layer')['historic_layers'];evicted=0
        for layer in layers:
            if layer['remote'] or critical_layer(layer):continue
            name=layer['layer_file_name'];assert re.fullmatch(r'[0-9A-Fa-f_-]+',name)
            request=urllib.request.Request('http://127.0.0.1:9898'+path+'/layer/'+urllib.parse.quote(name,safe=''),method='DELETE',headers={'Authorization':'Bearer '+token})
            try:
                with urllib.request.urlopen(request,timeout=150) as response:
                    response.read();assert response.status==200;evicted+=1
            except urllib.error.HTTPError as error:
                code=error.code;error.close()
                if code==304:continue
                if code==400 and not any(x['layer_file_name']==name for x in api('GET',path+'/layer')['historic_layers']):continue
                raise AssertionError('Layer CACHE eviction failed: '+str(code)) from None
        rows.append({'timeline_id':tid,'upload_frontier':info['remote_consistent_lsn_visible'],
          'frontier_kind':'generation-validated remote_consistent_lsn_visible',
          'projected_frontier':info.get('remote_consistent_lsn'),'evicted_layers':evicted})
    after=os.statvfs(root)
    return {'status':'PASS','tenant_id':tenant,'timelines':rows,'evicted_layers':sum(x['evicted_layers'] for x in rows),
      'stopped_compute_replay':stopped,
      'free_bytes_before':before.f_bavail*before.f_frsize,'free_bytes_after':after.f_bavail*after.f_frsize,
      'scope':'Supported pageserver cache eviction after uploaded/disk frontier verification; all remote objects, timeline metadata, documents and compute evidence retained. Outside timed samples.'}

def warm_critical_cache(attempt=0,previous_bytes=0):
    """Bounded, parallel setup recovery after a completely evicted cache.

    This is outside wake/performance timers and is recorded explicitly. It is
    not a claim that a fully cold pageserver wakes in under one second.
    """
    root=Path('/var/lib/neon/comparison')
    spec=json.loads((root/'neon/endpoints/bench/config.json').read_text())['spec']
    tenant,tid=spec['tenant_id'],spec['timeline_id']
    assert all(re.fullmatch(r'[a-f0-9]{32}',x) for x in (tenant,tid))
    prefix='http://127.0.0.1:9898/v1/tenant/'+tenant+'/timeline/'+tid+'/layer'
    headers={'Authorization':'Bearer '+spec['storage_auth_token']}
    with urllib.request.urlopen(urllib.request.Request(prefix,headers=headers),timeout=30) as response:
        layers=json.load(response)['historic_layers']
    selected=[x for x in layers if x['remote'] and critical_layer(x)]
    size=sum(x['layer_file_size'] for x in selected);space=os.statvfs(root)
    assert previous_bytes+size<=12*1024**3 and space.f_bavail*space.f_frsize-size>8*1024**3,'Critical-cache recovery exceeds space budget'
    print(json.dumps({'event':'CACHE','name':'critical-cache recovery: '+str(len(selected))+' layers / '+str(size)+' bytes','status':'START'}),flush=True)
    def download(layer):
        name=layer['layer_file_name'];assert re.fullmatch(r'[0-9A-Fa-f_-]+',name)
        request=urllib.request.Request(prefix+'/'+urllib.parse.quote(name,safe=''),headers=headers)
        try:
            with urllib.request.urlopen(request,timeout=300) as response:response.read();assert response.status==200
        except urllib.error.HTTPError as error:
            code=error.code;error.close()
            if code==400:
                with urllib.request.urlopen(urllib.request.Request(prefix,headers=headers),timeout=30) as response:
                    current=json.load(response)['historic_layers']
                if not any(x['layer_file_name']==name for x in current):return 0
            if code!=304:raise AssertionError('Critical cache download failed: '+str(code)) from None
        return layer['layer_file_size']
    begin=time.monotonic()
    outcomes=[]
    with ThreadPoolExecutor(max_workers=4) as pool:
        for count,downloaded in enumerate(pool.map(download,selected),1):
            outcomes.append(downloaded)
            if count%10==0:print(json.dumps({'event':'CACHE','name':'critical-cache layers restored: '+str(count),'status':'PASS'}),flush=True)
    with urllib.request.urlopen(urllib.request.Request(prefix,headers=headers),timeout=30) as response:
        pending=[x for x in json.load(response)['historic_layers'] if x['remote'] and critical_layer(x)]
    result={'status':'PASS','layers':sum(x>0 for x in outcomes),'bytes':sum(outcomes),'compacted_before_download':sum(x==0 for x in outcomes),'seconds':time.monotonic()-begin,
      'scope':'Untimed setup: parallel fetch of remote L0/metadata-overlapping partitions. Fully cold pageserver recovery is separate from warm compute wake.'}
    if pending:
        assert attempt<3,'Critical cache did not converge after concurrent compaction'
        later=warm_critical_cache(attempt+1,previous_bytes+sum(outcomes))
        for key in ('layers','bytes','seconds','compacted_before_download'):result[key]+=later[key]
    return result
