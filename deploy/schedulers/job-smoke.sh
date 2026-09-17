#!/usr/bin/env bash
set -euo pipefail

compose_files="${1:-deploy/compose/docker-compose.schedulers.yml}"
env_file="${2:-deploy/schedulers/ports-alt.env}"
script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
repo_root="$(cd "${script_dir}/../.." && pwd)"

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
  echo "scheduler compose stack is not running; run deploy/schedulers/smoke.sh first" >&2
  exit 1
fi

"${script_dir}/verify-recognition.sh" "${compose_files}" "${env_file}"

server_port="${KQ_SCHEDULER_SERVER_HTTP_PORT:-3000}"
server_url="http://127.0.0.1:${server_port}/api"
tmp_dir="$(mktemp -d)"
job_id=""
cancelled="false"

cleanup() {
  if [[ -n "${job_id}" && "${cancelled}" != "true" ]]; then
    KQ_CONFIG_FILE="${tmp_dir}/kq-config.json" \
      bun run "${repo_root}/packages/cli/src/index.ts" cancel "${job_id}" >/dev/null 2>&1 || true
  fi
  rm -rf "${tmp_dir}"
}
trap cleanup EXIT

psql() {
  "${compose_cmd[@]}" exec -T postgres psql -U kq -d kuintessence "$@"
}

login_json="$(
  curl -fsS -X POST "${server_url}/auth/login" \
    -H "Content-Type: application/json" \
    --data '{"email":"scheduler-job-smoke@e2e.test","role":"platform_admin"}'
)"
token="$(node -e 'const fs=require("fs"); console.log(JSON.parse(fs.readFileSync(0,"utf8")).token)' <<<"${login_json}")"

wait_for_agent() {
  local agent_id="$1"
  local start="${SECONDS}"
  until psql -Atc "select count(*) from agents where agent_id = '${agent_id}' and status = 'online' and last_heartbeat >= now() - interval '90 seconds';" | grep -qx "1"; do
    if ((SECONDS - start >= 120)); then
      echo "timed out waiting for ${agent_id}" >&2
      exit 1
    fi
    sleep 3
  done
}

api_json() {
  local method="$1"
  local path="$2"
  local body="$3"
  curl -fsS -X "${method}" "${server_url}${path}" \
    -H "Authorization: Bearer ${token}" \
    -H "Content-Type: application/json" \
    --data "${body}"
}

api_get() {
  local path="$1"
  curl -fsS "${server_url}${path}" \
    -H "Authorization: Bearer ${token}"
}

provider_org_id="$(
  api_get "/cp/agent-registration-context" | node -e '
    const fs = require("fs");
    const context = JSON.parse(fs.readFileSync(0, "utf8"));
    const orgs = context.providerOrgs ?? [];
    const selected = orgs.find((org) => org.name === "Development Compute Provider") ?? orgs[0];
    if (!selected?.id) process.exit(1);
    process.stdout.write(selected.id);
  '
)"
if [[ -z "${provider_org_id}" ]]; then
  echo "failed to resolve Development Compute Provider org from CP API" >&2
  exit 1
fi

rebuild_authz_relationships() {
  api_json "POST" "/admin/authz/rebuild" "{}" >/dev/null
}

queue_exists() {
  local queue_id="$1"
  api_get "/admin/queues" | node -e '
    const fs = require("fs");
    const queues = JSON.parse(fs.readFileSync(0, "utf8")).queues ?? [];
    process.stdout.write(queues.some((queue) => queue.queueId === process.argv[1]) ? "true" : "false");
  ' "${queue_id}"
}

create_or_update_queue() {
  local queue_id="$1"
  local name="$2"
  local agent_id="$3"
  local scheduler_type="$4"
  local queue_name="$5"
  wait_for_agent "${agent_id}"
  local create_payload update_payload
  create_payload="$(
    cat <<JSON
{
  "queueId": "${queue_id}",
  "name": "${name}",
  "providerOrgId": "${provider_org_id}",
  "visibleOrgIds": ["${provider_org_id}"],
  "agentId": "${agent_id}",
  "schedulerType": "${scheduler_type}",
  "queueName": "${queue_name}",
  "qos": null,
  "enabled": true,
  "policyTags": []
}
JSON
  )"
  update_payload="$(
    cat <<JSON
{
  "name": "${name}",
  "visibleOrgIds": ["${provider_org_id}"],
  "agentId": "${agent_id}",
  "schedulerType": "${scheduler_type}",
  "queueName": "${queue_name}",
  "qos": null,
  "enabled": true,
  "policyTags": []
}
JSON
  )"
  if [[ "$(queue_exists "${queue_id}")" == "true" ]]; then
    api_json "PATCH" "/admin/queues/${queue_id}" "${update_payload}" >/dev/null
  else
    api_json "POST" "/admin/queues" "${create_payload}" >/dev/null
  fi
  rebuild_authz_relationships
}

fetch_job() {
  local id="$1"
  curl -fsS -H "Authorization: Bearer ${token}" "${server_url}/jobs/${id}"
}

job_field() {
  local field="$1"
  node -e "const fs=require('fs'); const x=JSON.parse(fs.readFileSync(0,'utf8')); console.log(x[process.argv[1]] ?? '')" "${field}"
}

wait_for_scheduler_job_id() {
  local id="$1"
  local start="${SECONDS}"
  while true; do
    local job_json status scheduler_job_id
    job_json="$(fetch_job "${id}")"
    status="$(job_field status <<<"${job_json}")"
    scheduler_job_id="$(job_field schedulerJobId <<<"${job_json}")"
    if [[ -n "${scheduler_job_id}" && ("${status}" == "queued" || "${status}" == "running") ]]; then
      printf "%s" "${scheduler_job_id}"
      return
    fi
    if [[ "${status}" == "completed" || "${status}" == "failed" || "${status}" == "cancelled" ]]; then
      echo "job reached ${status} before cancel path could run: ${job_json}" >&2
      exit 1
    fi
    if ((SECONDS - start >= 90)); then
      echo "timed out waiting for schedulerJobId on ${id}: ${job_json}" >&2
      exit 1
    fi
    sleep 2
  done
}

wait_for_job_log_marker() {
  local id="$1"
  local marker="$2"
  local allow_terminal="${3:-false}"
  local start="${SECONDS}"
  local logs_out=""
  while true; do
    logs_out="$(
      KQ_CONFIG_FILE="${config_file}" \
        bun run "${repo_root}/packages/cli/src/index.ts" logs "${id}" --lines 50 2>&1 || true
    )"
    if grep -Fq "${marker}" <<<"${logs_out}"; then
      return
    fi

    local job_json status
    job_json="$(fetch_job "${id}")"
    status="$(job_field status <<<"${job_json}")"
    if [[ "${allow_terminal}" != "true" && ("${status}" == "failed" || "${status}" == "cancelled") ]]; then
      echo "job reached ${status} before log marker appeared: marker=${marker} logs=${logs_out} job=${job_json}" >&2
      exit 1
    fi
    if ((SECONDS - start >= 60)); then
      echo "timed out waiting for job log marker: marker=${marker} logs=${logs_out} job=${job_json}" >&2
      exit 1
    fi
    sleep 2
  done
}

wait_for_pbs_running_logs() {
  local id="$1"
  local marker="$2"
  local start="${SECONDS}"
  local logs_out=""
  while true; do
    logs_out="$(
      KQ_CONFIG_FILE="${config_file}" \
        bun run "${repo_root}/packages/cli/src/index.ts" logs "${id}" --lines 50 2>&1 || true
    )"
    if grep -Fq "${marker}" <<<"${logs_out}" || grep -Fq "PBS spools stdout" <<<"${logs_out}"; then
      return
    fi
    if ((SECONDS - start >= 60)); then
      echo "timed out waiting for PBS logs RPC: marker=${marker} logs=${logs_out}" >&2
      exit 1
    fi
    sleep 2
  done
}

wait_for_k3s_job_log_marker() {
  local id="$1"
  local marker="$2"
  local start="${SECONDS}"
  local logs_out=""
  while true; do
    logs_out="$(
      KQ_CONFIG_FILE="${config_file}" \
        bun run "${repo_root}/packages/cli/src/index.ts" logs "${id}" --lines 50 2>&1 || true
    )"
    if grep -Fq "${marker}" <<<"${logs_out}"; then
      return 0
    fi

    local job_json status
    job_json="$(fetch_job "${id}")"
    status="$(job_field status <<<"${job_json}")"
    if [[ "${status}" == "failed" ]]; then
      return 1
    fi
    if [[ "${status}" == "cancelled" ]]; then
      echo "K3s job was cancelled before log marker appeared: marker=${marker} logs=${logs_out}" >&2
      exit 1
    fi
    if ((SECONDS - start >= 60)); then
      echo "timed out waiting for K3s job log marker: marker=${marker} logs=${logs_out} job=${job_json}" >&2
      exit 1
    fi
    sleep 2
  done
}

wait_for_server_cancelled() {
  local id="$1"
  local start="${SECONDS}"
  while true; do
    local job_json status
    job_json="$(fetch_job "${id}")"
    status="$(job_field status <<<"${job_json}")"
    if [[ "${status}" == "cancelled" ]]; then
      return
    fi
    if ((SECONDS - start >= 60)); then
      echo "timed out waiting for Server cancellation on ${id}: ${job_json}" >&2
      exit 1
    fi
    sleep 2
  done
}

wait_for_slurm_cancelled() {
  local scheduler_job_id="$1"
  local start="${SECONDS}"
  while true; do
    local detail
    detail="$("${compose_cmd[@]}" exec -T scheduler-slurm scontrol show job "${scheduler_job_id}" -o 2>/dev/null || true)"
    if grep -Eq "JobState=CANCELLED" <<<"${detail}"; then
      return
    fi
    if ((SECONDS - start >= 60)); then
      echo "timed out waiting for Slurm cancellation on ${scheduler_job_id}: ${detail}" >&2
      exit 1
    fi
    sleep 2
  done
}

wait_for_pbs_cancelled() {
  local scheduler_job_id="$1"
  local start="${SECONDS}"
  while true; do
    local detail state exit_status
    detail="$("${compose_cmd[@]}" exec -T scheduler-pbs qstat -x -f -F json "${scheduler_job_id}" 2>/dev/null || true)"
    state="$(
      node -e '
        const fs = require("fs");
        const input = fs.readFileSync(0, "utf8").trim();
        if (!input) process.exit(0);
        const data = JSON.parse(input);
        const job = data.Jobs?.[process.argv[1]] ?? Object.values(data.Jobs ?? {})[0];
        process.stdout.write(job?.job_state ?? "");
      ' "${scheduler_job_id}" <<<"${detail}"
    )"
    exit_status="$(
      node -e '
        const fs = require("fs");
        const input = fs.readFileSync(0, "utf8").trim();
        if (!input) process.exit(0);
        const data = JSON.parse(input);
        const job = data.Jobs?.[process.argv[1]] ?? Object.values(data.Jobs ?? {})[0];
        process.stdout.write(String(job?.Exit_status ?? ""));
      ' "${scheduler_job_id}" <<<"${detail}"
    )"
    if [[ "${state}" == "F" && -n "${exit_status}" && "${exit_status}" != "0" ]]; then
      return
    fi
    if ((SECONDS - start >= 60)); then
      echo "timed out waiting for PBS cancellation on ${scheduler_job_id}: ${detail}" >&2
      exit 1
    fi
    sleep 2
  done
}

wait_for_k3s_deleted() {
  local scheduler_job_id="$1"
  local start="${SECONDS}"
  while true; do
    if ! "${compose_cmd[@]}" exec -T scheduler-k3s kubectl get job "${scheduler_job_id}" -n default >/dev/null 2>&1; then
      return
    fi
    if ((SECONDS - start >= 60)); then
      local detail
      detail="$("${compose_cmd[@]}" exec -T scheduler-k3s kubectl get job "${scheduler_job_id}" -n default -o json 2>/dev/null || true)"
      echo "timed out waiting for K3s job deletion on ${scheduler_job_id}: ${detail}" >&2
      exit 1
    fi
    sleep 2
  done
}

wait_for_scheduler_cancelled() {
  local label="$1"
  local scheduler_job_id="$2"
  case "${label}" in
    slurm) wait_for_slurm_cancelled "${scheduler_job_id}" ;;
    pbs) wait_for_pbs_cancelled "${scheduler_job_id}" ;;
    k3s) wait_for_k3s_deleted "${scheduler_job_id}" ;;
    *)
      echo "unknown scheduler smoke label: ${label}" >&2
      exit 1
      ;;
  esac
}

k3s_runtime_failure_detected() {
  local scheduler_job_id="$1"
  local job_json="$2"
  if grep -Eq "K8s pod runtime failure|FailedCreatePodSandBox|CreatePodSandbox|seccomp is not supported" <<<"${job_json}"; then
    return 0
  fi
  local events
  events="$(
    "${compose_cmd[@]}" exec -T scheduler-k3s kubectl get events -n default -o json 2>/dev/null || true
  )"
  node -e '
    const fs = require("fs");
    const input = fs.readFileSync(0, "utf8").trim();
    if (!input) process.exit(1);
    const data = JSON.parse(input);
    const jobName = process.argv[1];
    const matched = (data.items ?? []).some((event) => {
      const objectName = event.involvedObject?.name ?? "";
      if (objectName !== jobName && !objectName.startsWith(`${jobName}-`)) return false;
      const detail = `${event.reason ?? ""} ${event.message ?? ""}`;
      return /FailedCreatePodSandBox|CreatePodSandbox|seccomp is not supported/.test(detail);
    });
    process.exit(matched ? 0 : 1);
  ' "${scheduler_job_id}" <<<"${events}"
}

wait_for_scheduler_job_id_diagnostic() {
  local id="$1"
  local start="${SECONDS}"
  while true; do
    local job_json scheduler_job_id status
    job_json="$(fetch_job "${id}")"
    scheduler_job_id="$(job_field schedulerJobId <<<"${job_json}")"
    if [[ -n "${scheduler_job_id}" ]]; then
      printf "%s" "${scheduler_job_id}"
      return
    fi
    status="$(job_field status <<<"${job_json}")"
    if [[ "${status}" == "completed" || "${status}" == "failed" || "${status}" == "cancelled" ]]; then
      echo "job reached ${status} before schedulerJobId was recorded: ${job_json}" >&2
      exit 1
    fi
    if ((SECONDS - start >= 90)); then
      echo "timed out waiting for schedulerJobId on ${id}: ${job_json}" >&2
      exit 1
    fi
    sleep 2
  done
}

config_file="${tmp_dir}/kq-config.json"
cat >"${config_file}" <<JSON
{"serverUrl":"http://127.0.0.1:${server_port}","token":"${token}"}
JSON

run_job_smoke() {
  local label="$1"
  local queue_id="$2"
  local job_name="$3"
  local spec_file="${tmp_dir}/${label}-job-smoke.json"
  local log_marker="kq-${label}-job-log-smoke"
  job_id=""
  cancelled="false"
  cat >"${spec_file}" <<JSON
{
  "name": "${job_name}",
  "command": "printf '${log_marker}\\n'; sleep 120",
  "resources": {
    "cpus": 1,
    "memoryMb": 128,
    "wallTimeSec": 180
  },
  "schedulingStrategy": {
    "queueId": "${queue_id}"
  }
}
JSON

  local submit_out scheduler_job_id
  submit_out="$(KQ_CONFIG_FILE="${config_file}" bun run "${repo_root}/packages/cli/src/index.ts" submit "${spec_file}")"
  job_id="$(sed -n 's/^Job submitted: //p' <<<"${submit_out}")"
  if [[ -z "${job_id}" ]]; then
    echo "missing job id for ${label}: ${submit_out}" >&2
    exit 1
  fi

  scheduler_job_id="$(wait_for_scheduler_job_id "${job_id}")"
  KQ_CONFIG_FILE="${config_file}" bun run "${repo_root}/packages/cli/src/index.ts" status "${job_id}" | grep -Eq "Status: (queued|running)"
  if [[ "${label}" == "pbs" ]]; then
    wait_for_pbs_running_logs "${job_id}" "${log_marker}"
  else
    wait_for_job_log_marker "${job_id}" "${log_marker}"
  fi
  KQ_CONFIG_FILE="${config_file}" bun run "${repo_root}/packages/cli/src/index.ts" cancel "${job_id}" | grep -q "cancelled"
  cancelled="true"
  wait_for_server_cancelled "${job_id}"
  wait_for_scheduler_cancelled "${label}" "${scheduler_job_id}"
  if [[ "${label}" == "pbs" ]]; then
    wait_for_job_log_marker "${job_id}" "${log_marker}" "true"
  fi
  echo "${label} job smoke passed: serverJob=${job_id} schedulerJob=${scheduler_job_id}"
  job_id=""
}

run_k3s_job_smoke() {
  local spec_file="${tmp_dir}/k3s-job-smoke.json"
  local log_marker="kq-k3s-job-log-smoke"
  job_id=""
  cancelled="false"
  cat >"${spec_file}" <<JSON
{
  "name": "scheduler_k3s_job_cancel_smoke",
  "command": "printf '${log_marker}\\n'; sleep 120",
  "resources": {
    "cpus": 1,
    "memoryMb": 128,
    "wallTimeSec": 180
  },
  "schedulingStrategy": {
    "queueId": "88888888-8888-4888-8888-888888888303"
  }
}
JSON

  local submit_out scheduler_job_id job_json status
  submit_out="$(KQ_CONFIG_FILE="${config_file}" bun run "${repo_root}/packages/cli/src/index.ts" submit "${spec_file}")"
  job_id="$(sed -n 's/^Job submitted: //p' <<<"${submit_out}")"
  if [[ -z "${job_id}" ]]; then
    echo "missing job id for k3s: ${submit_out}" >&2
    exit 1
  fi

  scheduler_job_id="$(wait_for_scheduler_job_id_diagnostic "${job_id}")"
  KQ_CONFIG_FILE="${config_file}" bun run "${repo_root}/packages/cli/src/index.ts" status "${job_id}" >/dev/null || true
  job_json="$(fetch_job "${job_id}")"
  status="$(job_field status <<<"${job_json}")"
  if [[ "${status}" == "queued" || "${status}" == "running" ]]; then
    if wait_for_k3s_job_log_marker "${job_id}" "${log_marker}"; then
      KQ_CONFIG_FILE="${config_file}" bun run "${repo_root}/packages/cli/src/index.ts" cancel "${job_id}" | grep -q "cancelled"
      cancelled="true"
      wait_for_server_cancelled "${job_id}"
      wait_for_scheduler_cancelled "k3s" "${scheduler_job_id}"
      echo "k3s job smoke passed: serverJob=${job_id} schedulerJob=${scheduler_job_id}"
      job_id=""
      return
    fi
    job_json="$(fetch_job "${job_id}")"
    status="$(job_field status <<<"${job_json}")"
  fi

  if [[ "${status}" == "failed" && "${KQ_JOB_SMOKE_ALLOW_K3S_RUNTIME_FAILURE:-false}" == "true" ]]; then
    if k3s_runtime_failure_detected "${scheduler_job_id}" "${job_json}"; then
      "${compose_cmd[@]}" exec -T scheduler-k3s kubectl delete job "${scheduler_job_id}" -n default --ignore-not-found >/dev/null 2>&1 || true
      cancelled="true"
      echo "k3s job smoke hit expected runtime sandbox failure on this host: serverJob=${job_id} schedulerJob=${scheduler_job_id}"
      job_id=""
      return
    fi
  fi

  echo "k3s job ended ${status} before cancel path could run: ${job_json}" >&2
  exit 1
}

create_or_update_queue \
  "88888888-8888-4888-8888-888888888301" \
  "Scheduler Smoke Slurm" \
  "scheduler-slurm" \
  "slurm" \
  "debug"
create_or_update_queue \
  "88888888-8888-4888-8888-888888888302" \
  "Scheduler Smoke PBS" \
  "scheduler-pbs" \
  "pbs-pro" \
  "workq"

run_job_smoke "slurm" "88888888-8888-4888-8888-888888888301" "scheduler_slurm_job_cancel_smoke"
run_job_smoke "pbs" "88888888-8888-4888-8888-888888888302" "scheduler_pbs_job_cancel_smoke"

if [[ "${KQ_JOB_SMOKE_INCLUDE_K3S:-false}" == "true" ]]; then
  create_or_update_queue \
    "88888888-8888-4888-8888-888888888303" \
    "Scheduler Smoke K3s" \
    "scheduler-k3s" \
    "kubernetes" \
    "default"
  run_k3s_job_smoke
fi
