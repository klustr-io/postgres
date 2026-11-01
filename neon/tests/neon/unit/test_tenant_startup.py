import subprocess
import tempfile
from pathlib import Path
import unittest
from tenant_startup import create_tenant, TENANT, TIMELINE


class TenantStartupTests(unittest.TestCase):
    def test_attaching_resumes_same_timeline_without_recreating_tenant(self):
        with tempfile.TemporaryDirectory() as directory:
            logs, commands = Path(directory), []
            def run(command, name, timeout):
                commands.append(command)
                self.assertGreater(timeout, 0)
                if len(commands) <= 2:
                    (logs/(name+'.log')).write_text(
                        f'tenant {TENANT} successfully created on the pageserver\n'
                        'Timed out waiting 5s for tenant active state. Latest state: Some(Attaching)')
                    raise AssertionError('CLI not ready')
                return ''
            result = create_tenant(run, logs, 64, 30)
            self.assertEqual(result['timeline_resume_attempts'], 2)
            self.assertEqual(sum(c[1:3] == ['tenant', 'create'] for c in commands), 1)
            for command in commands[:-1]:
                self.assertEqual(command[command.index('--tenant-id')+1], TENANT)
                self.assertEqual(command[command.index('--timeline-id')+1], TIMELINE)
            self.assertEqual(commands[-1][1:3], ['tenant', 'set-default'])

    def test_permission_failure_is_not_retried(self):
        with tempfile.TemporaryDirectory() as directory:
            logs, commands = Path(directory), []
            def run(command, name, timeout):
                commands.append(command)
                (logs/(name+'.log')).write_text(f'tenant {TENANT} successfully created on the pageserver\nHTTP 403 forbidden')
                raise AssertionError('forbidden')
            with self.assertRaisesRegex(AssertionError, 'forbidden'):
                create_tenant(run, logs, 64, 30)
            self.assertEqual(len(commands), 1)

    def test_unknown_timeout_is_not_retried(self):
        with tempfile.TemporaryDirectory() as directory:
            commands = []
            def run(command, name, timeout):
                commands.append(command)
                raise subprocess.TimeoutExpired(command, timeout)
            with self.assertRaises(subprocess.TimeoutExpired):
                create_tenant(run, Path(directory), 64, 30)
            self.assertEqual(len(commands), 1)

    def test_successful_create_preserves_checkpoint_configuration(self):
        with tempfile.TemporaryDirectory() as directory:
            commands = []
            def run(command, name, timeout):
                commands.append(command)
                return ''
            result = create_tenant(run, Path(directory), 128, 45)
            self.assertEqual(result['timeline_resume_attempts'], 0)
            self.assertIn('checkpoint_distance:134217728', commands[0])
            self.assertIn('checkpoint_timeout:45s', commands[0])
            self.assertEqual(len(commands), 2)


if __name__ == '__main__':
    unittest.main()
