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

if ! command -v docker >/dev/null 2>&1; then
  echo "docker is not installed or not on PATH" >&2
  exit 1
fi

if ! docker info >/dev/null 2>&1; then
  echo "docker daemon is not reachable" >&2
  exit 1
fi

docker compose version >/dev/null
"${compose_cmd[@]}" config >/dev/null

if [[ "${KQ_SCHEDULER_PREFLIGHT_SKIP_PORTS:-false}" == "true" ]]; then
  echo "preflight passed: docker is reachable, compose project ${project_name} config is valid, port check skipped"
  exit 0
fi

ports=(
  "${KQ_SCHEDULER_SERVER_HTTP_PORT:-3000}"
  "${KQ_SCHEDULER_SERVER_GRPC_PORT:-3001}"
  "${KQ_SCHEDULER_REGISTRY_PORT:-3100}"
  "${KQ_SCHEDULER_WEB_PORT:-5173}"
  "${KQ_SCHEDULER_POSTGRES_PORT:-5432}"
  "${KQ_SCHEDULER_REDIS_PORT:-6379}"
  "${KQ_SCHEDULER_RUSTFS_API_PORT:-9000}"
  "${KQ_SCHEDULER_RUSTFS_CONSOLE_PORT:-9001}"
)
busy=()
for port in "${ports[@]}"; do
  if lsof -nP -iTCP:"${port}" -sTCP:LISTEN >/dev/null 2>&1; then
    busy+=("${port}")
  fi
done

if ((${#busy[@]} > 0)); then
  echo "ports already in use: ${busy[*]}" >&2
  exit 1
fi

echo "preflight passed: docker is reachable, compose project ${project_name} config is valid, required ports are free"
