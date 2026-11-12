#!/bin/bash -l
# 用 sbatch 或 KQ 在计算节点执行；当前目录必须是本次独立共享工作目录。
set -eo pipefail
source "${1:?需要 site.env 的绝对路径}"
: "${SLURM_JOB_ID:?请通过 Slurm/KQ 提交，不要在登录节点直接执行}"
if [[ -n ${KQ_MODULE_INIT:-} ]]; then source "$KQ_MODULE_INIT"; fi
type module >/dev/null 2>&1 || { echo '请配置 KQ_MODULE_INIT' >&2; exit 1; }
module load "$KQ_PYTHON_MODULE" >/dev/null 2>&1
export KQ_SMOKE_COMPILER_STATUS=not-tested KQ_SMOKE_MPI_STATUS=not-tested
if [[ -n ${KQ_SMOKE_COMPILER_MODULE:-} ]]; then
  if module load "$KQ_SMOKE_COMPILER_MODULE" >/dev/null 2>&1; then
    export KQ_SMOKE_COMPILER_STATUS=loaded
  else
    export KQ_SMOKE_COMPILER_STATUS=failed
  fi
fi
if [[ -n ${KQ_SMOKE_MPI_MODULE:-} ]]; then
  if module load "$KQ_SMOKE_MPI_MODULE" >/dev/null 2>&1; then
    export KQ_SMOKE_MPI_STATUS=loaded
  else
    export KQ_SMOKE_MPI_STATUS=failed
  fi
fi
export KQ_SMOKE_APPTAINER_STATUS=not-tested
if [[ -n ${KQ_APPTAINER_MODULE:-} ]]; then
  if module load "$KQ_APPTAINER_MODULE" >/dev/null 2>&1; then
    export KQ_SMOKE_APPTAINER_STATUS=loaded
  else
    export KQ_SMOKE_APPTAINER_STATUS=failed
  fi
fi
umask 077
python3 - <<'PY'
import hashlib
import json
import shutil
import os
from pathlib import Path
import platform
import re
import subprocess
import tempfile
import time

delay = int(os.environ.get('KQ_SMOKE_SLEEP_SEC', '0'))
if not 0 <= delay <= 120:
    raise SystemExit('KQ_SMOKE_SLEEP_SEC must be between 0 and 120')
if Path('result.json').exists():
    raise SystemExit('result.json already exists; use a new working directory')
shared = Path(os.environ['KQ_SHARED']).resolve()
inside_shared = Path.cwd().resolve().is_relative_to(shared)
if not inside_shared:
    raise SystemExit('working directory must be inside KQ_SHARED')
print('KQ_SMOKE_STARTED slurm_job_id=' + os.environ['SLURM_JOB_ID'], flush=True)
time.sleep(delay)
with tempfile.TemporaryFile(dir='.') as probe:
    probe.write(b'kq-shared-probe')
    probe.flush()
    os.fsync(probe.fileno())
    probe.seek(0)
    shared_ok = probe.read() == b'kq-shared-probe'

def module_label(value):
    if re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9_+./-]{0,199}', value) and '..' not in value.split('/'):
        return value
    return 'redacted'

def version(kind, default, allowed):
    status = os.environ['KQ_SMOKE_' + kind + '_STATUS']
    if status != 'loaded':
        return {'status': status}
    command = os.environ.get('KQ_SMOKE_' + kind + '_COMMAND', default)
    if command not in allowed:
        return {'status': 'failed'}
    try:
        result = subprocess.run([command, '--version'], capture_output=True, text=True, timeout=5)
        # Retain only a version token; tool banners can contain site paths or hostnames.
        match = re.search(r'(?<![\w.])\d+\.\d+(?:\.\d+){0,2}(?![\w.])', result.stdout[:4096])
        if result.returncode == 0 and match:
            return {'status': 'passed', 'module': module_label(os.environ.get('KQ_SMOKE_' + kind + '_MODULE', '')), 'command': command, 'version': match[0]}
    except (OSError, subprocess.TimeoutExpired):
        pass
    return {'status': 'failed', 'command': command}

os_release = {}
try:
    for line in Path('/etc/os-release').read_text()[:16384].splitlines():
        key, _, value = line.partition('=')
        value = value.strip('"\'')
        if key in ('ID', 'VERSION_ID') and re.fullmatch(r'[A-Za-z0-9_.-]{1,80}', value):
            os_release[key] = value
except OSError:
    pass
flags = None
try:
    with open('/proc/cpuinfo') as cpuinfo:
        cpu_text = cpuinfo.read(2 * 1024 * 1024)
    for line in cpu_text.splitlines():
        key, _, value = line.partition(':')
        if key.strip() in ('flags', 'Features'):
            current = set(value.split())
            flags = current if flags is None else flags & current
except OSError:
    pass
supported = {'sse2', 'ssse3', 'popcnt', 'cx16', 'lahf_lm', 'sse4_1', 'sse4_2', 'avx', 'avx2', 'avx512f', 'avx512bw', 'avx512dq', 'avx512vl', 'fma', 'aes', 'bmi1', 'bmi2', 'neon', 'asimd', 'sve', 'sve2', 'atomics', 'crc32'}
libc_name, libc_version = platform.libc_ver()
def command_status(args):
    try:
        probe = subprocess.run(args, capture_output=True, text=True, timeout=15)
        return 'passed' if probe.returncode == 0 else 'failed'
    except (OSError, subprocess.TimeoutExpired):
        return 'failed'

budget = os.environ.get('KQ_SPACK_MANAGED_MEMORY_MIB', '4096')
valid_budget = bool(re.fullmatch(r'[0-9]{1,7}', budget)) and 1024 <= int(budget) <= 1048576
scratch_min = os.environ.get('KQ_SPACK_SCRATCH_MIN_MIB', '20480')
scratch = os.environ.get('KQ_COMPUTE_SCRATCH', '')
capabilities = {
    'observedAt': int(time.time()),
    'partition': os.environ.get('SLURM_JOB_PARTITION', ''),
    'memoryMib': int(budget) if valid_budget else None,
    'abi': {'status': 'passed' if platform.machine() and libc_name == 'glibc' and re.fullmatch(r'[0-9]+\.[0-9]+', libc_version) else 'failed'},
    'userManager': {'status': command_status(['systemctl', '--user', 'show-environment'])},
    'scratch': {'status': 'not-tested'},
    'isolation': {'status': 'not-tested'},
}
if scratch and re.fullmatch(r'[0-9]{1,9}', scratch_min) and 1 <= int(scratch_min) <= 1048576:
    try:
        scratch_path = Path(scratch)
        if not scratch_path.is_absolute() or not scratch_path.is_dir():
            raise ValueError('scratch')
        free = shutil.disk_usage(scratch_path).free // 1024**2
        with tempfile.TemporaryFile(dir=scratch_path) as probe:
            probe.write(b'kq-scratch')
            probe.flush()
            os.fsync(probe.fileno())
        capabilities['scratch'] = {'status': 'passed' if free >= int(scratch_min) else 'failed', 'availableMib': free, 'requiredMib': int(scratch_min)}
    except (OSError, ValueError):
        capabilities['scratch'] = {'status': 'failed'}
sif = os.environ.get('KQ_CAPABILITY_SIF_PATH', '')
if sif and valid_budget:
    try:
        image = Path(sif)
        if not image.is_absolute() or not image.is_file():
            raise ValueError('image')
        digest = hashlib.sha256()
        with image.open('rb') as source:
            for chunk in iter(lambda: source.read(1024 * 1024), b''):
                digest.update(chunk)
        capabilities['runtimeSifSha256'] = digest.hexdigest()
        memory = int(budget) * 1024**2
        host_net = os.readlink('/proc/self/ns/net')
        host_pid = os.readlink('/proc/self/ns/pid')
        # Verify effective controls inside the same isolation flags as managed workers.
        code = """import os,pathlib
assert os.readlink('/proc/self/ns/net') != %r
assert os.readlink('/proc/self/ns/pid') != %r
status = pathlib.Path('/proc/self/status').read_text().splitlines()
assert any(x.split() == ['NoNewPrivs:', '1'] for x in status)
assert any(x.split() == ['CapEff:', '0000000000000000'] for x in status)
entries = pathlib.Path('/proc/self/cgroup').read_text().splitlines()
assert len(entries) == 1 and entries[0].startswith('0::/')
root = pathlib.Path('/sys/fs/cgroup') / entries[0][3:].lstrip('/')
limit = (root / 'memory.max').read_text().strip()
assert limit.isdecimal() and 0 < int(limit) <= %d
assert (root / 'memory.swap.max').read_text().strip() == '0'
pids = (root / 'pids.max').read_text().strip()
assert pids.isdecimal() and 0 < int(pids) <= 128
""" % (host_net, host_pid, memory)
        args = [os.environ.get('KQ_APPTAINER_PATH') or 'apptainer', 'exec', '--containall', '--userns', '--cleanenv', '--no-home', '--no-eval', '--disable-cache', '--writable-tmpfs', '--no-mount', 'bind-paths,hostfs,cwd,home,sys', '--net', '--network', 'none', '--drop-caps', 'all', '--security', 'no-new-privs', '--pids-limit', '128', '--memory', str(memory), '--memory-swap', str(memory), '--cpus', '2', '--bind', '/sys/fs/cgroup:/sys/fs/cgroup:ro', str(image), 'python3', '-c', code]
        capabilities['isolation'] = {'status': command_status(args)}
    except (OSError, ValueError):
        capabilities['isolation'] = {'status': 'failed'}

result = {
    'managedCapabilities': capabilities,
    'schemaVersion': 1,
    'kind': 'kq-compute-inventory',
    'ok': shared_ok,
    'sum': sum(range(100)),
    'os': os_release,
    'arch': platform.machine(),
    'libc': {'name': libc_name, 'version': libc_version},
    'cpu': {'supportedFlags': sorted((flags or set()) & supported)},
    'python': {'status': 'passed', 'version': platform.python_version(), 'module': module_label(os.environ['KQ_PYTHON_MODULE'])},
    'compiler': version('COMPILER', 'cc', {'cc', 'gcc', 'clang', 'icx', 'icc'}),
    'mpi': version('MPI', 'mpirun', {'mpirun', 'mpiexec'}),
    'shared': {'workingDirectoryInsideShared': inside_shared, 'writeReadDelete': 'passed' if shared_ok else 'failed'},
}
with open('result.json', 'x') as output:
    json.dump(result, output, sort_keys=True)
    output.write('\n')
print(json.dumps(result, sort_keys=True))
PY
sha256sum result.json
