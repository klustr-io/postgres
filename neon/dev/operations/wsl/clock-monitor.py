#!/usr/bin/env python3
"""Detect wall-clock steps that invalidate PostgreSQL restart/timestamp tests."""
import argparse
import datetime as dt
import json
from pathlib import Path
import subprocess
import time

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument("--seconds", type=float, default=60)
parser.add_argument("--output", type=Path)
parser.add_argument("command", nargs=argparse.REMAINDER,
                    help="command after --; monitor for its entire duration")
args = parser.parse_args()
if args.seconds <= 0:
    parser.error("seconds must be positive")
started = time.monotonic()
wall, mono = time.time(), started
steps = []
command = args.command[1:] if args.command[:1] == ["--"] else args.command
process = subprocess.Popen(command) if command else None
while True:
    if process:
        if process.poll() is not None:
            break
    elif time.monotonic() - started >= args.seconds:
        break
    time.sleep(0.2)
    next_wall, next_mono = time.time(), time.monotonic()
    delta = (next_wall - wall) - (next_mono - mono)
    if abs(delta) > 0.5:
        steps.append({"observed_at": dt.datetime.fromtimestamp(next_wall, dt.timezone.utc).isoformat(),
                      "wall_clock_step_seconds": delta})
    wall, mono = next_wall, next_mono
code = process.wait() if process else 0
result = {"duration_seconds": round(time.monotonic() - started, 3), "steps": steps,
          "command_exit_code": code, "status": "FAIL" if steps or code else "PASS"}
if args.output:
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(result, indent=2) + "\n")
print(json.dumps(result, indent=2))
raise SystemExit(code if code else (1 if steps else 0))
