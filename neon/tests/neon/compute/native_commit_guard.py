"""Exercise native commit admission without any benchmark-table triggers."""
import json
import os
from pathlib import Path
import signal
import subprocess
import threading
import time
from bounded_async_guard import BoundedAsyncGuard


class NativeCommitGuard:
    def __init__(self, engine, port, user, logs):
        assert engine == 'neon'
        self.helper = BoundedAsyncGuard(engine, port, user, logs)
        self.port, self.user = port, user

    def execute(self, *args, **kwargs):
        return self.helper.execute(*args, **kwargs)

    def status(self):
        return json.loads(self.execute('SELECT neon.bounded_commit_guard_status()'))

    def command(self, statement, application, policy='off', timeout_ms=5000):
        env = {**os.environ, 'PGOPTIONS': f'-c synchronous_commit={policy} -c statement_timeout={timeout_ms}',
               'PGAPPNAME': application}
        return subprocess.Popen(['/opt/upstream/v18/bin/psql', '-XqAt', '-v', 'ON_ERROR_STOP=1',
            '-h', '127.0.0.1', '-p', str(self.port), '-U', self.user, '-d', 'postgres', '-c', statement],
            env=env, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)

    def proposer(self):
        parent = int(Path('/var/lib/neon/comparison/neon/endpoints/bench/pgdata/postmaster.pid').read_text().splitlines()[0])
        rows = self.execute("SELECT pid FROM pg_stat_activity WHERE backend_type='WAL proposer'").splitlines()
        if not rows:
            rows = [item.name for item in Path('/proc').iterdir() if item.name.isdigit() and
                (item/'stat').exists() and (item/'stat').read_text().rsplit(')', 1)[1].split()[1] == str(parent) and
                b'walproposer' in (item/'cmdline').read_bytes().lower().replace(b' ', b'')]
        assert len(rows) == 1
        pid = int(rows[0])
        assert Path(f'/proc/{pid}/stat').read_text().rsplit(')', 1)[1].split()[1] == str(parent)
        return pid, parent

    def start(self):
        state = self.status()
        assert state['enabled'] and state['max_age_ms'] == 750
        assert self.execute("SELECT count(*) FROM pg_trigger WHERE tgname='benchmark_guard'") == '0'

    def fresh(self):
        deadline = time.monotonic()+10
        while True:
            state = self.status()
            if 0 <= state['age_ms'] < 100:
                return state
            assert time.monotonic() < deadline, 'No fresh verified quorum frontier'
            time.sleep(.01)

    def finish(self):
        initial = self.status()
        try:
            self.execute('SET neon.bounded_async_commit=off')
            raise AssertionError('A session disabled the postmaster guard')
        except RuntimeError as error:
            assert 'cannot be changed without restarting' in str(error)
        self.execute('CREATE TABLE IF NOT EXISTS native_guard_witness(id bigint PRIMARY KEY); '
                     'CREATE TABLE IF NOT EXISTS native_guard_other(id bigint PRIMARY KEY, payload text)')
        stop = threading.Event()
        witness, errors = [], []
        base = time.time_ns()//1000

        def writer():
            sequence = 0
            while not stop.is_set():
                sequence += 1
                identity = base+sequence
                try:
                    self.execute(f'INSERT INTO native_guard_witness VALUES({identity})',
                                 policy='off' if sequence % 2 else 'local', application='native_guard_probe')
                    witness.append({'id': identity, 'ack_epoch': time.time()})
                except Exception as error:
                    errors.append(str(error))
                    return

        thread = threading.Thread(target=writer, daemon=True)
        thread.start()
        deadline = time.monotonic()+10
        while len(witness) < 5:
            assert not errors and time.monotonic() < deadline
            time.sleep(.01)
        paused = []
        cancel_proof = None
        try:
            for number in [2, 3]:
                self.helper._local('safekeeper', 'stop', str(number)); paused.append(number)
            time.sleep(1.2)
            before = len(witness)
            time.sleep(.2)
            assert len(witness) == before and not errors, 'Off/local ACKs continued past stale frontier'
            state = self.status()
            assert state['age_ms'] >= 750 and state['waits'] > initial['waits']
            waiting = int(self.execute("SELECT count(*) FROM pg_stat_activity WHERE application_name='native_guard_probe' "
                                      "AND wait_event_type='IPC' AND wait_event='SyncRep'"))
            assert waiting == 1, 'Native commit guard did not block the unrelated table writer'
            cancelled = self.command(f"INSERT INTO native_guard_other VALUES({base},'cancel')", 'native_guard_cancel', timeout_ms=100)
            # PostgreSQL disables statement_timeout before the commit wait.
            # Exercise an actual cancellation signal, not an inactive timer.
            deadline = time.monotonic()+2
            while True:
                cancel_pid = self.execute("SELECT pid FROM pg_stat_activity WHERE application_name='native_guard_cancel' AND wait_event='SyncRep'")
                if cancel_pid:
                    break
                assert cancelled.poll() is None and time.monotonic()<deadline
                time.sleep(.01)
            assert self.execute(f'SELECT pg_cancel_backend({int(cancel_pid)})') == 't'
            stdout, stderr = cancelled.communicate(timeout=3)
            assert cancelled.returncode != 0 and 'transaction outcome is unknown' in stderr
            cancel_proof = {'status': 'PASS', 'exit_code': cancelled.returncode,
                            'scope': 'Commit-time cancellation disconnected; no success response'}
        finally:
            for number in paused:
                self.helper._local('safekeeper', 'start', str(number))
        deadline = time.monotonic()+10
        while len(witness) <= before:
            assert not errors and time.monotonic() < deadline, 'Native witness failed after quorum restoration: '+repr(errors)
            time.sleep(.01)
        stop.set(); thread.join(8)
        assert not thread.is_alive() and not errors

        # A lone async tail must be published without another client write.
        idle_id = base+1000000
        self.execute(f'INSERT INTO native_guard_witness VALUES({idle_id})', policy='off')
        witness.append({'id': idle_id, 'ack_epoch': time.time()})
        target = self.execute('SELECT pg_current_wal_insert_lsn()')
        began = time.monotonic()
        while self.execute(f"SELECT (neon.bounded_commit_guard_status()::jsonb->>'quorum_lsn')::pg_lsn >= '{target}'::pg_lsn") != 't':
            assert time.monotonic()-began < 1, 'Idle tail did not reach quorum within one second in this fault-free test'
            time.sleep(.01)
        idle_seconds = time.monotonic()-began

        prepared = 'native_guard_'+str(base)
        self.execute(f"BEGIN; INSERT INTO native_guard_other VALUES({base+1500000},'prepared'); PREPARE TRANSACTION '{prepared}'", policy='off')
        assert self.execute(f"SELECT count(*) FROM pg_prepared_xacts WHERE gid='{prepared}'") == '1'
        self.execute(f"COMMIT PREPARED '{prepared}'", policy='off')
        assert self.execute(f"SELECT count(*) FROM native_guard_other WHERE id={base+1500000}") == '1'

        byte_proof = {'status':'NOT-RUN', 'reason':'The byte-bound isolation probe requires a 1-MiB configured limit'}
        if initial['max_wal_bytes'] == 1048576:
            self.fresh(); pid, parent = self.proposer(); pending = None
            os.kill(pid, signal.SIGSTOP)
            try:
                pending = self.command('INSERT INTO native_guard_other SELECT '+str(base+2000000)+
                    "+g,repeat(md5(g::text),16) FROM generate_series(1,6000) g", 'native_guard_bytes')
                deadline = time.monotonic()+.5
                while self.execute("SELECT count(*) FROM pg_stat_activity WHERE application_name='native_guard_bytes' AND wait_event='SyncRep'") != '1':
                    assert pending.poll() is None and time.monotonic() < deadline, 'Byte-limit wait was not observed before age limit'
                    time.sleep(.01)
                state = self.status()
                assert state['age_ms'] < 750
                lag = int(self.execute("SELECT pg_current_wal_insert_lsn()-(neon.bounded_commit_guard_status()::jsonb->>'quorum_lsn')::pg_lsn"))
                assert lag > initial['max_wal_bytes']
                byte_proof = {'status':'PASS','lag_bytes':lag,'age_ms':state['age_ms']}
            finally:
                if Path(f'/proc/{pid}/stat').exists() and Path(f'/proc/{pid}/stat').read_text().rsplit(')',1)[1].split()[1] == str(parent):
                    os.kill(pid, signal.SIGCONT)
            stdout, stderr = pending.communicate(timeout=10)
            assert pending.returncode == 0, stderr

        # Planned sleep fence is sticky: subsequent off/local commits must wait
        # for their own quorum LSN even while the age lease would allow fast ACKs.
        frontier = self.execute('SELECT neon.bounded_commit_guard_drain()')
        assert self.status()['draining']
        paused = []
        try:
            for number in [2, 3]:
                self.helper._local('safekeeper', 'stop', str(number)); paused.append(number)
            pending = self.command(f"INSERT INTO native_guard_other VALUES({base+3000000},'drain')", 'native_guard_draining')
            time.sleep(.15)
            assert pending.poll() is None, 'Sticky drain allowed a non-durable fast ACK'
        finally:
            for number in paused:
                self.helper._local('safekeeper', 'start', str(number))
        stdout, stderr = pending.communicate(timeout=10)
        assert pending.returncode == 0, stderr
        return {'status':'PASS','scope':'Native commit hook; no benchmark-table triggers; compound-failure RPO remains unqualified',
                'workload_status':initial,'final_status':self.status(),'witness':witness,
                'session_disable_rejected':'PASS',
                'partition_off_and_local':'PASS','cancellation':cancel_proof,'idle_tail_quorum_seconds':idle_seconds,
                'prepare_and_commit_prepared':'PASS',
                'byte_limit':byte_proof,'planned_sleep_frontier':frontier,'sticky_drain':'PASS'}

    def immediate_loss_probe(self, reconstruct):
        # Restart clears the prior sticky drain; graceful stop first hardens the
        # old witness history. The fault below then deliberately omits a drain.
        self.helper._local('endpoint','stop','bench')
        self.helper._local('endpoint','start','bench','--dev')
        self.fresh()
        older = json.loads(self.execute("SELECT coalesce(json_agg(id),'[]') FROM native_guard_witness"))
        pid, parent = self.proposer()
        acknowledged = []
        base = time.time_ns()//1000
        os.kill(pid, signal.SIGSTOP)
        try:
            for index in range(10):
                identity = base+index
                self.execute(f'INSERT INTO native_guard_witness VALUES({identity})', policy='off')
                acknowledged.append({'id':identity,'ack_epoch':time.time()})
            time.sleep(.55)
            killed_at = reconstruct()
        finally:
            file = Path(f'/proc/{pid}/stat')
            if file.exists() and file.read_text().rsplit(')',1)[1].split()[1] == str(parent):
                os.kill(pid, signal.SIGCONT)
        recovered = set(json.loads(self.execute("SELECT coalesce(json_agg(id),'[]') FROM native_guard_witness")))
        assert set(older) <= recovered, 'Older drained native witness history was lost'
        lost = [row for row in acknowledged if row['id'] not in recovered]
        assert lost
        age = killed_at-min(row['ack_epoch'] for row in lost)
        assert 0 < age < 1, 'Controlled loss exceeded the accepted one-second window'
        return {'status':'PASS','acknowledged':acknowledged,'lost_ids':[row['id'] for row in lost],
                'oldest_lost_ack_age_at_crash_seconds':age,'older_ids_verified':len(older),'crash_epoch':killed_at,
                'scope':'Single deliberate unshipped-tail crash without drain; not universal RPO certification'}
