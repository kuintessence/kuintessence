"""Boundary fixtures for the checker; actual kernel tests live in the lab script."""
import importlib.machinery
import importlib.util
from pathlib import Path
import stat
from types import SimpleNamespace
import unittest
from unittest.mock import patch

loader = importlib.machinery.SourceFileLoader('checker', str(Path(__file__).with_name('kq-sandbox-cgroup-check')))
spec = importlib.util.spec_from_loader(loader.name, loader)
checker = importlib.util.module_from_spec(spec)
loader.exec_module(checker)


class BoundsTest(unittest.TestCase):
    def setUp(self):
        self.job = '/sys/fs/cgroup/scheduler/job_42'
        self.files = {
            '/proc/self/cgroup': '0::/scheduler/job_42/step_batch\n',
            '/proc/self/mountinfo': '1 0 0:1 / /sys/fs/cgroup rw - cgroup2 cgroup rw\n',
            self.job + '/memory.max': str(128 * checker.MIB),
            self.job + '/memory.swap.max': '0',
            self.job + '/cpu.max': '100000 100000',
            self.job + '/cpuset.cpus': '',
            '/sys/fs/cgroup/cgroup.threads': '',
            '/sys/fs/cgroup/cgroup.subtree_control': 'cpu memory cpuset',
        }
        self.insecure = {}

    def read(self, path, *args, **kwargs):
        if str(path) not in self.files:
            raise FileNotFoundError(str(path))
        return self.files[str(path)]

    def fact(self, path):
        name = str(path)
        default = (stat.S_IFREG | 0o644) if name in self.files or path.name == 'cgroup.procs' else (stat.S_IFDIR | 0o755)
        uid, mode = self.insecure.get(name, (0, default))
        return SimpleNamespace(st_uid=uid, st_mode=mode)

    def run_check(self, scheduler='slurm', job_id='42'):
        with patch.object(Path, 'read_text', lambda path: self.read(path)), patch.object(Path, 'lstat', lambda path: self.fact(path)), \
                patch.object(Path, 'exists', lambda path: str(path) in self.files):
            return checker.check(scheduler, job_id, 1, 128)

    def test_signed_upper_bounds_and_child_membership(self):
        self.assertEqual(self.run_check()['memoryBytes'], 128 * checker.MIB)
        self.files[self.job + '/cpu.max'] = '50000 100000'
        self.assertEqual(self.run_check()['cpuQuota'], [50000, 100000])

    def test_parent_container_limits_do_not_count(self):
        self.files['/sys/fs/cgroup/memory.max'] = str(128 * checker.MIB)
        self.files[self.job + '/memory.max'] = 'max'
        with self.assertRaises(ValueError):
            self.run_check()
        self.files[self.job + '/memory.max'] = str(128 * checker.MIB)
        self.files['/sys/fs/cgroup/cpu.max'] = '100000 100000'
        self.files[self.job + '/cpu.max'] = 'max 100000'
        self.files[self.job + '/cpuset.cpus.effective'] = '0'
        with self.assertRaisesRegex(ValueError, 'empty job cpuset'):
            self.run_check()

    def test_job_cpuset_alternative(self):
        self.files[self.job + '/cpu.max'] = 'max 100000'
        self.files[self.job + '/cpuset.cpus'] = '7'
        self.assertEqual(self.run_check()['cpusetCpus'], 1)
        for value in ['0-1', '1,1', '2-1', '2-', '-1', '0-2147483648']:
            with self.subTest(value=value):
                self.files[self.job + '/cpuset.cpus'] = value
                with self.assertRaises(ValueError):
                    self.run_check()

    def test_invalid_or_excessive_limits(self):
        for field, values in {
            'memory.max': ['max', '0', '-1', '1.5', str(128 * checker.MIB + 1)],
            'cpu.max': ['max 100000', '100001 100000', '1 0', '-1 100000', '1', '1 1 1'],
            'memory.swap.max': ['max', '1'],
        }.items():
            for value in values:
                with self.subTest(field=field, value=value), patch.dict(self.files, {self.job + '/' + field: value}):
                    with self.assertRaises(ValueError):
                        self.run_check()
        del self.files[self.job + '/memory.max']
        with self.assertRaises((ValueError, OSError)):
            self.run_check()

    def test_non_job_scope_wrong_job_and_hidden_job(self):
        for membership, mount in [
            ('0::/kubepods/pod\n', '/'),
            ('0::/scheduler/job_43/step_batch\n', '/'),
            ('0::/scheduler/job_42/job_42/step_batch\n', '/'),
            ('0::/scheduler/job_42/step_batch\n', '/scheduler/job_42/step_batch'),
            ('0::/scheduler/job_42/../step_batch\n', '/'),
        ]:
            with self.subTest(membership=membership, mount=mount), patch.dict(self.files, {
                '/proc/self/cgroup': membership,
                '/proc/self/mountinfo': f'1 0 0:1 {mount} /sys/fs/cgroup rw - cgroup2 cgroup rw\n',
            }):
                with self.assertRaises(ValueError):
                    self.run_check()

    def test_writable_controls_ancestors_and_symlinks(self):
        for path in [self.job, self.job + '/cpu.max', self.job + '/memory.max',
                     self.job + '/cgroup.procs', '/sys/fs/cgroup/scheduler', '/sys/fs/cgroup/cgroup.procs',
                     '/sys/fs/cgroup/cgroup.threads', '/sys/fs/cgroup/cgroup.subtree_control']:
            regular = path in self.files or path.endswith('procs')
            kind = stat.S_IFREG if regular else stat.S_IFDIR
            for uid, mode in [(1001, kind | 0o755), (0, kind | 0o777), (0, stat.S_IFLNK | 0o755)]:
                with self.subTest(path=path, uid=uid, mode=mode), patch.dict(self.insecure, {path: (uid, mode)}):
                    with self.assertRaises(ValueError):
                        self.run_check()

    def test_mount_ambiguity_and_wrong_filesystem(self):
        for value in [self.files['/proc/self/mountinfo'] * 2,
                      '1 0 0:1 / /sys/fs/cgroup rw - tmpfs tmpfs rw\n']:
            with patch.dict(self.files, {'/proc/self/mountinfo': value}):
                with self.assertRaises(ValueError):
                    self.run_check()

    def test_pbs_and_torque_job_scopes(self):
        for scheduler, parent in [('pbs-pro', 'jobid'), ('torque', 'torque')]:
            job = '/sys/fs/cgroup/scheduler/' + parent + '/0.host'
            values = {key.replace(self.job, job): value for key, value in self.files.items()}
            values['/proc/self/cgroup'] = f'0::/scheduler/{parent}/0.host/worker\n'
            with patch.dict(self.files, values):
                self.assertEqual(self.run_check(scheduler, '0.host')['jobId'], '0.host')

    def test_v1_independent_controllers_and_hierarchy(self):
        self.files = {
            '/proc/self/cgroup': '1:memory:/slurm/job_42/step_batch\n2:cpu,cpuacct:/slurm/job_42/step_batch\n',
            '/proc/self/mountinfo': '1 0 0:1 / /sys/fs/cgroup/memory rw - cgroup cgroup rw,memory\n2 0 0:2 / /sys/fs/cgroup/cpu rw - cgroup cgroup rw,cpu,cpuacct\n',
            '/proc/swaps': 'Filename Type Size Used Priority\n',
            '/sys/fs/cgroup/memory/slurm/job_42/memory.limit_in_bytes': str(128 * checker.MIB),
            '/sys/fs/cgroup/memory/slurm/job_42/memory.use_hierarchy': '1',
            '/sys/fs/cgroup/cpu/slurm/job_42/cpu.cfs_quota_us': '100000',
            '/sys/fs/cgroup/cpu/slurm/job_42/cpu.cfs_period_us': '100000',
        }
        self.assertEqual(self.run_check()['cgroupVersion'], 1)
        self.files['/proc/swaps'] += '/swap file 100000 0 -2\n'
        with self.assertRaises((ValueError, OSError)):
            self.run_check()
        self.files['/sys/fs/cgroup/memory/slurm/job_42/memory.memsw.limit_in_bytes'] = str(128 * checker.MIB)
        self.assertEqual(self.run_check()['cgroupVersion'], 1)
        self.files['/sys/fs/cgroup/memory/slurm/job_42/memory.memsw.limit_in_bytes'] = str(129 * checker.MIB)
        with self.assertRaisesRegex(ValueError, 'memory and swap'):
            self.run_check()
        self.files['/sys/fs/cgroup/memory/slurm/job_42/memory.use_hierarchy'] = '0'
        with self.assertRaisesRegex(ValueError, 'hierarchy disabled'):
            self.run_check()


if __name__ == '__main__':
    unittest.main()
