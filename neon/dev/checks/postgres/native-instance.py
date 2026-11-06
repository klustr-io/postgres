#!/usr/bin/env python3
"""Run integration tests or crash recovery on a new, isolated native cluster.

No existing database path is accepted. Evidence and data are retained on failure.
"""
import os
from pathlib import Path
import secrets
import re
import subprocess
import sys
import tempfile

root = Path(__file__).resolve().parents[4]
build = Path(os.environ.get("BUILD_ROOT", root / "build")) / os.environ.get("BUILD_MODE", "debug")
prefix = Path(os.environ.get("INSTALL_PREFIX", build / "install"))
directory = Path(tempfile.mkdtemp(prefix="qualification-instance-", dir=build))
data = directory / "data"
log = directory / "server.log"
password_file = directory / "password"
password = secrets.token_hex(24)
password_file.write_text(password + "\n")
password_file.chmod(0o600)
port = os.environ.get("QUALIFICATION_PORT", "55419")
environment = {**os.environ, "PGHOST": "127.0.0.1", "PGPORT": port,
               "PGUSER": "qualification", "PGDATABASE": "postgres", "PGPASSWORD": password}
source = Path(os.environ.get("BUILD_SOURCE", root))
environment["PG_EXPECTED_VERSION"] = re.search(r"AC_INIT\(\[PostgreSQL\], \[([^\]]+)\]", (source / "configure.ac").read_text())[1]
def run(program, *args, **kwargs):
    return subprocess.run([str(prefix / "bin" / program), *map(str, args)], env=environment, check=True, **kwargs)

def start():
    preload = os.environ.get("QUALIFICATION_PRELOAD", "")
    preload_options = f" -c shared_preload_libraries={preload}" if preload else ""
    # All clients use authenticated TCP. Avoid Unix socket path limits when the
    # caller chooses a deeply nested build directory.
    run("pg_ctl", "-D", data, "-l", log, "-o", f"-p {port} -c unix_socket_directories= -c listen_addresses=127.0.0.1 -c autovacuum_naptime=1s{preload_options}", "-w", "start")

running = False
code = 1
try:
    run("initdb", "-D", data, "--username=qualification", f"--pwfile={password_file}",
        "--auth-local=peer", "--auth-host=scram-sha-256", "--locale=C.UTF-8")
    password_file.unlink()
    start()
    running = True
    if sys.argv[1] == "integration":
        code = subprocess.call([sys.executable, str(root / "neon/dev/checks/postgres/integration.py")], env=environment)
    elif sys.argv[1] == "crash-recovery":
        run("psql", "-X", "-v", "ON_ERROR_STOP=1", "-c",
            "CREATE TABLE crash_marker(id int PRIMARY KEY); CHECKPOINT;")
        run("psql", "-X", "-v", "ON_ERROR_STOP=1", "-c", "INSERT INTO crash_marker VALUES(42);")
        run("pg_ctl", "-D", data, "-m", "immediate", "-w", "stop")
        running = False
        start()
        running = True
        output = run("psql", "-XAt", "-c", "SELECT id FROM crash_marker", capture_output=True, text=True)
        assert output.stdout.strip() == "42"
        code = 0
    else:
        raise ValueError("Expected integration or crash-recovery")
except (subprocess.CalledProcessError, AssertionError) as error:
    print(f"Validation failure: {error}")
    if log.exists():
        print(log.read_text()[-16000:])
finally:
    if running:
        try:
            run("pg_ctl", "-D", data, "-m", "fast", "-w", "stop")
        except subprocess.CalledProcessError:
            code = 1
    if password_file.exists():
        password_file.unlink()
    print(f"Isolated cluster and server evidence retained in {directory}")
sys.exit(code)
