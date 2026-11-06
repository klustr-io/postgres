#!/usr/bin/env python3
"""Execute a qualification command and preserve output, timing and exit status."""
import argparse
import datetime as dt
import json
import os
from pathlib import Path
import subprocess
import sys
import time


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--name", required=True)
    parser.add_argument("--reports", default=os.environ.get("REPORT_DIR", "neon/tests/reports/local"))
    parser.add_argument("command", nargs=argparse.REMAINDER)
    args = parser.parse_args()
    command = args.command[1:] if args.command[:1] == ["--"] else args.command
    if not command:
        parser.error("a command is required")
    reports = Path(args.reports).resolve()
    reports.mkdir(parents=True, exist_ok=True)
    stamp = dt.datetime.now(dt.timezone.utc).strftime("%Y%m%dT%H%M%S%fZ")
    stem = f"{stamp}-{args.name}"
    start = dt.datetime.now(dt.timezone.utc)
    clock = time.monotonic()
    logfile = reports / f"{stem}.log"
    with logfile.open("wb") as output:
        output.write(("COMMAND " + json.dumps(command) + "\n").encode())
        output.flush()
        try:
            result = subprocess.run(command, stdout=output, stderr=subprocess.STDOUT)
            code = result.returncode
        except OSError as error:
            output.write((str(error) + "\n").encode())
            code = 127
    record = {
        "name": args.name, "command": command, "cwd": os.getcwd(),
        "started_at": start.isoformat(),
        "completed_at": dt.datetime.now(dt.timezone.utc).isoformat(),
        "duration_seconds": round(time.monotonic() - clock, 3),
        "exit_code": code, "status": "PASS" if code == 0 else "FAIL",
        "log": logfile.name,
    }
    (reports / f"{stem}.json").write_text(json.dumps(record, indent=2) + "\n")
    print(json.dumps(record), flush=True)
    if code:
        print(logfile.read_text(errors="replace")[-16000:], file=sys.stderr)
    return code if code >= 0 else 128 - code


if __name__ == "__main__":
    sys.exit(main())
