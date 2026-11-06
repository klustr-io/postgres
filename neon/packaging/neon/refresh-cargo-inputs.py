#!/usr/bin/env python3
"""Restore content-checked source mtimes for Cargo's development target cache.

Source archives intentionally use stable timestamps. Cargo freshness uses
mtimes, so a changed file must get a new timestamp before reusing a target
cache. Unchanged files retain their previously recorded times. Release clean
builds use a separate cache namespace derived from the complete input digest.
"""
import hashlib
import json
import os
from pathlib import Path
import time

source = Path('/source')
state_file = source / 'target/.klustr-source-mtimes.json'
previous = json.loads(state_file.read_text()) if state_file.exists() else {}
current = {}
changed = 0
for directory, names, files in os.walk(source):
    names[:] = [name for name in names if name not in ('target', 'build', '.git')]
    for name in files:
        path = Path(directory) / name
        if path.is_symlink() or not path.is_file():
            continue
        relative = path.relative_to(source).as_posix()
        digest = hashlib.file_digest(path.open('rb'), 'sha256').hexdigest()
        prior = previous.get(relative, {})
        stamp = prior['mtime_ns'] if prior.get('sha256') == digest else time.time_ns()
        changed += prior.get('sha256') != digest
        os.utime(path, ns=(stamp, stamp))
        current[relative] = {'sha256': digest, 'mtime_ns': stamp}
state_file.parent.mkdir(exist_ok=True)
state_file.write_text(json.dumps(current, sort_keys=True) + '\n')
print(f'Content-checked {len(current)} source inputs; refreshed {changed} changed timestamps.', flush=True)
