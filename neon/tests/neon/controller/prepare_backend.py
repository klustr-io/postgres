"""Single-fixture shared storage for the controller smoke, not production topology.

Keep state on a new PVC, use authenticated native services and real HTTPS S3.
No test database or object is removed by this helper.
"""
import asyncio
import base64
import json
import os
from pathlib import Path
import signal
import subprocess
import sys
import time

# Reap orphaned native daemons while the setup child owns its subprocess waits.
# Otherwise a stopped compute remains a zombie and neon_local cannot observe
# its exit, even though PostgreSQL has already stopped correctly.
if os.getpid() == 1:
    child = os.fork()
    if child:
        signal.signal(signal.SIGTERM, lambda *_: os.kill(child, signal.SIGTERM))
        while True:
            reaped, status = os.waitpid(-1, 0)
            if reaped == child:
                code = os.waitstatus_to_exitcode(status)
                sys.exit(code if code >= 0 else 128 - code)

root = Path('/var/lib/neon')
repo = root / 'cluster'
logs = root / 'logs'
logs.mkdir(exist_ok=True)
os.environ.update(NEON_REPO_DIR=str(repo), POSTGRES_DISTRIB_DIR='/opt/postgres')
s3 = json.loads(Path('/run/s3/config.json').read_text())
assert s3['endpoint'].startswith('https://')
os.environ.update(AWS_ACCESS_KEY_ID=s3['access_key'], AWS_SECRET_ACCESS_KEY=s3['secret_key'],
                 AWS_REGION=s3['region'], AWS_EC2_METADATA_DISABLED='true')


def local(*args):
    with (logs / ('-'.join(args[:2]) + '-' + str(time.time_ns()) + '.log')).open('w') as output:
        result = subprocess.run(['neon_local', *args], stdout=output, stderr=subprocess.STDOUT, timeout=180)
    assert result.returncode == 0, 'Native storage initialization failed; private logs retained'


def remote(role):
    values = {'bucket_name': s3['bucket'], 'bucket_region': s3['region'],
              'prefix_in_bucket': s3['prefix'] + '/' + role, 'endpoint': s3['endpoint']}
    return '{' + ','.join(key + '=' + json.dumps(value) for key, value in values.items()) + '}'


assert not repo.exists() or os.environ.get('NEON_CONTROLLER_BACKEND_RESUME') == '1', 'Explicit fixture resume required'
config = root / 'init.toml'
config.write_text('''pg_distrib_dir = "/opt/postgres"
neon_distrib_dir = "/usr/local/bin"
default_tenant_id = "30000000000000000000000000000001"
generate_local_ssl_certs = false
control_plane_api = "http://127.0.0.1:1234/upcall/v1/"
[broker]
listen_addr = "127.0.0.1:50051"
[endpoint_storage]
listen_addr = "127.0.0.1:9993"
[[pageservers]]
id = 1
listen_pg_addr = "127.0.0.1:6400"
listen_http_addr = "127.0.0.1:9898"
pg_auth_type = "NeonJWT"
http_auth_type = "NeonJWT"
grpc_auth_type = "NeonJWT"
no_sync = false
virtual_file_io_engine = "std-fs"
page_cache_size = 32768
basebackup_cache_config = {cleanup_period="60s",max_total_size_bytes=67108864,max_size_entries=16,prepare_channel_size=8}
''' + 'remote_storage = ' + remote('pageserver') + '\n' + '\n'.join(f'''[[safekeepers]]
id = {number}
pg_port = {5453 + number}
http_port = {7675 + number}
sync = true
auth_enabled = true
remote_storage = {json.dumps(remote('safekeeper'))}
''' for number in range(1, 4)))
if not repo.exists():
    local('init', '--config', str(config))
elif os.environ.get('NEON_CONTROLLER_BACKEND_RESUME') == '1':
    # The fixture's local metadata PG has no cross-Pod PID namespace identity.
    # A recycled PID can belong to an unrelated process in the replacement Pod.
    # Preserve a stale text lock only after proving no matching postmaster lives.
    metadata = repo / 'storage_controller_db'
    lock = metadata / 'postmaster.pid'
    if lock.exists():
        for process in Path('/proc').glob('[0-9]*'):
            try:
                command = (process / 'cmdline').read_bytes().split(b'\0')
            except (FileNotFoundError, PermissionError):
                continue
            assert not (command and Path(command[0].decode(errors='replace')).name == 'postgres'
                        and str(metadata).encode() in command), 'Live metadata postmaster must not be displaced'
        assert lock.resolve().parent == metadata.resolve()
        lock.rename(metadata / ('postmaster.pid.stale-' + str(time.time_ns())))
local('start', '--start-timeout', '90s')
if (root / 'operator-spec.json').exists():
    spec = json.loads((root / 'operator-spec.json').read_text())
else:
    if not (repo / 'endpoints/operator').exists():
        local('tenant', 'create', '--pg-version', '18', '--set-default',
              '-c', 'basebackup_cache_enabled:true', '-c', 'checkpoint_distance:1048576', '-c', 'checkpoint_timeout:5s')
        local('endpoint', 'create', 'operator', '--branch-name', 'main', '--pg-version', '18',
              '--pg-port', '55432', '--external-http-port', '55433', '--internal-http-port', '55434', '--update-catalog')
    # neon_local materializes compute_ctl's config at start, not at create.
    local('endpoint', 'start', 'operator', '--dev')
    spec = json.loads((repo / 'endpoints/operator/config.json').read_text())['spec']
    local('endpoint', 'stop', 'operator')
settings = {row['name']: row['value'] for row in spec['cluster'].get('settings') or []}
spec['tenant_id'] = spec.get('tenant_id') or settings['neon.tenant_id']
spec['timeline_id'] = spec.get('timeline_id') or settings['neon.timeline_id']
tenant = spec['tenant_id']
# Export only a tenant-scoped storage JWT, never the storage administrator token.
encode = lambda data: base64.urlsafe_b64encode(data).rstrip(b'=')
header = encode(b'{"alg":"EdDSA","typ":"JWT"}')
claims = encode(json.dumps({'scope': 'tenant', 'tenant_id': tenant, 'exp': int(time.time()) + 86400}).encode())
message = header + b'.' + claims
message_file = root / 'claims'
message_file.write_bytes(message)
signature = subprocess.run(['openssl', 'pkeyutl', '-sign', '-rawin', '-inkey',
                            str(repo / 'auth_private_key.pem'), '-in', str(message_file)], capture_output=True, check=True).stdout
spec['storage_auth_token'] = (message + b'.' + encode(signature)).decode()
host = os.environ['STORAGE_SERVICE_HOSTNAME']
spec['pageserver_connection_info'] = None
spec['pageserver_connstring'] = f'host={host} port=6400'
spec['safekeeper_connstrings'] = [f'{host}:{5453 + index}' for index in range(1, 4)]
legacy = {'neon.tenant_id', 'neon.timeline_id', 'neon.pageserver_connstring', 'neon.safekeepers', 'neon.storage_auth_token'}
spec['cluster']['settings'] = [row for row in spec['cluster'].get('settings') or [] if row['name'] not in legacy]
(root / 'operator-spec.json').write_text(json.dumps(spec))


async def forward(reader, writer, port):
    remote_reader, remote_writer = await asyncio.open_connection('127.0.0.1', port)

    async def copy(source, target):
        try:
            while chunk := await source.read(65536):
                target.write(chunk)
                await target.drain()
        finally:
            target.close()
    try:
        await asyncio.gather(copy(reader, remote_writer), copy(remote_reader, writer))
    except (ConnectionError, asyncio.CancelledError):
        pass
    finally:
        remote_writer.close()
        writer.close()


async def main():
    servers = []
    for exposed, native in [(16400, 6400), (15454, 5454), (15455, 5455), (15456, 5456)]:
        servers.append(await asyncio.start_server(lambda r, w, p=native: forward(r, w, p), '0.0.0.0', exposed))
    (root / 'backend-ready.json').write_text(json.dumps({'status': 'PASS', 'tenant': tenant}))
    print('Authenticated S3-backed storage ready for the controller smoke', flush=True)
    while True:
        # Reap orphaned native services; their absence is visible to compute.
        try:
            while os.waitpid(-1, os.WNOHANG)[0]:
                pass
        except ChildProcessError:
            pass
        await asyncio.sleep(1)


signal.signal(signal.SIGTERM, lambda *_: (_ for _ in ()).throw(SystemExit(143)))
asyncio.run(main())
