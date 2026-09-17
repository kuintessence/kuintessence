#!/usr/bin/env bash
set -euo pipefail

compose_files="${1:-deploy/compose/docker-compose.schedulers.yml}"
env_file="${2:-deploy/schedulers/ports-alt.env}"
script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

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

running_count="$("${compose_cmd[@]}" ps --status running -q | wc -l | tr -d '[:space:]')"
if [[ "${running_count}" == "0" ]]; then
  "${script_dir}/preflight.sh" "${compose_files}" "${env_file}"
else
  KQ_SCHEDULER_PREFLIGHT_SKIP_PORTS=true "${script_dir}/preflight.sh" "${compose_files}" "${env_file}"
fi

if [[ "${KQ_SCHEDULER_SMOKE_BUILD:-false}" == "true" ]]; then
  "${compose_cmd[@]}" build
fi

"${compose_cmd[@]}" up -d
"${script_dir}/verify-recognition.sh" "${compose_files}" "${env_file}"

echo
echo "scheduler smoke passed"
