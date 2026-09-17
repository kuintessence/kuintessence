#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat <<'EOF'
Usage:
  bash deploy/schedulers/interruptible-validation.sh [compose-files] [env-file]

Environment:
  KQ_SCHEDULER_INTERRUPTIBLE_VALIDATION_RESTART
      When true, restart existing Server / Registry / SpiceDB services, run the
      scheduler-stack DB migration, then execute root and transfer restart
      smoke checks. Defaults to false.

Examples:
  bash deploy/schedulers/interruptible-validation.sh deploy/compose/docker-compose.schedulers.yml deploy/schedulers/ports-alt.env
  KQ_SCHEDULER_INTERRUPTIBLE_VALIDATION_RESTART=true \
    bash deploy/schedulers/interruptible-validation.sh deploy/compose/docker-compose.schedulers.yml deploy/schedulers/ports-alt.env
EOF
}

if [[ "${1:-}" == "-h" || "${1:-}" == "--help" ]]; then
  usage
  exit 0
fi

compose_files="${1:-deploy/compose/docker-compose.schedulers.yml}"
env_file="${2:-deploy/schedulers/ports-alt.env}"
restart_services="${KQ_SCHEDULER_INTERRUPTIBLE_VALIDATION_RESTART:-false}"

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

if ! command -v curl >/dev/null 2>&1; then
  echo "curl is required" >&2
  exit 1
fi

if ! command -v bun >/dev/null 2>&1; then
  echo "bun is required" >&2
  exit 1
fi

project_name="${KQ_SCHEDULER_COMPOSE_PROJECT:-kq-schedulers}"
server_port="${KQ_SCHEDULER_SERVER_HTTP_PORT:-3000}"
postgres_port="${KQ_SCHEDULER_POSTGRES_PORT:-5432}"
api_base="http://127.0.0.1:${server_port}/api"
script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
repo_root="$(cd "${script_dir}/../.." && pwd)"

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

json_get() {
  local expr="$1"
  KQ_JSON_EXPR="${expr}" bun -e '
    const fs = require("node:fs");
    const data = JSON.parse(fs.readFileSync(0, "utf8"));
    const value = Function("data", `return (${process.env.KQ_JSON_EXPR});`)(data);
    if (value === undefined || value === null) {
      process.exit(2);
    }
    process.stdout.write(typeof value === "string" ? value : JSON.stringify(value));
  '
}

wait_for_server() {
  local start="${SECONDS}"
  until curl -fsS "${api_base}/health" | json_get 'data.status ?? data.data?.status ?? data.status' | grep -qx "ok"; do
    if ((SECONDS - start >= 120)); then
      echo "timed out waiting for Server health at ${api_base}/health" >&2
      exit 1
    fi
    sleep 2
  done
}

running_count="$("${compose_cmd[@]}" ps --status running -q | wc -l | tr -d '[:space:]')"
if [[ "${running_count}" == "0" ]]; then
  echo "scheduler compose stack is not running; run deploy/schedulers/smoke.sh first" >&2
  exit 1
fi

"${script_dir}/db-pool-diagnostic.sh" "${compose_files}" "${env_file}" || true
"${script_dir}/file-transfer-restart-smoke.sh" "${compose_files}" "${env_file}"

if [[ "${restart_services}" != "true" ]]; then
  cat <<EOF
Non-disruptive validation finished.
Set KQ_SCHEDULER_INTERRUPTIBLE_VALIDATION_RESTART=true to restart Server / Registry / SpiceDB,
run DATABASE_URL=postgres://kq:kq@localhost:${postgres_port}/kuintessence bun run db:migrate,
then execute cluster-file-roots and restart-reconciliation smoke checks.
EOF
  exit 0
fi

echo "Restarting existing scheduler control-plane services: spicedb server registry"
"${compose_cmd[@]}" restart spicedb server registry
wait_for_server

(
  cd "${repo_root}"
  DATABASE_URL="postgres://kq:kq@localhost:${postgres_port}/kuintessence" bun run db:migrate
)

"${script_dir}/db-pool-diagnostic.sh" "${compose_files}" "${env_file}" || true
"${script_dir}/cluster-file-roots-smoke.sh" "${compose_files}" "${env_file}"
KQ_FILE_TRANSFER_RESTART_SMOKE_RESTART_SERVER=true \
  "${script_dir}/file-transfer-restart-smoke.sh" "${compose_files}" "${env_file}"

echo "Interruptible scheduler validation OK."
