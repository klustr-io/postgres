#!/usr/bin/env python3
"""Export tracked source plus development tooling as an LF-safe OCI context.

Git's archive avoids Windows checkout line endings. Overlay tracked edits and
only the explicitly named tooling directories, excluding credentials/reports.
"""
import io
from pathlib import Path
import subprocess
import tarfile
import tempfile

root = Path(__file__).resolve().parents[4]
archive = subprocess.check_output(["git", "-c", "core.autocrlf=false", "archive", "HEAD"], cwd=root)
overlay = {".dockerignore", "neon/Makefile"}
changed = subprocess.check_output(["git", "-c", "core.autocrlf=true", "diff", "HEAD", "--name-only"], cwd=root, text=True)
overlay.update(changed.splitlines())
added_source = subprocess.check_output(["git", "ls-files", "--others", "--exclude-standard", "--", "src", "contrib"], cwd=root, text=True)
overlay.update(added_source.splitlines())
for directory in ("neon/dev", "neon/packaging", "neon/tests", "neon/docs/qualification"):
    folder = root / directory
    if folder.exists():
        overlay.update(str(p.relative_to(root)).replace("\\", "/") for p in folder.rglob("*") if p.is_file())

def included(name):
    return not (name.startswith("neon/tests/reports/") or name == "neon/dev/.env" or
                "/__pycache__/" in name or name.startswith("neon/dev/.venv/"))

overlay = {p for p in overlay if included(p)}
output = root / "build/oci-context.tar"
output.parent.mkdir(exist_ok=True)
with tarfile.open(fileobj=io.BytesIO(archive)) as original, tarfile.open(output, "w") as result:
    for member in original:
        if member.name in overlay:
            continue
        result.addfile(member, original.extractfile(member) if member.isfile() else None)
    for name in sorted(overlay):
        path = root / name
        if not path.is_file():
            continue
        data = path.read_bytes()
        # Restore git's LF convention for changed text from a Windows checkout.
        if b"\x00" not in data:
            data = data.replace(b"\r\n", b"\n")
        info = tarfile.TarInfo(name)
        info.size = len(data)
        info.mode = 0o755 if path.suffix == ".sh" else 0o644
        result.addfile(info, io.BytesIO(data))
print(f"OCI context: {output} ({output.stat().st_size} bytes)")
context = Path(tempfile.mkdtemp(prefix="oci-context-", dir=root / "build"))
with tarfile.open(output) as stream:
    stream.extractall(context, filter="data")
(root / "build/oci-context-path").write_text(str(context.relative_to(root)) + "\n")
print(f"Extracted context: {context}")
