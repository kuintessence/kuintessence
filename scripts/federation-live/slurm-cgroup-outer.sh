#!/bin/bash
set -euo pipefail
[[ ${KQ_SLURM_CGROUP_LAB:-} == 1 ]]
mkdir -p /usr/libexec/kuintessence
cp /workspace/packages/agent/scripts/kq-sandbox-cgroup-check /usr/libexec/kuintessence/kq-sandbox-cgroup-check
chmod 755 /usr/libexec/kuintessence/kq-sandbox-cgroup-check
python3 - <<'PY'
from pathlib import Path
import time
membership=Path('/proc/self/cgroup').read_text().strip()
assert membership.startswith('0::/kubepods') and '..' not in membership.split('/')
root=Path('/sys/fs/cgroup')/membership[4:]
assert (root/'cpu.max').read_text().split()[0] != 'max'
assert (root/'memory.max').read_text().strip() != 'max'
manager=root/'manager'
manager.mkdir()
for attempt in range(20):
    for pid in (root/'cgroup.procs').read_text().split():
        try: (manager/'cgroup.procs').write_text(pid)
        except ProcessLookupError: pass
    try:
        (root/'cgroup.subtree_control').write_text('+cpu +memory +cpuset')
        break
    except OSError:
        if attempt==19: raise
        time.sleep(.05)
(root/'experiment').mkdir()
Path('/run/kq-slurm-root').write_text(str(root))
PY
root=$(cat /run/kq-slurm-root)
python3 - "$root" <<'PY' &
import os,sys
from pathlib import Path
(Path(sys.argv[1])/'experiment/cgroup.procs').write_text(str(os.getpid()))
os.execvp('unshare',['unshare','--cgroup','--mount','--propagation','private','--pid','--fork','--mount-proc','bash','/workspace/scripts/federation-live/slurm-cgroup-inner.sh'])
PY
launcher=$!
for ((n=0;n<100;n++)); do [[ ! -f /run/kq-slurm-inner-ready ]] || break; sleep .05; done
test -f /run/kq-slurm-inner-ready
echo "$launcher" >"$root/manager/cgroup.procs"
touch /run/kq-slurm-continue
wait "$launcher"
