#!/usr/bin/env python3
"""Run independent native suites sequentially; return failure if any fail."""
import os
from pathlib import Path
import subprocess
import sys

root = Path(__file__).resolve().parents[4]
build = Path(os.environ.get("BUILD_ROOT", root / "build")) / "debug"
suites = {
    "initdb": "src/bin/initdb", "authentication": "src/test/authentication",
    "ssl": "src/test/ssl", "pgbench-tap": "src/bin/pgbench",
    "injection-points": "src/test/modules/injection_points", "isolation": "src/test/isolation",
}
selected = sys.argv[1:] or list(suites)
results = []
for name in selected:
    command = [sys.executable, str(root / "neon/dev/reporting/record.py"), "--name", f"final-native-{name}",
               "--", "timeout", "300", "make", "-C", str(build / suites[name]), "check"]
    results.append(subprocess.call(command, env={**os.environ, "PG_TEST_EXTRA": "ssl"}))
sys.exit(1 if any(results) else 0)
