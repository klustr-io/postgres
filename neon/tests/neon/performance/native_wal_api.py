"""Private-fixture qualification of native WAL transport, not a throughput test."""
import base64
import ctypes
import json
import os
from pathlib import Path
import signal
import select
import struct
import subprocess
import time
import urllib.request
import urllib.error


def verify_native_wal_api(sql, root):
    work = root/'native-api-check'
    work.mkdir()
    def encode(data):
        return base64.urlsafe_b64encode(data).rstrip(b'=')
    def token(tenant):
        signing = encode(b'{"alg":"EdDSA","typ":"JWT"}')+b'.'+encode(json.dumps(
            {'scope':'tenant','tenant_id':tenant},separators=(',',':')).encode())
        (work/'jwt-input').write_bytes(signing)
        result = subprocess.run(['openssl','pkeyutl','-sign','-rawin','-inkey',str(root/'neon/auth_private_key.pem'),
            '-in',str(work/'jwt-input'),'-out',str(work/'jwt-signature')],capture_output=True,timeout=5)
        assert result.returncode == 0, 'Could not sign private-fixture token'
        return (signing+b'.'+encode((work/'jwt-signature').read_bytes())).decode()
    tenant = sql('SHOW neon.tenant_id')
    timeline = sql('SHOW neon.timeline_id')
    valid = token(tenant)
    wrong = token('30000000000000000000000000000001')
    def request(node, body=None, credential=valid, suffix=''):
        headers = {'Content-Type':'application/octet-stream'}
        if credential is not None:
            headers['Authorization'] = 'Bearer '+credential
        url = f'http://127.0.0.1:{7675+node}/v1/tenant/{tenant}/timeline/{timeline}'+suffix
        try:
            with urllib.request.urlopen(urllib.request.Request(url,data=body,headers=headers),timeout=8) as response:
                return response.status,json.loads(response.read())
        except urllib.error.HTTPError as error:
            return error.code,json.loads(error.read())
    def lsn(value):
        high,low=value.split('/')
        return int(high,16)*2**32+int(low,16)
    def frame(state, start, data=b'', term=None, generation=None, committed=0):
        return b'a'+struct.pack('>IQQQQQ',state['mconf']['generation'] if generation is None else generation,
            state['acceptor_state']['term'] if term is None else term,start,start+len(data),committed,0)+data
    def read_wal(start,end):
        segment_size = int(sql("SELECT setting FROM pg_settings WHERE name='wal_segment_size'"))
        data = bytearray()
        while start < end:
            segment,offset = divmod(start,segment_size)
            count = min(end-start,segment_size-offset)
            filename = f'{1:08X}{segment//(2**32//segment_size):08X}{segment%(2**32//segment_size):08X}'
            with (root/'neon/endpoints/bench/pgdata/pg_wal'/filename).open('rb') as source:
                source.seek(offset)
                chunk = source.read(count)
            assert len(chunk)==count, 'Local WAL range unavailable'
            data.extend(chunk)
            start += count
        assert len(data)<=128*1024, 'Fixture must remain a bounded append'
        return bytes(data)

    class NativeCopy:
        """Use the packaged libpq; credentials never enter process arguments."""
        def __init__(self, node, credential, query=b'START_WAL_APPEND'):
            self.lib = ctypes.CDLL('/opt/postgres/v18/lib/libpq.so.5')
            pointer = ctypes.c_void_p
            signatures = {
                'PQconnectdbParams':(pointer,[ctypes.POINTER(ctypes.c_char_p),ctypes.POINTER(ctypes.c_char_p),ctypes.c_int]),
                'PQstatus':(ctypes.c_int,[pointer]), 'PQexec':(pointer,[pointer,ctypes.c_char_p]),
                'PQresultStatus':(ctypes.c_int,[pointer]), 'PQclear':(None,[pointer]),
                'PQsetnonblocking':(ctypes.c_int,[pointer,ctypes.c_int]),
                'PQputCopyData':(ctypes.c_int,[pointer,ctypes.c_char_p,ctypes.c_int]),
                'PQflush':(ctypes.c_int,[pointer]), 'PQconsumeInput':(ctypes.c_int,[pointer]),
                'PQgetCopyData':(ctypes.c_int,[pointer,ctypes.POINTER(pointer),ctypes.c_int]),
                'PQsocket':(ctypes.c_int,[pointer]), 'PQfreemem':(None,[pointer]), 'PQfinish':(None,[pointer]),
            }
            for name,(result,arguments) in signatures.items():
                function=getattr(self.lib,name); function.restype=result; function.argtypes=arguments
            options = {'host':'127.0.0.1','port':str((7453 if os.environ.get('QUORUM_NATIVE_DEDICATED')=='1' else 5453)+node),'user':'cloud_admin','dbname':'replication',
                'password':credential,'options':f'-c tenant_id={tenant} timeline_id={timeline}',
                'sslmode':'disable','connect_timeout':'2','application_name':'native-copy-qualification'}
            array = ctypes.c_char_p*(len(options)+1)
            self.connection=self.lib.PQconnectdbParams(array(*[key.encode() for key in options],None),
                array(*[value.encode() for value in options.values()],None),0)
            self.copy = False
            if self.connection and self.lib.PQstatus(self.connection)==0:
                result=self.lib.PQexec(self.connection,query)
                self.copy=bool(result and self.lib.PQresultStatus(result)==8)
                if result: self.lib.PQclear(result)
            if self.copy:
                assert self.lib.PQsetnonblocking(self.connection,1)==0
        def exchange(self, body, allow_end=False):
            replies=self.exchange_many([body],allow_end)
            return replies[0] if replies else None
        def exchange_many(self, bodies, allow_end=False):
            assert self.copy, 'Native COPY admission failed'
            deadline=time.monotonic()+3
            for body in bodies:
                assert self.lib.PQputCopyData(self.connection,body,len(body))==1
            fd=self.lib.PQsocket(self.connection)
            while True:
                status=self.lib.PQflush(self.connection)
                if status==0: break
                if status<0 and allow_end: return []
                assert status>=0 and time.monotonic()<deadline, 'Native COPY send did not complete'
                select.select([],[fd],[],.05)
            replies=[]
            while time.monotonic()<deadline:
                buffer=ctypes.c_void_p()
                count=self.lib.PQgetCopyData(self.connection,ctypes.byref(buffer),1)
                if count>0:
                    data=ctypes.string_at(buffer,count); self.lib.PQfreemem(buffer)
                    assert count==46, 'Invalid native progress frame'
                    replies.append(struct.unpack('>BBIQQQQQ',data))
                    if len(replies)==len(bodies): return replies
                    continue
                if count<0:
                    assert allow_end, 'Native COPY ended without progress'
                    return []
                if select.select([fd],[],[],.05)[0]:
                    consumed=self.lib.PQconsumeInput(self.connection)
                    if not consumed:
                        assert allow_end, 'Native COPY disconnected'
                        return []
            raise AssertionError('Native COPY reply deadline exceeded')
        def close(self):
            if self.connection:
                self.lib.PQfinish(self.connection); self.connection=None

    sql('CREATE TABLE native_api_witness(id int PRIMARY KEY, value text)')
    code,state = request(1)
    assert code == 200
    heartbeat = frame(state,0)
    assert request(1,heartbeat,None,'/wal')[0] == 401
    assert request(1,heartbeat,wrong,'/wal')[0] == 403
    code,progress = request(1,heartbeat,suffix='/wal')
    assert code == 200 and progress['outcome'] == 'appended', (code,progress)
    written = lsn(progress['write_lsn'])
    payload = read_wal(written-64,written)
    code,duplicate = request(1,frame(state,written-64,payload),suffix='/wal')
    assert code == 200 and duplicate['outcome'] == 'already_present', (code,duplicate)
    damaged = bytes([payload[0]^1])+payload[1:]
    code,mismatch = request(1,frame(state,written-64,damaged),suffix='/wal')
    assert code == 409 and mismatch['outcome']=='mismatch'
    for body,outcome in [(frame(state,written+1024,b'gap'),'gap'),
                         (frame(state,written,term=state['acceptor_state']['term']+1),'fenced'),
                         (frame(state,written,generation=state['mconf']['generation']+1),'fenced')]:
        code,answer=request(1,body,suffix='/wal')
        assert code==409 and answer['outcome']==outcome,(code,answer)
        assert answer['write_lsn']==mismatch['write_lsn'], 'Rejected append changed the stream'
    assert request(1,heartbeat+b'extra',suffix='/wal')[0] == 400
    assert request(1,b'a'*(128*1024+46),suffix='/wal')[0] == 400

    # The binary stream reuses existing PostgreSQL transport authentication,
    # without another HTTP request/authentication cycle for each append.
    copy_checks = False
    if (Path('/source/safekeeper/src/native_wal.rs').read_text().find('handle_native_wal_append')>=0):
        if os.environ.get('QUORUM_NATIVE_DEDICATED')=='1':
            denied=NativeCopy(1,valid,b'START_WAL_PUSH')
            try: assert not denied.copy, 'Native ingest listener admitted control/election protocol'
            finally: denied.close()
        for credential in ('',wrong):
            denied=NativeCopy(1,credential)
            try: assert not denied.copy, 'Native COPY admitted an unauthenticated or wrong-tenant writer'
            finally: denied.close()
        stream=NativeCopy(1,valid)
        try:
            for _ in range(3):
                answer=stream.exchange(heartbeat)
                assert answer[0:4]==(1,0,state['mconf']['generation'],state['acceptor_state']['term']) and answer[4]==1
            answer=stream.exchange(frame(state,written-64,payload))
            assert answer[1]==1, 'Native COPY did not verify the duplicate'
            answer=stream.exchange(frame(state,written-64,damaged))
            assert answer[1]==4, 'Native COPY accepted conflicting bytes'
            answer=stream.exchange(frame(state,written,term=state['acceptor_state']['term']+1))
            assert answer[1]==3, 'Native COPY bypassed election fencing'
            assert stream.exchange(b'a'*(128*1024+46),allow_end=True) is None, 'Oversized COPY frame acknowledged'
            copy_checks = True
        finally: stream.close()

    # Stop only this disposable compute's proposer. The append API must persist
    # the new local WAL itself, rather than succeed because the old path raced it.
    parent = int((root/'neon/endpoints/bench/pgdata/postmaster.pid').read_text().splitlines()[0])
    rows = sql("SELECT pid FROM pg_stat_activity WHERE backend_type='WAL proposer'").splitlines()
    if not rows:
        rows = [item.name for item in Path('/proc').iterdir() if item.name.isdigit() and
            (item/'stat').exists() and (item/'stat').read_text().rsplit(')', 1)[1].split()[1] == str(parent) and
            b'walproposer' in (item/'cmdline').read_bytes().lower().replace(b' ', b'')]
    assert len(rows) == 1, 'Expected exactly one proposer belonging to this fixture'
    stability = None
    if os.environ.get('QUORUM_STABILITY_CHECK') == '1':
        import sys
        sys.path.insert(0, '/security-probe')
        from native_wal_stability import verify_native_stream_stability
        stability = verify_native_stream_stability(lambda node: NativeCopy(node, valid), heartbeat)
    proposer = int(rows[0])
    assert Path(f'/proc/{proposer}/stat').read_text().rsplit(')', 1)[1].split()[1] == str(parent)
    starts = {}
    states = {}
    for node in (1,2,3):
        _,states[node]=request(node)
        code,position=request(node,frame(states[node],0),suffix='/wal')
        assert code==200
        starts[node]=lsn(position['write_lsn'])
        # Enable this resident store's lazy comparison window before generating
        # the new tail. The initial duplicate still verifies against storage.
        prior=read_wal(starts[node]-64,starts[node])
        code,answer=request(node,frame(states[node],starts[node]-64,prior),suffix='/wal')
        assert code==200 and answer['outcome']=='already_present'
    deadline=time.monotonic()+3
    while json.loads(sql('SELECT neon.bounded_commit_guard_status()'))['age_ms']>=50:
        assert time.monotonic()<deadline
        time.sleep(.01)
    os.kill(proposer,signal.SIGSTOP)
    try:
        sql("SET synchronous_commit=off; INSERT INTO native_api_witness VALUES(1,'native-append')")
        deadline=time.monotonic()+3
        while True:
            target=lsn(sql('SELECT pg_current_wal_flush_lsn()'))
            if target>max(starts.values()):
                break
            assert time.monotonic()<deadline
            time.sleep(.01)
        prefixes=[]
        for node in (1,2,3):
            data=read_wal(starts[node],target)
            body=frame(states[node],starts[node],data)
            if copy_checks:
                writer=NativeCopy(node,valid)
                try:
                    step=max(1,(len(data)+7)//8)
                    frames=[frame(states[node],starts[node]+offset,data[offset:offset+step])
                        for offset in range(0,len(data),step)]
                    assert 2<=len(frames)<=8, 'Witness did not produce a multi-frame COPY tail'
                    replies=writer.exchange_many(frames)
                    assert all(reply[0]==1 and reply[1] in (0,1) and reply[2:4]==(states[node]['mconf']['generation'],states[node]['acceptor_state']['term'])
                        and reply[4]==node for reply in replies)
                    assert all(left[5]<=right[5] and left[6]<=right[6] for left,right in zip(replies,replies[1:]))
                    progress=replies[-1]
                    assert progress[0:4]==(1,0,states[node]['mconf']['generation'],states[node]['acceptor_state']['term'])
                    assert progress[4]==node and progress[5]==target
                finally: writer.close()
            code,answer=request(node,body,suffix='/wal')
            assert code==200 and answer['outcome']==('already_present' if copy_checks else 'appended'),(code,answer)
            assert lsn(answer['write_lsn'])==target
            prefixes.append(lsn(answer['flush_lsn']))
            code,retry=request(node,frame(states[node],starts[node],data),suffix='/wal')
            assert code==200 and retry['outcome']=='already_present'
            damaged=bytes([data[0]^1])+data[1:]
            code,rejected=request(node,frame(states[node],starts[node],damaged),suffix='/wal')
            assert code==409 and rejected['outcome']=='mismatch'
            assert lsn(rejected['write_lsn'])==target, 'Conflicting cached retry changed written WAL'
        quorum=sorted(prefixes)[1]
        assert quorum>max(starts.values()), 'No new complete durable WAL prefix'
        for node in (1,2,3):
            code,answer=request(node,frame(states[node],target,committed=quorum),suffix='/wal')
            assert code==200 and lsn(answer['commit_lsn'])>=quorum
    finally:
        os.kill(proposer,signal.SIGCONT)
    return {'status':'PASS','stability':stability,'tenant_authorization':True,'duplicate_bytes_verified':True,
        'mismatching_bytes_rejected':True,'term_and_generation_fenced':True,'gaps_rejected':True,
        'frame_limits_enforced':True,'new_wal_persisted_while_proposer_paused':True,
        'new_tail_retries_verified_and_conflicts_rejected':True,
        'authenticated_copy_stream_checks':copy_checks,
        'new_wal_written_over_copy_while_proposer_paused':copy_checks,
        'multiple_new_wal_frames_queued_before_copy_feedback':copy_checks,
        'scope':'Three isolated RAM-backed processes; not persistent-media or power-loss qualification'}
