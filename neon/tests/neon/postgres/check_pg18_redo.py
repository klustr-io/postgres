#!/usr/bin/env python3
"""Run the actual PG18 pageserver redo helper protocol in isolated directories."""
import hashlib
import os
from pathlib import Path
import struct
import subprocess
import tempfile

build = Path(os.environ['BUILD_ROOT']) / os.environ.get('BUILD_MODE', 'debug')
postgres = Path(os.environ.get('INSTALL_PREFIX', build / 'install')) / 'bin/postgres'
directory = Path(tempfile.mkdtemp(prefix='neon-redo-protocol-', dir=build))


def frame(kind, payload=b''):
    return kind + struct.pack('!I', 4 + len(payload)) + payload


def execute(name, payload, expected=None):
    case = directory / name
    case.mkdir()
    result = subprocess.run([str(postgres), '--wal-redo'], input=payload,
                            cwd=case, capture_output=True, timeout=30)
    (case / 'stderr.log').write_bytes(result.stderr)
    (case / 'stdout.sha256').write_text(hashlib.sha256(result.stdout).hexdigest() + '\n')
    if expected is not None:
        assert result.returncode == 0, (name, result.returncode, result.stderr.decode(errors='replace'))
        assert result.stdout == expected, (name, len(result.stdout), result.stderr.decode(errors='replace'))
        assert not result.stderr, (name, result.stderr.decode(errors='replace'))
    else:
        assert result.returncode != 0 and b'invalid message length' in result.stderr, result
    print(f'PASS actual WAL redo helper: {name}', flush=True)


execute('startup-eof', b'', b'')
execute('ping', frame(b'H'), bytes(8192))
requests = bytearray()
responses = bytearray()
for index in range(20):
    identity = struct.pack('!BIIII', 0, 1663, 5, 20000 + index, index)
    page = bytearray(8192)
    struct.pack_into('<QHHHHHHI', page, 0, 0, 0, 0, 24, 8192, 8192, 8192 | 4, 0)
    page[24:] = bytes((position + index) & 255 for position in range(8192 - 24))
    requests += frame(b'B', identity) + frame(b'P', identity + page) + frame(b'G', identity) + frame(b'H')
    responses += page + bytes(8192)
execute('twenty-page-roundtrips', requests, responses)


def crc32c(data):
    value = 0xffffffff
    for byte in data:
        value ^= byte
        for _ in range(8):
            value = (value >> 1) ^ (0x82f63b78 if value & 1 else 0)
    return value ^ 0xffffffff


# Real XLOG_NOOP records exercise ApplyRecord and its per-record SMGR reset.
# Exceed the backend's exit-callback limit repeatedly in one helper process.
identity = struct.pack('!BIIII', 0, 1663, 5, 20000, 0)
page = bytearray(8192)
struct.pack_into('<QHHHHHHI', page, 0, 0, 0, 0, 24, 8192, 8192, 8192 | 4, 0)
request = bytearray(frame(b'B', identity) + frame(b'P', identity + page))
for index in range(256):
    header = struct.pack('<IIQBBH', 24, 0, 0, 0x20, 0, 0)
    record = header + struct.pack('<I', crc32c(header))
    request += frame(b'A', struct.pack('!Q', 0x1000 + 24 * index) + record)
request += frame(b'G', identity)
execute('256-wal-records-one-helper', request, bytes(page))
execute('invalid-length-rejected', b'H' + struct.pack('!I', 1))
print(f'All helper protocol evidence retained in {directory}', flush=True)
