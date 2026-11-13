import importlib.util
from pathlib import Path
from types import SimpleNamespace
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('hook', Path(__file__).with_name('kq-cgroup-v2.py'))
hook = importlib.util.module_from_spec(spec)
spec.loader.exec_module(hook)


class HookTest(unittest.TestCase):
    def test_pbs_allocated_resources_are_used(self):
        job = SimpleNamespace(exec_vnode='(node-1:ncpus=2:mem=131072kb:mpiprocs=1:ompthreads=2)')
        self.assertEqual(hook.limits(job), {'cpu.max': '200000 100000',
                                         'memory.max': str(128 * 1024 ** 2), 'memory.swap.max': '0'})

    def test_unsupported_or_invalid_allocations_are_rejected(self):
        for value in ['None', '(node:ncpus=0:mem=1kb)', '(node:ncpus=-1:mem=1kb)',
                      '(node:ncpus=2147483648:mem=1kb)', '(node:ncpus=1:mem=0kb)',
                      '(node:ncpus=1:mem=1mb)', '(node:ncpus=1:mem=1kb:ngpus=1)',
                      '(node:ncpus=1:mem=1kb)+(other:ncpus=1:mem=1kb)',
                      '(node:ncpus=1:ncpus=2:mem=1kb)', '(node:mem=1kb)',
                      '(node:ncpus=1)', '(node:ncpus=1.5:mem=1kb)']:
            with self.subTest(value=value), self.assertRaises(ValueError):
                hook.resources(SimpleNamespace(exec_vnode=value))

    def test_other_queues_do_not_create_or_change_groups(self):
        event = SimpleNamespace(job=SimpleNamespace(id='0.host', queue='ordinary'))
        with patch.object(hook.os, 'geteuid', return_value=0), \
                patch.object(hook, 'settings', return_value=(Path('/kernel/jobid'), ['sandbox'])), \
                patch.object(Path, 'exists', return_value=False), patch.object(hook.os, 'open') as opened:
            hook.handle(event, SimpleNamespace())
            opened.assert_not_called()

    def test_existing_processes_block_reused_job_group(self):
        with patch.object(hook, 'parents'), patch.object(Path, 'exists', return_value=True), \
                patch.object(hook, 'populated', return_value=True), \
                patch.object(Path, 'write_text') as write:
            with self.assertRaisesRegex(ValueError, 'previous PBS job'):
                hook.prepare(Path('/test/0.host'), SimpleNamespace(exec_vnode='(node:ncpus=1:mem=1kb)'))
            write.assert_not_called()

    def test_attach_rechecks_limits_before_moving_process(self):
        job = SimpleNamespace(exec_vnode='(node:ncpus=1:mem=1kb)')
        with patch.object(hook, 'parents'), patch.object(hook, 'secure'), \
                patch.object(Path, 'read_text', return_value='200000 100000'), \
                patch.object(Path, 'write_text') as write:
            with self.assertRaisesRegex(ValueError, 'limits drifted'):
                hook.attach(Path('/test/0.host'), job, 42)
            write.assert_not_called()

    def test_cleanup_never_removes_a_populated_group(self):
        with patch.object(hook, 'parents'), patch.object(hook, 'secure'), \
                patch.object(Path, 'exists', return_value=True), \
                patch.object(hook, 'populated', return_value=True), \
                patch.object(hook.time, 'monotonic', side_effect=[0, 3]), \
                patch.object(Path, 'write_text') as write, patch.object(Path, 'rmdir') as remove:
            with self.assertRaisesRegex(ValueError, 'did not stop'):
                hook.finish(Path('/test/0.host'))
            write.assert_called_once_with('1')
            remove.assert_not_called()


if __name__ == '__main__':
    unittest.main()
