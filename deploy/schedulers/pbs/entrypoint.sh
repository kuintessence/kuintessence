#!/usr/bin/env bash
set -euo pipefail

/usr/local/bin/kq-verify-architecture /usr/local/bin/bun

agent_user=kq
agent_command=(runuser -u kq --preserve-environment --)
root_impersonation="${AGENT_SANDBOX_ROOT_IMPERSONATION:-false}"
case "${root_impersonation,,}" in
  true)
    case "${AGENT_SANDBOX_EXECUTION_MODE:-disabled}" in
      disabled|root-impersonation) ;;
      *) echo "PBS root impersonation conflicts with the configured execution mode" >&2; exit 2 ;;
    esac
    agent_user=root
    agent_command=()
    export HOME=/root
    ;;
  *)
    if [[ "${AGENT_SANDBOX_EXECUTION_MODE:-disabled}" == root-impersonation ]]; then
      echo "PBS root impersonation requires AGENT_SANDBOX_ROOT_IMPERSONATION=true" >&2
      exit 2
    fi
    ;;
esac

host_name="$(hostname -s)"

if ! grep -qE "[[:space:]]${host_name}$" /etc/hosts; then
  echo "127.0.1.1 ${host_name}" >>/etc/hosts
fi

mkdir -p /var/lib/kuintessence /scratch
chmod 1777 /scratch

# pbs.conf is recreated with the container; the database belongs to the persistent PBS_HOME.
if [[ ! -f /var/spool/pbs/server_priv/db_password ]]; then
  /opt/pbs/libexec/pbs_postinstall
fi

cat >/etc/pbs.conf <<EOF
PBS_EXEC=/opt/pbs
PBS_HOME=/var/spool/pbs
PBS_SERVER=${host_name}
PBS_START_SERVER=1
PBS_START_SCHED=1
PBS_START_COMM=1
PBS_START_MOM=1
PBS_CORE_LIMIT=unlimited
PBS_SCP=/usr/bin/scp
EOF

agent_pid=""
shutdown() {
  if [[ -n "${agent_pid}" ]]; then
    kill -TERM "${agent_pid}" 2>/dev/null || true
    wait "${agent_pid}" 2>/dev/null || true
  fi
  /etc/init.d/pbs stop
}
trap 'shutdown; exit 143' TERM
trap 'shutdown; exit 130' INT

/etc/init.d/pbs start

for _ in {1..90}; do
  if qstat -B >/dev/null 2>&1; then
    break
  fi
  sleep 1
done

if ! qstat -B >/dev/null 2>&1; then
  echo "PBS did not become ready" >&2
  shutdown
  exit 1
fi

qmgr -c "create node ${host_name}" >/dev/null 2>&1 || true
qmgr -c "set node ${host_name} queue=workq" >/dev/null 2>&1 || true
read -r cpu_count real_memory_mb < <(python3 /usr/local/bin/kq-scheduler-capacity.py)
[[ -n "$cpu_count" && -n "$real_memory_mb" ]] || exit 1
qmgr -c "set node ${host_name} resources_available.ncpus=${cpu_count}"
qmgr -c "set node ${host_name} resources_available.mem=${real_memory_mb}mb"
qmgr -c "set server job_history_enable = True"
qmgr -c "set server job_history_duration = 24:00:00"

if [[ "${KQ_AIO_MANAGED_RUNTIME:-0}" == 1 ]]; then
  python3 /usr/local/lib/kuintessence/managed.py pbs-hook
fi

mkdir -p /var/lib/kuintessence /var/cache/bun
chown -R "${agent_user}:${agent_user}" /var/lib/kuintessence /var/cache/bun

"${agent_command[@]}" /usr/local/bin/kq-register-compose-agent

"${agent_command[@]}" /usr/local/bin/kq-start-agent &
agent_pid="$!"

set +e
wait "${agent_pid}"
status="$?"
set -e
shutdown
exit "${status}"
