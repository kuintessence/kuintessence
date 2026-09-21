#!/usr/bin/env bash
set -euo pipefail
[[ "${KQ_PR_TEST:-}" == 1 && "$(id -u)" == 0 ]]
phase=cgroup
trap 'printf "managed-setup-failed:%s\n" "$phase" > /run/kq-pr/status' ERR
cd /workspace
test "$(stat -fc %T /sys/fs/cgroup)" = cgroup2fs
phase=user-manager
loginctl enable-linger kq
systemctl start user@1000.service
test -S /run/user/1000/bus

# The bounded filesystem is this disposable site's enforced installation quota.
# Its backing volume survives scheduler restarts; no host directory is mounted.
phase=store
if [[ ! -f /managed-disk/store.ext4 ]]; then
  truncate -s 2G /managed-disk/store.ext4
  mkfs.ext4 -q -F /managed-disk/store.ext4
fi
mount -o loop,nosuid,nodev /managed-disk/store.ext4 /srv/kq/spack
chown kq:kq /srv/kq/spack /var/lib/kuintessence
chmod 0755 /srv/kq/spack
phase=profile
bun deploy/pr-test/spack-managed/profile.ts

phase=slurm
host_name="$(hostname -s)"
cpu_count="$(nproc)"
real_memory_mb="$(awk '/MemTotal/ {print int($2 / 1024 * 0.8)}' /proc/meminfo)"
mkdir -p /run/munge /var/log/munge /var/spool/slurmctld /var/spool/slurmd /var/log/slurm /scratch
chmod 1777 /scratch
chown -R munge:munge /run/munge /var/log/munge
chown -R slurm:slurm /var/spool/slurmctld /var/spool/slurmd /var/log/slurm
if [[ ! -f /etc/munge/munge.key ]]; then
  dd if=/dev/urandom of=/etc/munge/munge.key bs=1024 count=1 status=none
  chown munge:munge /etc/munge/munge.key
  chmod 0400 /etc/munge/munge.key
fi
sed -e "s/__HOSTNAME__/${host_name}/g" -e "s/__CPUS__/${cpu_count}/g" \
  -e "s/__REAL_MEMORY__/${real_memory_mb}/g" \
  /etc/slurm-llnl/slurm.conf.template >/etc/slurm-llnl/slurm.conf
munged --force
slurmctld -D &
slurmd -D &
for _ in {1..60}; do
  if sinfo -h -o '%T' 2>/dev/null | grep -Eq 'idle|alloc|mix'; then break; fi
  sleep 1
done
sinfo -h -o '%T' | grep -Eq 'idle|alloc|mix'
phase=registration
/usr/local/bin/kq-register-compose-agent
chown -R kq:kq /var/lib/kuintessence
# The user manager is required for Apptainer's rootless resource limits.
# Registration remains a root setup step, outside the Agent and worker.
printf 'managed-setup-ready\n' >/run/kq-pr/status
exec runuser -u kq -- env XDG_RUNTIME_DIR=/run/user/1000 \
  DBUS_SESSION_BUS_ADDRESS=unix:path=/run/user/1000/bus \
  bash /workspace/deploy/pr-test/spack-managed/agent.sh
