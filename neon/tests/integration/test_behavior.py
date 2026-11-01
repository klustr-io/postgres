"""Behavioral tests against a running fork server; each test owns a schema."""
from concurrent.futures import ThreadPoolExecutor
import os
import socket
import threading
import time
import uuid

import psycopg
from psycopg import errors, sql
import pytest


def connect(**kwargs):
    return psycopg.connect(connect_timeout=5, **kwargs)


@pytest.fixture
def db():
    schema = "qual_" + uuid.uuid4().hex
    with connect(autocommit=True) as admin:
        admin.execute(sql.SQL("CREATE SCHEMA {}").format(sql.Identifier(schema)))
        admin.execute(sql.SQL("SET search_path TO {},public").format(sql.Identifier(schema)))
        yield admin, schema
        admin.execute(sql.SQL("DROP SCHEMA {} CASCADE").format(sql.Identifier(schema)))


def session(schema, **kwargs):
    connection = connect(**kwargs)
    connection.execute(sql.SQL("SET search_path TO {},public").format(sql.Identifier(schema)))
    if not connection.autocommit:
        connection.commit()
    return connection


def test_provenance(db):
    c, _ = db
    expected = os.environ.get("PG_EXPECTED_VERSION", "18.2")
    major, minor = map(int, expected.split("."))
    assert c.execute("SHOW server_version_num").fetchone()[0] == str(major*10000+minor)
    assert f"PostgreSQL {expected}" in c.execute("SELECT version()").fetchone()[0]
    assert c.execute("SELECT pg_is_in_recovery()").fetchone() == (False,)
    assert c.execute("SELECT count(*) FROM pg_get_wal_resource_managers() WHERE rm_id=134 AND rm_name='neon'").fetchone() == (1,)


def test_commit_rollback_savepoint(db):
    c, schema = db
    c.execute("CREATE TABLE tx (id int PRIMARY KEY)")
    with session(schema) as tx:
        tx.execute("INSERT INTO tx VALUES (1)")
    with session(schema) as tx:
        tx.execute("INSERT INTO tx VALUES (2)")
        tx.rollback()
    with session(schema) as tx:
        tx.execute("INSERT INTO tx VALUES (3)")
        tx.execute("SAVEPOINT here")
        tx.execute("INSERT INTO tx VALUES (4)")
        tx.execute("ROLLBACK TO here")
    assert c.execute("SELECT array_agg(id ORDER BY id) FROM tx").fetchone()[0] == [1, 3]


@pytest.mark.parametrize("level", ["READ COMMITTED", "REPEATABLE READ", "SERIALIZABLE"])
def test_isolation_levels(db, level):
    c, schema = db
    c.execute("CREATE TABLE levels (v int)")
    c.execute("INSERT INTO levels VALUES (0)")
    with session(schema) as tx:
        tx.execute(sql.SQL("SET TRANSACTION ISOLATION LEVEL " + level))
        assert tx.execute("SELECT v FROM levels").fetchone() == (0,)
        c.execute("UPDATE levels SET v=1")
        expected = 1 if level == "READ COMMITTED" else 0
        assert tx.execute("SELECT v FROM levels").fetchone() == (expected,)


def test_serialization_conflict(db):
    c, schema = db
    c.execute("CREATE TABLE serial (v int)")
    c.execute("INSERT INTO serial VALUES (0)")
    with session(schema) as a, session(schema) as b:
        for tx in (a, b):
            tx.execute("SET TRANSACTION ISOLATION LEVEL SERIALIZABLE")
            tx.execute("SELECT v FROM serial").fetchone()
        a.execute("UPDATE serial SET v=1")
        a.commit()
        with pytest.raises(errors.SerializationFailure):
            b.execute("UPDATE serial SET v=2")
        b.rollback()
    assert c.execute("SELECT v FROM serial").fetchone() == (1,)


def test_concurrent_updates(db):
    c, schema = db
    c.execute("CREATE TABLE counter (v int)")
    c.execute("INSERT INTO counter VALUES (0)")
    def increment(_):
        with session(schema, autocommit=True) as tx:
            for _ in range(25):
                tx.execute("UPDATE counter SET v=v+1")
    with ThreadPoolExecutor(max_workers=8) as pool:
        list(pool.map(increment, range(8)))
    assert c.execute("SELECT v FROM counter").fetchone() == (200,)


def test_deadlock_and_recovery(db):
    c, schema = db
    c.execute("CREATE TABLE locks (id int PRIMARY KEY,v int)")
    c.execute("INSERT INTO locks VALUES (1,0),(2,0)")
    barrier = threading.Barrier(2)
    def worker(first):
        with session(schema) as tx:
            tx.execute("SET deadlock_timeout='100ms'")
            tx.execute("UPDATE locks SET v=v+1 WHERE id=%s", (first,))
            barrier.wait(timeout=5)
            try:
                tx.execute("UPDATE locks SET v=v+1 WHERE id=%s", (3-first,))
                tx.commit()
                return "committed"
            except errors.DeadlockDetected:
                tx.rollback()
                assert tx.execute("SELECT 1").fetchone() == (1,)
                return "deadlock"
    with ThreadPoolExecutor(max_workers=2) as pool:
        assert sorted(pool.map(worker, [1, 2])) == ["committed", "deadlock"]
    assert c.execute("SELECT v FROM locks ORDER BY id").fetchall() == [(1,), (1,)]


def test_constraints_indexes_foreign_keys(db):
    c, _ = db
    c.execute("CREATE TABLE parent (id int PRIMARY KEY, value int UNIQUE CHECK(value>0))")
    c.execute("CREATE TABLE child (id int REFERENCES parent(id))")
    c.execute("INSERT INTO parent VALUES (1,10)")
    c.execute("INSERT INTO child VALUES (1)")
    for statement, exception in [
        ("INSERT INTO parent VALUES (1,20)", errors.UniqueViolation),
        ("INSERT INTO parent VALUES (2,-1)", errors.CheckViolation),
        ("INSERT INTO child VALUES (999)", errors.ForeignKeyViolation),
    ]:
        with pytest.raises(exception):
            c.execute(statement)


def test_json_arrays_cte_windows_prepared_temp(db):
    c, _ = db
    assert c.execute("SELECT '{\"a\": [1,2]}'::jsonb @> '{\"a\": [2]}'::jsonb").fetchone() == (True,)
    assert c.execute("SELECT ARRAY[1,2,3] && ARRAY[3,4]").fetchone() == (True,)
    assert c.execute("WITH x AS (SELECT generate_series(1,3) v) SELECT sum(v) OVER (ORDER BY v) FROM x").fetchall() == [(1,), (3,), (6,)]
    c.execute("PREPARE qualification_add(int) AS SELECT $1+1")
    assert c.execute("EXECUTE qualification_add(41)").fetchone() == (42,)
    c.execute("DEALLOCATE qualification_add")
    c.execute("CREATE TEMP TABLE private_temp (id int)")
    c.execute("INSERT INTO private_temp VALUES (7)")
    with connect(autocommit=True) as other:
        with pytest.raises(errors.UndefinedTable):
            other.execute("SELECT * FROM private_temp")


def test_pg18_uuid_virtual_returning(db):
    c, _ = db
    assert c.execute("SELECT uuid_extract_version(uuidv7())").fetchone() == (7,)
    c.execute("CREATE TABLE pg18 (id int, doubled int GENERATED ALWAYS AS (id*2) VIRTUAL)")
    c.execute("INSERT INTO pg18(id) VALUES (4)")
    assert c.execute("UPDATE pg18 SET id=5 RETURNING OLD.id, NEW.id, NEW.doubled").fetchone() == (4, 5, 10)
    assert c.execute("SHOW io_method").fetchone()[0] in ("worker", "sync", "io_uring")


def test_authentication_failures_and_role(db):
    c, _ = db
    with pytest.raises(psycopg.OperationalError, match="password authentication failed"):
        with connect(password="deliberately-invalid-qualification-password"):
            pass
    role = "qual_role_" + uuid.uuid4().hex
    try:
        c.execute(sql.SQL("CREATE ROLE {} LOGIN PASSWORD 'local-test-only'").format(sql.Identifier(role)))
        with connect(user=role, password="local-test-only", autocommit=True) as test_user:
            assert test_user.execute("SELECT current_user").fetchone() == (role,)
            with pytest.raises(errors.InsufficientPrivilege):
                test_user.execute("CREATE ROLE forbidden_role")
    finally:
        c.execute(sql.SQL("DROP ROLE IF EXISTS {}").format(sql.Identifier(role)))


def wait_query(admin, pid):
    deadline = time.monotonic() + 5
    while time.monotonic() < deadline:
        if admin.execute("SELECT wait_event='PgSleep' FROM pg_stat_activity WHERE pid=%s", (pid,)).fetchone() == (True,):
            return
        time.sleep(0.02)
    pytest.fail("session never entered pg_sleep")


def test_cancel_terminate_reconnect(db):
    c, _ = db
    with connect(autocommit=True) as victim, ThreadPoolExecutor(max_workers=1) as pool:
        pid = victim.info.backend_pid
        future = pool.submit(victim.execute, "SELECT pg_sleep(20)")
        wait_query(c, pid)
        victim.cancel()
        with pytest.raises(errors.QueryCanceled):
            future.result(timeout=5)
        assert victim.execute("SELECT 1").fetchone() == (1,)
        assert c.execute("SELECT pg_terminate_backend(%s)", (pid,)).fetchone() == (True,)
        with pytest.raises(psycopg.OperationalError):
            victim.execute("SELECT 1")
    with connect() as again:
        assert again.execute("SELECT 1").fetchone() == (1,)


def test_connect_timeout():
    # A local TCP listener that accepts but never completes PostgreSQL startup.
    with socket.socket() as listener:
        listener.bind(("127.0.0.1", 0))
        listener.listen(1)
        listener.settimeout(5)
        def stall():
            connection, _ = listener.accept()
            with connection:
                time.sleep(4)
        with ThreadPoolExecutor(max_workers=1) as pool:
            future = pool.submit(stall)
            started = time.monotonic()
            with pytest.raises(psycopg.OperationalError, match="timeout"):
                psycopg.connect(host="127.0.0.1", port=listener.getsockname()[1], connect_timeout=2, sslmode="disable")
            assert 1.5 <= time.monotonic() - started < 5
            future.result(timeout=6)


def test_maintenance_and_index_integrity(db):
    c, _ = db
    # Extension objects must outlive this test's disposable search_path schema.
    c.execute("CREATE EXTENSION IF NOT EXISTS amcheck WITH SCHEMA public")
    extension_schema = c.execute("SELECT n.nspname FROM pg_extension e JOIN pg_namespace n ON n.oid=e.extnamespace WHERE e.extname='amcheck'").fetchone()[0]
    c.execute("CREATE TABLE maint AS SELECT i, repeat('x',50) val FROM generate_series(1,1000) i")
    c.execute("CREATE INDEX maint_idx ON maint(i)")
    c.execute("DELETE FROM maint WHERE i%2=0")
    c.execute("VACUUM (ANALYZE) maint")
    c.execute("REINDEX TABLE maint")
    c.execute("CHECKPOINT")
    c.execute(sql.SQL("SELECT {}.bt_index_check('maint_idx'::regclass,true)").format(sql.Identifier(extension_schema)))
    assert c.execute("SELECT count(*) FROM maint").fetchone() == (500,)


def test_autovacuum(db):
    c, schema = db
    c.execute("CREATE TABLE av (v int) WITH (autovacuum_vacuum_threshold=0,autovacuum_vacuum_scale_factor=0,autovacuum_analyze_threshold=0,autovacuum_analyze_scale_factor=0)")
    c.execute("INSERT INTO av SELECT generate_series(1,2000)")
    c.execute("DELETE FROM av WHERE v%2=0")
    deadline = time.monotonic() + 100
    while time.monotonic() < deadline:
        c.execute("SELECT pg_stat_clear_snapshot()")
        if c.execute("SELECT autovacuum_count>0 AND autoanalyze_count>0 FROM pg_stat_user_tables WHERE schemaname=%s AND relname='av'", (schema,)).fetchone() == (True,):
            return
        time.sleep(0.5)
    pytest.fail("Autovacuum and autoanalyze did not process the test table within 100 seconds")


@pytest.mark.parametrize("prefetch", ["on", "off"])
def test_neon_prefetch_index_and_storage_lifecycle(db, prefetch):
    c, _ = db
    c.execute("CREATE UNLOGGED TABLE lifecycle AS SELECT i, i*3 val FROM generate_series(1,10000) i")
    c.execute("CREATE INDEX lifecycle_idx ON lifecycle(i)")
    c.execute("ALTER TABLE lifecycle SET LOGGED")
    c.execute("ANALYZE lifecycle")
    c.execute("SET enable_seqscan=off")
    c.execute("SET enable_bitmapscan=off")
    c.execute(sql.SQL("SET enable_indexscan_prefetch=" + prefetch))
    c.execute(sql.SQL("SET enable_indexonlyscan_prefetch=" + prefetch))
    plan = str(c.execute("EXPLAIN (FORMAT JSON) SELECT sum(val) FROM lifecycle WHERE i BETWEEN 100 AND 500").fetchone())
    assert "Index Scan" in plan
    assert c.execute("SELECT sum(val) FROM lifecycle WHERE i BETWEEN 100 AND 500").fetchone() == (360900,)
    c.execute("VACUUM lifecycle")
    assert c.execute("SELECT count(i) FROM lifecycle WHERE i BETWEEN 100 AND 500").fetchone() == (401,)
    c.execute("TRUNCATE lifecycle")
    assert c.execute("SELECT count(*) FROM lifecycle").fetchone() == (0,)
