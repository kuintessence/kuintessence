#!/usr/bin/env bash
set -euo pipefail

/usr/local/bin/kq-verify-architecture /usr/local/bin/bun /usr/local/bin/k3s

mkdir -p /etc/rancher/k3s /var/lib/rancher/k3s /var/lib/kuintessence /scratch
chmod 1777 /scratch

remove_stale_k3s_cgroups() {
  local path name cgroup_pid

  shopt -s nullglob
  for path in /sys/fs/cgroup/k8s.io/*; do
    [[ -d "${path}" ]] || continue
    name="${path##*/}"
    [[ "${name}" =~ ^[0-9a-f]{64}$ ]] || continue
    if ! read -r cgroup_pid <"${path}/cgroup.procs"; then
      rmdir "${path}" 2>/dev/null || true
    fi
  done
  shopt -u nullglob
}

remove_stale_k3s_cgroups

k3s_pid=""
agent_pid=""

shutdown() {
  trap - TERM INT

  for pid in "${agent_pid}" "${k3s_pid}"; do
    if [[ -n "${pid}" ]] && kill -0 "${pid}" 2>/dev/null; then
      kill -TERM "${pid}"
    fi
  done

  for pid in "${agent_pid}" "${k3s_pid}"; do
    if [[ -n "${pid}" ]]; then
      wait "${pid}" 2>/dev/null || true
    fi
  done
}

trap 'shutdown; exit 143' TERM
trap 'shutdown; exit 130' INT

k3s server \
  --write-kubeconfig /etc/rancher/k3s/k3s.yaml \
  --write-kubeconfig-mode 0644 \
  --disable traefik \
  --disable servicelb \
  --kubelet-arg cgroups-per-qos=false \
  --kubelet-arg enforce-node-allocatable= \
  --kubelet-arg fail-swap-on=false \
  --node-name "$(hostname -s)" &
k3s_pid="$!"

for _ in {1..120}; do
  if kubectl get nodes >/dev/null 2>&1; then
    break
  fi
  sleep 1
done

if ! kubectl get nodes >/dev/null 2>&1; then
  echo "K3s did not become ready" >&2
  exit 1
fi

/usr/local/bin/kq-register-compose-agent

/usr/local/bin/kq-start-agent &
agent_pid="$!"

set +e
wait -n "${k3s_pid}" "${agent_pid}"
status="$?"
set -e

shutdown
exit "${status}"
