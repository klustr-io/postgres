#!/usr/bin/env python3
"""Verify an authenticated WSL localhost connection using the fork's psql."""
import os
from pathlib import Path
import subprocess
import sys

root = Path(__file__).resolve().parents[4]
settings = dict(line.split("=",1) for line in (root / "neon/dev/.env").read_text().splitlines() if line and not line.startswith("#"))
environment = {**os.environ,"PGHOST":"127.0.0.1","PGPORT":settings.get("PGPORT","55418"),
               "PGUSER":settings["POSTGRES_USER"],"PGDATABASE":settings["POSTGRES_DB"],
               "PGPASSWORD":settings["POSTGRES_PASSWORD"],"PGCONNECT_TIMEOUT":"5"}
binary = Path(os.environ.get("PGBIN",root / "build/debug/install/bin")) / "psql"
result = subprocess.run([str(binary),"-XAtw","-v","ON_ERROR_STOP=1","-c","SELECT 1; SELECT current_user; SELECT version();"],env=environment)
sys.exit(result.returncode)
