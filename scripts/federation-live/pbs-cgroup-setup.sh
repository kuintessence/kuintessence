#!/usr/bin/env bash
# Only for an owned disposable scheduler Pod; never a host-global cgroup change.
set -euo pipefail
[[ ${KQ_MEDIA_CGROUP_LAB:-} == 1 ]]
mkdir -p /etc/kuintessence /run/kuintessence /usr/libexec/kuintessence
cp /workspace/packages/agent/scripts/kq-sandbox-cgroup-check /usr/libexec/kuintessence/kq-sandbox-cgroup-check
chmod 755 /usr/libexec/kuintessence/kq-sandbox-cgroup-check
python3 - <<'PY'
import json,os,pathlib,time
membership=pathlib.Path('/proc/self/cgroup').read_text().strip()
assert membership.startswith('0::/kubepods'), membership
root=pathlib.Path('/sys/fs/cgroup')/membership[4:]
assert root.joinpath('memory.max').read_text().strip() != 'max'
assert root.joinpath('cpu.max').read_text().split()[0] != 'max'
manager=root/'manager'
manager.mkdir()
for attempt in range(10):
    for pid in root.joinpath('cgroup.procs').read_text().split():
        try: manager.joinpath('cgroup.procs').write_text(pid)
        except ProcessLookupError: pass
    try:
        root.joinpath('cgroup.subtree_control').write_text('+cpu +memory')
        break
    except OSError:
        if attempt == 9: raise
        time.sleep(.05)
jobs=root/'jobid'
jobs.mkdir()
jobs.joinpath('cgroup.subtree_control').write_text('+cpu +memory')
pathlib.Path('/etc/kuintessence/pbs-cgroup-v2.json').write_text(json.dumps({'cgroupRoot':str(jobs),'queues':['workq']}))
PY
qmgr -c 'create hook kq_sandbox_cgroup_v2'
qmgr -c 'set hook kq_sandbox_cgroup_v2 event="execjob_begin,execjob_launch,execjob_attach,execjob_end"'
qmgr -c 'set hook kq_sandbox_cgroup_v2 alarm=10'
qmgr -c 'import hook kq_sandbox_cgroup_v2 application/x-python default /workspace/deploy/schedulers/pbs/kq-cgroup-v2.py'
qmgr -c 'set hook kq_sandbox_cgroup_v2 enabled=true'
for ((attempt=0;attempt<30;attempt++)); do
  if cmp -s /var/spool/pbs/mom_priv/hooks/kq_sandbox_cgroup_v2.PY /workspace/deploy/schedulers/pbs/kq-cgroup-v2.py; then break; fi
  sleep 1
done
cmp /var/spool/pbs/mom_priv/hooks/kq_sandbox_cgroup_v2.PY /workspace/deploy/schedulers/pbs/kq-cgroup-v2.py
