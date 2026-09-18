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
  while IFS= read -r line || [[ -n "${line}" ]]; do
    line="${line%$'\r'}"
    [[ -z "${line}" || "${line}" == \#* ]] && continue
    if [[ ! "${line}" =~ ^([A-Za-z_][A-Za-z0-9_]*)=(.*)$ ]]; then
      echo "invalid env file line: ${line}" >&2
      exit 1
    fi
    env_key="${BASH_REMATCH[1]}"
    env_value="${BASH_REMATCH[2]}"
    case "${env_key}" in
      KQ_SCHEDULER_COMPOSE_PROJECT | KQ_SCHEDULER_SERVER_HTTP_PORT | KQ_SCHEDULER_SERVER_GRPC_PORT | KQ_SCHEDULER_REGISTRY_PORT | KQ_SCHEDULER_WEB_PORT | KQ_SCHEDULER_POSTGRES_PORT | KQ_SCHEDULER_REDIS_PORT | KQ_SCHEDULER_RUSTFS_API_PORT | KQ_SCHEDULER_RUSTFS_CONSOLE_PORT | KQ_SCHEDULER_CASDOOR_HTTP_PORT | KQ_SCHEDULER_APT_MIRROR)
        export "${env_key}=${env_value}"
        ;;
      *)
        echo "unsupported env file key: ${env_key}" >&2
        exit 1
        ;;
    esac
  done <"${env_file}"
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

if [[ "${KQ_WORKFLOW_SMOKE_SEED_ONLY:-false}" != "true" ]]; then
  "${script_dir}/smoke.sh" "${compose_files}" "${env_file}"
fi

if [[ "${KQ_WORKFLOW_SMOKE_SKIP_SERVER_SOURCE_CHECK:-false}" != "true" ]]; then
  if ! "${compose_cmd[@]}" exec -T server sh -lc \
    "grep -q 'schedulingStrategy' /app/packages/shared/src/workflow/usecase-executor.ts && grep -q 'fileOutputDescriptors' /app/packages/shared/src/workflow/usecase-executor.ts && grep -q 'stdinText' /app/packages/server/src/workflow/job-submitter.ts && grep -q 'collectedFiles' /app/packages/server/src/workflow/job-submitter.ts"; then
    cat >&2 <<'EOF'
Server container image does not contain the current workflow executor field passthrough.
Re-run with:
  KQ_SCHEDULER_SMOKE_BUILD=true bash deploy/schedulers/workflow-smoke.sh
or use the watch compose profile so Server runs the current working tree.
EOF
    exit 1
  fi
fi

server_port="${KQ_SCHEDULER_SERVER_HTTP_PORT:-3000}"
server_url="http://127.0.0.1:${server_port}/api"
tmp_dir="$(mktemp -d)"
cleanup() {
  rm -rf "${tmp_dir}"
}
trap cleanup EXIT

login_json="$(
  curl -fsS -X POST "${server_url}/auth/login" \
    -H "Content-Type: application/json" \
    --data '{"email":"scheduler-workflow-smoke@e2e.test","role":"platform_admin"}'
)"
token="$(node -e 'const fs=require("fs"); console.log(JSON.parse(fs.readFileSync(0,"utf8")).token)' <<<"${login_json}")"

psql() {
  "${compose_cmd[@]}" exec -T postgres psql -U kq -d kuintessence "$@"
}

provider_org_id="$(
  psql -Atc "select uom.org_id from user_org_memberships uom join users u on u.id = uom.user_id where u.email = 'scheduler-workflow-smoke@e2e.test' limit 1;" | tr -d '[:space:]'
)"
smoke_user_id="$(
  psql -Atc "select id from users where email = 'scheduler-workflow-smoke@e2e.test' limit 1;" | tr -d '[:space:]'
)"
if [[ -z "${smoke_user_id}" ]]; then
  echo "failed to resolve smoke user id" >&2
  exit 1
fi
if [[ -z "${provider_org_id}" ]]; then
  provider_org_id="$(
    psql -Atc "select id from orgs where name = 'Development Compute Provider' limit 1;" | tr -d '[:space:]'
  )"
  if [[ -z "${provider_org_id}" ]]; then
    echo "failed to resolve default provider org" >&2
    exit 1
  fi
  psql -v ON_ERROR_STOP=1 >/dev/null <<SQL
insert into user_org_memberships (user_id, org_id, role)
values ('${smoke_user_id}', '${provider_org_id}', 'admin')
on conflict (user_id, org_id) do update set role = 'admin', updated_at = now();
SQL
fi
if [[ -z "${provider_org_id}" ]]; then
  echo "failed to resolve smoke user org" >&2
  exit 1
fi

psql -v ON_ERROR_STOP=1 >/dev/null <<SQL
delete from authz_outbox
where status in ('pending', 'processing')
  and (subject_id = '${smoke_user_id}' or resource_id = '${provider_org_id}');
SQL

package_id="88888888-8888-4888-8888-888888888101"
batch_package_id="88888888-8888-4888-8888-888888888102"
software_asset_id="88888888-8888-4888-8888-888888888201"
software_revision_id="88888888-8888-4888-8888-888888888202"
ecosystem_release_id="88888888-8888-4888-8888-888888888203"
ecosystem_release_asset_id="88888888-8888-4888-8888-888888888204"
fixture_dir="${repo_root}/deploy/schedulers/fixtures"

cp "${fixture_dir}/governed-shell-usecase.json" "${tmp_dir}/package.json"
cp "${fixture_dir}/governed-batch-usecase.json" "${tmp_dir}/batch-package.json"

package_json="$(node -e 'const fs=require("fs"); process.stdout.write(JSON.stringify(JSON.parse(fs.readFileSync(process.argv[1],"utf8"))))' "${tmp_dir}/package.json")"
batch_package_json="$(node -e 'const fs=require("fs"); process.stdout.write(JSON.stringify(JSON.parse(fs.readFileSync(process.argv[1],"utf8"))))' "${tmp_dir}/batch-package.json")"
software_revision_json="$(node -e 'const fs=require("fs"); process.stdout.write(JSON.stringify(JSON.parse(fs.readFileSync(process.argv[1],"utf8"))))' "${fixture_dir}/governed-software-revision.json")"
software_revision_recipe_sha256="$(node -e '
const crypto = require("crypto");
const fs = require("fs");
const normalize = (value) => {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error("Canonical JSON does not support non-finite numbers");
    return value;
  }
  if (Array.isArray(value)) return value.map(normalize);
  if (typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value)
        .filter(([, item]) => item !== undefined)
        .toSorted(([left], [right]) => left.localeCompare(right))
        .map(([key, item]) => [key, normalize(item)]),
    );
  }
  throw new Error(`Canonical JSON does not support ${typeof value}`);
};
const payload = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
process.stdout.write(crypto.createHash("sha256").update(JSON.stringify(normalize(payload))).digest("hex"));
' "${fixture_dir}/governed-software-revision.json")"
license_policy_json="$(node -e 'const fs=require("fs"); process.stdout.write(JSON.stringify(JSON.parse(fs.readFileSync(process.argv[1],"utf8"))))' "${fixture_dir}/governed-license-policy.json")"
psql -v ON_ERROR_STOP=1 >/dev/null <<SQL
insert into usecase_packages (id, name, version, spec)
values ('${package_id}', 'mock-sh-multischeduler-smoke', '1', '${package_json}'::jsonb)
on conflict (id) do update set
  name = excluded.name,
  version = excluded.version,
  spec = excluded.spec;
insert into usecase_packages (id, name, version, spec)
values ('${batch_package_id}', 'mock-bash-batch-multischeduler-smoke', '1', '${batch_package_json}'::jsonb)
on conflict (id) do update set
  name = excluded.name,
  version = excluded.version,
  spec = excluded.spec;
insert into software_assets (
  id, kind, name, version, source, lifecycle, visibility, payload, provenance,
  trusted_for_global_use, created_by
)
values (
  '${software_asset_id}', 'spack-package', 'zlib', '1.3.1', 'official-upstream',
  'published', 'platform-public', '${software_revision_json}'::jsonb,
  '{"source":"official-upstream","upstreamName":"zlib","upstreamRef":"v1.3.1"}'::jsonb,
  true, '${smoke_user_id}'
)
on conflict (id) do update set
  kind = excluded.kind,
  name = excluded.name,
  version = excluded.version,
  source = excluded.source,
  lifecycle = excluded.lifecycle,
  visibility = excluded.visibility,
  payload = excluded.payload,
  provenance = excluded.provenance,
  trusted_for_global_use = excluded.trusted_for_global_use,
  updated_at = now();
insert into software_asset_revisions (
  id, asset_id, revision, payload, provenance, recipe_sha256, content_sha256, created_by
)
values (
  '${software_revision_id}', '${software_asset_id}', 1,
  '${software_revision_json}'::jsonb,
  '{"source":"official-upstream","upstreamName":"zlib","upstreamRef":"v1.3.1"}'::jsonb,
  '${software_revision_recipe_sha256}', null, '${smoke_user_id}'
)
on conflict do nothing;
insert into ecosystem_releases (
  id, release_key, version, artifact_digest, manifest, provenance, signature,
  signing_key_id, status, imported_by, activated_by, activated_at
)
values (
  '${ecosystem_release_id}', 'scheduler-governed-workflow-smoke', '1',
  'sha256:204f9d8de5176540bdff8f6d53e6d2530e2a7c12da4d18b70e22e117e6ca3103',
  '{"fixture":"scheduler-governed-workflow-smoke","version":1}'::jsonb,
  '{"source":"repository-fixture"}'::jsonb,
  'controlled-scheduler-fixture', 'repository-fixture-key', 'active',
  '${smoke_user_id}', '${smoke_user_id}', now()
)
on conflict (id) do update set
  release_key = excluded.release_key,
  version = excluded.version,
  artifact_digest = excluded.artifact_digest,
  manifest = excluded.manifest,
  provenance = excluded.provenance,
  signature = excluded.signature,
  signing_key_id = excluded.signing_key_id,
  status = excluded.status,
  activated_by = excluded.activated_by,
  activated_at = excluded.activated_at;
insert into ecosystem_release_assets (
  id, release_id, ecosystem_key, kind, name, version, payload, provenance,
  license_policy, manifest_entry_digest, asset_id, asset_revision_id, materialized_at
)
values (
  '${ecosystem_release_asset_id}', '${ecosystem_release_id}',
  'spack:zlib@1.3.1', 'spack-package', 'zlib', '1.3.1',
  '${software_revision_json}'::jsonb,
  '{"source":"official-upstream","upstreamName":"zlib","upstreamRef":"v1.3.1"}'::jsonb,
  '${license_policy_json}'::jsonb,
  'sha256:ddeca86d241def9cb25a1cce1f52bf49e87df590f590a57169d1493f252d5c85',
  '${software_asset_id}', '${software_revision_id}', now()
)
on conflict (id) do update set
  release_id = excluded.release_id,
  ecosystem_key = excluded.ecosystem_key,
  kind = excluded.kind,
  name = excluded.name,
  version = excluded.version,
  payload = excluded.payload,
  provenance = excluded.provenance,
  license_policy = excluded.license_policy,
  manifest_entry_digest = excluded.manifest_entry_digest,
  asset_id = excluded.asset_id,
  asset_revision_id = excluded.asset_revision_id,
  materialized_at = excluded.materialized_at;
SQL

revision_matches="$(
  psql -Atc "
select count(*)
from software_asset_revisions
where id = '${software_revision_id}'
  and asset_id = '${software_asset_id}'
  and revision = 1
  and payload = '${software_revision_json}'::jsonb
  and provenance = '{\"source\":\"official-upstream\",\"upstreamName\":\"zlib\",\"upstreamRef\":\"v1.3.1\"}'::jsonb
  and recipe_sha256 = '${software_revision_recipe_sha256}'
  and content_sha256 is null;" | tr -d '[:space:]'
)"
if [[ "${revision_matches}" != "1" ]]; then
  echo "frozen software revision conflicts with the governed smoke fixture" >&2
  exit 1
fi

wait_for_agent() {
  local agent_id="$1"
  local start="${SECONDS}"
  until psql -Atc "select count(*) from agents where agent_id = '${agent_id}' and status = 'online' and last_heartbeat >= now() - interval '90 seconds';" | grep -qx "1"; do
    if ((SECONDS - start >= 180)); then
      echo "timed out waiting for ${agent_id}" >&2
      exit 1
    fi
    sleep 3
  done
}

create_queue() {
  local queue_id="$1"
  local name="$2"
  local agent_id="$3"
  local scheduler_type="$4"
  local queue_name="$5"
  local exists
  wait_for_agent "${agent_id}"
  exists="$(psql -Atc "select count(*) from scheduler_queues where queue_id = '${queue_id}';" | tr -d '[:space:]')"
  if [[ "${exists}" == "0" ]]; then
    curl -fsS -X POST "${server_url}/admin/queues" \
      -H "Authorization: Bearer ${token}" \
      -H "Content-Type: application/json" \
      --data "{
        \"queueId\":\"${queue_id}\",
        \"name\":\"${name}\",
        \"providerOrgId\":\"${provider_org_id}\",
        \"visibleOrgIds\":[\"${provider_org_id}\"],
        \"agentId\":\"${agent_id}\",
        \"schedulerType\":\"${scheduler_type}\",
        \"queueName\":\"${queue_name}\",
        \"enabled\":true,
        \"policyTags\":[]
      }" >/dev/null
  else
    psql -v ON_ERROR_STOP=1 >/dev/null <<SQL
update scheduler_queues
set name = '${name}',
    provider_org_id = '${provider_org_id}',
    visible_org_ids = jsonb_build_array('${provider_org_id}'::text),
    agent_id = '${agent_id}',
    scheduler_type = '${scheduler_type}',
    queue_name = '${queue_name}',
    qos = null,
    enabled = true,
    policy_tags = '[]'::jsonb,
    updated_at = now()
where queue_id = '${queue_id}';
SQL
  fi
}

create_queue "88888888-8888-4888-8888-888888888301" "Scheduler Smoke Slurm" "scheduler-slurm" "slurm" "debug"
create_queue "88888888-8888-4888-8888-888888888302" "Scheduler Smoke PBS" "scheduler-pbs" "pbs-pro" "workq"
create_queue "88888888-8888-4888-8888-888888888303" "Scheduler Smoke K3s" "scheduler-k3s" "kubernetes" "default"

curl --max-time 120 -fsS -X POST "${server_url}/admin/authz/rebuild" \
  -H "Authorization: Bearer ${token}" \
  -H "Content-Type: application/json" \
  --data "{}" >/dev/null

if [[ "${KQ_WORKFLOW_SMOKE_SEED_ONLY:-false}" == "true" ]]; then
  echo "scheduler governed workflow fixtures seeded"
  exit 0
fi

config_file="${tmp_dir}/kq-config.json"
cat >"${config_file}" <<JSON
{"serverUrl":"http://127.0.0.1:${server_port}","token":"${token}"}
JSON

fetch_workflow_detail() {
  local run_id="$1"
  local start="${SECONDS}"
  while true; do
    local response status body
    response="$(
      curl -sS -H "Authorization: Bearer ${token}" \
        -w $'\n%{http_code}' \
        "${server_url}/workflows/${run_id}" || true
    )"
    status="${response##*$'\n'}"
    body="${response%$'\n'*}"
    if [[ "${status}" == "200" ]]; then
      printf "%s" "${body}"
      return
    fi
    if [[ ("${status}" == "403" || "${status}" == "404") && $((SECONDS - start)) -lt 45 ]]; then
      sleep 2
      continue
    fi
    echo "GET /workflows/${run_id} returned HTTP ${status}: ${body}" >&2
    return 1
  done
}

k3s_runtime_failure_detected() {
  local status_json="$1"
  if grep -Eq "ContainerCreating|FailedCreatePodSandBox|CreatePodSandbox|seccomp is not supported" <<<"${status_json}"; then
    return 0
  fi
  local job_id
  job_id="$(node -e 'const fs=require("fs"); const x=JSON.parse(fs.readFileSync(0,"utf8")); console.log(x.stepJobs?.k3s ?? "")' <<<"${status_json}")"
  local k3s_detail
  k3s_detail="$(
    "${compose_cmd[@]}" exec -T scheduler-k3s bash -lc '
      kubectl get events -A --sort-by=.lastTimestamp | tail -120
      if [[ -n "${1:-}" ]]; then
        kubectl describe job -n default "kq-${1}" 2>/dev/null || true
        kubectl describe pod -n default -l "job-name=kq-${1}" 2>/dev/null || true
      fi
    ' _ "${job_id}" 2>/dev/null || true
  )"
  grep -Eq "ContainerCreating|FailedCreatePodSandBox|CreatePodSandbox|seccomp is not supported" <<<"${k3s_detail}"
}

submit_and_wait() {
  local label="$1"
  local queue_id="$2"
  local expected="$3"
  local workflow_file="${tmp_dir}/${label}.workflow.json"
  cat >"${workflow_file}" <<JSON
{
  "name": "scheduler_${label}_workflow_smoke",
  "description": "Multi-scheduler workflow smoke for ${label}.",
  "parameters": [],
  "spec": {
    "nodeDrafts": [
      {
        "type": "SoftwareUsecaseComputing",
        "id": "${label}",
        "name": "${label}",
        "usecaseVersionId": "${package_id}",
        "softwareVersionId": "${software_revision_id}",
        "schedulingStrategy": { "type": "Manual", "queues": ["${queue_id}"] },
        "inputSlots": [
          {
            "type": "Text",
            "descriptor": "script",
            "from": { "expr": "'printf \"value=${expected}\\n\"'" }
          }
        ]
      }
    ],
    "nodeRelations": []
  }
}
JSON
  local submit_out
  submit_out="$(KQ_CONFIG_FILE="${config_file}" bun run "${repo_root}/packages/cli/src/index.ts" workflow submit "${workflow_file}")"
  local run_id
  run_id="$(sed -n 's/^Run ID: //p' <<<"${submit_out}")"
  if [[ -z "${run_id}" ]]; then
    echo "missing run id for ${label}: ${submit_out}" >&2
    exit 1
  fi
  local start="${SECONDS}"
  while true; do
    local status_json
    status_json="$(fetch_workflow_detail "${run_id}")"
    local status value
    status="$(node -e 'const fs=require("fs"); const x=JSON.parse(fs.readFileSync(0,"utf8")); console.log(x.status)' <<<"${status_json}")"
    value="$(node -e "const fs=require('fs'); const x=JSON.parse(fs.readFileSync(0,'utf8')); console.log(x.result?.values?.${label}?.values?.value ?? '')" <<<"${status_json}")"
    if [[ "${status}" == "completed" ]]; then
      if [[ "${value}" != "${expected}" ]]; then
        echo "${label} completed with unexpected value ${value}, expected ${expected}" >&2
        exit 1
      fi
      KQ_CONFIG_FILE="${config_file}" bun run "${repo_root}/packages/cli/src/index.ts" workflow status "${run_id}" | grep -q "${label}: Succeeded"
      echo "${label}: completed run ${run_id} value=${value}"
      return
    fi
    if [[ "${status}" == "failed" || "${status}" == "cancelled" ]]; then
      if [[ "${label}" == "k3s" && "${KQ_WORKFLOW_SMOKE_ALLOW_K3S_RUNTIME_FAILURE:-false}" == "true" ]]; then
        if k3s_runtime_failure_detected "${status_json}"; then
          echo "${label}: expected runtime sandbox failure on this host; continuing"
          return
        fi
      fi
      echo "${label} workflow ended ${status}: ${status_json}" >&2
      exit 1
    fi
    if ((SECONDS - start >= 240)); then
      if [[ "${label}" == "k3s" && "${KQ_WORKFLOW_SMOKE_ALLOW_K3S_RUNTIME_FAILURE:-false}" == "true" ]]; then
        if k3s_runtime_failure_detected "${status_json}"; then
          echo "${label}: timed out with expected runtime sandbox blockage on this host; continuing"
          return
        fi
      fi
      echo "${label} workflow timed out: ${status_json}" >&2
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

upload_text_file() {
  local path="$1"
  local text="$2"
  local source_file="${tmp_dir}/upload-$(basename "${path}")"
  printf "%s" "${text}" >"${source_file}"
  local size sha256 payload mint_json upload_url storage_key commit_token commit_payload commit_json
  size="$(wc -c <"${source_file}" | tr -d '[:space:]')"
  sha256="$(shasum -a 256 "${source_file}" | awk '{print $1}')"
  payload="$(
    node -e 'process.stdout.write(JSON.stringify({path:process.argv[1],size:Number(process.argv[2]),contentType:"text/plain",sha256:process.argv[3]}))' \
      "${path}" "${size}" "${sha256}"
  )"
  mint_json="$(api_json POST "/netdrive/upload-url" "${payload}")"
  upload_url="$(node -e 'const fs=require("fs"); console.log(JSON.parse(fs.readFileSync(0,"utf8")).data.uploadUrl)' <<<"${mint_json}")"
  storage_key="$(node -e 'const fs=require("fs"); console.log(JSON.parse(fs.readFileSync(0,"utf8")).data.storageKey)' <<<"${mint_json}")"
  commit_token="$(node -e 'const fs=require("fs"); console.log(JSON.parse(fs.readFileSync(0,"utf8")).data.commitToken)' <<<"${mint_json}")"
  curl -fsS -X PUT "${upload_url}" -H "Content-Type: text/plain" --data-binary "@${source_file}" >/dev/null
  commit_payload="$(
    node -e 'process.stdout.write(JSON.stringify({path:process.argv[1],size:Number(process.argv[2]),contentType:"text/plain",sha256:process.argv[3],storageKey:process.argv[4],commitToken:process.argv[5]}))' \
      "${path}" "${size}" "${sha256}" "${storage_key}" "${commit_token}"
  )"
  commit_json="$(api_json POST "/netdrive/files" "${commit_payload}")"
  node -e 'const fs=require("fs"); const x=JSON.parse(fs.readFileSync(0,"utf8")).data; const path=process.argv[1]; process.stdout.write(JSON.stringify({fileMetadataId:x.id,fileMetadataName:path.split("/").pop()||"input.txt",hash:x.sha256,size:x.size}))' \
    "${path}" <<<"${commit_json}"
}

write_batch_artifact_edge_workflow() {
  local label="$1"
  local queue_id="$2"
  local files_json="$3"
  local workflow_file="$4"
  WORKFLOW_LABEL="${label}" \
    WORKFLOW_QUEUE_ID="${queue_id}" \
    WORKFLOW_FILES_JSON="${files_json}" \
    WORKFLOW_BATCH_PACKAGE_ID="${batch_package_id}" \
    WORKFLOW_SOFTWARE_ID="${software_revision_id}" \
    node -e '
const fs = require("fs");
const label = process.env.WORKFLOW_LABEL;
const queueId = process.env.WORKFLOW_QUEUE_ID;
const files = JSON.parse(process.env.WORKFLOW_FILES_JSON);
const packageId = process.env.WORKFLOW_BATCH_PACKAGE_ID;
const softwareId = process.env.WORKFLOW_SOFTWARE_ID;
const fanoutScript = "set -e; mkdir -p chunks; for f in inputs/*.txt; do b=$(basename \"$f\"); tr \"[:lower:]\" \"[:upper:]\" < \"$f\" > \"chunks/$b\"; done";
const consumeScript = "printf \"summary=%s\\n\" \"$(cat inputs/*.txt | tr \"\\n\" \",\" | sed \"s/,$//\")\"";
const celString = (value) => {
  const quote = String.fromCharCode(39);
  if (value.includes(quote)) {
    throw new Error("batch smoke CEL string must not contain single quotes");
  }
  return `${quote}${value}${quote}`;
};
const workflow = {
  name: `scheduler_${label}_batch_file_smoke`,
  description: `Multi-scheduler batch file workflow smoke for ${label}.`,
  parameters: [],
  spec: {
    nodeDrafts: [
      {
        type: "SoftwareUsecaseComputing",
        id: `${label}BatchFanout`,
        name: `${label}BatchFanout`,
        usecaseVersionId: packageId,
        softwareVersionId: softwareId,
        schedulingStrategy: { type: "Manual", queues: [queueId] },
        inputSlots: [
          {
            type: "File",
            descriptor: "inputs",
            contents: files,
            expectedFileName: "inputs/*.txt",
            isBatch: true,
          },
          {
            type: "Text",
            descriptor: "script",
            from: { expr: celString(fanoutScript) },
          },
        ],
        outputSlots: [
          {
            type: "File",
            descriptor: "chunks",
            optional: false,
            origin: "UsecaseOut",
            isBatch: true,
          },
        ],
      },
      {
        type: "SoftwareUsecaseComputing",
        id: `${label}BatchConsume`,
        name: `${label}BatchConsume`,
        usecaseVersionId: packageId,
        softwareVersionId: softwareId,
        schedulingStrategy: { type: "Manual", queues: [queueId] },
        inputSlots: [
          {
            type: "File",
            descriptor: "inputs",
            from: { node: `${label}BatchFanout`, output: "chunks" },
            expectedFileName: "inputs/*.txt",
            isBatch: true,
          },
          {
            type: "Text",
            descriptor: "script",
            from: { expr: celString(consumeScript) },
          },
        ],
        valueOutputsOverride: [
          {
            descriptor: "summary",
            type: "string",
            from: { collectedOutDescriptor: "stdout" },
            extract: { kind: "Regex", pattern: "summary=([A-Z,]+)", group: 1 },
          },
        ],
      },
    ],
    nodeRelations: [{ fromId: `${label}BatchFanout`, toId: `${label}BatchConsume`, slotRelations: [] }],
  },
};
fs.writeFileSync(process.argv[1], JSON.stringify(workflow, null, 2));
' "${workflow_file}"
}

submit_batch_and_wait() {
  local label="$1"
  local queue_id="$2"
  local workflow_file="${tmp_dir}/${label}.batch.workflow.json"
  local input_a input_b files_json submit_out run_id start
  input_a="$(upload_text_file "scheduler-smoke/${label}/batch/a.txt" $'alpha\n')"
  input_b="$(upload_text_file "scheduler-smoke/${label}/batch/b.txt" $'beta\n')"
  files_json="$(node -e 'process.stdout.write(JSON.stringify([JSON.parse(process.argv[1]),JSON.parse(process.argv[2])]));' "${input_a}" "${input_b}")"
  write_batch_artifact_edge_workflow "${label}" "${queue_id}" "${files_json}" "${workflow_file}"
  submit_out="$(KQ_CONFIG_FILE="${config_file}" bun run "${repo_root}/packages/cli/src/index.ts" workflow submit "${workflow_file}")"
  run_id="$(sed -n 's/^Run ID: //p' <<<"${submit_out}")"
  if [[ -z "${run_id}" ]]; then
    echo "missing run id for ${label} batch: ${submit_out}" >&2
    exit 1
  fi
  start="${SECONDS}"
  while true; do
    local status_json status summary
    status_json="$(fetch_workflow_detail "${run_id}")"
    status="$(node -e 'const fs=require("fs"); const x=JSON.parse(fs.readFileSync(0,"utf8")); console.log(x.status)' <<<"${status_json}")"
    summary="$(WORKFLOW_LABEL="${label}" node -e 'const fs=require("fs"); const x=JSON.parse(fs.readFileSync(0,"utf8")); const label=process.env.WORKFLOW_LABEL; console.log(x.result?.values?.[`${label}BatchConsume`]?.values?.summary ?? "")' <<<"${status_json}")"
    if [[ "${status}" == "completed" ]]; then
      if [[ "${summary}" != "ALPHA,BETA" ]]; then
        echo "${label} batch completed with unexpected summary ${summary}, expected ALPHA,BETA" >&2
        exit 1
      fi
      KQ_CONFIG_FILE="${config_file}" bun run "${repo_root}/packages/cli/src/index.ts" workflow status "${run_id}" | grep -q "${label}BatchConsume: Succeeded"
      echo "${label} batch: completed run ${run_id} summary=${summary}"
      return
    fi
    if [[ "${status}" == "failed" || "${status}" == "cancelled" ]]; then
      echo "${label} batch workflow ended ${status}: ${status_json}" >&2
      exit 1
    fi
    if ((SECONDS - start >= 300)); then
      echo "${label} batch workflow timed out: ${status_json}" >&2
      exit 1
    fi
    sleep 3
  done
}

run_optional_netdrive_smoke() {
  if [[ "${KQ_WORKFLOW_SMOKE_VERIFY_NETDRIVE:-false}" != "true" ]]; then
    return
  fi
  local netdrive_api_base="${KQ_WORKFLOW_SMOKE_NETDRIVE_API_BASE:-${server_url}}"
  echo "running optional NetDrive/RustFS smoke against ${netdrive_api_base}"
  KQ_NETDRIVE_SMOKE_API_BASE="${netdrive_api_base}" bash "${repo_root}/deploy/netdrive-smoke.sh"
}

submit_and_wait "slurm" "88888888-8888-4888-8888-888888888301" "31"
submit_and_wait "pbs" "88888888-8888-4888-8888-888888888302" "32"
submit_batch_and_wait "slurm" "88888888-8888-4888-8888-888888888301"
submit_batch_and_wait "pbs" "88888888-8888-4888-8888-888888888302"
run_optional_netdrive_smoke
submit_and_wait "k3s" "88888888-8888-4888-8888-888888888303" "33"

echo "scheduler workflow smoke passed"
