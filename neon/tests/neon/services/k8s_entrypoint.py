"""Keep the Pod available for evidence collection after the test child exits."""
import json
import os
from pathlib import Path
import signal
import sys
import time

phase = os.environ.get('NEON_QUALIFICATION_PHASE', 'primary')
signal.signal(signal.SIGTERM, lambda *_args: sys.exit(143))
child = os.fork()
if child == 0:
    os.execv(sys.executable, [sys.executable, '/qualification/check_pg18_distributed.py'])
# Act as PID 1: reap orphaned Neon daemons while preserving the actual test
# child's exit status. A generic waitpid reaper thread could steal that status.
while True:
    reaped, status = os.waitpid(-1, 0)
    if reaped == child:
        code = os.waitstatus_to_exitcode(status)
        break
target = Path('/var/lib/neon') / (phase + '-phase-status.json')
temporary = target.with_suffix('.tmp')
temporary.write_text(json.dumps({'phase': phase, 'exit_code': code,
                                 'status': 'PASS' if code == 0 else 'FAIL'}))
temporary.replace(target)
print('QUALIFICATION PHASE ' + phase + ': ' + ('PASS' if code == 0 else 'FAIL'), flush=True)
while True:
    try:
        os.waitpid(-1, os.WNOHANG)
    except ChildProcessError:
        pass
    time.sleep(1)
