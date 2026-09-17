#!/usr/bin/env bash
set -euo pipefail

/usr/local/bin/kq-verify-architecture /usr/local/bin/bun

host_name="$(hostname -s)"

if ! grep -qE "[[:space:]]${host_name}$" /etc/hosts; then
  echo "127.0.1.1 ${host_name}" >>/etc/hosts
fi

mkdir -p /var/lib/kuintessence /scratch
chmod 1777 /scratch

if [[ ! -f /etc/pbs.conf ]]; then
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

/etc/init.d/pbs start

for _ in {1..90}; do
  if qstat -B >/dev/null 2>&1; then
    break
  fi
  sleep 1
done

if ! qstat -B >/dev/null 2>&1; then
  echo "PBS did not become ready" >&2
  exit 1
fi

qmgr -c "create node ${host_name}" >/dev/null 2>&1 || true
qmgr -c "set node ${host_name} queue=workq" >/dev/null 2>&1 || true
qmgr -c "set node ${host_name} resources_available.ncpus=2" >/dev/null 2>&1 || true
qmgr -c "set node ${host_name} resources_available.mem=2gb" >/dev/null 2>&1 || true
qmgr -c "set server job_history_enable = True" >/dev/null 2>&1 || true
qmgr -c "set server job_history_duration = 01:00:00" >/dev/null 2>&1 || true

mkdir -p /var/lib/kuintessence /var/cache/bun
chown -R kq:kq /var/lib/kuintessence /var/cache/bun

runuser -u kq --preserve-environment -- /usr/local/bin/kq-register-compose-agent

runuser -u kq --preserve-environment -- /usr/local/bin/kq-start-agent &
agent_pid="$!"

wait "${agent_pid}"
