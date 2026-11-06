#!/usr/bin/env python3
"""Preserve native test diagnostics and summarize observed TAP/SQL counts."""
import json
import os
from pathlib import Path
import re
import shutil

root = Path(__file__).resolve().parents[3]
build = Path(os.environ.get("BUILD_ROOT", root / "build")) / "debug"
reports = Path(os.environ.get("REPORT_DIR", root / "neon/tests/reports/local"))
destination = reports / os.environ.get("NATIVE_ARTIFACT_LABEL", "native-artifacts")
count = 0
for source in build.rglob("*"):
    if not source.is_file() or source.is_symlink():
        continue
    if source.suffix == ".log" or source.name in ("regression.diffs", "regression.out") or source.name.startswith("regress_log_"):
        target = destination / source.relative_to(build)
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(source, target)
        count += 1
summary = []
for logfile in sorted(reports.glob("*native-*.log")):
    text = logfile.read_text(errors="replace")
    summary.append({"log": logfile.name,
        "sql_suites": [int(n) for n in re.findall(r"All (\d+) tests passed", text)],
        "tap_summaries": re.findall(r"Files=\d+, Tests=\d+[^\n]*", text),
        "tap_results": re.findall(r"Result: (?:PASS|FAIL)", text),
        "skips": re.findall(r"[^\n]*(?:skipped:|skip_all|SKIP)[^\n]*", text),
        "failures": re.findall(r"[^\n]*(?:not ok |Non-zero exit|FAILED--|Error \d)[^\n]*", text)})
(reports / "native-summary.json").write_text(json.dumps(summary,indent=2) + "\n")
print(f"Copied {count} diagnostic files to {destination}")
