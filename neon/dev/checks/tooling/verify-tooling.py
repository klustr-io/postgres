#!/usr/bin/env python3
"""Static Python/shell/YAML checks; no database or credentials are accessed."""
import ast
from pathlib import Path
import subprocess

root = Path(__file__).resolve().parents[4]
def sources_under(directory, suffix):
    for source in directory.rglob("*" + suffix):
        if not any(part in {".venv", "__pycache__"} for part in source.relative_to(directory).parts):
            yield source


for directory in (root / "neon/dev", root / "neon/tests/integration", root / "neon/tests/neon", root / "neon/packaging/neon"):
    for source in sources_under(directory, ".py"):
        ast.parse(source.read_text(), filename=str(source))
for source in (root / "neon/tests").glob("*.py"):
    ast.parse(source.read_text(), filename=str(source))
for source in sources_under(root / "neon/dev", ".sh"):
    subprocess.run(["bash", "-n", str(source)], check=True)
subprocess.run(["bash", "-n", str(root / "neon/packaging/docker/postgres/entrypoint.sh")], check=True)
import yaml
neon_workflow = yaml.safe_load((root / ".github/workflows/neon-pg18-candidate.yml").read_text())
assert neon_workflow["permissions"] == {"contents": "read"}
assert set(neon_workflow["jobs"]) == {"build"}
compose = yaml.safe_load((root / "neon/dev/operations/docker/compose.yaml").read_text())
assert compose["services"]["postgres"]["ports"][0].startswith("127.0.0.1:")
assert compose["volumes"]["pg18-dev-data"]["name"] == "klustr-pg18-dev-data"
print("Python AST, bash syntax, YAML structure and least-privilege/loopback configuration checks passed.")
