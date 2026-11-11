#!/usr/bin/env bash
set -euo pipefail

/usr/local/bin/kq-verify-architecture /usr/local/bin/bun

host_name="$(hostname -s)"
read -r cpu_count real_memory_mb < <(python3 /usr/local/bin/kq-scheduler-capacity.py)
[[ -n "$cpu_count" && -n "$real_memory_mb" ]] || exit 1

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

slurmctld_pid=""
slurmd_pid=""
agent_pid=""
accounting_pid=""
shutdown() {
  local pid
  trap - EXIT
  for pid in "${agent_pid}" "${slurmctld_pid}" "${slurmd_pid}" "${accounting_pid}"; do
    [[ -z "${pid}" ]] || kill -TERM "${pid}" 2>/dev/null || true
  done
  for pid in "${agent_pid}" "${slurmctld_pid}" "${slurmd_pid}" "${accounting_pid}"; do
    [[ -z "${pid}" ]] || wait "${pid}" 2>/dev/null || true
  done
}
trap shutdown EXIT
trap 'exit 143' TERM
trap 'exit 130' INT

munged --force
if [[ "${KQ_AIO_MANAGED_RUNTIME:-0}" == 1 ]]; then
  python3 /usr/local/lib/kuintessence/managed.py slurm-accounting
  slurmdbd -D &
  accounting_pid="$!"
  python3 /usr/local/lib/kuintessence/managed.py slurm-accounting-register
  kill -0 "$accounting_pid"
fi
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

if [[ "${KQ_AIO_MANAGED_RUNTIME:-0}" == 1 ]]; then
  chown -R kq:kq /var/lib/kuintessence /var/cache/bun
  runuser -u kq --preserve-environment -- /usr/local/bin/kq-start-agent &
else
  /usr/local/bin/kq-start-agent &
fi
agent_pid="$!"

children=("${slurmctld_pid}" "${slurmd_pid}" "${agent_pid}")
[[ -z "${accounting_pid}" ]] || children+=("${accounting_pid}")
wait -n "${children[@]}"
