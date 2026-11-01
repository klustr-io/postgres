#!/usr/bin/env python3
"""Summarize observed top-level TAP assertions from preserved upstream logs."""
import argparse
import json
from pathlib import Path
import re

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument("artifacts", type=Path)
parser.add_argument("--output", type=Path, required=True)
args = parser.parse_args()
results = []
for file in sorted(args.artifacts.rglob("regress_log_*")):
    content = file.read_text(errors="replace")
    # PostgreSQL's logger prefixes each TAP line with wall time and elapsed time.
    lines = re.findall(r"^\[[^\n]+?\]\([^)]+\) (.*)$", content, re.MULTILINE)
    assertions = [match for line in lines if (match := re.match(r"(not ok|ok) (\d+)(.*)", line))]
    plans = [int(match[1]) for line in lines if (match := re.match(r"1\.\.(\d+)", line))]
    counts = {"passed": 0, "failed": 0, "skipped": 0, "todo": 0}
    for assertion in assertions:
        if re.search(r"#\s*SKIP\b", assertion[3], re.I):
            counts["skipped"] += 1
        elif re.search(r"#\s*TODO\b", assertion[3], re.I):
            counts["todo"] += 1
        else:
            counts["failed" if assertion[1] == "not ok" else "passed"] += 1
    bailouts = [line for line in lines if line.startswith("Bail out!")]
    complete = bool(plans) and plans[-1] == len(assertions)
    status = "FAIL" if bailouts or counts["failed"] or (assertions and not complete) else "PASS" if complete and assertions else "SKIP"
    results.append({"log": str(file), "status": status, "planned": plans[-1] if plans else None,
                    "observed": len(assertions), **counts, "bailouts": bailouts})
assert results, "No preserved TAP logs found"
args.output.parent.mkdir(parents=True, exist_ok=True)
args.output.write_text(json.dumps({"assertion_scope": "top-level TAP assertions, excluding nested subtest internals",
    "files": results}, indent=2) + "\n")
print(json.dumps({status: sum(row["status"] == status for row in results) for status in ["PASS", "FAIL", "SKIP"]}))
for row in results:
    if row["status"] == "FAIL":
        print(json.dumps(row))
