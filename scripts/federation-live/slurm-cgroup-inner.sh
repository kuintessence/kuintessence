#!/bin/bash
set -euo pipefail
[[ ${KQ_SLURM_CGROUP_LAB:-} == 1 ]]
[[ $$ == 1 ]]
touch /run/kq-slurm-inner-ready
for ((n=0;n<100;n++)); do [[ ! -f /run/kq-slurm-continue ]] || break; sleep .05; done
test -f /run/kq-slurm-continue
[[ $(cat /proc/1/cgroup) == '0::/' ]]
umount /sys/fs/cgroup
mount -t cgroup2 none /sys/fs/cgroup
mkdir /sys/fs/cgroup/init.scope /sys/fs/cgroup/system.slice
echo 1 >/sys/fs/cgroup/init.scope/cgroup.procs
echo '+cpu +memory +cpuset' >/sys/fs/cgroup/cgroup.subtree_control
echo '+cpu +memory +cpuset' >/sys/fs/cgroup/system.slice/cgroup.subtree_control
[[ $(cat /proc/1/cgroup) == '0::/init.scope' ]]
mkdir -p /run/munge /var/lib/munge /var/log/munge /var/spool/slurmctld /var/spool/slurmd /var/log/slurm /scratch/job
chown munge:munge /run/munge /var/lib/munge /var/log/munge /etc/munge/munge.key
chmod 700 /var/lib/munge
chown slurm:slurm /var/spool/slurmctld /var/log/slurm
chown scientist:scientist /scratch/job
runuser -u munge -- /usr/sbin/munged --foreground >/tmp/munge.log 2>&1 &
node=$(slurmd -C | head -1 | sed -E 's/RealMemory=[0-9]+/RealMemory=512/')
cat >/etc/slurm/slurm.conf <<EOF
ClusterName=kq-cgroup-lab
SlurmctldHost=$(hostname)
SlurmUser=slurm
AuthType=auth/munge
MpiDefault=none
MailProg=/bin/true
StateSaveLocation=/var/spool/slurmctld
SlurmdSpoolDir=/var/spool/slurmd
ProctrackType=proctrack/cgroup
TaskPlugin=task/cgroup
SelectType=select/cons_tres
SelectTypeParameters=CR_Core_Memory
SchedulerType=sched/backfill
JobAcctGatherType=jobacct_gather/cgroup
AccountingStorageType=accounting_storage/none
SlurmctldLogFile=/var/log/slurm/controller.log
SlurmdLogFile=/var/log/slurm/daemon.log
SlurmctldDebug=info
SlurmdDebug=info
$node State=UNKNOWN
PartitionName=sandbox Nodes=$(hostname) Default=YES MaxTime=00:02:00 State=UP
EOF
cat >/etc/slurm/cgroup.conf <<'EOF'
CgroupPlugin=cgroup/v2
IgnoreSystemd=yes
EnableControllers=yes
ConstrainCores=yes
ConstrainRAMSpace=yes
ConstrainSwapSpace=yes
AllowedRAMSpace=100
AllowedSwapSpace=0
ConstrainDevices=no
EOF
/usr/sbin/slurmctld -D >/tmp/slurmctld.log 2>&1 &
mkdir /sys/fs/cgroup/system.slice/slurmd.service
python3 - <<'PY' >/tmp/slurmd.log 2>&1 &
from pathlib import Path
import os
Path('/sys/fs/cgroup/system.slice/slurmd.service/cgroup.procs').write_text(str(os.getpid()))
os.execl('/usr/sbin/slurmd', 'slurmd', '-D')
PY
trap 'cat /tmp/munge.log /tmp/slurmctld.log /tmp/slurmd.log; cat /scratch/job/output /scratch/job/error 2>/dev/null || true' EXIT
for ((n=0;n<40;n++)); do
  if sinfo -h -o '%T' | grep -Eq '^idle$'; then break; fi
  sleep .5
done
sinfo -h -o '%T' | grep -Eq '^idle$'
[[ ${KQ_SLURM_CGROUP_JOB:-} == /workspace/temp/kq-slurm-cgroup-*/job.sh ]]
cp "$KQ_SLURM_CGROUP_JOB" /scratch/job/job.sh
chmod 644 /scratch/job/job.sh
runuser -u scientist -- sbatch --wait --parsable --partition=sandbox --cpus-per-task=1 --mem=128M --time=00:01:00 --output=/scratch/job/output --error=/scratch/job/error /scratch/job/job.sh
cat /scratch/job/output
grep -q REAL_SLURM_CGROUP_OK /scratch/job/output
python3 - <<'PY'
from pathlib import Path
import time
membership=next(line[3:] for line in Path('/scratch/job/output').read_text().splitlines() if line.startswith('0::'))
path=Path('/sys/fs/cgroup')/membership.lstrip('/')
while not path.name.startswith('job_'):
    assert path != Path('/sys/fs/cgroup')
    path=path.parent
for attempt in range(50):
    if not path.exists(): break
    time.sleep(.1)
assert not path.exists(), 'Slurm did not remove the original job cgroup'
print('SLURM ORIGINAL JOB CGROUP REMOVED')
PY
echo 'REAL SLURM V2 SELFACCOUNT CHECKER PASSED'
