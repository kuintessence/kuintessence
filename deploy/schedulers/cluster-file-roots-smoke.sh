#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat <<'EOF'
Usage:
  bash deploy/schedulers/cluster-file-roots-smoke.sh [compose-files] [env-file]

Environment:
  KQ_CLUSTER_ROOTS_SMOKE_AGENT_ID
      Agent used for shell-backed cluster listing and transfer preflight.
      Defaults to scheduler-slurm.
  KQ_CLUSTER_ROOTS_SMOKE_SITE_ID
      Site name passed to /api/files/cluster. Defaults to Docker Slurm AIO.
  KQ_CLUSTER_ROOTS_SMOKE_COMPOSE_SERVICE
      Docker Compose service used to prepare/remove smoke files. Defaults to
      scheduler-slurm.
  KQ_CLUSTER_ROOTS_SMOKE_PATH
      Writable root path created inside the scheduler container. Defaults to
      /tmp/kq-cluster-roots-smoke.
  KQ_CLUSTER_ROOTS_SMOKE_EMAIL
      Dev login email. Defaults to cluster-roots-smoke@e2e.test.

Examples:
  bash deploy/schedulers/cluster-file-roots-smoke.sh
  bash deploy/schedulers/cluster-file-roots-smoke.sh deploy/compose/docker-compose.schedulers.yml deploy/schedulers/ports-alt.env
EOF
}

if [[ "${1:-}" == "-h" || "${1:-}" == "--help" ]]; then
  usage
  exit 0
fi

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
email="${KQ_CLUSTER_ROOTS_SMOKE_EMAIL:-cluster-roots-smoke@e2e.test}"
agent_id="${KQ_CLUSTER_ROOTS_SMOKE_AGENT_ID:-scheduler-slurm}"
site_id="${KQ_CLUSTER_ROOTS_SMOKE_SITE_ID:-Docker Slurm AIO}"
compose_service="${KQ_CLUSTER_ROOTS_SMOKE_COMPOSE_SERVICE:-scheduler-slurm}"
cluster_root="${KQ_CLUSTER_ROOTS_SMOKE_PATH:-/tmp/kq-cluster-roots-smoke}"
readonly_root="/sys"
sample_dir="${cluster_root}/inputs"
sample_file="${sample_dir}/README.md"
missing_file="${sample_dir}/missing.txt"
readonly_target="${readonly_root}/kq-cluster-roots-smoke.txt"
token=""
writable_root_id=""
readonly_root_id=""

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

api_status() {
  local method="$1"
  local path="$2"
  local body="${3:-}"
  local out_file="$4"
  if [[ -n "${body}" ]]; then
    curl -sS -o "${out_file}" -w "%{http_code}" -X "${method}" "${api_base}${path}" \
      -H "Authorization: Bearer ${token}" \
      -H "Content-Type: application/json" \
      --data "${body}"
  else
    curl -sS -o "${out_file}" -w "%{http_code}" -X "${method}" "${api_base}${path}" \
      -H "Authorization: Bearer ${token}"
  fi
}

process_authz_outbox() {
  curl -fsS -X POST "${api_base}/admin/authz/outbox/process" \
    -H "Authorization: Bearer ${token}" >/dev/null 2>&1 || true
}

rebuild_authz_relationships() {
  curl --max-time 120 -fsS -X POST "${api_base}/admin/authz/rebuild" \
    -H "Authorization: Bearer ${token}" \
    -H "Content-Type: application/json" \
    --data "{}" >/dev/null
}

psql() {
  "${compose_cmd[@]}" exec -T postgres psql -U kq -d kuintessence "$@"
}

wait_for_agent() {
  local start="${SECONDS}"
  until psql -Atc "select count(*) from agents where agent_id = '${agent_id}' and status = 'online' and last_heartbeat >= now() - interval '90 seconds';" | grep -qx "1"; do
    if ((SECONDS - start >= 120)); then
      echo "timed out waiting for ${agent_id}" >&2
      exit 1
    fi
    sleep 3
  done
}

disable_root() {
  local id="$1"
  if [[ -n "${id}" && -n "${token}" ]]; then
    api_json PATCH "/admin/cluster-file-roots/${id}" '{"enabled":false}' >/dev/null 2>&1 || true
    process_authz_outbox
  fi
}

cleanup() {
  disable_root "${writable_root_id}"
  disable_root "${readonly_root_id}"
  "${compose_cmd[@]}" exec -T "${compose_service}" sh -lc "rm -rf '${cluster_root}'" >/dev/null 2>&1 || true
}
trap cleanup EXIT

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

provider_org_id() {
  api_json GET "/cp/agent-registration-context" | json_get '
    (data.providerOrgs ?? []).find((org) => org.name === "Development Compute Provider")?.id ??
      (data.providerOrgs ?? [])[0]?.id
  '
}

prepare_cluster_files() {
  "${compose_cmd[@]}" exec -T "${compose_service}" sh -lc "
    mkdir -p '${sample_dir}' &&
    printf '%s\n' 'cluster file roots smoke' > '${sample_file}' &&
    chmod 755 '${cluster_root}' '${sample_dir}'
  "
}

find_root_id() {
  local path="$1"
  psql -At -v root_path="${path}" -v root_agent="${agent_id}" <<'SQL'
select id
from cluster_file_roots
where path = :'root_path' and agent_id = :'root_agent'
limit 1;
SQL
}

create_or_update_root() {
  local label="$1"
  local path="$2"
  local provider_org="$3"
  local existing_id payload
  existing_id="$(find_root_id "${path}")"
  payload="$(
    KQ_LABEL="${label}" KQ_PROVIDER_ORG="${provider_org}" KQ_AGENT_ID="${agent_id}" KQ_PATH="${path}" bun -e '
      process.stdout.write(JSON.stringify({
        label: process.env.KQ_LABEL,
        providerOrgId: process.env.KQ_PROVIDER_ORG,
        agentId: process.env.KQ_AGENT_ID,
        path: process.env.KQ_PATH,
        visibleOrgIds: [process.env.KQ_PROVIDER_ORG],
        enabled: true,
      }));
    '
  )"
  if [[ -n "${existing_id}" ]]; then
    api_json PATCH "/admin/cluster-file-roots/${existing_id}" "${payload}" >/dev/null
    echo "${existing_id}"
  else
    api_json POST "/admin/cluster-file-roots" "${payload}" | json_get 'data.id'
  fi
}

assert_listing_contains_sample() {
  local body_file status path_param site_param
  body_file="$(mktemp)"
  path_param="$(urlencode "${sample_dir}")"
  site_param="$(urlencode "${site_id}")"
  status="$(api_status GET "/files/cluster?agentId=${agent_id}&siteId=${site_param}&path=${path_param}" "" "${body_file}")"
  if [[ "${status}" != "200" ]]; then
    echo "expected cluster listing HTTP 200, got ${status}" >&2
    cat "${body_file}" >&2
    exit 1
  fi
  KQ_SAMPLE_NAME="README.md" bun -e '
    const fs = require("node:fs");
    const data = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
    const entries = data.entries ?? [];
    if (!entries.some((entry) => entry.name === process.env.KQ_SAMPLE_NAME && entry.kind === "file")) {
      console.error(`sample file ${process.env.KQ_SAMPLE_NAME} not returned by cluster listing`);
      console.error(JSON.stringify(data, null, 2));
      process.exit(1);
    }
  ' "${body_file}"
  rm -f "${body_file}"
}

assert_scratch_not_mocked() {
  local body_file status path_param site_param reason
  body_file="$(mktemp)"
  path_param="$(urlencode "/scratch/me/inputs")"
  site_param="$(urlencode "${site_id}")"
  status="$(api_status GET "/files/cluster?agentId=${agent_id}&siteId=${site_param}&path=${path_param}" "" "${body_file}")"
  if [[ "${status}" != "403" && "${status}" != "404" ]]; then
    echo "expected /scratch listing to fail with 403 or 404, got ${status}" >&2
    cat "${body_file}" >&2
    exit 1
  fi
  reason="$(json_get 'data.error?.details?.reason ?? data.details?.reason ?? data.reason' <"${body_file}" || true)"
  if [[ "${reason}" != "PATH_OUTSIDE_ALLOWED_ROOT" && "${reason}" != "CLUSTER_PATH_UNAVAILABLE" ]]; then
    echo "unexpected /scratch failure reason: ${reason:-<empty>}" >&2
    cat "${body_file}" >&2
    exit 1
  fi
  rm -f "${body_file}"
}

assert_root_check() {
  local root_id="$1"
  local expected_status="$2"
  local body_file status actual_status
  body_file="$(mktemp)"
  status="$(api_status POST "/admin/cluster-file-roots/${root_id}/check" "{}" "${body_file}")"
  if [[ "${status}" != "200" ]]; then
    echo "expected cluster file root check HTTP 200, got ${status}" >&2
    cat "${body_file}" >&2
    exit 1
  fi
  actual_status="$(json_get 'data.status' <"${body_file}")"
  if [[ "${actual_status}" != "${expected_status}" ]]; then
    echo "expected cluster file root check status ${expected_status}, got ${actual_status}" >&2
    cat "${body_file}" >&2
    exit 1
  fi
  rm -f "${body_file}"
}

assert_missing_source_preflight() {
  local body_file status payload
  body_file="$(mktemp)"
  payload="$(
    KQ_SOURCE="${missing_file}" KQ_AGENT_ID="${agent_id}" KQ_SITE_ID="${site_id}" bun -e '
      process.stdout.write(JSON.stringify({
        direction: "cluster_to_cloud",
        source: process.env.KQ_SOURCE,
        target: "users/smoke/missing.txt",
        agentId: process.env.KQ_AGENT_ID,
        siteId: process.env.KQ_SITE_ID,
      }));
    '
  )"
  status="$(api_status POST "/files/transfers" "${payload}" "${body_file}")"
  if [[ "${status}" != "404" ]]; then
    echo "expected missing cluster source HTTP 404, got ${status}" >&2
    cat "${body_file}" >&2
    exit 1
  fi
  json_get 'data.error?.details?.reason ?? data.details?.reason ?? data.reason' <"${body_file}" | grep -qx "CLUSTER_SOURCE_FILE_UNAVAILABLE"
  rm -f "${body_file}"
}

assert_unwritable_target_preflight() {
  local body_file status payload
  body_file="$(mktemp)"
  payload="$(
    KQ_TARGET="${readonly_target}" KQ_AGENT_ID="${agent_id}" KQ_SITE_ID="${site_id}" bun -e '
      process.stdout.write(JSON.stringify({
        direction: "cloud_to_cluster",
        source: "users/smoke/input.txt",
        target: process.env.KQ_TARGET,
        agentId: process.env.KQ_AGENT_ID,
        siteId: process.env.KQ_SITE_ID,
      }));
    '
  )"
  status="$(api_status POST "/files/transfers" "${payload}" "${body_file}")"
  if [[ "${status}" != "403" ]]; then
    echo "expected unwritable cluster target HTTP 403, got ${status}" >&2
    cat "${body_file}" >&2
    exit 1
  fi
  json_get 'data.error?.details?.reason ?? data.details?.reason ?? data.reason' <"${body_file}" | grep -qx "CLUSTER_TARGET_DIR_NOT_WRITABLE"
  rm -f "${body_file}"
}

curl -fsS "${api_base}/health" | json_get 'data.status' | grep -qx "ok"
wait_for_agent
login
rebuild_authz_relationships
provider_org="$(provider_org_id)"
prepare_cluster_files
writable_root_id="$(create_or_update_root "Scheduler smoke writable root" "${cluster_root}" "${provider_org}")"
readonly_root_id="$(create_or_update_root "Scheduler smoke readonly root" "${readonly_root}" "${provider_org}")"
process_authz_outbox

assert_listing_contains_sample
assert_scratch_not_mocked
assert_root_check "${writable_root_id}" "ok"
assert_root_check "${readonly_root_id}" "not_writable"
assert_missing_source_preflight
assert_unwritable_target_preflight

echo "Cluster file roots smoke OK: agent=${agent_id}, root=${cluster_root}"
