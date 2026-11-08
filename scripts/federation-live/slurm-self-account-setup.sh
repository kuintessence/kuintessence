#!/bin/bash
set -euo pipefail
[[ ${KQ_SLURM_SELFACCOUNT:-} == 1 ]]
[[ ${KQ_SLURM_LAB_OUTPUT:-} == /workspace/temp/kq-slurm-cgroup-* ]]
export DEBIAN_FRONTEND=noninteractive
apt-get install -y --no-install-recommends liblzo2-2 libseccomp2 openssl squashfuse=0.5.2-0.2+b2
dpkg-deb -x /lab-runtime/apptainer.deb /
dpkg-deb -x /lab-runtime/apptainer-suid.deb /
# Use the distribution helper with its matching FUSE ABI, instead of the older bundled one.
install -m 755 /usr/bin/squashfuse_ll /usr/libexec/apptainer/bin/squashfuse_ll
dpkg-query -W squashfuse libfuse3-4
sha256sum /usr/libexec/apptainer/bin/squashfuse_ll
mkdir -p /opt/kq /etc/kuintessence /scratch/sandbox
chown scientist:scientist /scratch/sandbox
chmod 700 /scratch/sandbox
cp /lab-bun /usr/local/bin/bun
chmod 755 /usr/local/bin/bun
cp "$KQ_SLURM_LAB_OUTPUT/self-account.js" /opt/kq/self-account.js
cp "$KQ_SLURM_LAB_OUTPUT/root-probe.js" /opt/kq/root-probe.js
cp /lab-runtime/bash.sif /opt/kq/bash.sif
openssl genpkey -algorithm RSA -pkeyopt rsa_keygen_bits:2048 -out /opt/kq/runtime.key >/dev/null 2>&1
chmod 600 /opt/kq/runtime.key
openssl pkey -in /opt/kq/runtime.key -pubout -out /opt/kq/runtime.pub
trap 'rm -f /opt/kq/runtime.key' EXIT
apptainer sign --key /opt/kq/runtime.key /opt/kq/bash.sif
apptainer verify --all --key /opt/kq/runtime.pub /opt/kq/bash.sif
rm /opt/kq/runtime.key
chmod 444 /opt/kq/bash.sif
python3 - <<'PY'
import hashlib, json
from pathlib import Path
config=Path('/etc/apptainer/apptainer.conf')
config.write_text(config.read_text().replace('allow user ns = yes', 'allow user ns = no'))
production=json.loads(Path('/workspace/deploy/schedulers/k3s/seccomp-kubernetes-no-network.json').read_text())
Path('/etc/kuintessence/seccomp.json').write_text(json.dumps(production))
production['syscalls'].append({'names':['uname'], 'action':'SCMP_ACT_ERRNO', 'errnoRet':1})
Path('/etc/kuintessence/seccomp-probe.json').write_text(json.dumps(production))
values={
    'SERVER_GRPC_URL':'http://127.0.0.1:1', 'AGENT_ID':'isolated-lab', 'AGENT_SITE_NAME':'isolated-lab',
    'AGENT_SANDBOX_ENABLED':'true', 'AGENT_SANDBOX_EXECUTION_MODE':'self-account',
    'AGENT_SANDBOX_ROOT':'/scratch/sandbox', 'AGENT_SANDBOX_APPTAINER_PATH':'/usr/bin/apptainer',
    'AGENT_SANDBOX_ATTESTATION_QUEUE':'sandbox',
}
for name,path in {
    'CGROUP_CHECK':'/usr/libexec/kuintessence/kq-sandbox-cgroup-check',
    'SIF_PUBLIC_KEY':'/opt/kq/runtime.pub',
    'SECCOMP_PROFILE':'/etc/kuintessence/seccomp.json',
    'SECCOMP_PROBE_PROFILE':'/etc/kuintessence/seccomp-probe.json',
}.items():
    values['AGENT_SANDBOX_'+name+'_PATH']=path
    # Checker is installed by the outer script after setup, but copied from these same bytes.
    source='/workspace/packages/agent/scripts/kq-sandbox-cgroup-check' if name=='CGROUP_CHECK' else path
    values['AGENT_SANDBOX_'+name+'_SHA256']=hashlib.sha256(Path(source).read_bytes()).hexdigest()
digest='sha256:'+hashlib.sha256(Path('/opt/kq/bash.sif').read_bytes()).hexdigest()
values['AGENT_SANDBOX_RUNTIME_CACHE_JSON']=json.dumps({digest:{'kind':'SIF','localPath':'/opt/kq/bash.sif','signatureVerified':False}})
Path('/opt/kq/self-account-config.json').write_text(json.dumps(values))
PY
