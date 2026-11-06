#!/usr/bin/env python3
"""Compare the explicit native source export with the current source changes."""
import hashlib
import json
import os
from pathlib import Path
import subprocess

root = Path(__file__).resolve().parents[4]
target = Path(os.environ["BUILD_SOURCE"])
paths = ["src", "contrib", "configure", "configure.ac", "meson.build", "meson_options.txt"]
def git(*args):
    return subprocess.check_output(["git", "-c", "core.autocrlf=true", *args], cwd=root, text=True).strip()

revision = git("rev-parse", "HEAD")
assert (target / ".qualification-source-sha").read_text().strip() == revision
names = {"configure", "configure.ac"}
for arguments in (("diff", "--name-only", "HEAD", "--", *paths),
                  ("ls-files", "--others", "--exclude-standard", "--", *paths)):
    names.update(filter(None, git(*arguments).splitlines()))
manifest = []
for name in sorted(names):
    current = (root / name).read_bytes().replace(b"\r\n", b"\n")
    exported = (target / name).read_bytes()
    assert current == exported, f"Native source export differs: {name}"
    manifest.append({"path": name, "sha256": hashlib.sha256(exported).hexdigest()})
reports = Path(os.environ.get("REPORT_DIR", root / "neon/tests/reports/local"))
reports.mkdir(parents=True, exist_ok=True)
(reports / "native-source-manifest.json").write_text(json.dumps({"base_sha": revision,
    "source_directory": str(target), "files": manifest}, indent=2) + "\n")
print(f"Verified base SHA and all {len(manifest)} changed/added native source files against the checkout.")
