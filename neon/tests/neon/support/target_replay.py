"""Select an exact tenant/timeline before checking a replay frontier."""
import re

def canonical_wal_end(cursor,segment_size,block_size=8192):
    """PG18/AMD64 next-record cursor -> generated end, before empty headers."""
    assert re.fullmatch(r'[0-9A-Fa-f]+/[0-9A-Fa-f]+',cursor)
    high,low=cursor.split('/');value=(int(high,16)<<32)+int(low,16)
    offset=value%segment_size
    if offset==40:value-=40
    elif offset>=block_size and value%block_size==24:value-=24
    return f'{value>>32:X}/{value&0xffffffff:X}'

def generated_wal_executor(execute):
    def query(statement):
        value=execute(statement)
        if statement=='SELECT pg_current_wal_insert_lsn()':
            return canonical_wal_end(value,int(execute("SELECT pg_size_bytes(current_setting('wal_segment_size'))")),
              int(execute("SELECT setting FROM pg_settings WHERE name='wal_block_size'")))
        return value
    return query


def select_timeline_metrics(body,tenant,timeline):
    assert re.fullmatch(r'[a-f0-9]{32}',tenant)
    assert re.fullmatch(r'[a-f0-9]{32}',timeline)
    selected=[line for line in body.splitlines()
              if line.startswith('pageserver_last_record_lsn{')
              and f'tenant_id="{tenant}"' in line and f'timeline_id="{timeline}"' in line]
    assert len(selected)==1,'Expected one exact tenant/timeline replay frontier'
    return '\n'.join(selected)+'\n'
