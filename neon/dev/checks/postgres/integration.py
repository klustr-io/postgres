#!/usr/bin/env python3
"""Load ignored local credentials and run tests without logging secrets."""
import os
import re
from pathlib import Path
import subprocess
import sys

root = Path(__file__).resolve().parents[4]
settings = {}
local = root / "neon/dev/.env"
if local.exists():
    for line in local.read_text().splitlines():
        if line and not line.startswith("#"):
            key, value = line.split("=", 1)
            settings[key] = value
mapping = {"PGUSER": "POSTGRES_USER", "PGDATABASE": "POSTGRES_DB", "PGPASSWORD": "POSTGRES_PASSWORD", "PGPORT": "PGPORT"}
for variable, source in mapping.items():
    if variable not in os.environ and source in settings:
        os.environ[variable] = settings[source]
os.environ.setdefault("PGHOST", "127.0.0.1")
os.environ.setdefault("PG_EXPECTED_VERSION", re.search(r"AC_INIT\(\[PostgreSQL\], \[([^\]]+)\]", (root / "configure.ac").read_text())[1])
reports = Path(os.environ.get("REPORT_DIR", root / "neon/tests/reports/local"))
reports.mkdir(parents=True, exist_ok=True)
sys.exit(subprocess.call([sys.executable, "-m", "pytest", "-v", "--tb=short", str(root / "neon/tests/integration"), f"--junitxml={reports}/integration.xml", *sys.argv[1:]]))
