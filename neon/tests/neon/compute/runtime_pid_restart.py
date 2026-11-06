"""Small isolated runtime restart check; no throughput, S3 or durability claim."""
import hashlib
import json
import os
from pathlib import Path
import subprocess
import sys
import time

root = Path('/var/lib/neon/pid-restart')
root.mkdir()
os.environ.update(NEON_REPO_DIR=str(root / 'neon'), POSTGRES_DISTRIB_DIR='/opt/postgres',
                  NEON_DISTRIB_DIR='/usr/local/bin', RUST_BACKTRACE='1')
config = root / 'init.toml'
config.write_text('''pg_distrib_dir = "/opt/postgres"
neon_distrib_dir = "/usr/local/bin"
default_tenant_id = "20000000000000000000000000000001"
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
page_cache_size = 8192
''' + ''.join(f'''[[safekeepers]]
id = {i}
pg_port = {5453 + i}
http_port = {7675 + i}
sync = true
auth_enabled = true
''' for i in range(1, 4)))


def local(*args, require=True):
    result = subprocess.run(['neon_local', *args], capture_output=True, text=True, timeout=150)
    if require and result.returncode:
        raise AssertionError(f'Runtime command {args[:2]} failed: {result.stdout[-4000:]} {result.stderr[-4000:]}')
    return result


def owner(path):
    content = path.read_text().strip()
    assert content.isdecimal() and int(content) > 1, 'Invalid live PID file'
    os.kill(int(content), 0)
    return content


result = {'status': 'RUNNING', 'restarts': [], 'storage': 'New disposable tmpfs only; no remote storage',
          'claims': 'Runtime PID/restart behavior only; not performance, durable recovery or production qualification'}
local('init', '--config', str(config))
try:
    for cycle in range(1, 6):
        started = time.monotonic()
        local('start', '--start-timeout', '90s')
        path = root / 'neon/pageserver_1/pageserver.pid'
        pid = owner(path)
        # Run the actual live pageserver command as a rejected contender. Its
        # process must not erase or replace the original owner's PID file.
        args = Path(f'/proc/{pid}/cmdline').read_bytes().rstrip(b'\0').split(b'\0')
        command = [part.decode() for part in args]
        assert Path(command[0]).name == 'pageserver'
        duplicate = subprocess.run(command, capture_output=True, timeout=30)
        assert duplicate.returncode != 0, 'Duplicate pageserver unexpectedly acquired ownership'
        assert owner(path) == pid, 'Rejected contender changed the live owner PID'
        result['restarts'].append({'cycle': cycle, 'start_seconds': time.monotonic() - started,
            'duplicate_exit_code': duplicate.returncode, 'live_owner_preserved': True,
            'pid_content_sha256': hashlib.sha256(path.read_bytes()).hexdigest()})
        local('stop')
        print(f'Completed isolated runtime restart and rejected duplicate {cycle}/5', file=sys.stderr, flush=True)
    result['status'] = 'PASS'
finally:
    local('stop', require=False)
print(json.dumps(result))
