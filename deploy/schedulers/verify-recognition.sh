#!/usr/bin/env bash
set -euo pipefail

compose_files="${1:-deploy/compose/docker-compose.schedulers.yml}"
env_file="${2:-}"

if [[ -n "${env_file}" ]]; then
  if [[ ! -f "${env_file}" ]]; then
    echo "env file not found: ${env_file}" >&2
    exit 1
  fi
  set -a
  # shellcheck disable=SC1090
  source "${env_file}"
  set +a
fi

project_name="${KQ_SCHEDULER_COMPOSE_PROJECT:-kq-schedulers}"
compose_cmd=(docker compose --project-directory . -p "${project_name}")
if [[ -n "${env_file}" ]]; then
  compose_cmd+=(--env-file "${env_file}")
fi
IFS=':' read -r -a compose_file_list <<<"${compose_files}"
for compose_file in "${compose_file_list[@]}"; do
  if [[ -n "${compose_file}" ]]; then
    compose_cmd+=(-f "${compose_file}")
  fi
done

timeout_sec="${KQ_SCHEDULER_VERIFY_TIMEOUT_SEC:-240}"
poll_sec="${KQ_SCHEDULER_VERIFY_POLL_SEC:-5}"
heartbeat_max_age_sec="${KQ_SCHEDULER_VERIFY_HEARTBEAT_MAX_AGE_SEC:-90}"

if [[ ! "${heartbeat_max_age_sec}" =~ ^[0-9]+$ ]] || ((heartbeat_max_age_sec <= 0)); then
  echo "KQ_SCHEDULER_VERIFY_HEARTBEAT_MAX_AGE_SEC must be a positive integer" >&2
  exit 1
fi

wait_for() {
  local label="$1"
  shift
  local start="${SECONDS}"

  until "$@" >/dev/null 2>&1; do
    if ((SECONDS - start >= timeout_sec)); then
      echo "timed out waiting for ${label} after ${timeout_sec}s" >&2
      return 1
    fi
    sleep "${poll_sec}"
  done
}

agent_registry_ready() {
  local count
  count="$(
    "${compose_cmd[@]}" exec -T postgres psql -U kq -d kuintessence -Atc "
      select count(*)
      from agents
      where status = 'online'
        and last_heartbeat is not null
        and last_heartbeat >= now() - (${heartbeat_max_age_sec} * interval '1 second')
        and (
          (agent_id = 'scheduler-slurm' and scheduler_type = 'slurm')
          or (agent_id = 'scheduler-pbs' and scheduler_type = 'pbs-pro')
          or (agent_id = 'scheduler-k3s' and scheduler_type = 'kubernetes')
        );
    " 2>/dev/null | tr -d '[:space:]'
  )"
  [[ "${count}" == "3" ]]
}

"${compose_cmd[@]}" ps

echo
echo "Waiting for scheduler CLIs and Server registry..."
wait_for "Slurm architecture contract" "${compose_cmd[@]}" exec -T scheduler-slurm kq-verify-architecture /usr/local/bin/bun
wait_for "PBS architecture contract" "${compose_cmd[@]}" exec -T scheduler-pbs kq-verify-architecture /usr/local/bin/bun
wait_for "K3s architecture contract" "${compose_cmd[@]}" exec -T scheduler-k3s kq-verify-architecture /usr/local/bin/bun /usr/local/bin/k3s
wait_for "Slurm CLI" "${compose_cmd[@]}" exec -T scheduler-slurm bash -lc "sinfo -h -o '%N|%T|%P' | grep -Eq '.+'"
wait_for "PBS CLI" "${compose_cmd[@]}" exec -T scheduler-pbs bash -lc "qsub --version && qstat -B"
wait_for "K3s CLI" "${compose_cmd[@]}" exec -T scheduler-k3s bash -lc "kubectl get nodes >/dev/null"
wait_for "Server agent registry" agent_registry_ready

echo
echo "== Slurm =="
"${compose_cmd[@]}" exec -T scheduler-slurm sinfo -h -o "%N|%T|%P"

echo
echo "== PBS =="
"${compose_cmd[@]}" exec -T scheduler-pbs qsub --version
"${compose_cmd[@]}" exec -T scheduler-pbs qstat -B

echo
echo "== K3s =="
"${compose_cmd[@]}" exec -T scheduler-k3s kubectl get nodes -o wide

echo
echo "== Server agent registry =="
"${compose_cmd[@]}" exec -T postgres psql -U kq -d kuintessence -c \
  "select agent_id, scheduler_type, scheduler_version, status, last_heartbeat, round(extract(epoch from (now() - last_heartbeat)))::int as heartbeat_age_sec from agents where agent_id in ('scheduler-slurm','scheduler-pbs','scheduler-k3s') order by agent_id;"
