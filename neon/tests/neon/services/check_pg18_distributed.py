#!/usr/bin/env python3
"""Exercise real PG18 remote storage in a fresh, isolated Neon local environment.

This acceptance test is not a Kubernetes deployment controller or a scale claim.
All state and logs remain in the caller's new qualification volume.
"""
import json
import hashlib
import base64
import os
import re
from pathlib import Path
import subprocess
import sys
import time
import urllib.error
import urllib.request

root = Path('/var/lib/neon')
repo = root / 'cluster'
logs = root / 'acceptance-logs'
logs.mkdir(exist_ok=True)
os.environ.update(NEON_REPO_DIR=str(repo), POSTGRES_DISTRIB_DIR='/opt/postgres')
results = []
s3_config = None
s3_proxy = None
if os.environ.get('NEON_S3_CONFIG'):
    from s3_client import S3Client
    from s3_fault_proxy import S3FaultProxy
    s3_config = json.loads(Path(os.environ['NEON_S3_CONFIG']).read_text())
    assert s3_config['endpoint'].startswith('https://'), 'S3 qualification requires verified upstream TLS'
    os.environ.update(AWS_ACCESS_KEY_ID=s3_config['access_key'],
                      AWS_SECRET_ACCESS_KEY=s3_config['secret_key'], AWS_REGION=s3_config['region'],
                      AWS_EC2_METADATA_DISABLED='true')
    s3_proxy = S3FaultProxy(s3_config)


def passed(name):
    results.append({'name': name, 'status': 'PASS'})
    (root / 'acceptance-results.json').write_text(json.dumps(results, indent=2) + '\n')
    print('PASS ' + name, flush=True)


def local(*args, timeout=120):
    name = '-'.join(args[:2]) + '-' + str(time.time_ns())
    with (logs / (name + '.log')).open('w') as output:
        result = subprocess.run(['neon_local', *args], stdout=output,
                                stderr=subprocess.STDOUT, timeout=timeout)
    assert result.returncode == 0, f'neon_local {args[:2]} failed; inspect {output.name}'


def sql(statement, port=55432, *, input=None, database='postgres'):
    result = subprocess.run(['psql', '-X', '-qAt', '-v', 'ON_ERROR_STOP=1',
                             '-h', '127.0.0.1', '-p', str(port), '-U', 'cloud_admin',
                             '-d', database, '-c', statement], capture_output=True,
                            text=True, input=input, timeout=90)
    if result.returncode:
        (logs / 'sql-failure.log').write_text(result.stderr)
    assert result.returncode == 0, 'SQL failed; inspect sql-failure.log'
    return result.stdout.strip()


def enable_compute_fsync(endpoint):
    # neon_local's developer template uses fsync=off. This qualification uses
    # real synchronous disk writes in the compute as well as storage services.
    with (repo / 'endpoints' / endpoint / 'postgresql.conf').open('a') as output:
        output.write('\nfsync=on\n')


def tenant_token(tenant_id):
    def encoded(data):
        return base64.urlsafe_b64encode(data).rstrip(b'=')
    header = encoded(b'{"alg":"EdDSA","typ":"JWT"}')
    claims = encoded(json.dumps({'scope': 'tenant', 'tenant_id': tenant_id,
                                 'exp': int(time.time()) + 3600}).encode())
    message = header + b'.' + claims
    message_path = root / 'tenant-test-claims'
    message_path.write_bytes(message)
    signed = subprocess.run(['openssl', 'pkeyutl', '-sign', '-rawin',
                             '-inkey', str(repo / 'auth_private_key.pem'), '-in', str(message_path)],
                            capture_output=True, timeout=10)
    assert signed.returncode == 0, 'Unable to sign the tenant-scoped test credential'
    return (message + b'.' + encoded(signed.stdout)).decode()


def storage_api(method, path):
    compute_config = json.loads((repo / 'endpoints/pg18-primary/config.json').read_text())
    token = compute_config['spec']['storage_auth_token']
    request = urllib.request.Request('http://127.0.0.1:9898' + path, method=method,
                                     headers={'Authorization': 'Bearer ' + token})
    with urllib.request.urlopen(request, timeout=120) as response:
        body = response.read()
        return json.loads(body) if body else None


if os.environ.get('NEON_QUALIFICATION_PHASE') == 'verify-replacement':
    assert repo.exists(), 'Replacement Pod must mount the original PVC'
    results = json.loads((root / 'acceptance-results.json').read_text())
    state = json.loads((root / 'acceptance-state.json').read_text())
    try:
        local('start', '--start-timeout', '90s', timeout=180)
        local('endpoint', 'start', 'pg18-primary', '--dev', timeout=180)
        assert sql(state['durable_digest_sql']) == state['durable_digest']
        assert sql(state['bench_digest_sql']) == state['bench_digest']
        passed('Kubernetes Pod replacement with the same PVC preserves committed PG18 data')
        local('endpoint', 'stop', 'pg18-primary')
    finally:
        local('stop')
        if s3_proxy:
            s3_proxy.close()
    sys.exit(0)


def remote_settings(role):
    if not s3_config:
        return ''
    values = {'bucket_name': s3_config['bucket'], 'bucket_region': s3_config['region'],
              'prefix_in_bucket': s3_config['prefix'] + '/' + role, 'endpoint': s3_proxy.endpoint}
    return '{' + ', '.join(key + '=' + json.dumps(value) for key, value in values.items()) + '}'


page_storage = ('remote_storage = ' + remote_settings('pageserver') + '\n') if s3_config else ''
sk_storage = ('remote_storage = ' + json.dumps(remote_settings('safekeeper')) + '\n') if s3_config else ''
tenant_options = ['-c', 'checkpoint_distance:1048576', '-c', 'checkpoint_timeout:5s'] if s3_config else []
assert not repo.exists(), 'Use a new volume for each qualification run'
config = root / 'init.toml'
config.write_text('''pg_distrib_dir = "/opt/postgres"
neon_distrib_dir = "/usr/local/bin"
default_tenant_id = "10000000000000000000000000000001"
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
''' + page_storage + '\n'.join(f'''[[safekeepers]]
id = {index}
pg_port = {5453 + index}
http_port = {7675 + index}
sync = true
auth_enabled = true
''' + sk_storage for index in range(1, 4)))

try:
    local('init', '--config', str(config))
    local('start', '--start-timeout', '90s', timeout=180)
    passed('three synchronous safekeepers and authenticated pageserver startup')
    for port, resource in ((9898, '/v1/tenant'), (7676, '/v1/tenant')):
        try:
            urllib.request.urlopen(f'http://127.0.0.1:{port}{resource}', timeout=5)
        except urllib.error.HTTPError as error:
            assert error.code == 401, (port, error.code)
        else:
            raise AssertionError(f'unauthenticated storage request accepted on {port}')
    passed('storage APIs reject unauthenticated requests')
    local('tenant', 'create', '--tenant-id', '10000000000000000000000000000001',
          '--pg-version', '18', '--set-default', *tenant_options, timeout=180)
    local('endpoint', 'create', 'pg18-primary', '--branch-name', 'main',
          '--pg-version', '18', '--pg-port', '55432', '--external-http-port', '55433',
          '--internal-http-port', '55434', '--update-catalog')
    enable_compute_fsync('pg18-primary')
    local('endpoint', 'start', 'pg18-primary', '--dev', timeout=180)
    assert sql('SHOW server_version').startswith('18.6'), 'Wrong PostgreSQL minor'
    assert sql("SELECT current_setting('neon.pageserver_connstring') <> ''") == 't'
    assert sql('SHOW fsync') == 'on'
    assert sql('SHOW synchronous_commit') == 'on'
    assert sql('SHOW data_checksums') == 'off', 'Inherited Neon storage profile must be explicit'
    assert sql('SHOW ignore_checksum_failure') == 'off'
    sql('CREATE EXTENSION pg_visibility')
    sql("CREATE TABLE durable_rows (id integer PRIMARY KEY, payload text NOT NULL); "
        "INSERT INTO durable_rows SELECT g, md5(g::text) FROM generate_series(1,20000) g; CHECKPOINT")
    sql('CREATE INDEX durable_payload_idx ON durable_rows(payload)')
    sql('VACUUM FREEZE durable_rows')
    sql('CHECKPOINT')
    sql("UPDATE durable_rows SET payload=md5(payload) WHERE id<=100; "
        "DELETE FROM durable_rows WHERE id>19900; "
        "CREATE SEQUENCE durable_sequence; SELECT nextval('durable_sequence'); "
        "CREATE UNLOGGED TABLE local_scratch(id int); INSERT INTO local_scratch VALUES (1); "
        "CREATE TEMP TABLE temporary_scratch AS SELECT generate_series(1,100) AS id; "
        "DO $$ BEGIN IF (SELECT count(*) FROM temporary_scratch) <> 100 THEN "
        "RAISE EXCEPTION 'temporary storage mismatch'; END IF; END $$")
    sql('REINDEX TABLE durable_rows')
    passed('remote index build, vacuum/freeze, update/delete, sequences and local temporary/unlogged storage')
    expected = sql("SELECT count(*)||':'||md5(string_agg(payload, ',' ORDER BY id)) FROM durable_rows")
    payloads = [hashlib.md5(str(index).encode()).hexdigest() for index in range(1, 19901)]
    payloads[:100] = [hashlib.md5(value.encode()).hexdigest() for value in payloads[:100]]
    oracle = '19900:' + hashlib.md5(','.join(payloads).encode()).hexdigest()
    assert expected == oracle, 'Remote SQL result differs from the independent row oracle'
    invalid_vm = sql("SELECT count(*) FROM pg_check_visible('durable_rows')")
    if invalid_vm != '0':
        (logs / 'visibility-failure.json').write_text(sql("SELECT json_agg(v) FROM (SELECT * FROM pg_check_visible('durable_rows') LIMIT 100) v"))
    assert invalid_vm == '0', f'{invalid_vm} invalid visibility-map entries; inspect visibility-failure.json'
    data = Path(sql('SHOW data_directory'))
    relation = data / sql("SELECT pg_relation_filepath('durable_rows')")
    assert not relation.exists() or relation.stat().st_size == 0, 'Permanent heap stored locally'
    passed('PG18.6 writes and reads use remote permanent storage with fsync')
    sql('CREATE TABLE copy_rows(id int PRIMARY KEY, payload text)')
    sql('COPY copy_rows FROM STDIN', input=''.join(f'{index}\tbulk-{index}\n' for index in range(10000)))
    assert sql('SELECT count(*) FROM copy_rows') == '10000'
    passed('remote COPY multi-insert and index maintenance')
    assert sql('SHOW wal_level') == 'logical'
    sql('CREATE TABLE logical_rows(id int PRIMARY KEY, payload text)')
    sql("SELECT slot_name FROM pg_create_logical_replication_slot('pg18_acceptance', 'test_decoding')")
    sql("INSERT INTO logical_rows VALUES (1, 'pg18-remote-logical-decoding')")
    decoded = sql("SELECT string_agg(data, E'\\n') FROM pg_logical_slot_get_changes('pg18_acceptance', NULL, NULL)")
    assert 'pg18-remote-logical-decoding' in decoded
    sql("SELECT pg_drop_replication_slot('pg18_acceptance')")
    passed('logical decoding through remote PG18 WAL and replication slots')
    local('safekeeper', 'stop', '3', '-m', 'immediate')
    sql("INSERT INTO durable_rows VALUES (20001, 'one-safekeeper-down')")
    passed('writes survive loss of one of three safekeepers')
    local('safekeeper', 'stop', '2', '-m', 'immediate')
    pending = subprocess.Popen(['psql', '-X', '-qAt', '-v', 'ON_ERROR_STOP=1', '-h', '127.0.0.1',
                                '-p', '55432', '-U', 'cloud_admin', '-d', 'postgres',
                                '-c', "INSERT INTO durable_rows VALUES (20002, 'quorum-restored')"],
                               stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    time.sleep(5)
    assert pending.poll() is None, 'Write acknowledged without a safekeeper majority'
    local('safekeeper', 'start', '2')
    stdout, stderr = pending.communicate(timeout=90)
    assert pending.returncode == 0, 'Write did not finish after restoring a majority'
    local('safekeeper', 'start', '3')
    passed('quorum loss blocks commit until durable majority returns')
    expected = sql("SELECT count(*)||':'||md5(string_agg(payload, ',' ORDER BY id)) FROM durable_rows")
    local('endpoint', 'stop', 'pg18-primary', '--mode', 'immediate')
    local('endpoint', 'start', 'pg18-primary', '--dev', timeout=180)
    assert sql("SELECT count(*)||':'||md5(string_agg(payload, ',' ORDER BY id)) FROM durable_rows") == expected
    assert sql('SELECT count(*) FROM local_scratch') == '0', 'Unlogged rows survived crash recovery'
    assert sql("SELECT nextval('durable_sequence') > 1") == 't', 'Sequence reused an acknowledged value'
    passed('compute crash and remote reconstruction preserve acknowledged rows')
    local('storage-broker', 'stop', '-m', 'immediate')
    local('storage-broker', 'start')
    local('pageserver', 'stop', '-m', 'immediate')
    local('pageserver', 'start', '--start-timeout', '30s')
    sql("INSERT INTO durable_rows VALUES (30001, 'storage-services-restarted')")
    expected = sql("SELECT count(*)||':'||md5(string_agg(payload, ',' ORDER BY id)) FROM durable_rows")
    passed('broker and pageserver restart resume discovery and WAL ingestion')
    fork_lsn = sql('SELECT pg_current_wal_flush_lsn()')
    local('timeline', 'branch', '--branch-name', 'fork', '--ancestor-branch-name', 'main',
          '--ancestor-start-lsn', fork_lsn)
    local('endpoint', 'create', 'pg18-fork', '--branch-name', 'fork', '--pg-version', '18',
          '--pg-port', '55435', '--external-http-port', '55436', '--internal-http-port', '55437', '--update-catalog')
    enable_compute_fsync('pg18-fork')
    local('endpoint', 'start', 'pg18-fork', '--dev', timeout=180)
    assert sql("SELECT count(*)||':'||md5(string_agg(payload, ',' ORDER BY id)) FROM durable_rows", 55435) == expected
    assert sql("SELECT count(*) FROM pg_check_visible('durable_rows')", 55435) == '0'
    sql("INSERT INTO durable_rows VALUES (30000, 'branch-only')", 55435)
    assert sql('SELECT count(*) FROM durable_rows WHERE id=30000') == '0'
    passed('PG18 branch reconstruction and write isolation')
    local('endpoint', 'stop', 'pg18-fork')
    sql('CREATE DATABASE restore_check')
    dump = logs / 'durable-rows.dump'
    connection = ['-h', '127.0.0.1', '-p', '55432', '-U', 'cloud_admin']
    for name, command in [
        ('pg-dump', ['pg_dump', '--format=custom', '--table=public.durable_rows',
                     '--no-owner', '--no-privileges', '--file', str(dump), *connection, 'postgres']),
        ('pg-restore', ['pg_restore', '--exit-on-error', '--no-owner', '--no-privileges',
                        '--dbname=restore_check', *connection, str(dump)]),
    ]:
        backup = subprocess.run(command, capture_output=True, text=True, timeout=120)
        (logs / (name + '.log')).write_text(backup.stdout + backup.stderr)
        assert backup.returncode == 0, f'{name} failed; inspect its log'
    assert sql("SELECT count(*)||':'||md5(string_agg(payload, ',' ORDER BY id)) FROM durable_rows",
               database='restore_check') == expected
    sql('DROP DATABASE restore_check')
    passed('remote CREATE/DROP DATABASE and logical backup/restore preserve the independent row digest')
    second_tenant = '20000000000000000000000000000002'
    local('tenant', 'create', '--tenant-id', second_tenant, '--pg-version', '18', *tenant_options, timeout=180)
    local('endpoint', 'create', 'pg18-other-tenant', '--tenant-id', second_tenant,
          '--branch-name', 'main', '--pg-version', '18', '--pg-port', '55438',
          '--external-http-port', '55439', '--internal-http-port', '55440', '--update-catalog')
    enable_compute_fsync('pg18-other-tenant')
    local('endpoint', 'start', 'pg18-other-tenant', '--dev', timeout=180)
    assert sql("SELECT to_regclass('public.durable_rows') IS NULL", 55438) == 't'
    sql('CREATE TABLE other_tenant_rows AS SELECT generate_series(1,20) AS id', 55438)
    assert sql("SELECT to_regclass('public.other_tenant_rows') IS NULL") == 't'
    passed('separate PG18 tenants have isolated catalogs and data')
    # neon_local uses a management credential for local computes. Generate a
    # genuinely tenant-scoped token instead of mistaking that for tenant auth.
    token = tenant_token('10000000000000000000000000000001')
    # Exercise actual signed tenant credentials. Never print tokens or config.
    for resource, expected_status in [
        ('/v1/tenant/10000000000000000000000000000001/timeline', 200),
        (f'/v1/tenant/{second_tenant}/timeline', 403), ('/v1/tenant', 403),
    ]:
        request = urllib.request.Request('http://127.0.0.1:9898' + resource,
                                         headers={'Authorization': 'Bearer ' + token})
        try:
            with urllib.request.urlopen(request, timeout=10) as response:
                status = response.status
        except urllib.error.HTTPError as error:
            status = error.code
            error.close()
        assert status == expected_status, f'Tenant authorization returned {status}, expected {expected_status}'
    token_parts = token.split('.')
    token_parts[2] = ('A' if token_parts[2][0] != 'A' else 'B') + token_parts[2][1:]
    request = urllib.request.Request('http://127.0.0.1:9898/v1/tenant/10000000000000000000000000000001/timeline',
                                     headers={'Authorization': 'Bearer ' + '.'.join(token_parts)})
    try:
        urllib.request.urlopen(request, timeout=10)
    except urllib.error.HTTPError as error:
        # AuthError maps to 403 in this API. Test an own-tenant resource that
        # returned 200 above so scope denial cannot mask signature acceptance.
        assert error.code == 403, 'Invalid signature did not fail authentication'
        error.close()
    else:
        raise AssertionError('Invalid JWT signature accepted')
    passed('tenant JWT rejects cross-tenant and management access; invalid signatures fail authentication')
    local('endpoint', 'stop', 'pg18-other-tenant')
    bench_connection = ['-h', '127.0.0.1', '-p', '55432', '-U', 'cloud_admin', 'postgres']
    initialized = subprocess.run(['pgbench', '--initialize', '--scale=1', *bench_connection],
                                 capture_output=True, text=True, timeout=120)
    (logs / 'pgbench-init.log').write_text(initialized.stdout + initialized.stderr)
    assert initialized.returncode == 0, 'Remote pgbench initialization failed'
    workload = subprocess.run(['pgbench', '-c', '8', '-j', '4', '-T', '60', '-P', '10',
                               '--protocol=prepared', *bench_connection],
                              capture_output=True, text=True, timeout=120)
    (logs / 'pgbench.log').write_text(workload.stdout + workload.stderr)
    assert workload.returncode == 0, 'Remote pgbench workload failed'
    failures = re.search(r'number of failed transactions:\s*(\d+)', workload.stdout)
    processed = re.search(r'number of transactions actually processed:\s*(\d+)', workload.stdout)
    tps = re.search(r'tps = ([0-9.]+)', workload.stdout)
    assert failures and int(failures[1]) == 0, 'Remote pgbench reported transaction failures'
    assert processed and int(processed[1]) > 0, 'Remote pgbench did not process transactions'
    totals = [sql(f'SELECT sum({column}) FROM {table}') for table, column in
              [('pgbench_accounts', 'abalance'), ('pgbench_tellers', 'tbalance'),
               ('pgbench_branches', 'bbalance'), ('pgbench_history', 'delta')]]
    assert len(set(totals)) == 1, 'Remote pgbench accounting invariant failed'
    bench_digest_sql = "SELECT md5(string_agg(aid||':'||abalance, ',' ORDER BY aid)) FROM pgbench_accounts"
    bench_digest = sql(bench_digest_sql)
    (logs / 'pgbench-summary.json').write_text(json.dumps({'duration_seconds': 60, 'clients': 8,
        'scale': 1, 'transactions': int(processed[1]), 'failed_transactions': 0,
        'tps': float(tps[1]) if tps else None, 'profile': 'local-loopback-three-safekeepers-fsync-on'}, indent=2))
    passed('60-second concurrent remote pgbench workload and accounting invariants')
    local('endpoint', 'stop', 'pg18-primary')
    local('stop')
    local('start', '--start-timeout', '90s', timeout=180)
    local('endpoint', 'start', 'pg18-primary', '--dev', timeout=180)
    assert sql("SELECT count(*)||':'||md5(string_agg(payload, ',' ORDER BY id)) FROM durable_rows") == expected
    assert sql(bench_digest_sql) == bench_digest
    local('endpoint', 'start', 'pg18-other-tenant', '--dev', timeout=180)
    assert sql('SELECT count(*)||\':\'||sum(id) FROM other_tenant_rows', 55438) == '20:210'
    local('endpoint', 'stop', 'pg18-other-tenant')
    passed('full storage stack restart preserves committed data')
    if s3_config:
        sql('SELECT pg_switch_wal(); CHECKPOINT')
        local('endpoint', 'stop', 'pg18-primary')
        local('pageserver', 'stop')
        client = S3Client(s3_config)
        deadline = time.monotonic() + 180
        while True:
            layers = client.objects(s3_config['prefix'] + '/pageserver/')
            wal = client.objects(s3_config['prefix'] + '/safekeeper/')
            if layers and any(item['size'] >= 16 * 1024 * 1024 for item in wal):
                break
            assert time.monotonic() < deadline, 'S3 layer upload or full-segment WAL offload did not complete'
            time.sleep(2)
        passed('verified TLS S3 contains actual pageserver layers and full safekeeper WAL segments')
        local('pageserver', 'start', '--start-timeout', '90s')
        local('endpoint', 'start', 'pg18-primary', '--dev', timeout=180)
        compute_config = json.loads((repo / 'endpoints/pg18-primary/config.json').read_text())
        timeline_id = compute_config['spec']['timeline_id']
        layer_path = f'/v1/tenant/10000000000000000000000000000001/timeline/{timeline_id}/layer'
        evicted = 0
        for layer in storage_api('GET', layer_path)['historic_layers']:
            if not layer['remote']:
                try:
                    storage_api('DELETE', layer_path + '/' + layer['layer_file_name'])
                    evicted += 1
                except urllib.error.HTTPError as error:
                    if error.code not in (304, 404):
                        raise
                    error.close()
        assert evicted > 0, 'No uploaded resident layer was evicted'
        local('pageserver', 'stop')
        local('pageserver', 'start', '--start-timeout', '90s')
        assert any(layer['remote'] for layer in storage_api('GET', layer_path)['historic_layers'])
        downloaded_before = s3_proxy.counts['upstream_get_bytes']
        s3_proxy.outage.set()
        pending = subprocess.Popen(['psql', '-X', '-qAt', '-v', 'ON_ERROR_STOP=1',
                                    *bench_connection[:-1], '-d', 'postgres', '-c', bench_digest_sql],
                                   stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
        time.sleep(3)
        assert pending.poll() is None, 'Cold read did not wait through the injected S3 outage'
        assert s3_proxy.counts['injected_503'] > 0, 'No actual S3 request encountered the outage'
        s3_proxy.outage.clear()
        output, errors = pending.communicate(timeout=120)
        assert pending.returncode == 0 and output.strip() == bench_digest, 'S3 cold reconstruction did not recover correctly'
        assert s3_proxy.counts['upstream_get_bytes'] > downloaded_before, 'Cold recovery did not download S3 layer data'
        assert sql("SELECT count(*)||':'||md5(string_agg(payload, ',' ORDER BY id)) FROM durable_rows") == expected
        passed('evicted-layer cold reads wait through S3 503s and recover the committed dataset')
        (root / 's3-acceptance.json').write_text(json.dumps({'status': 'PASS', 'prefix': s3_config['prefix'],
            'upstream_tls_verified': True, 'pageserver_objects': len(layers), 'wal_objects': len(wal),
            'evicted_layers': evicted, 'proxy_counts': dict(s3_proxy.counts)}, indent=2))
    (root / 'acceptance-state.json').write_text(json.dumps({
        'durable_digest_sql': "SELECT count(*)||':'||md5(string_agg(payload, ',' ORDER BY id)) FROM durable_rows",
        'durable_digest': expected, 'bench_digest_sql': bench_digest_sql, 'bench_digest': bench_digest}, indent=2))
    local('endpoint', 'stop', 'pg18-primary')
finally:
    # Keep the complete test volume, including any failure evidence.
    subprocess.run(['neon_local', 'stop'], stdout=(logs / 'cleanup.log').open('w'),
                   stderr=subprocess.STDOUT, timeout=120)
    if s3_proxy:
        s3_proxy.close()
