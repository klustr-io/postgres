#!/usr/bin/env python3
"""Execute the PG18 non-file AIO adapter through real SQL and buffer callbacks.

Tests use fresh disk-backed clusters; they do not qualify Neon's remote storage.
"""
import os
from pathlib import Path
import secrets
import subprocess
import tempfile

build = Path(os.environ['BUILD_ROOT']) / os.environ.get('BUILD_MODE', 'debug')
prefix = Path(os.environ.get('INSTALL_PREFIX', build / 'install'))
directory = Path(tempfile.mkdtemp(prefix='neon-aio-probe-', dir=build))
library = directory / 'pg18_aio_probe.so'
server_include = subprocess.check_output([str(prefix / 'bin/pg_config'), '--includedir-server'], text=True).strip()
internal_include = Path(server_include).parent / 'internal'
subprocess.run(['cc', '-shared', '-fPIC', '-Wall', '-Wextra', '-Werror=implicit-function-declaration',
                f'-I{server_include}', f'-I{internal_include}',
                str(Path(__file__).with_name('pg18_aio_probe.c')), '-o', str(library)], check=True)

for method in ('sync', 'worker'):
    data = directory / method
    logfile = directory / f'{method}.log'
    password_file = directory / f'{method}.password'
    password = secrets.token_hex(24)
    password_file.write_text(password + '\n')
    password_file.chmod(0o600)
    port = str(int(os.environ.get('QUALIFICATION_PORT', '55429')))
    environment = {**os.environ, 'PGHOST': '127.0.0.1', 'PGPORT': port,
                   'PGUSER': 'qualification', 'PGDATABASE': 'postgres', 'PGPASSWORD': password}

    def run(program, *arguments):
        return subprocess.run([str(prefix / 'bin' / program), *map(str, arguments)],
                              env=environment, check=True, timeout=60)

    def sql(statement):
        run('psql', '-X', '-v', 'ON_ERROR_STOP=1', '-c', statement)

    def start():
        run('pg_ctl', '-D', data, '-l', logfile, '-w', '-o',
            f'-p {port} -c unix_socket_directories= -c listen_addresses=127.0.0.1 '
            f'-c shared_preload_libraries={library} -c io_method={method} -c autovacuum=off', 'start')

    running = False
    try:
        run('initdb', '-D', data, '--username=qualification', f'--pwfile={password_file}',
            '--auth-local=peer', '--auth-host=scram-sha-256', '--locale=C.UTF-8', '--data-checksums')
        password_file.unlink()
        start()
        running = True
        sql(f"""
            CREATE FUNCTION test_neon_aio_calls() RETURNS integer AS '{library}',
                'test_neon_aio_calls' LANGUAGE C;
            CREATE FUNCTION test_neon_smgr_conflict() RETURNS integer AS '{library}',
                'test_neon_smgr_conflict' LANGUAGE C;
            CREATE TABLE aio_fixture AS SELECT n, repeat(md5(n::text), 32) AS payload
                FROM generate_series(1, 4096) AS n;
            CHECKPOINT;
        """)
        for scenario in ('read_error', 'corrupt_page', 'normal'):
            # Clear shared buffers so every scenario actually enters the adapter.
            run('pg_ctl', '-D', data, '-m', 'fast', '-w', 'stop')
            running = False
            start()
            running = True
            injection = ''
            if scenario == 'read_error':
                injection = """DO $$ BEGIN
                    SET test_neon_aio.fail_read = on;
                    BEGIN
                        PERFORM sum(n) FROM aio_fixture;
                        RAISE EXCEPTION 'expected injected read error';
                    EXCEPTION WHEN io_error THEN
                        IF SQLERRM <> 'injected non-file read failure' THEN RAISE; END IF;
                    END;
                    SET test_neon_aio.fail_read = off;
                END $$;"""
            elif scenario == 'corrupt_page':
                injection = """DO $$ BEGIN
                    SET test_neon_aio.corrupt_read = on;
                    BEGIN
                        PERFORM sum(n) FROM aio_fixture;
                        RAISE EXCEPTION 'expected page validation error';
                    EXCEPTION WHEN data_corrupted THEN NULL;
                    END;
                    SET test_neon_aio.corrupt_read = off;
                END $$;"""
            sql(injection + """
                SET enable_indexscan = off;
                DO $$ BEGIN
                    IF (SELECT sum(n) FROM aio_fixture) <> 8390656 THEN
                        RAISE EXCEPTION 'fixture sum mismatch';
                    END IF;
                    IF (SELECT sum(length(payload)) FROM aio_fixture) <> 4194304 THEN
                        RAISE EXCEPTION 'fixture payload mismatch';
                    END IF;
                    IF test_neon_aio_calls() <= 0 THEN
                        RAISE EXCEPTION 'non-file AIO callback was not executed';
                    END IF;
                    BEGIN
                        PERFORM test_neon_smgr_conflict();
                        RAISE EXCEPTION 'conflicting storage manager was accepted';
                    EXCEPTION WHEN invalid_object_definition THEN NULL;
                    END;
                END $$;
                CREATE TEMP TABLE aio_temp AS SELECT * FROM aio_fixture;
                CREATE UNLOGGED TABLE aio_unlogged AS SELECT * FROM aio_fixture;
                SELECT count(*) FROM aio_temp;
                DROP TABLE aio_unlogged;
                CHECKPOINT;
            """)
            print(f'PASS io_method={method}: {scenario}, subsequent reads and registration conflict', flush=True)
    except Exception:
        if logfile.exists():
            print(logfile.read_text()[-12000:])
        raise
    finally:
        if running:
            run('pg_ctl', '-D', data, '-m', 'fast', '-w', 'stop')
        password_file.unlink(missing_ok=True)
        print(f'Cluster and evidence retained: {data}', flush=True)
print('PASS: six real-buffer AIO scenarios, page verification and error cleanup in both IO methods')
