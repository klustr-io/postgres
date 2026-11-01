"""Current-runtime all-transaction guard regression, outside timed workloads."""
import json
import os
from pathlib import Path
import re
import signal
import subprocess
import sys
import time
from endpoint_evidence import preserve_stopped_pgdata,durable_safekeepers
from native_commit_guard import NativeCommitGuard
from target_replay import canonical_wal_end

r=json.loads(sys.stdin.readline());assert re.fullmatch(r'[0-9]{17}',r['stamp'])
root=Path('/var/lib/neon/comparison/neon/endpoints/bench');config=root/'postgresql.conf'
result={'status':'RUNNING','checks':[], 'scope':'Local native guard faults with 1 MiB byte cap; no comparative timings or independent-zone guarantee'}
started=False;original=None

def run(args):
    p=subprocess.run(args,capture_output=True,text=True,timeout=180)
    assert p.returncode==0,Path(args[0]).name+' failed ('+str(p.returncode)+')'
    return p.stdout.strip()

def local(*args):
    if args[:3]==('endpoint','start','bench'):
        saved=preserve_stopped_pgdata('bench',55432)
        if saved:result.setdefault('preserved_compute_directories',[]).append(saved)
    return run(['neon_local',*args])

def passed(name):
    result['checks'].append({'name':name,'status':'PASS'});print(json.dumps({'event':'CHECK','name':name,'status':'PASS'}),flush=True)

try:
    c=r['config'];os.environ.update(NEON_REPO_DIR='/var/lib/neon/comparison/neon',POSTGRES_DISTRIB_DIR='/opt/postgres',
      AWS_ACCESS_KEY_ID=c['access_key'],AWS_SECRET_ACCESS_KEY=c['secret_key'],AWS_REGION=c['region'],AWS_EC2_METADATA_DISABLED='true')
    assert not config.is_symlink();original=config.read_bytes()
    backup=root/('postgresql-before-guard-regression-'+r['stamp']+'.conf');assert not backup.exists();backup.write_bytes(original)
    compute_fsync=r.get('compute_local_fsync','on');assert compute_fsync in ('on','off')
    with config.open('a') as f:f.write("\nneon.bounded_async_max_wal='1MB'\nfsync="+compute_fsync+"\nfull_page_writes=on\n")
    local('start','--start-timeout','90s');started=True;local('endpoint','start','bench','--dev')
    result['safekeeper_fsync']=durable_safekeepers()
    logs=Path('/tmp/native-guard-full');logs.mkdir()
    native=NativeCommitGuard('neon',55432,'cloud_admin',logs);native.helper._local=local
    original_execute=native.execute
    def execute(statement,*args,**kwargs):
        value=original_execute(statement,*args,**kwargs)
        if statement=='SELECT pg_current_wal_insert_lsn()':
            return canonical_wal_end(value,int(original_execute("SELECT pg_size_bytes(current_setting('wal_segment_size'))")))
        return value
    native.execute=execute
    native.start();assert native.status()['max_wal_bytes']==1048576
    assert native.execute('SHOW fsync')==compute_fsync
    result['compute_local_fsync']=compute_fsync
    result['native_guard']=native.finish()
    for name in ('partition_off_and_local','prepare_and_commit_prepared','session_disable_rejected','sticky_drain'):
        assert result['native_guard'][name]=='PASS';passed(name)
    for name in ('byte_limit','cancellation'):
        assert result['native_guard'][name]['status']=='PASS';passed(name)
    assert result['native_guard']['idle_tail_quorum_seconds']<1;passed('isolated asynchronous idle tail reaches quorum in under one second')

    def reconstruct():
        ctl=int((root/'compute_ctl.pid').read_text().strip())
        command=Path('/proc',str(ctl),'cmdline').read_bytes()
        assert ctl>1 and b'compute_ctl' in command and str(root/'pgdata').encode() in command
        parent=int((root/'pgdata/postmaster.pid').read_text().splitlines()[0]);assert parent>1
        rows={}
        for path in Path('/proc').glob('[0-9]*'):
            try:rows[int(path.name)]=int((path/'stat').read_text().rsplit(')',1)[1].split()[1])
            except FileNotFoundError:continue
        def descendant(pid):
            seen=set()
            while pid in rows and pid not in seen:
                if rows[pid]==parent:return True
                seen.add(pid);pid=rows[pid]
            return False
        targets=[pid for pid in rows if descendant(pid)];assert targets
        os.kill(ctl,signal.SIGKILL)
        for pid in targets:
            try:os.kill(pid,signal.SIGKILL)
            except ProcessLookupError:pass
        os.kill(parent,signal.SIGKILL);crashed_at=time.time()
        time.sleep(.1)
        cache=Path('/var/lib/neon/comparison/lfc.cache')
        if cache.exists():
            assert not cache.is_symlink();cache.rename(cache.with_name('lfc-guard-loss-'+r['stamp']+'.cache'))
        local('endpoint','start','bench','--dev')
        return crashed_at
    result['controlled_loss']=native.immediate_loss_probe(reconstruct)
    assert result['controlled_loss']['status']=='PASS';passed('controlled unshipped-tail loss is under one second; all older drained witness rows survive')
    result['status']='PASS'
finally:
    if started:
        subprocess.run(['neon_local','endpoint','stop','bench'],capture_output=True,timeout=180)
        subprocess.run(['neon_local','stop'],capture_output=True,timeout=180)
    if original is not None:config.write_bytes(original)
    print(json.dumps({'event':'RESULT','result':result}),flush=True)
