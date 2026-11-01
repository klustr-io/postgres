#!/usr/bin/env python3
"""Generate local-only credentials without replacing an existing environment."""
import os
from pathlib import Path
import secrets
import re

target = Path(__file__).resolve().parents[3] / "neon/dev/.env"
version = re.search(r"AC_INIT\(\[PostgreSQL\], \[([^\]]+)\]", (Path(__file__).resolve().parents[3] / "configure.ac").read_text())[1]
with target.open("x") as output:
    os.chmod(target, 0o600)
    output.write("# Local development only. Never commit this file.\n")
    output.write("POSTGRES_USER=klustr_dev\nPOSTGRES_DB=klustr_dev\nPGPORT=55418\n")
    output.write(f"PG_IMAGE=klustr-postgres:{version}-dev\n")
    output.write(f"POSTGRES_PASSWORD={secrets.token_hex(24)}\n")
print(f"Created {target}; credential values are not logged.")
