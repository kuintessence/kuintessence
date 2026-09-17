#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat <<'EOF'
Usage:
  bash deploy/schedulers/file-transfer-cancel-smoke.sh [compose-files] [env-file]

Environment:
  KQ_FILE_TRANSFER_CANCEL_SMOKE_SIZE_BYTES
      Sparse cluster source size. Defaults to 1073741824 (1 GiB).
  KQ_FILE_TRANSFER_CANCEL_SMOKE_AGENT_ID
      Agent used for the live multipart transfer. Defaults to scheduler-slurm.
  KQ_FILE_TRANSFER_CANCEL_SMOKE_SITE_ID
      Site name recorded on the transfer. Defaults to Docker Slurm AIO.
  KQ_FILE_TRANSFER_CANCEL_SMOKE_SERVICE
      Compose service containing the source file. Defaults to scheduler-slurm.
  KQ_FILE_TRANSFER_CANCEL_SMOKE_EMAIL
      Dev login email. Defaults to transfer-cancel-smoke@e2e.test.
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

for command in bun curl; do
  if ! command -v "${command}" >/dev/null 2>&1; then
    echo "${command} is required" >&2
    exit 1
  fi
done

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

if [[ "$("${compose_cmd[@]}" ps --status running -q | wc -l | tr -d '[:space:]')" == "0" ]]; then
  echo "scheduler compose stack is not running; run deploy/schedulers/smoke.sh first" >&2
  exit 1
fi

server_port="${KQ_SCHEDULER_SERVER_HTTP_PORT:-3000}"
api_base="http://127.0.0.1:${server_port}/api"
email="${KQ_FILE_TRANSFER_CANCEL_SMOKE_EMAIL:-transfer-cancel-smoke@e2e.test}"
agent_id="${KQ_FILE_TRANSFER_CANCEL_SMOKE_AGENT_ID:-scheduler-slurm}"
site_id="${KQ_FILE_TRANSFER_CANCEL_SMOKE_SITE_ID:-Docker Slurm AIO}"
compose_service="${KQ_FILE_TRANSFER_CANCEL_SMOKE_SERVICE:-scheduler-slurm}"
size_bytes="${KQ_FILE_TRANSFER_CANCEL_SMOKE_SIZE_BYTES:-1073741824}"
smoke_root="/tmp/kq-transfer-cancel-smoke"
source_path="${smoke_root}/source-$$.bin"
target_path="smoke/transfer-cancel/target-$(date +%s)-$$.bin"
token=""
root_id=""
transfer_id=""

if [[ ! "${size_bytes}" =~ ^[1-9][0-9]*$ ]]; then
  echo "KQ_FILE_TRANSFER_CANCEL_SMOKE_SIZE_BYTES must be a positive integer" >&2
  exit 1
fi

json_get() {
  local expr="$1"
  KQ_JSON_EXPR="${expr}" bun -e '
    const fs = require("node:fs");
    const data = JSON.parse(fs.readFileSync(0, "utf8"));
    const value = Function("data", `return (${process.env.KQ_JSON_EXPR});`)(data);
    if (value === undefined || value === null) process.exit(2);
    process.stdout.write(typeof value === "string" ? value : JSON.stringify(value));
  '
}

urlencode() {
  KQ_VALUE="$1" bun -e 'process.stdout.write(encodeURIComponent(process.env.KQ_VALUE ?? ""));'
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

process_authz_outbox() {
  api_json POST "/admin/authz/outbox/process" "{}" >/dev/null 2>&1 || true
}

rebuild_authz_relationships() {
  curl --max-time 120 -fsS -X POST "${api_base}/admin/authz/rebuild" \
    -H "Authorization: Bearer ${token}" \
    -H "Content-Type: application/json" \
    --data "{}" >/dev/null
}

cleanup_published_target() {
  if [[ -z "${token}" ]]; then
    return
  fi
  local prefix files
  prefix="$(urlencode "${target_path}")"
  files="$(api_json GET "/netdrive/files?prefix=${prefix}" 2>/dev/null || true)"
  if [[ -z "${files}" ]]; then
    return
  fi
  while IFS= read -r file_id; do
    if [[ -n "${file_id}" ]]; then
      api_json DELETE "/netdrive/files/${file_id}" >/dev/null 2>&1 || true
    fi
  done < <(
    KQ_TARGET_PATH="${target_path}" bun -e '
      const fs = require("node:fs");
      const data = JSON.parse(fs.readFileSync(0, "utf8"));
      for (const file of data.files ?? []) {
        if (file.path === process.env.KQ_TARGET_PATH) console.log(file.id);
      }
    ' <<<"${files}"
  )
}

cleanup() {
  if [[ -n "${transfer_id}" && -n "${token}" ]]; then
    api_json POST "/files/transfers/${transfer_id}/cancel" "{}" >/dev/null 2>&1 || true
  fi
  cleanup_published_target
  if [[ -n "${root_id}" && -n "${token}" ]]; then
    api_json PATCH "/admin/cluster-file-roots/${root_id}" '{"enabled":false}' >/dev/null 2>&1 || true
    process_authz_outbox
  fi
  "${compose_cmd[@]}" exec -T "${compose_service}" sh -lc "rm -rf '${smoke_root}'" >/dev/null 2>&1 || true
}
trap cleanup EXIT

login() {
  local payload response
  payload="$(
    KQ_EMAIL="${email}" bun -e '
      process.stdout.write(JSON.stringify({ email: process.env.KQ_EMAIL, role: "platform_admin" }));
    '
  )"
  response="$(curl -fsS -X POST "${api_base}/auth/login" -H "Content-Type: application/json" --data "${payload}")"
  token="$(json_get 'data.token' <<<"${response}")"
}

wait_for_agent() {
  local start="${SECONDS}"
  until psql -At -v agent="${agent_id}" <<'SQL' | grep -qx "1"; do
select count(*)
from agents
where agent_id = :'agent'
  and status = 'online'
  and last_heartbeat >= now() - interval '90 seconds';
SQL
    if ((SECONDS - start >= 120)); then
      echo "timed out waiting for ${agent_id}" >&2
      exit 1
    fi
    sleep 3
  done
}

provider_org_id() {
  api_json GET "/cp/agent-registration-context" | json_get '
    (data.providerOrgs ?? []).find((org) => org.name === "Development Compute Provider")?.id ??
      (data.providerOrgs ?? [])[0]?.id
  '
}

find_root_id() {
  psql -At -v root_path="${smoke_root}" -v root_agent="${agent_id}" <<'SQL'
select id
from cluster_file_roots
where path = :'root_path' and agent_id = :'root_agent'
limit 1;
SQL
}

create_or_update_root() {
  local provider_org="$1"
  local existing payload
  existing="$(find_root_id)"
  payload="$(
    KQ_PROVIDER_ORG="${provider_org}" KQ_AGENT_ID="${agent_id}" KQ_PATH="${smoke_root}" bun -e '
      process.stdout.write(JSON.stringify({
        label: "Transfer cancel smoke root",
        providerOrgId: process.env.KQ_PROVIDER_ORG,
        agentId: process.env.KQ_AGENT_ID,
        path: process.env.KQ_PATH,
        visibleOrgIds: [process.env.KQ_PROVIDER_ORG],
        enabled: true,
      }));
    '
  )"
  if [[ -n "${existing}" ]]; then
    api_json PATCH "/admin/cluster-file-roots/${existing}" "${payload}" >/dev/null
    echo "${existing}"
  else
    api_json POST "/admin/cluster-file-roots" "${payload}" | json_get 'data.id'
  fi
}

prepare_source() {
  "${compose_cmd[@]}" exec -T "${compose_service}" sh -lc \
    "mkdir -p '${smoke_root}' && truncate -s '${size_bytes}' '${source_path}' && chmod 755 '${smoke_root}' && chmod 644 '${source_path}'"
}

create_transfer() {
  local payload response
  payload="$(
    KQ_SOURCE="${source_path}" KQ_TARGET="${target_path}" KQ_AGENT_ID="${agent_id}" \
      KQ_SITE_ID="${site_id}" KQ_SIZE_BYTES="${size_bytes}" bun -e '
        process.stdout.write(JSON.stringify({
          direction: "cluster_to_cloud",
          source: process.env.KQ_SOURCE,
          target: process.env.KQ_TARGET,
          agentId: process.env.KQ_AGENT_ID,
          siteId: process.env.KQ_SITE_ID,
          totalBytes: Number(process.env.KQ_SIZE_BYTES),
        }));
      '
  )"
  response="$(api_json POST "/files/transfers" "${payload}")"
  transfer_id="$(json_get 'data.id' <<<"${response}")"
}

transfer_snapshot() {
  api_json GET "/files/transfers" | KQ_TRANSFER_ID="${transfer_id}" bun -e '
    const fs = require("node:fs");
    const data = JSON.parse(fs.readFileSync(0, "utf8"));
    const transfer = (data.transfers ?? []).find((item) => item.id === process.env.KQ_TRANSFER_ID);
    if (!transfer) process.exit(2);
    process.stdout.write(JSON.stringify(transfer));
  '
}

wait_for_live_io() {
  local start="${SECONDS}"
  local snapshot state copied
  while true; do
    snapshot="$(transfer_snapshot)"
    state="$(json_get 'data.state' <<<"${snapshot}")"
    copied="$(json_get 'data.copiedBytes' <<<"${snapshot}")"
    if [[ "${state}" == "running" && "${copied}" -gt 0 ]]; then
      echo "live multipart I/O observed: copiedBytes=${copied}"
      return
    fi
    if [[ "${state}" == "succeeded" ]]; then
      echo "transfer completed before cancellation; increase KQ_FILE_TRANSFER_CANCEL_SMOKE_SIZE_BYTES" >&2
      exit 1
    fi
    if [[ "${state}" == "failed" || "${state}" == "cancelled" ]]; then
      echo "transfer reached ${state} before live I/O assertion: ${snapshot}" >&2
      exit 1
    fi
    if ((SECONDS - start >= 90)); then
      echo "timed out waiting for live transfer I/O: ${snapshot}" >&2
      exit 1
    fi
    sleep 0.1
  done
}

cancel_transfer() {
  local response state
  response="$(api_json POST "/files/transfers/${transfer_id}/cancel" "{}")"
  state="$(json_get 'data.state' <<<"${response}")"
  if [[ "${state}" != "cancelled" ]]; then
    echo "expected cancel response state=cancelled, got ${state}: ${response}" >&2
    exit 1
  fi
}

assert_cancelled_stable() {
  sleep 3
  local snapshot state
  snapshot="$(transfer_snapshot)"
  state="$(json_get 'data.state' <<<"${snapshot}")"
  if [[ "${state}" != "cancelled" ]]; then
    echo "cancelled transfer changed terminal state: ${snapshot}" >&2
    exit 1
  fi
}

assert_target_not_published() {
  local prefix response
  prefix="$(urlencode "${target_path}")"
  response="$(api_json GET "/netdrive/files?prefix=${prefix}")"
  KQ_TARGET_PATH="${target_path}" bun -e '
    const fs = require("node:fs");
    const data = JSON.parse(fs.readFileSync(0, "utf8"));
    const published = (data.files ?? []).find((file) => file.path === process.env.KQ_TARGET_PATH);
    if (published) {
      console.error(`cancelled transfer published ${published.path} (${published.id})`);
      process.exit(1);
    }
  ' <<<"${response}"
}

curl -fsS "${api_base}/health" | json_get 'data.status' | grep -qx "ok"
wait_for_agent
login
rebuild_authz_relationships
provider_org="$(provider_org_id)"
prepare_source
root_id="$(create_or_update_root "${provider_org}")"
process_authz_outbox
create_transfer
wait_for_live_io
cancel_transfer
assert_cancelled_stable
assert_target_not_published

echo "File transfer cancel smoke OK: transfer=${transfer_id}, copied-before-cancel>0, target=${target_path}"
