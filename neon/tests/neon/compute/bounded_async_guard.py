"""Benchmark-only deferred-trigger prototype. Not a general commit/RPO hook."""
import os
import signal
from pathlib import Path
import subprocess
import threading
import time


class BoundedAsyncGuard:
    def __init__(self, engine, port, user, log_directory, partition_probe=False):
        self.engine, self.port, self.user = engine, port, user
        self.logs = Path(log_directory)
        self.partition = partition_probe and engine == 'neon'
        self.stop_event = threading.Event()
        self.markers, self.errors, self.witness = [], [], []
        self.outage = None

    def execute(self, statement, policy='on', application='bounded_async_marker', timeout=8):
        env = {**os.environ, 'PGOPTIONS': '-c synchronous_commit='+policy+' -c statement_timeout=5000',
               'PGAPPNAME': application}
        child = subprocess.run(['/opt/upstream/v18/bin/psql', '-XqAt', '-v', 'ON_ERROR_STOP=1',
                                '-h', '127.0.0.1', '-p', str(self.port), '-U', self.user,
                                '-d', 'postgres', '-c', statement], capture_output=True,
                               text=True, env=env, timeout=timeout)
        if child.returncode:
            raise RuntimeError(child.stderr[-2000:])
        return child.stdout.strip()

    def marker(self):
        emitted = float(self.execute("UPDATE benchmark_commit_epoch SET emitted_at=clock_timestamp() "
                                    "WHERE id=1 RETURNING extract(epoch FROM emitted_at)"))
        self.markers.append({'emitted_epoch': emitted, 'completed_epoch': time.time()})

    def start(self):
        self.execute("""
CREATE TABLE IF NOT EXISTS benchmark_commit_epoch(id int PRIMARY KEY, emitted_at timestamptz NOT NULL);
INSERT INTO benchmark_commit_epoch VALUES(1,clock_timestamp()) ON CONFLICT(id) DO NOTHING;
CREATE TABLE IF NOT EXISTS benchmark_async_witness(id bigint PRIMARY KEY);
CREATE OR REPLACE FUNCTION benchmark_guard_commit() RETURNS trigger LANGUAGE plpgsql VOLATILE AS $$
DECLARE marker_time timestamptz;
BEGIN
  LOOP
    SELECT emitted_at INTO marker_time FROM benchmark_commit_epoch WHERE id=1;
    IF marker_time IS NOT NULL AND clock_timestamp() < marker_time+interval '750 milliseconds' THEN
      RETURN NULL;
    END IF;
    PERFORM pg_sleep(0.001);
  END LOOP;
END $$;
""")
        for table in ('pgbench_accounts', 'benchmark_json', 'benchmark_async_witness'):
            self.execute(f"DROP TRIGGER IF EXISTS benchmark_guard ON {table}; "
                         f"CREATE CONSTRAINT TRIGGER benchmark_guard AFTER INSERT OR UPDATE OR DELETE ON {table} "
                         "DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION benchmark_guard_commit()")
        self.marker()

        def publish():
            while not self.stop_event.is_set():
                began = time.monotonic()
                try:
                    self.marker()
                except Exception as error:
                    # Fixture engine restarts are expected between setup and measurement.
                    self.errors.append({'epoch': time.time(), 'error': str(error)})
                self.stop_event.wait(max(0, .1-(time.monotonic()-began)))

        self.thread = threading.Thread(target=publish, daemon=True)
        self.thread.start()

    def _local(self, *args):
        child = subprocess.run(['neon_local', *args], capture_output=True, text=True, timeout=60)
        (self.logs / ('bounded-guard-'+ '-'.join(args[:3])+'-'+str(time.time_ns())+'.log')).write_text(child.stdout+child.stderr)
        assert child.returncode == 0, 'Fixture safekeeper control failed; inspect private log'
        if os.environ.get('NEON_BENCHMARK_CPU_LAYOUT') == 'compute8-storage8':
            from cpu_layout import configure_services
            configure_services()

    def partition_probe(self):
        """Admission test only. Does not claim immediate-crash RPO qualification."""
        writer_stop = threading.Event()
        self.writer_stop = writer_stop
        writer_errors = []
        base = time.time_ns()//1000

        def write():
            seq = 0
            while not writer_stop.is_set():
                seq += 1
                identity = base+seq
                try:
                    value = self.execute(f'INSERT INTO benchmark_async_witness VALUES({identity}) RETURNING id',
                                         'off', 'bounded_async_witness')
                    assert int(value) == identity
                    self.witness.append({'id': identity, 'ack_epoch': time.time()})
                except Exception as error:
                    writer_errors.append(str(error))
                    return

        writer = threading.Thread(target=write, daemon=True)
        self.writer_thread = writer
        writer.start()
        deadline = time.monotonic()+10
        while len(self.witness)<5:
            assert time.monotonic()<deadline and not writer_errors, 'Witness could not establish healthy writes'
            time.sleep(.01)
        paused = []
        try:
            for identity in (2,3):
                self._local('safekeeper','stop',str(identity),'-m','immediate')
                paused.append(identity)
            paused_at = time.time()
            time.sleep(1.3)
            before = len(self.witness)
            time.sleep(.2)
            assert len(self.witness)==before and not writer_errors, 'Fast ACKs did not stop safely'
            sleeping = int(self.execute("SELECT count(*) FROM pg_stat_activity WHERE "
                "application_name='bounded_async_witness' AND wait_event='PgSleep'"))
            assert sleeping==1, 'Witness was not waiting in the deferred guard'
            observed_at = time.time()
            visible = [row for row in self.markers if row['completed_epoch']<=observed_at]
            latest = max(visible,key=lambda row:row['completed_epoch'])
            last_ack = max(row['ack_epoch'] for row in self.witness)
            assert last_ack-latest['emitted_epoch']<1, 'Acknowledgement exceeded the configured reserve'
            self.outage = {'status':'PASS','paused_members':paused[:], 'paused_epoch':paused_at,
                'observed_epoch':observed_at,'guard_waiting_sessions':sleeping,
                'acks_before_restore':before,'last_ack_minus_barrier_seconds':last_ack-latest['emitted_epoch'],
                'scope':'Outage admission/response test; not an immediate-crash or compound-failure RPO proof'}
        finally:
            for identity in paused:
                self._local('safekeeper','start',str(identity))
        deadline = time.monotonic()+15
        previous = len(self.witness)
        while len(self.witness)<=previous:
            assert time.monotonic()<deadline and not writer_errors, 'Witness did not resume after quorum restoration'
            time.sleep(.01)
        writer_stop.set()
        writer.join(8)
        assert not writer.is_alive() and not writer_errors
        self.outage['resumed']=True

    def finish(self):
        try:
            if self.partition:
                self.partition_probe()
        finally:
            self.stop_event.set()
            self.thread.join(10)
            assert not self.thread.is_alive(), 'Durability marker worker did not stop'
            if hasattr(self, 'writer_stop'):
                self.writer_stop.set()
                self.writer_thread.join(8)
                assert not self.writer_thread.is_alive(), 'Witness writer did not stop'
        # All foreground clients have finished. This synchronous marker drains
        # their WAL before existing hard-loss/planned-zero control checks.
        self.marker()
        for table in ('pgbench_accounts', 'benchmark_json', 'benchmark_async_witness'):
            self.execute(f'DROP TRIGGER IF EXISTS benchmark_guard ON {table}')
        return {'scope':'Benchmark tables only; deferred row triggers and wall clock are not a production commit hook',
                'guard_budget_ms':750,'marker_interval_ms':100,'markers':self.markers,
                'marker_errors':self.errors,'partition_probe':self.outage,'witness':self.witness,
                'planned_sleep_fence':'Synchronous marker completed after foreground clients and marker worker stopped',
                'one_second_rpo_status':'NOT-QUALIFIED'}

    def immediate_loss_probe(self, proposer_pid, parent_pid, reconstruct):
        """Deliberately lose an unshipped ACK tail in this fresh fixture only."""
        self.start()
        self.stop_event.set()
        self.thread.join(10)
        assert not self.thread.is_alive()
        self.marker()  # Covers all previous benchmark/control data.
        stat = Path(f'/proc/{proposer_pid}/stat').read_text()
        assert int(stat[stat.rfind(')')+2:].split()[1]) == parent_pid
        base = time.time_ns()//1000
        acknowledged = []
        try:
            os.kill(proposer_pid, signal.SIGSTOP)
            for offset in range(10):
                identity = base+offset
                returned = self.execute(f'INSERT INTO benchmark_async_witness VALUES({identity}) RETURNING id',
                                        'off', 'bounded_async_loss_witness')
                assert int(returned)==identity
                acknowledged.append({'id':identity,'ack_epoch':time.time()})
            crashed_at = reconstruct()  # Returns the recorded compute kill epoch.
            assert isinstance(crashed_at,(int,float))
            identities = ','.join(str(row['id']) for row in acknowledged)
            recovered = set(int(value) for value in self.execute(
                f'SELECT id FROM benchmark_async_witness WHERE id IN ({identities})').splitlines() if value)
            lost = [row for row in acknowledged if row['id'] not in recovered]
            assert lost, 'Fault did not exercise loss of any asynchronous acknowledgement'
            oldest_age = crashed_at-min(row['ack_epoch'] for row in lost)
            assert 0<=oldest_age<1, 'Observed acknowledged loss exceeded one second at crash'
            return {'status':'PASS','fault':'WAL proposer paused before async ACKs; complete compute-file loss without final drain',
                    'crash_epoch':crashed_at,'acknowledged':acknowledged,'recovered_ids':sorted(recovered),
                    'lost_ids':[row['id'] for row in lost], 'oldest_lost_ack_age_at_crash_seconds':oldest_age,
                    'scope':'One controlled immediate compute-loss experiment; not a universal or compound-failure RPO guarantee'}
        finally:
            try:
                stat = Path(f'/proc/{proposer_pid}/stat').read_text()
                if int(stat[stat.rfind(')')+2:].split()[1])==parent_pid:
                    os.kill(proposer_pid,signal.SIGCONT)
            except FileNotFoundError:
                pass
            self.finish()
