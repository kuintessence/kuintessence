#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat <<'EOF'
Usage:
  bash deploy/schedulers/file-transfer-restart-smoke.sh [compose-files] [env-file]

Environment:
  KQ_FILE_TRANSFER_RESTART_SMOKE_RESTART_SERVER
      When true, insert queued/running transfer rows, restart the existing Server
      service, and verify restart reconciliation. Defaults to false.
  KQ_FILE_TRANSFER_RESTART_SMOKE_EMAIL
      Dev login email. Defaults to transfer-restart-smoke@e2e.test.

Examples:
  bash deploy/schedulers/file-transfer-restart-smoke.sh
  KQ_FILE_TRANSFER_RESTART_SMOKE_RESTART_SERVER=true \
    bash deploy/schedulers/file-transfer-restart-smoke.sh deploy/compose/docker-compose.schedulers.yml deploy/schedulers/ports-alt.env
EOF
}

if [[ "${1:-}" == "-h" || "${1:-}" == "--help" ]]; then
  usage
  exit 0
fi

compose_files="${1:-deploy/compose/docker-compose.schedulers.yml}"
env_file="${2:-deploy/schedulers/ports-alt.env}"

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
  echo "scheduler compose stack is not running; run deploy/schedulers/smoke.sh first" >&2
  exit 1
fi

server_port="${KQ_SCHEDULER_SERVER_HTTP_PORT:-3000}"
api_base="http://127.0.0.1:${server_port}/api"
email="${KQ_FILE_TRANSFER_RESTART_SMOKE_EMAIL:-transfer-restart-smoke@e2e.test}"
restart_server="${KQ_FILE_TRANSFER_RESTART_SMOKE_RESTART_SERVER:-false}"
token=""
smoke_ids=(
  "00000000-0000-4000-8000-000000000301"
  "00000000-0000-4000-8000-000000000302"
  "00000000-0000-4000-8000-000000000303"
)

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

api_json() {
  local method="$1"
  local path="$2"
  local body="${3:-}"
  if [[ -n "${body}" ]]; then
    curl -fsS -X "${method}" "${api_base}${path}" \
      -H "Authorization: Bearer ${token}" \
      -H "Content-Type: application/json" \
      --data "${body}"
  else
    curl -fsS -X "${method}" "${api_base}${path}" \
      -H "Authorization: Bearer ${token}"
  fi
}

psql() {
  "${compose_cmd[@]}" exec -T postgres psql -U kq -d kuintessence "$@"
}

cleanup() {
  psql -v id1="${smoke_ids[0]}" -v id2="${smoke_ids[1]}" -v id3="${smoke_ids[2]}" >/dev/null 2>&1 <<'SQL' || true
delete from file_transfers
where id in (:'id1', :'id2', :'id3');
SQL
}
trap cleanup EXIT

wait_for_server() {
  local start="${SECONDS}"
  local body=""
  local status=""
  while true; do
    if body="$(curl -fsS "${api_base}/health" 2>/dev/null)" && \
      status="$(json_get 'data.status' <<<"${body}" 2>/dev/null)" && \
      [[ "${status}" == "ok" ]]; then
      return
    fi
    if ((SECONDS - start >= 120)); then
      echo "timed out waiting for Server health" >&2
      exit 1
    fi
    sleep 2
  done
}

login() {
  local payload login_json
  payload="$(
    KQ_EMAIL="${email}" bun -e '
      process.stdout.write(JSON.stringify({ email: process.env.KQ_EMAIL, role: "platform_admin" }));
    '
  )"
  login_json="$(curl -fsS -X POST "${api_base}/auth/login" -H "Content-Type: application/json" --data "${payload}")"
  token="$(json_get 'data.token' <<<"${login_json}")"
}

user_id() {
  psql -At -v user_email="${email}" <<'SQL'
select id from users where email = :'user_email' limit 1;
SQL
}

assert_filter_endpoint() {
  local body
  body="$(api_json GET "/files/transfers?state=failed&error=TRANSFER_INTERRUPTED_BY_SERVER_RESTART")"
  bun -e '
    const fs = require("node:fs");
    const data = JSON.parse(fs.readFileSync(0, "utf8"));
    if (!Array.isArray(data.transfers)) {
      console.error("expected transfers array");
      console.error(JSON.stringify(data, null, 2));
      process.exit(1);
    }
  ' <<<"${body}"
}

assert_file_transfers_table() {
  local exists
  if ! exists="$(psql -Atc "select to_regclass('public.file_transfers') is not null;")"; then
    echo "failed to query scheduler PostgreSQL; check the compose stack and connection limits" >&2
    exit 1
  fi
  echo "${exists}" | grep -qx "t" || {
    echo "file_transfers table is missing; run DATABASE_URL=postgres://kq:kq@localhost:${KQ_SCHEDULER_POSTGRES_PORT:-5432}/kuintessence bun run db:migrate for the scheduler stack" >&2
    exit 1
  }
}

precheck_file_transfers_table() {
  local exists
  if ! exists="$(psql -Atc "select to_regclass('public.file_transfers') is not null;")"; then
    local diagnostic_hint="bash deploy/schedulers/db-pool-diagnostic.sh ${compose_files}"
    if [[ -n "${env_file}" ]]; then
      diagnostic_hint="${diagnostic_hint} ${env_file}"
    fi
    echo "warning: skipped file_transfers table precheck because scheduler PostgreSQL rejected the connection; run ${diagnostic_hint} to locate connection pressure" >&2
    return
  fi
  if echo "${exists}" | grep -qx "t"; then
    echo "file_transfers table precheck OK."
    return
  fi
  echo "warning: file_transfers table is missing; opt-in restart reconciliation smoke will fail until DATABASE_URL=postgres://kq:kq@localhost:${KQ_SCHEDULER_POSTGRES_PORT:-5432}/kuintessence bun run db:migrate is applied" >&2
}

insert_smoke_transfers() {
  local uid="$1"
  psql -v uid="${uid}" -v id1="${smoke_ids[0]}" -v id2="${smoke_ids[1]}" -v id3="${smoke_ids[2]}" <<'SQL'
delete from file_transfers
where id in (:'id1', :'id2', :'id3');

insert into file_transfers (
  id, user_id, direction, source, target, agent_id, site_id, total_bytes,
  copied_bytes, state, started_at, error, netdrive_file_ids
) values
  (:'id1', :'uid', 'cluster_to_cloud', '/tmp/kq-transfer-restart-running.txt', 'smoke/transfer-restart/running.txt', 'scheduler-slurm', 'Docker Slurm AIO', 12, 3, 'running', now(), null, '[]'::jsonb),
  (:'id2', :'uid', 'cloud_to_cluster', 'smoke/transfer-restart/queued.txt', '/tmp/kq-transfer-restart-queued.txt', 'scheduler-slurm', 'Docker Slurm AIO', 12, 0, 'queued', now(), null, '[]'::jsonb),
  (:'id3', :'uid', 'cluster_to_cloud', '/tmp/kq-transfer-restart-done.txt', 'smoke/transfer-restart/done.txt', 'scheduler-slurm', 'Docker Slurm AIO', 12, 12, 'succeeded', now(), null, '[]'::jsonb);
SQL
}

restart_server_service() {
  "${compose_cmd[@]}" restart server >/dev/null
  wait_for_server
}

assert_reconciled() {
  local uid="$1"
  local count terminal_state
  count="$(
    psql -At -v uid="${uid}" -v id1="${smoke_ids[0]}" -v id2="${smoke_ids[1]}" <<'SQL'
select count(*)
from file_transfers
where user_id = :'uid'
  and id in (:'id1', :'id2')
  and state = 'failed'
  and error = 'TRANSFER_INTERRUPTED_BY_SERVER_RESTART';
SQL
  )"
  if [[ "${count}" != "2" ]]; then
    echo "expected 2 interrupted transfers after Server restart, got ${count}" >&2
    exit 1
  fi
  terminal_state="$(
    psql -At -v id3="${smoke_ids[2]}" <<'SQL'
select state || ':' || coalesce(error, '')
from file_transfers
where id = :'id3';
SQL
  )"
  if [[ "${terminal_state}" != "succeeded:" ]]; then
    echo "terminal transfer was modified unexpectedly: ${terminal_state}" >&2
    exit 1
  fi
  login
  api_json GET "/files/transfers?state=failed&error=TRANSFER_INTERRUPTED_BY_SERVER_RESTART" |
    KQ_ID1="${smoke_ids[0]}" KQ_ID2="${smoke_ids[1]}" bun -e '
      const fs = require("node:fs");
      const data = JSON.parse(fs.readFileSync(0, "utf8"));
      const ids = new Set((data.transfers ?? []).map((transfer) => transfer.id));
      for (const id of [process.env.KQ_ID1, process.env.KQ_ID2]) {
        if (!ids.has(id)) {
          console.error(`missing interrupted transfer ${id} from filtered API`);
          console.error(JSON.stringify(data, null, 2));
          process.exit(1);
        }
      }
    '
}

wait_for_server
login
assert_filter_endpoint

if [[ "${restart_server}" != "true" ]]; then
  precheck_file_transfers_table
  echo "File transfer restart smoke API filter OK; set KQ_FILE_TRANSFER_RESTART_SMOKE_RESTART_SERVER=true to verify Server restart reconciliation."
  exit 0
fi

assert_file_transfers_table
uid="$(user_id)"
if [[ -z "${uid}" ]]; then
  echo "login did not create a Server user for ${email}" >&2
  exit 1
fi
insert_smoke_transfers "${uid}"
restart_server_service
assert_reconciled "${uid}"

echo "File transfer restart smoke OK: interrupted=${smoke_ids[0]},${smoke_ids[1]}"
