"""Root PBS MOM hook for explicitly configured, single-vnode CPU queues."""
import fcntl
import json
import os
from pathlib import Path
import re
import stat
import time

CONFIG = Path('/etc/kuintessence/pbs-cgroup-v2.json')
LOCK = Path('/run/kuintessence/pbs-cgroup-v2.lock')


def require(value, message):
    if not value:
        raise ValueError(message)


def secure(path, directory=False):
    value = path.lstat()
    require(value.st_uid == 0 and value.st_mode & 0o022 == 0 and
            (stat.S_ISDIR(value.st_mode) if directory else stat.S_ISREG(value.st_mode)),
            'insecure PBS cgroup path')


def parents(path):
    while True:
        secure(path, True)
        if path == Path('/'):
            break
        path = path.parent


def settings():
    parents(CONFIG.parent)
    secure(CONFIG)
    config = json.loads(CONFIG.read_text())
    require(set(config) == {'cgroupRoot', 'queues'}, 'invalid PBS cgroup configuration')
    root = Path(config['cgroupRoot'])
    require(str(root).startswith('/sys/fs/cgroup/') and str(root) == config['cgroupRoot'] and
            '..' not in root.parts and root.name == 'jobid', 'invalid PBS cgroup root')
    parents(root)
    matches = []
    for line in Path('/proc/self/mountinfo').read_text().splitlines():
        before, _, after = line.partition(' - ')
        mount = Path(before.split()[4])
        if mount == Path('/sys/fs/cgroup'):
            require(after.split()[0] == 'cgroup2', 'PBS cgroup v2 is unavailable')
            matches.append(mount)
        elif (mount == root or str(root).startswith(str(mount) + '/')) and str(mount).startswith('/sys/fs/cgroup/'):
            raise ValueError('submounted PBS cgroup root')
    require(len(matches) == 1, 'ambiguous PBS cgroup mount')
    queues = config['queues']
    require(isinstance(queues, list) and bool(queues) and len(queues) == len(set(queues)) and
            all(isinstance(q, str) and re.fullmatch(r'[A-Za-z0-9._-]{1,128}', q) for q in queues),
            'invalid PBS cgroup queues')
    for name in ('cgroup.procs', 'cgroup.subtree_control'):
        secure(root / name)
    require({'cpu', 'memory'} <= set((root / 'cgroup.subtree_control').read_text().split()),
            'PBS cgroup controllers are not enabled')
    return root, queues


def resources(job):
    # KQ's Sandbox adapter submits select=1; never apply a whole-job limit to
    # each vnode of a multi-node allocation or silently ignore GPU allocations.
    match = re.fullmatch(r'\(([^():+]+):([^()]+)\)', str(job.exec_vnode))
    require(match, 'PBS cgroup hook requires a single-vnode CPU allocation')
    fields = {}
    for item in match[2].split(':'):
        key, value = item.split('=', 1)
        require(key not in fields and key in ('ncpus', 'mem', 'mpiprocs', 'ompthreads'),
                'unsupported PBS vnode resource')
        fields[key] = value
    require(re.fullmatch(r'[0-9]+', fields.get('ncpus', '')), 'missing PBS CPU allocation')
    memory = re.fullmatch(r'([0-9]+)kb', fields.get('mem', ''))
    require(memory, 'missing PBS memory allocation')
    cpus, size = int(fields['ncpus']), int(memory[1]) * 1024
    require(0 < cpus <= 2_147_483_647 and 0 < size <= 9_007_199_253_692_416,
            'invalid PBS allocated resources')
    return cpus, size


def limits(job):
    cpus, size = resources(job)
    return {'cpu.max': str(cpus * 100000) + ' 100000', 'memory.max': str(size),
            'memory.swap.max': '0'}


def populated(group):
    secure(group / 'cgroup.events')
    values = dict(line.split() for line in (group / 'cgroup.events').read_text().splitlines())
    require(values.get('populated') in ('0', '1'), 'unknown PBS cgroup population')
    return values['populated'] == '1'


def prepare(group, job):
    expected = limits(job)
    if group.exists():
        parents(group)
        require(not populated(group), 'previous PBS job processes have not stopped')
    else:
        group.mkdir(mode=0o755)
        group.chmod(0o755)
    for name, value in expected.items():
        secure(group / name)
        (group / name).write_text(value)
    secure(group / 'cgroup.procs')
    secure(group / 'cgroup.kill')
    require(not (group / 'cgroup.subtree_control').read_text().strip(), 'unexpected PBS job subgroups')


def attach(group, job, pid):
    parents(group)
    for name, expected in limits(job).items():
        secure(group / name)
        require((group / name).read_text().strip() == expected, 'PBS job cgroup limits drifted')
    require(isinstance(pid, int) and pid > 1, 'invalid PBS launch PID')
    secure(group / 'cgroup.procs')
    (group / 'cgroup.procs').write_text(str(pid))


def finish(group):
    if not group.exists():
        return
    parents(group)
    secure(group / 'cgroup.kill')
    # Only the exact root-owned job group is touched; no PID/name-based kills.
    (group / 'cgroup.kill').write_text('1')
    deadline = time.monotonic() + 2
    while populated(group):
        require(time.monotonic() < deadline, 'PBS job cgroup did not stop')
        time.sleep(0.02)
    group.rmdir()


def handle(event, pbs):
    require(os.geteuid() == 0, 'PBS cgroup hook requires MOM root authority')
    root, queues = settings()
    job_id = str(event.job.id)
    require(re.fullmatch(r'[0-9]+(?:\[[0-9]+\])?\.[A-Za-z0-9._-]+', job_id), 'invalid PBS job ID')
    group = root / job_id
    if str(event.job.queue) not in queues and not group.exists():
        return
    parents(LOCK.parent)
    fd = os.open(str(LOCK), os.O_CREAT | os.O_RDWR | os.O_NOFOLLOW | os.O_CLOEXEC, 0o600)
    try:
        value = os.fstat(fd)
        require(stat.S_ISREG(value.st_mode) and value.st_uid == 0 and value.st_mode & 0o077 == 0,
                'insecure PBS cgroup lock')
        fcntl.flock(fd, fcntl.LOCK_EX)
        if event.type == pbs.EXECJOB_BEGIN:
            prepare(group, event.job)
        elif event.type == pbs.EXECJOB_LAUNCH:
            # Same MOM launch-parent binding used by the upstream PBS cgroups hook.
            attach(group, event.job, os.getppid())
        elif event.type == pbs.EXECJOB_ATTACH:
            attach(group, event.job, int(event.pid))
        elif event.type == pbs.EXECJOB_END:
            finish(group)
        else:
            raise ValueError('unsupported PBS cgroup hook event')
    finally:
        os.close(fd)


if __name__ in ('__main__', 'builtins', '__builtin__'):
    import pbs
    event = pbs.event()
    try:
        handle(event, pbs)
    except (ValueError, OSError, KeyError, TypeError) as error:
        pbs.logmsg(pbs.EVENT_ERROR, 'KQ cgroup v2: ' + str(error))
        event.reject('KQ per-job resource isolation failed')
    event.accept()
