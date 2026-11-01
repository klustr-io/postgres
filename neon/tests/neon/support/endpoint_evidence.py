"""Preserve disposable compute files before neon_local recreates an endpoint.

The host must first prove exclusive ownership of the fixture volume. Never use
this helper for a live endpoint: port and process checks fail closed.
"""
from pathlib import Path
import hashlib
import json
import socket
import time

def configure_document_write_window(stamp, compute_local_fsync='on'):
    """Bound pageserver receipt backlog above the fixture's 15-MiB window.

    This is separate from the unchanged native quorum/age/byte ACK guard.
    Call only before compute starts in the exclusively owned fixture.
    """
    import re
    assert re.fullmatch(r'[0-9]{17}',stamp) and compute_local_fsync in ('on','off')
    root=Path('/var/lib/neon/comparison/neon/endpoints/bench')
    config=root/'postgresql.conf';assert not config.is_symlink()
    original=config.read_bytes();backup=root/('postgresql-before-write-window-'+stamp+'.private')
    assert not backup.exists();backup.write_bytes(original)
    with config.open('a') as output:output.write("\nmax_replication_write_lag='64MB'\nfsync="+compute_local_fsync+"\n")
    return {'pageserver_receipt_window_mib':64,'compute_local_fsync':compute_local_fsync,'original_private_config_sha256':hashlib.sha256(original).hexdigest(),
      'scope':'Bounded pageserver receipt backlog; native 750ms/64MiB external-quorum admission is unchanged'}

def compute_start_metrics():
    """Publish numeric runtime phase counters, never private log contents."""
    import re
    log=Path('/var/lib/neon/comparison/neon/endpoints/bench/compute.log').read_text()
    rows=[line for line in log.splitlines() if 'compute start finished metrics=ComputeMetrics {' in line]
    assert rows,'Missing compute startup phase counters'
    selected={}
    for key in ('sync_safekeepers_ms','pageserver_connect_micros','basebackup_ms','basebackup_bytes','start_postgres_ms','config_ms','total_startup_ms'):
        match=re.search(r'\b'+key+r': ([0-9]+)',rows[-1]);assert match,key
        selected[key]=int(match[1])
    return selected

def durable_safekeepers():
    """Prove storage sync remains enabled even for ephemeral compute."""
    import tomllib
    config=tomllib.loads(Path('/var/lib/neon/comparison/neon/config').read_text())
    nodes=config['safekeepers'];assert sorted(node['id'] for node in nodes)==[1,2,3]
    assert all(node['sync'] is True for node in nodes)
    commands=[]
    for entry in Path('/proc').glob('[0-9]*'):
        try:
            if (entry/'comm').read_text().strip()!='safekeeper':continue
            args=(entry/'cmdline').read_bytes().split(b'\0')
        except (FileNotFoundError,ProcessLookupError):continue
        assert b'--no-sync' not in args,'Storage fsync was disabled'
        commands.append(int(args[args.index(b'--id')+1]))
    assert sorted(commands)==[1,2,3]
    return {'configured_sync_nodes':[1,2,3],'running_nodes_without_no_sync':[1,2,3],'status':'PASS'}

def enable_steady_catalog_mode(name, stamp):
    """After explicit installed-version validation, avoid migrations on wake.

    Caller must stop compute first. Retain the original endpoint configuration;
    version upgrades still require an explicit catalog migration phase.
    """
    import re
    assert name=='bench' and re.fullmatch(r'[0-9]{17}',stamp)
    root=Path('/var/lib/neon/comparison/neon/endpoints')/name
    assert not (root/'pgdata/postmaster.pid').exists(),'Stop compute before changing steady endpoint mode'
    config=root/'endpoint.json';assert not config.is_symlink()
    original=config.read_bytes();value=json.loads(original)
    assert value['endpoint_id']==name and value['pg_version']==18
    if value['skip_pg_catalog_updates']:
        return {'status':'PASS','skip_pg_catalog_updates':True,'changed':False}
    backup=root/('endpoint-before-steady-'+stamp+'.json');assert not backup.exists();backup.write_bytes(original)
    value['skip_pg_catalog_updates']=True
    temporary=root/('endpoint-steady-'+stamp+'.json');assert not temporary.exists()
    temporary.write_text(json.dumps(value,indent=2)+'\n');temporary.replace(config)
    return {'status':'PASS','skip_pg_catalog_updates':True,'changed':True,'backup':backup.name,
      'previous_sha256':hashlib.sha256(original).hexdigest(),'scope':'Same pinned binaries; installed Neon 1.7 verified before stop; migrations excluded from steady compute wake'}


def preserve_stopped_pgdata(name, port):
    import re
    assert re.fullmatch(r'(bench|docrc[0-9]+|rcscale[0-9]+)', name)
    root = Path('/var/lib/neon/comparison/neon/endpoints') / name
    data = root / 'pgdata'
    if not data.exists():
        return None
    assert not root.is_symlink() and not data.is_symlink()
    assert data.resolve().parent == root.resolve()
    with socket.socket() as probe:
        probe.settimeout(.3)
        assert probe.connect_ex(('127.0.0.1', port)) != 0, 'Endpoint port is live'
    for process in Path('/proc').iterdir():
        if not process.name.isdigit():
            continue
        try:
            command = (process / 'cmdline').read_bytes().replace(b'\0', b' ')
        except FileNotFoundError:
            continue
        assert not (b'postgres' in command and str(data).encode() in command), 'Live endpoint process'
    target = root / ('pgdata-preserved-' + str(time.time_ns()))
    data.rename(target)
    return target.name
