"""Live PG18/AMD64 guard regression at virtual WAL page/segment headers."""
import re


def verify_guard_wal_boundaries(sql,drain=False):
    def pid():
        value=sql("SELECT pid FROM pg_stat_activity WHERE backend_type='Neon bounded commit guard'")
        assert re.fullmatch(r'[1-9][0-9]*',value),'Expected one live native guard worker'
        return int(value)
    before=pid()
    segment=int(sql("SELECT pg_size_bytes(current_setting('wal_segment_size'))"))
    segment_cursor=sql("""DO $probe$
    DECLARE raw pg_lsn; found boolean:=false;
    BEGIN
      FOR i IN 1..10 LOOP
        PERFORM pg_switch_wal(); raw:=pg_current_wal_insert_lsn();
        IF mod(pg_wal_lsn_diff(raw,'0/0')::bigint,pg_size_bytes(current_setting('wal_segment_size')))=40 THEN
          PERFORM set_config('guard_probe.segment_cursor',raw::text,false);
          PERFORM pg_sleep(0.15);found:=true;EXIT;
        END IF;
      END LOOP;
      IF NOT found THEN RAISE EXCEPTION 'Could not hold a long-header boundary';END IF;
    END $probe$; SELECT current_setting('guard_probe.segment_cursor')""")
    assert pid()==before,'Native guard restarted at a segment boundary'
    page_cursor=sql("""DO $probe$
    DECLARE first_lsn pg_lsn; after_lsn pg_lsn; raw pg_lsn;
      used integer; overhead integer; remaining integer; found boolean:=false;
    BEGIN
      FOR i IN 1..40 LOOP
        raw:=pg_current_wal_insert_lsn();
        remaining:=8192-mod(pg_wal_lsn_diff(raw,'0/0')::bigint,8192)::int;
        IF remaining<1024 THEN PERFORM pg_logical_emit_message(false,'guard-boundary',repeat('x',512));END IF;
        first_lsn:=pg_current_wal_insert_lsn();
        PERFORM pg_logical_emit_message(false,'guard-boundary',repeat('x',256));
        after_lsn:=pg_current_wal_insert_lsn();
        used:=pg_wal_lsn_diff(after_lsn,first_lsn)::int;
        IF used<256 OR used>512 THEN CONTINUE;END IF;
        overhead:=used-256;
        remaining:=8192-mod(pg_wal_lsn_diff(after_lsn,'0/0')::bigint,8192)::int;
        IF remaining-overhead<256 THEN CONTINUE;END IF;
        PERFORM pg_logical_emit_message(false,'guard-boundary',repeat('x',remaining-overhead));
        raw:=pg_current_wal_insert_lsn();
        IF mod(pg_wal_lsn_diff(raw,'0/0')::bigint,8192)=24 AND
           mod(pg_wal_lsn_diff(raw,'0/0')::bigint,pg_size_bytes(current_setting('wal_segment_size')))>=8192 THEN
          PERFORM set_config('guard_probe.page_cursor',raw::text,false);
          PERFORM pg_sleep(0.15);found:=true;EXIT;
        END IF;
      END LOOP;
      IF NOT found THEN RAISE EXCEPTION 'Could not hold a short-header boundary';END IF;
    END $probe$; SELECT current_setting('guard_probe.page_cursor')""")
    assert pid()==before,'Native guard restarted at a page boundary'
    # Sticky drain must use the same generated-WAL end convention. It must not
    # wait for an ungenerated next-page header after the last writer is gone.
    drained=sql('SELECT neon.bounded_commit_guard_drain()') if drain else None
    assert pid()==before
    return {'status':'PASS','guard_pid':before,'segment_size':segment,'segment_cursor':segment_cursor,
      'page_cursor':page_cursor,'drained_lsn':drained,
      'scope':'Held live page/segment header cursors with unchanged guard PID; optional sticky drain checked when requested.'}
