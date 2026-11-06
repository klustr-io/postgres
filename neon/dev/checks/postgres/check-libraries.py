#!/usr/bin/env python3
"""Fail if any installed ELF binary or extension has unresolved libraries."""
from pathlib import Path
import subprocess
import sys

count = 0
for path in sorted(Path(sys.argv[1]).rglob("*")):
    if not path.is_file() or path.is_symlink():
        continue
    with path.open("rb") as stream:
        if stream.read(4) != b"\x7fELF":
            continue
    result = subprocess.run(["ldd", str(path)], text=True, capture_output=True)
    print(f"{path}:\n{result.stdout}{result.stderr}")
    if "not found" in result.stdout or result.returncode:
        sys.exit(f"Cannot resolve runtime dependencies: {path}")
    count += 1
assert count > 0, "No installed ELF binaries found"
print(f"Checked {count} ELF binaries/modules; no missing libraries")
