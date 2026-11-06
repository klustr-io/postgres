"""Resume only a confirmed not-yet-active tenant's initial timeline creation."""
import time

TENANT = '20000000000000000000000000000001'
TIMELINE = '30000000000000000000000000000001'


def create_tenant(run, logs, checkpoint_mib, checkpoint_seconds, budget_seconds=90):
    assert budget_seconds > 0
    began = time.monotonic()
    deadline = began+budget_seconds
    retries = 0

    def invoke(arguments, name):
        remaining = deadline-time.monotonic()
        assert remaining > 0, 'Tenant activation retry budget exhausted'
        return run(['neon_local', *arguments], name, timeout=remaining)

    def attaching(name):
        path = logs/(name+'.log')
        if not path.exists():
            return False
        detail = path.read_text()
        return ('Timed out waiting 5s for tenant active state' in detail and
                'Latest state: Some(Attaching)' in detail)

    create_name = 'tenant-startup-create'
    try:
        invoke(['tenant', 'create', '--tenant-id', TENANT, '--timeline-id', TIMELINE,
                '--pg-version', '18', '--set-default', '-c', f'checkpoint_distance:{checkpoint_mib*1048576}',
                '-c', f'checkpoint_timeout:{checkpoint_seconds}s'], create_name)
    except AssertionError:
        # The server rejects timeline creation while the tenant is Attaching,
        # before creating that timeline. Do not retry tenant creation itself.
        path = logs/(create_name+'.log')
        if not path.exists():
            raise
        detail = path.read_text()
        if f'tenant {TENANT} successfully created on the pageserver' not in detail or not attaching(create_name):
            raise
        while True:
            retries += 1
            name = f'tenant-startup-timeline-resume-{retries}'
            try:
                invoke(['timeline', 'create', '--tenant-id', TENANT, '--timeline-id', TIMELINE,
                        '--branch-name', 'main', '--pg-version', '18'], name)
                break
            except AssertionError:
                if not attaching(name):
                    raise
                assert time.monotonic() < deadline, 'Tenant never became active'
                time.sleep(min(.25, max(0, deadline-time.monotonic())))
    invoke(['tenant', 'set-default', '--tenant-id', TENANT], 'tenant-startup-set-default')
    return {'status': 'PASS', 'tenant_id': TENANT, 'timeline_id': TIMELINE,
            'timeline_resume_attempts': retries, 'seconds': time.monotonic()-began,
            'scope': 'New-tenant setup only; no retry after unknown outcomes, permission errors or other failures. No wake latency relaxation.'}
