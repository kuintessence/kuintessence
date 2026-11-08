#!/usr/bin/python3
"""Disposable kernel proof for the checker; this is not a scheduler integration test."""
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import uuid

REPO = Path(__file__).resolve().parents[1]
CHECKER = REPO / 'packages/agent/scripts/kq-sandbox-cgroup-check'


def inside():
    group = Path('/proc/self/cgroup').read_text().strip()
    assert group.startswith('0::/system.slice/kq-sandbox-cgroup-lab-') and group.endswith('.service')
    root = Path('/sys/fs/cgroup') / group[4:]
    assert (root / 'memory.max').read_text().strip() == str(256 * 1024 ** 2)
    manager = root / 'manager'
    manager.mkdir()
    (manager / 'cgroup.procs').write_text(str(os.getpid()))
    (root / 'cgroup.subtree_control').write_text('+cpu +memory +cpuset')
    directory = Path(tempfile.mkdtemp(prefix='kq-sandbox-cgroup-lab-', dir='/var/lib'))
    directory.chmod(0o755)
    checker = directory / 'checker'
    shutil.copyfile(CHECKER, checker)
    checker.chmod(0o755)
    paths = [manager]

    def run(group, command, expected=0):
        def child():
            (group / 'cgroup.procs').write_text(str(os.getpid()))
            os.setgroups([])
            os.setgid(65534)
            os.setuid(65534)
        result = subprocess.run(command, preexec_fn=child, cwd='/', env={'PATH': '/usr/bin:/bin'},
                                capture_output=True, text=True, timeout=10)
        assert result.returncode == expected, (command, result.returncode, result.stdout, result.stderr)
        return result.stdout

    def check(group, scheduler='slurm', job_id='42', expected=0):
        return run(group, ['/usr/bin/python3', str(checker), '--scheduler', scheduler,
                          '--job-id', job_id, '--cpus', '1', '--memory-mb', '64'], expected)

    def create(relative):
        job = root
        for component in relative.split('/'):
            job = job / component
            job.mkdir()
            paths.append(job)
            if component in ('jobid', 'torque'):
                (job / 'cgroup.subtree_control').write_text('+cpu +memory +cpuset')
        (job / 'memory.max').write_text(str(64 * 1024 ** 2))
        (job / 'memory.swap.max').write_text('0')
        (job / 'cpu.max').write_text('25000 100000')
        (job / 'cgroup.subtree_control').write_text('+cpu +memory +cpuset')
        child = job / 'step_batch'
        child.mkdir()
        paths.append(child)
        return job, child

    try:
        job, child = create('job_42')
        print('BOUNDS', check(child), flush=True)
        check(manager, expected=126)
        check(child, job_id='43', expected=126)
        (job / 'memory.max').write_text(str(65 * 1024 ** 2))
        check(child, expected=126)
        (job / 'memory.max').write_text(str(64 * 1024 ** 2))
        (job / 'cpu.max').write_text('max 100000')
        check(child, expected=126)
        available = (job / 'cpuset.cpus.effective').read_text().strip().split(',')[0].split('-')[0]
        (job / 'cpuset.cpus').write_text(available)
        print('CPUSET', check(child), flush=True)
        (job / 'cpuset.cpus').write_text('')
        (job / 'cpu.max').write_text('25000 100000')
        (job / 'cpu.max').chmod(0o666)
        check(child, expected=126)
        (job / 'cpu.max').chmod(0o644)
        job.chmod(0o777)
        check(child, expected=126)
        job.chmod(0o755)
        run(child, ['/usr/bin/python3', '-c',
                    "from pathlib import Path\ntry:\n Path(" + repr(str(root / 'cgroup.procs')) + ").write_text('0')\nexcept PermissionError:\n pass\nelse:\n raise Exception('escaped job cgroup')"])
        print('NEGATIVE parent-only, wrong job, excess memory, inherited cpuset, writable controls, escape: passed', flush=True)
        before = dict(line.split() for line in (job / 'cpu.stat').read_text().splitlines())
        run(child, ['/usr/bin/python3', '-c', 'import os,time\npid=os.fork()\nend=time.monotonic()+1.5\nwhile time.monotonic()<end: pass\nif pid: os.waitpid(pid,0)'])
        after = dict(line.split() for line in (job / 'cpu.stat').read_text().splitlines())
        assert int(after['nr_throttled']) > int(before['nr_throttled'])
        print('CPU_THROTTLED', int(after['nr_throttled']) - int(before['nr_throttled']), flush=True)
        run(child, ['/usr/bin/python3', '-c', 'a=bytearray(128*1024*1024); print(len(a))'], expected=-9)
        events = dict(line.split() for line in (job / 'memory.events').read_text().splitlines())
        assert int(events['oom_kill']) > 0
        print('JOB_OOM_KILL', events['oom_kill'], flush=True)
        for scheduler, path in [('pbs-pro', 'jobid/0.host'), ('torque', 'torque/0.host')]:
            _, child = create(path)
            print('LAYOUT', scheduler, check(child, scheduler, '0.host'), flush=True)
        print('KERNEL CHECK PASSED (no Slurm/PBS/Torque scheduler was started)', flush=True)
    finally:
        try:
            for path in reversed(paths):
                if path == manager:
                    continue
                if (path / 'cgroup.kill').exists():
                    (path / 'cgroup.kill').write_text('1')
                path.rmdir()
        finally:
            shutil.rmtree(directory)


def main():
    assert os.geteuid() == 0 and os.environ.get('KQ_TEST_CGROUP_LIMITS') == '1', 'Explicit root local kernel lab opt-in required'
    if sys.argv[1:] == ['--inside']:
        inside()
        return
    assert len(sys.argv) == 1
    unit = 'kq-sandbox-cgroup-lab-' + uuid.uuid4().hex
    try:
        subprocess.run(['/usr/bin/systemd-run', '--quiet', '--wait', '--pipe', '--collect', '--unit=' + unit,
                        '--property=Delegate=yes', '--property=CPUQuota=100%', '--property=MemoryMax=256M',
                        '--property=MemorySwapMax=0', '--property=TasksMax=32', '--property=RuntimeMaxSec=45',
                        '--property=KillMode=control-group', '--property=TimeoutStopSec=2',
                        '--setenv=KQ_TEST_CGROUP_LIMITS=1', '--setenv=PYTHONDONTWRITEBYTECODE=1',
                        '/usr/bin/python3', str(Path(__file__).resolve()), '--inside'], check=True, timeout=60)
    finally:
        subprocess.run(['/usr/bin/systemctl', 'stop', unit + '.service'], capture_output=True, timeout=10)
        result = subprocess.run(['/usr/bin/systemctl', 'show', unit + '.service', '-p', 'ActiveState', '--value'],
                                capture_output=True, text=True, timeout=10)
        assert result.stdout.strip() in ('inactive', 'failed'), result.stdout
        print('CLEANED disposable systemd unit', flush=True)


if __name__ == '__main__':
    main()
