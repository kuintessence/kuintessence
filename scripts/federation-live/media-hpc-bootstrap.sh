#!/usr/bin/env bash
# Only used inside the disposable privileged Slurm/PBS lab Pod.
set -euo pipefail
[[ "${LAB_HPC_ROOT:-}" = /tmp/kq-federation-live-*/hpc ]]
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
apt-get install -y --no-install-recommends liblzo2-2 libfuse3-3
dpkg-deb -x /lab-runtime/apptainer.deb /
dpkg-deb -x /lab-runtime/apptainer-suid.deb /
mkdir -p /opt/kq /etc/kuintessence /usr/libexec/kuintessence
cp "$LAB_HPC_ROOT/bash.sif" /opt/kq/bash.sif
chmod 444 /opt/kq/bash.sif
apptainer key import "$LAB_HPC_ROOT/public.asc"
apptainer key import --global "$LAB_HPC_ROOT/public.asc"
apptainer verify --local /opt/kq/bash.sif
useradd -m -u 24001 scientist
cp /workspace/packages/agent/scripts/kq-sandbox-wrapper /usr/libexec/kuintessence/kq-sandbox-wrapper
chmod 755 /usr/libexec/kuintessence/kq-sandbox-wrapper
cp /workspace/deploy/schedulers/k3s/seccomp-kubernetes-no-network.json /etc/kuintessence/restricted-seccomp.json
chmod 644 /etc/kuintessence/restricted-seccomp.json
python3 - <<'PY'
import hashlib,json,os,pathlib,shlex
def digest(path):
    return hashlib.sha256(pathlib.Path(path).read_bytes()).hexdigest()
metadata=json.loads((pathlib.Path(os.environ['LAB_HPC_ROOT'])/'runtime.json').read_text())
values={
    'KQ_PROFILE_ID':os.environ['AGENT_RESTRICTED_EXECUTION_PROFILE_ID'],
    'KQ_APPTAINER_PATH':'/usr/bin/apptainer',
    'KQ_APPTAINER_SHA256':digest('/usr/bin/apptainer'),
    'KQ_SIF_PATH':'/opt/kq/bash.sif',
    'KQ_SIF_SHA256':metadata['digest'].split(':')[1],
    'KQ_WRAPPER_PATH':'/usr/libexec/kuintessence/kq-sandbox-wrapper',
    'KQ_WRAPPER_SHA256':digest('/usr/libexec/kuintessence/kq-sandbox-wrapper'),
    'KQ_SECCOMP_PATH':'/etc/kuintessence/restricted-seccomp.json',
    'KQ_SECCOMP_SHA256':digest('/etc/kuintessence/restricted-seccomp.json'),
}
pathlib.Path('/etc/kuintessence/restricted-execution-profile.conf').write_text('\n'.join(k+'='+shlex.quote(v) for k,v in values.items())+'\n')
pathlib.Path('/etc/apptainer/ecl.toml').write_text('activated = true\n[[execgroup]]\ntagname = "media-lab"\nmode = "whitestrict"\ndirpath = "/opt/kq"\nkeyfp = ["'+metadata['fingerprint']+'"]\n')
config=pathlib.Path('/etc/apptainer/apptainer.conf')
config.write_text(config.read_text().replace('allow user ns = yes','allow user ns = no'))
# This proves the lab-wide ceiling, not independent per-job scheduler cgroups.
groups=[line.split(':',2)[2] for line in pathlib.Path('/proc/self/cgroup').read_text().splitlines() if line.startswith('0::')]
assert len(groups)==1 and '..' not in groups[0].split('/')
group=pathlib.Path('/sys/fs/cgroup')/groups[0].lstrip('/')
assert group.joinpath('memory.max').read_text().strip() != 'max'
assert group.joinpath('cpu.max').read_text().split()[0] != 'max'
PY
/usr/libexec/kuintessence/kq-sandbox-wrapper --check-profile
cp /lab-runtime/bash.sif /opt/kq/unsigned.sif
chmod 444 /opt/kq/unsigned.sif
apptainer sif list /opt/kq/unsigned.sif >/dev/null
setpriv --reuid=24001 --regid=24001 --init-groups -- \
  apptainer exec --containall --cleanenv --net --network none \
  --security no-new-privs,seccomp:/etc/kuintessence/restricted-seccomp.json /opt/kq/bash.sif /bin/true
if setpriv --reuid=24001 --regid=24001 --init-groups -- \
  apptainer exec --containall --cleanenv --net --network none \
  --security no-new-privs,seccomp:/etc/kuintessence/restricted-seccomp.json /opt/kq/unsigned.sif /bin/true; then
  echo "Unsigned runtime was not rejected by ECL" >&2
  exit 1
fi
rm /opt/kq/unsigned.sif
export AGENT_RESTRICTED_EXECUTION_WRAPPER_SHA256
AGENT_RESTRICTED_EXECUTION_WRAPPER_SHA256=$(sha256sum /usr/libexec/kuintessence/kq-sandbox-wrapper | cut -d' ' -f1)
# Use the checked-out production supervisor, not the image's older copy.
cp /workspace/deploy/schedulers/common/start-agent.sh /usr/local/bin/kq-start-agent
cp /workspace/deploy/schedulers/common/supervise-agent.py /usr/local/bin/kq-supervise-agent.py
chmod 755 /usr/local/bin/kq-start-agent /usr/local/bin/kq-supervise-agent.py
case "$LAB_MEDIA_EXECUTION" in
  slurm) exec bash /workspace/deploy/schedulers/slurm/entrypoint.sh ;;
  pbs-pro)
    apt-get install -y --no-install-recommends postgresql postgresql-contrib libical3 libedit2 libpython3.8 libhwloc15 libtcl8.6 libtk8.6
    tar xzf /lab-pbs/pbs-install.tar.gz -C /opt
    [[ $(/opt/pbs/bin/qsub --version) == 'pbs_version = 23.06.06' ]]
    exec bash /workspace/deploy/schedulers/pbs/entrypoint.sh
    ;;
  *) echo "Unsupported media scheduler" >&2; exit 2 ;;
esac
