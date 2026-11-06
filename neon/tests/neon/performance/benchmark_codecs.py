#!/usr/bin/env python3
"""Warm in-memory codec screening, not a Neon protocol or network benchmark."""
import ctypes as C
import hashlib
import json
import platform
import random
import time
from pathlib import Path

MIB = 1024**2
lz4 = C.CDLL('liblz4.so.1')
zstd = C.CDLL('libzstd.so.1')
snappy = C.CDLL('/opt/snappy/lib/libsnappy.so')


def bind(lib, name, result, arguments):
    function = getattr(lib, name)
    function.restype = result
    function.argtypes = arguments
    return function


ptr, size, integer = C.c_void_p, C.c_size_t, C.c_int
lz_bound = bind(lz4, 'LZ4_compressBound', integer, [integer])
lz_encode = bind(lz4, 'LZ4_compress_default', integer, [ptr, ptr, integer, integer])
lz_decode = bind(lz4, 'LZ4_decompress_safe', integer, [ptr, ptr, integer, integer])
zs_bound = bind(zstd, 'ZSTD_compressBound', size, [size])
zs_encode = bind(zstd, 'ZSTD_compress', size, [ptr, size, ptr, size, integer])
zs_decode = bind(zstd, 'ZSTD_decompress', size, [ptr, size, ptr, size])
zs_error = bind(zstd, 'ZSTD_isError', C.c_uint, [size])
sn_bound = bind(snappy, 'snappy_max_compressed_length', size, [size])
sn_encode = bind(snappy, 'snappy_compress', integer, [ptr, size, ptr, C.POINTER(size)])
sn_decode = bind(snappy, 'snappy_uncompress', integer, [ptr, size, ptr, C.POINTER(size)])


def json_corpus(entropy):
    rows, total, index = [], 0, 0
    while total < 8*MIB:
        payload = (''.join(hashlib.md5(f'{index}:{j}'.encode()).hexdigest() for j in range(64))
                   if entropy else 'Order accepted; standard shipping; customer notification enabled. '*32)
        row = json.dumps({'id':index, 'tenant':index%100, 'kind':'order', 'status':'paid',
                          'currency':'USD', 'metrics':{'score':0}, 'payload':payload},
                         separators=(',', ':')).encode()+b'\n'
        rows.append(row)
        total += len(row)
        index += 1
    return b''.join(rows)


corpora = {'repetitive-json':json_corpus(False), 'hex-payload-json':json_corpus(True),
           'incompressible-control':random.Random(20261030).randbytes(8*MIB)}
profiles = [('lz4', None), ('snappy', None), ('zstd-fast4', -4), ('zstd-fast1', -1),
            ('zstd-1', 1), ('zstd-3', 3), ('zstd-6', 6)]
output = {'status':'RUNNING', 'scope':'Isolated single-process in-memory codec benchmark',
          'environment':{'kernel':platform.release(),'machine':platform.machine(),
                         'cpu_model':next((line.split(':',1)[1].strip() for line in Path('/proc/cpuinfo').read_text().splitlines() if line.startswith('model name')),'unknown'),
                         'cpu_max':Path('/sys/fs/cgroup/cpu.max').read_text().strip(),
                         'memory_max':Path('/sys/fs/cgroup/memory.max').read_text().strip()},
          'versions':{'lz4':bind(lz4, 'LZ4_versionString', C.c_char_p, [])().decode(),
                      'zstd':bind(zstd, 'ZSTD_versionString', C.c_char_p, [])().decode(),
                      'zstd_default_level':bind(zstd, 'ZSTD_defaultCLevel', integer, [])(),
                      'snappy':'1.2.2', 'snappy_source_revision':'6af9287fbdb913f0794d0148c6aa43b58e63c8e3'},
          'parameters':{'repeats':3,'minimum_seconds_per_direction':.15,
                        'chunk_bytes':[65536,1048576]},
          'limitations':['Synthetic generated data, not customer data or captured WAL.',
                         'Warm in-memory ctypes calls; wrapper overhead is included, buffers are preallocated.',
                         'Raw LZ4/Snappy blocks exclude framing; Zstd uses its standard frame.',
                         'Serial link model includes sender encode CPU, wire time and receiver decode CPU. It excludes protocol/TLS overhead, latency and pipelining.',
                         'Snappy is a codec experiment, not supported Neon/PostgreSQL format integration.'],
          'corpora':{name:{'bytes':len(data),'sha256':hashlib.sha256(data).hexdigest()}
                     for name,data in corpora.items()}, 'samples':[]}


def measure(operation, count):
    start, cpu, passes = time.perf_counter(), time.process_time(), 0
    while True:
        operation()
        passes += 1
        if time.perf_counter()-start >= .15:
            break
    return {'passes':passes,'wall_seconds_per_mib':(time.perf_counter()-start)/(passes*count/MIB),
            'cpu_seconds_per_mib':(time.process_time()-cpu)/(passes*count/MIB)}


for corpus, data in corpora.items():
    for chunk in (65536, 1048576):
        blocks = [data[i:i+chunk] for i in range(0,len(data),chunk)]
        inputs = [C.create_string_buffer(block) for block in blocks]
        decoded = [C.create_string_buffer(len(block)) for block in blocks]
        for name, level in profiles:
            bound = lz_bound(chunk) if name=='lz4' else sn_bound(chunk) if name=='snappy' else zs_bound(chunk)
            encoded = [C.create_string_buffer(bound) for block in blocks]
            lengths = [0]*len(blocks)
            sizes = [size(bound) for block in blocks]

            def encode():
                for i, block in enumerate(blocks):
                    if name=='lz4':
                        n = lz_encode(inputs[i], encoded[i], len(block), bound)
                        assert n>0
                    elif name=='snappy':
                        sizes[i].value = bound
                        assert sn_encode(inputs[i],len(block),encoded[i],C.byref(sizes[i]))==0
                        n = sizes[i].value
                    else:
                        n = zs_encode(encoded[i],bound,inputs[i],len(block),level)
                        assert not zs_error(n)
                    lengths[i] = n

            def decode():
                for i, block in enumerate(blocks):
                    if name=='lz4':
                        assert lz_decode(encoded[i],decoded[i],lengths[i],len(block))==len(block)
                    elif name=='snappy':
                        sizes[i].value = len(block)
                        assert sn_decode(encoded[i],lengths[i],decoded[i],C.byref(sizes[i]))==0
                        assert sizes[i].value==len(block)
                    else:
                        assert zs_decode(decoded[i],len(block),encoded[i],lengths[i])==len(block)

            encode()
            decode()
            assert all(decoded[i].raw==block for i,block in enumerate(blocks)), 'Round trip mismatch'
            for repetition in range(1,4):
                enc = measure(encode,len(data))
                dec = measure(decode,len(data))
                assert all(decoded[i].raw==block for i,block in enumerate(blocks)), 'Measured round trip mismatch'
                compressed = sum(lengths)
                ratio = compressed/len(data)
                output['samples'].append({'corpus':corpus,'chunk_bytes':chunk,'codec':name,
                    'repetition':repetition,'source_bytes':len(data),'compressed_bytes':compressed,
                    'stored_fraction':ratio,'encode':enc,'decode':dec,'roundtrip':'PASS',
                    'modeled_serial_ms_per_input_mib':{str(mbps):1000*(enc['cpu_seconds_per_mib']+
                        dec['cpu_seconds_per_mib']+ratio*MIB*8/(mbps*1e6)) for mbps in (100,1000,10000)}})
            print(f'PASS {corpus} {chunk} {name}: stored fraction {ratio:.3f}',flush=True)
output['status']='PASS'
print('RESULT_JSON '+json.dumps(output,separators=(',', ':')),flush=True)
