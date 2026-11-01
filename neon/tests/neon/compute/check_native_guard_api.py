"""Default-off compatibility and SQL API privilege checks on a real PG18 server."""
import json
from pathlib import Path
import subprocess
import time

bin_dir = '/opt/postgres/v18/bin/'
root = Path('/tmp/native-guard-api-qualification')
root.mkdir()
data = root/'pgdata'
def command(args, check=True):
    child = subprocess.run(args, text=True, capture_output=True, timeout=60)
    if check:
        assert child.returncode == 0, child.stderr
    return child
headers=command([bin_dir+'pg_config','--includedir-server']).stdout.strip()
includes=command([bin_dir+'pg_config','--includedir']).stdout.strip()
command(['cc','-O2','-D_GNU_SOURCE','-I'+headers,'-I'+includes,'-I'+includes+'/internal','-I/guard-inputs','-I/source/pgxn/neon',
         '/guard-inputs/guard_wal_boundary_unit.c','-o',str(root/'guard-wal-boundary-unit')])
command([str(root/'guard-wal-boundary-unit')])
command([bin_dir+'initdb','-D',str(data),'-U','guard_admin','-A','trust','--no-data-checksums','--locale=C.UTF-8'])
with (data/'postgresql.conf').open('a') as config:
    config.write("\nlisten_addresses='127.0.0.1'\nport=55439\nshared_preload_libraries='neon'\n")
checks = ['WAL page/segment end normalization at every page for 1 MiB, 16 MiB and 1 GiB segments',
          'Live quorum requires election and majorities of both joint-membership sets']
def sql(text, check=True):
    return command([bin_dir+'psql','-XqAt','-v','ON_ERROR_STOP=1','-h','127.0.0.1','-p','55439',
                    '-U','guard_admin','-d','postgres','-c',text],check)
command([bin_dir+'pg_ctl','-D',str(data),'-l',str(root/'postgres.log'),'-w','start'])
try:
    sql('CREATE SCHEMA neon; CREATE EXTENSION neon WITH SCHEMA neon')
    assert sql("SELECT extversion FROM pg_extension WHERE extname='neon'").stdout.strip() == '1.7'
    status = json.loads(sql('SELECT neon.bounded_commit_guard_status()').stdout)
    assert not status['enabled']
    sql('CREATE TABLE default_off_probe(id int); INSERT INTO default_off_probe VALUES(1)')
    assert sql('SELECT count(*) FROM default_off_probe').stdout.strip() == '1'
    checks.append('Default-off local PostgreSQL commits and extension 1.7 install')
    denied = sql('SET neon.bounded_async_commit=on',False)
    assert denied.returncode != 0 and 'cannot be changed without restarting' in denied.stderr
    checks.append('Session cannot turn the postmaster policy on or off')
    sql('CREATE ROLE native_guard_reader; GRANT USAGE ON SCHEMA neon TO native_guard_reader')
    for name in ['bounded_commit_guard_status','bounded_commit_guard_drain']:
        denied = sql('SET ROLE native_guard_reader; SELECT neon.'+name+'()',False)
        assert denied.returncode != 0 and 'permission denied' in denied.stderr
        sql('GRANT EXECUTE ON FUNCTION neon.'+name+'() TO native_guard_reader')
        denied = sql('SET ROLE native_guard_reader; SELECT neon.'+name+'()',False)
        assert denied.returncode != 0 and 'superuser required' in denied.stderr
        sql('REVOKE EXECUTE ON FUNCTION neon.'+name+'() FROM native_guard_reader')
    checks.append('SQL ACLs and C runtime checks both reject unprivileged status/drain calls')
    denied = sql('SELECT neon.bounded_commit_guard_drain()',False)
    assert denied.returncode != 0 and 'guard is disabled' in denied.stderr
    assert sql('SELECT 1').stdout.strip() == '1'
    checks.append('Disabled drain returns an error without crashing the server')
finally:
    command([bin_dir+'pg_ctl','-D',str(data),'-m','fast','-w','stop'])
report = {'status':'PASS','checks':checks,'scope':'Local default-off API/privileges; not a replication/RPO test',
          'postgresql_version':command([bin_dir+'postgres','--version']).stdout.strip()}
Path('/tmp/native-commit-guard-api.json').write_text(json.dumps(report,indent=2)+'\n')
print(json.dumps(report))
