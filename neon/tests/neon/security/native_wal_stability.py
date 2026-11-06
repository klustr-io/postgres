"""Bounded connection churn on an isolated three-node native WAL fixture."""
import os
from pathlib import Path
import select
import socket
import struct
import time


def verify_native_stream_stability(connect, heartbeat):
    def snapshot():
        rows = {}
        for proc in Path('/proc').iterdir():
            if not proc.name.isdigit():
                continue
            try:
                if (proc / 'comm').read_text().strip() != 'safekeeper':
                    continue
                status = dict(line.split(':', 1) for line in (proc / 'status').read_text().splitlines())
                rows[proc.name] = {'rss_kib': int(status['VmRSS'].split()[0]),
                                   'fds': len(list((proc / 'fd').iterdir()))}
            except (FileNotFoundError, ProcessLookupError):
                continue
        assert len(rows) == 3, 'Storage process exited during stability screen'
        return rows

    for n in range(24):
        stream = connect(n % 3 + 1)
        try:
            assert stream.copy
            stream.exchange(heartbeat)
        finally:
            stream.close()
    time.sleep(.1)
    checkpoints = [snapshot()]
    rejected = 0
    for batch in range(8):
        for n in range(32):
            stream = connect((batch * 32 + n) % 3 + 1)
            raw = None
            try:
                assert stream.copy
                if n % 4 == 0:
                    stream.exchange(heartbeat)
                    continue
                raw = socket.socket(fileno=os.dup(stream.lib.PQsocket(stream.connection)))
                if n % 4 == 1:
                    frame = b'd' + struct.pack('>I', 0xFFFFFFFF)
                elif n % 4 == 2:
                    frame = b'D\0\0\0\x04'  # A truncated extended-protocol message.
                else:
                    raw.sendall(b'd\0\0')  # Disconnect during a partial header.
                    continue
                raw.sendall(frame)
                deadline = time.monotonic() + 2
                while True:
                    assert time.monotonic() < deadline, 'Malformed stream was not closed'
                    if select.select([raw], [], [], .02)[0]:
                        try:
                            if not raw.recv(4096):
                                break
                        except ConnectionResetError:
                            break
                rejected += 1
            finally:
                if raw:
                    raw.close()
                stream.close()
        time.sleep(.1)
        checkpoints.append(snapshot())
    initial = checkpoints[0]
    final = checkpoints[-1]
    assert final.keys() == initial.keys(), 'Storage restarted during churn'
    for pid in initial:
        assert final[pid]['fds'] <= initial[pid]['fds'] + 4, 'File descriptor retention after churn'
        assert max(point[pid]['rss_kib'] for point in checkpoints) <= initial[pid]['rss_kib'] + 16 * 1024, \
            'RSS growth exceeded the bounded screen budget'
    return {'status': 'PASS', 'connections': 280, 'malformed_streams_rejected': rejected,
            'checkpoints': checkpoints, 'rss_growth_budget_kib_per_process': 16 * 1024,
            'scope': 'Short reconnect/malformed-frame screen, not proof of absence of leaks or a long soak'}
