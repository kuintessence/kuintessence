#!/usr/bin/env bash
set -euo pipefail

/usr/local/bin/kq-verify-architecture /usr/local/bin/bun

host_name="$(hostname -s)"
cpu_count="$(nproc)"
real_memory_mb="$(awk '/MemTotal/ { value = int($2 / 1024 * 0.8); if (value < 1024) value = 1024; print value }' /proc/meminfo)"

mkdir -p /run/munge /var/log/munge /var/lib/kuintessence /etc/slurm-llnl /var/spool/slurmctld /var/spool/slurmd /var/log/slurm /scratch
chmod 1777 /scratch
chown -R munge:munge /run/munge /var/log/munge
chown -R slurm:slurm /var/spool/slurmctld /var/spool/slurmd /var/log/slurm

if [[ ! -f /etc/munge/munge.key ]]; then
  dd if=/dev/urandom bs=1 count=1024 of=/etc/munge/munge.key status=none
  chown munge:munge /etc/munge/munge.key
  chmod 0400 /etc/munge/munge.key
fi

sed \
  -e "s/__HOSTNAME__/${host_name}/g" \
  -e "s/__CPUS__/${cpu_count}/g" \
  -e "s/__REAL_MEMORY__/${real_memory_mb}/g" \
  /etc/slurm-llnl/slurm.conf.template >/etc/slurm-llnl/slurm.conf
chown slurm:slurm /etc/slurm-llnl/slurm.conf

munged --force
slurmctld -D &
slurmctld_pid="$!"
slurmd -D &
slurmd_pid="$!"

for _ in {1..60}; do
  if sinfo -h -o "%T" 2>/dev/null | grep -Eq "idle|alloc|mix"; then
    break
  fi
  sleep 1
done

if ! sinfo -h -o "%T" 2>/dev/null | grep -Eq "idle|alloc|mix"; then
  echo "Slurm did not become ready" >&2
  exit 1
fi

/usr/local/bin/kq-register-compose-agent

/usr/local/bin/kq-start-agent &
agent_pid="$!"

wait -n "${slurmctld_pid}" "${slurmd_pid}" "${agent_pid}"
