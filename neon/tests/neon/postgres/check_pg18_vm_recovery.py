#!/usr/bin/env python3
"""Prove PG18.6 Neon VM full-page images repair damaged disposable VM files.

Runs both core and extension rmgr handlers. Each scenario writes only a newly
created test cluster and retains its evidence, including pre-damage VM files.
"""
import os
from pathlib import Path
import secrets
import subprocess
import tempfile

build = Path(os.environ['BUILD_ROOT']) / os.environ.get('BUILD_MODE', 'debug')
prefix = Path(os.environ.get('INSTALL_PREFIX', build / 'install'))
directory = Path(tempfile.mkdtemp(prefix='neon-vm-recovery-', dir=build))
tables = ['vm_insert', 'vm_delete', 'vm_update', 'vm_cross', 'vm_lock', 'vm_multi']

for handler in ('core', 'extension'):
    case = directory / handler
    case.mkdir()
    data = case / 'data'
    log = case / 'server.log'
    password_file = case / 'password'
    password = secrets.token_hex(24)
    password_file.write_text(password + '\n')
    password_file.chmod(0o600)
    port = os.environ.get('QUALIFICATION_PORT', '55449')
    environment = {**os.environ, 'PGHOST': '127.0.0.1', 'PGPORT': port,
                   'PGUSER': 'qualification', 'PGDATABASE': 'postgres', 'PGPASSWORD': password}

    def run(program, *arguments, **kwargs):
        return subprocess.run([str(prefix / 'bin' / program), *map(str, arguments)],
                              env=environment, check=True, timeout=90, **kwargs)

    def sql(statement, capture=False):
        result = run('psql', '-XAt', '-v', 'ON_ERROR_STOP=1', '-c', statement,
                     capture_output=capture, text=True)
        return result.stdout.strip() if capture else None

    def start():
        extra = os.environ.get('EXTRA_PRELOAD', '')
        assert extra in ('', 'neon')
        libraries = ([extra] if extra else []) + (['neon_rmgr'] if handler == 'extension' else [])
        preload = f" -c shared_preload_libraries={','.join(libraries)}" if libraries else ''
        run('pg_ctl', '-D', data, '-l', log, '-w', '-o',
            f'-p {port} -c unix_socket_directories= -c listen_addresses=127.0.0.1 '
            f'-c autovacuum=off{preload}', 'start')

    def digest(table):
        return sql(f"SELECT count(*) || ':' || md5(string_agg(id || ':' || md5(pad), ',' ORDER BY id)) FROM {table}", True)

    running = False
    try:
        run('initdb', '-D', data, '--username=qualification', f'--pwfile={password_file}',
            '--auth-local=peer', '--auth-host=scram-sha-256', '--locale=C.UTF-8', '--data-checksums')
        password_file.unlink()
        start()
        running = True
        assert int(sql('SHOW server_version_num', True)) >= 180006
        if os.environ.get('EXTRA_PRELOAD') == 'neon':
            sql('CREATE EXTENSION neon;')
        sql('CREATE EXTENSION pg_visibility; CREATE EXTENSION pg_walinspect;')
        for table in tables:
            sql(f"CREATE TABLE {table}(id int PRIMARY KEY, pad text) WITH(fillfactor=50); "
                f"ALTER TABLE {table} ALTER COLUMN pad SET STORAGE PLAIN; "
                f"INSERT INTO {table} SELECT n, repeat('a',100) FROM generate_series(1,500) n;")
            sql(f'VACUUM FREEZE {table}')
        sql('CHECKPOINT')
        begin_lsn = sql('SELECT pg_current_wal_insert_lsn()', True)
        sql("INSERT INTO vm_insert VALUES(501,repeat('b',100));")
        sql('DELETE FROM vm_delete WHERE id=1;')
        sql("UPDATE vm_update SET pad=repeat('c',100) WHERE id=1;")
        sql("UPDATE vm_cross SET id=id+10000, pad=repeat('d',1600) WHERE id<=50;")
        sql('SELECT id FROM vm_lock WHERE id=1 FOR UPDATE;')
        run('psql', '-X', '-v', 'ON_ERROR_STOP=1', '-c', 'COPY vm_multi FROM STDIN',
            input=''.join(f"{number}\t{'e' * 100}\n" for number in range(501, 551)), text=True)
        end_lsn = sql('SELECT pg_current_wal_flush_lsn()', True)
        expected = {table: digest(table) for table in tables}
        files = {}
        for table in tables:
            images = int(sql(f"SELECT count(*) FROM pg_get_wal_block_info('{begin_lsn}', '{end_lsn}', false) "
                f"WHERE resource_manager='neon' AND relfilenode=pg_relation_filenode('{table}') "
                'AND relforknumber=2 AND block_fpi_length>0', True))
            assert images > 0, (handler, table, 'no actual VM full-page image was generated')
            files[table] = sql(f"SELECT pg_relation_filepath('{table}')", True) + '_vm'
        run('pg_ctl', '-D', data, '-m', 'immediate', '-w', 'stop')
        running = False
        for table, relative in files.items():
            target = (data / relative).resolve()
            assert target.is_relative_to(data.resolve()) and target.name.endswith('_vm')
            original = target.read_bytes()
            assert len(original) >= 8192
            (case / f'{table}.vm-before-damage').write_bytes(original)
            with target.open('r+b') as output:
                output.write(b'\x7f' * 8192)
        start()
        running = True
        for table in tables:
            assert digest(table) == expected[table], (handler, table, 'committed rows changed')
            assert sql(f"SELECT count(*) FROM pg_check_visible('{table}')", True) == '0', (handler, table)
            assert sql(f"SELECT count(*) FROM pg_check_frozen('{table}')", True) == '0', (handler, table)
            print(f'PASS {handler} rmgr: VM FPI repair, rows and visibility for {table}', flush=True)
    except Exception:
        if log.exists():
            print(log.read_text()[-16000:])
        raise
    finally:
        if running:
            run('pg_ctl', '-D', data, '-m', 'fast', '-w', 'stop')
        password_file.unlink(missing_ok=True)
        print(f'Retained disposable recovery evidence: {case}', flush=True)
print('PASS: 12 committed-data/VM recovery scenarios using actual Neon WAL and damaged test files')
