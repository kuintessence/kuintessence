#!/bin/bash
# Disposable Pod only: production Agent and real Slurm, both using the scientist identity for jobs.
set -euo pipefail
[[ ${KQ_SLURM_AGENT:-} == 1 && ${LAB_HPC_ROOT:-} == /tmp/kq-federation-live-*/hpc ]]
export DEBIAN_FRONTEND=noninteractive
printf '#!/bin/sh\nexit 101\n' >/usr/sbin/policy-rc.d
chmod 755 /usr/sbin/policy-rc.d
apt-get update -qq
version=24.11.5-4+deb13u1
apt-get install -y --no-install-recommends slurmd=$version slurmctld=$version slurm-client=$version slurm-wlm-basic-plugins=$version slurmdbd=$version slurm-wlm-mysql-plugin=$version mariadb-server python3 util-linux procps mount liblzo2-2 libseccomp2 squashfuse=0.5.2-0.2+b2 ca-certificates
useradd -u 24001 -m scientist
dpkg-deb -x /lab-runtime/apptainer.deb /
dpkg-deb -x /lab-runtime/apptainer-suid.deb /
install -m 755 /usr/bin/squashfuse_ll /usr/libexec/apptainer/bin/squashfuse_ll
install -m 755 /lab-bun /usr/local/bin/bun
mkdir -p /opt/kq /etc/kuintessence /scratch/sandbox /scratch/workflows /var/lib/kuintessence/certs
install -m 444 "$LAB_HPC_ROOT/bash.sif" /opt/kq/bash.sif
apptainer key import --global "$LAB_HPC_ROOT/public.asc"
apptainer verify --local /opt/kq/bash.sif
# Copy only this Agent's issued identity; the source mount remains inaccessible to the non-root account.
set -a
source "$KQ_AGENT_ENV_FILE"
set +a
for name in client.crt client.key ca.crt; do
  install -m 600 "$AGENT_CERT_DIR/$name" "/var/lib/kuintessence/certs/$name"
done
export AGENT_SCHEDULER_VERSION=24.11.5
export AGENT_CERT_DIR=/var/lib/kuintessence/certs
export NODE_EXTRA_CA_CERTS=/var/lib/kuintessence/certs/ca.crt
export AGENT_DB_PATH=/var/lib/kuintessence/agent.db
export BUN_INSTALL_CACHE_DIR=/var/lib/kuintessence/bun-cache
chown -R scientist:scientist /scratch /var/lib/kuintessence
chmod 700 /scratch/sandbox /scratch/workflows /var/lib/kuintessence/certs
cp /workspace/deploy/schedulers/k3s/seccomp-kubernetes-no-network.json /etc/kuintessence/seccomp.json
python3 - <<'PY'
import hashlib,json,shlex
from pathlib import Path
config=Path('/etc/apptainer/apptainer.conf')
config.write_text(config.read_text().replace('allow user ns = yes', 'allow user ns = no'))
profile=json.loads(Path('/etc/kuintessence/seccomp.json').read_text())
profile['syscalls'].append({'names':['uname'],'action':'SCMP_ACT_ERRNO','errnoRet':1})
Path('/etc/kuintessence/seccomp-probe.json').write_text(json.dumps(profile))
settings={}
for name,path in {
    'CGROUP_CHECK':'/usr/libexec/kuintessence/kq-sandbox-cgroup-check',
    'SECCOMP_PROFILE':'/etc/kuintessence/seccomp.json',
    'SECCOMP_PROBE_PROFILE':'/etc/kuintessence/seccomp-probe.json',
}.items():
    source='/workspace/packages/agent/scripts/kq-sandbox-cgroup-check' if name=='CGROUP_CHECK' else path
    settings['AGENT_SANDBOX_'+name+'_PATH']=path
    settings['AGENT_SANDBOX_'+name+'_SHA256']=hashlib.sha256(Path(source).read_bytes()).hexdigest()
Path('/opt/kq/selfaccount.env').write_text('\n'.join(k+'='+shlex.quote(v) for k,v in settings.items())+'\n')
PY
set -a
source /opt/kq/selfaccount.env
set +a
exec bash /workspace/scripts/federation-live/slurm-cgroup-outer.sh
