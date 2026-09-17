#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat <<'EOF'
Usage:
  bash deploy/schedulers/spack-operation-smoke.sh [env-file]

Default env-file:
  deploy/schedulers/ports-alt.env

Default action chain:
  install,batch_import_preinstalled,load

Environment:
  KQ_SPACK_SMOKE_BASE_URL       Web/Server base URL. Defaults to http://localhost:${KQ_SCHEDULER_WEB_PORT:-5173}
  KQ_SPACK_SMOKE_EMAIL          Dev login email. Defaults to spack-smoke@example.com
  KQ_SPACK_SMOKE_ROLE           Dev login role. Defaults to platform_admin
  KQ_SPACK_SMOKE_AGENT_ID       Optional target Agent. Defaults to the first online control channel.
  KQ_SPACK_SMOKE_SPEC           Single-operation Spack spec. Defaults to zlib
  KQ_SPACK_SMOKE_BATCH_SPECS    Newline-separated batch specs. Defaults to KQ_SPACK_SMOKE_SPEC
  KQ_SPACK_SMOKE_ACTIONS        Comma-separated actions. Supported:
                                install,import_preinstalled,load,uninstall,
                                batch_install,batch_import_preinstalled
  KQ_SPACK_SMOKE_VERIFY_LEDGER  Verify CP overview installed ledger after install/import/uninstall.
                                Defaults to true. Set to false to skip.
  KQ_SPACK_SMOKE_CURL_TIMEOUT_SEC
                                Per-HTTP-request timeout. Defaults to 30.
  KQ_SPACK_SMOKE_CONNECT_TIMEOUT_SEC
                                Per-HTTP-request connect timeout. Defaults to 10.
  KQ_SPACK_SMOKE_TIMEOUT_SEC    Per-operation timeout. Defaults to 1800
  KQ_SPACK_SMOKE_POLL_SEC       Poll interval. Defaults to 5

Examples:
  bash deploy/schedulers/spack-operation-smoke.sh deploy/schedulers/ports-alt.env

  KQ_SPACK_SMOKE_AGENT_ID=scheduler-slurm \
  KQ_SPACK_SMOKE_SPEC=zlib \
  bash deploy/schedulers/spack-operation-smoke.sh deploy/schedulers/ports-alt.env

  KQ_SPACK_SMOKE_BATCH_SPECS=$'zlib\nopenmpi' \
  KQ_SPACK_SMOKE_ACTIONS=batch_import_preinstalled \
  bash deploy/schedulers/spack-operation-smoke.sh deploy/schedulers/ports-alt.env
EOF
}

if [[ "${1:-}" == "-h" || "${1:-}" == "--help" ]]; then
  usage
  exit 0
fi

env_file="${1:-deploy/schedulers/ports-alt.env}"

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

base_url="${KQ_SPACK_SMOKE_BASE_URL:-http://localhost:${KQ_SCHEDULER_WEB_PORT:-5173}}"
email="${KQ_SPACK_SMOKE_EMAIL:-spack-smoke@example.com}"
role="${KQ_SPACK_SMOKE_ROLE:-platform_admin}"
spec="${KQ_SPACK_SMOKE_SPEC:-zlib}"
batch_specs="${KQ_SPACK_SMOKE_BATCH_SPECS:-${spec}}"
actions_csv="${KQ_SPACK_SMOKE_ACTIONS:-install,batch_import_preinstalled,load}"
timeout_sec="${KQ_SPACK_SMOKE_TIMEOUT_SEC:-1800}"
poll_sec="${KQ_SPACK_SMOKE_POLL_SEC:-5}"
verify_ledger="${KQ_SPACK_SMOKE_VERIFY_LEDGER:-true}"
curl_timeout_sec="${KQ_SPACK_SMOKE_CURL_TIMEOUT_SEC:-30}"
connect_timeout_sec="${KQ_SPACK_SMOKE_CONNECT_TIMEOUT_SEC:-10}"

if ! command -v curl >/dev/null 2>&1; then
  echo "curl is required" >&2
  exit 1
fi

if ! command -v bun >/dev/null 2>&1; then
  echo "bun is required" >&2
  exit 1
fi

if [[ ! "${timeout_sec}" =~ ^[0-9]+$ ]] || ((timeout_sec <= 0)); then
  echo "KQ_SPACK_SMOKE_TIMEOUT_SEC must be a positive integer" >&2
  exit 1
fi

if [[ ! "${poll_sec}" =~ ^[0-9]+$ ]] || ((poll_sec <= 0)); then
  echo "KQ_SPACK_SMOKE_POLL_SEC must be a positive integer" >&2
  exit 1
fi

if [[ ! "${curl_timeout_sec}" =~ ^[0-9]+$ ]] || ((curl_timeout_sec <= 0)); then
  echo "KQ_SPACK_SMOKE_CURL_TIMEOUT_SEC must be a positive integer" >&2
  exit 1
fi

if [[ ! "${connect_timeout_sec}" =~ ^[0-9]+$ ]] || ((connect_timeout_sec <= 0)); then
  echo "KQ_SPACK_SMOKE_CONNECT_TIMEOUT_SEC must be a positive integer" >&2
  exit 1
fi

curl_args=(-fsS --connect-timeout "${connect_timeout_sec}" --max-time "${curl_timeout_sec}")

tmp_dir="$(mktemp -d /tmp/kq-spack-operation-smoke.XXXXXX)"
trap 'rm -rf "${tmp_dir}"' EXIT

cookie_jar="${tmp_dir}/cookies.txt"
overview_json="${tmp_dir}/overview.json"
operation_json="${tmp_dir}/operation.json"
operations_json="${tmp_dir}/operations.json"

json_eval() {
  local file="$1"
  local script="$2"
  bun -e "const fs=require('fs'); const data=JSON.parse(fs.readFileSync(process.argv[1], 'utf8')); ${script}" "${file}"
}

ledger_verification_enabled() {
  case "${verify_ledger}" in
    false | FALSE | 0 | no | NO) return 1 ;;
    *) return 0 ;;
  esac
}

print_agent_summary() {
  json_eval "${overview_json}" "
    const agents = data.agents || [];
    if (agents.length === 0) {
      console.error('No agents were returned by /api/cp/software/overview.');
      process.exit(0);
    }
    console.error('Agent runtime summary:');
    for (const agent of agents) {
      console.error([
        '  - ' + agent.agentId,
        'db=' + (agent.status || '-'),
        'runtime=' + (agent.runtimeStatus || '-'),
        'control=' + (agent.controlChannelOnline ? 'online' : 'offline'),
        'lastHeartbeat=' + (agent.lastHeartbeat || '-'),
      ].join(' '));
    }
  "
}

select_agent_id() {
  KQ_REQUESTED_AGENT_ID="${KQ_SPACK_SMOKE_AGENT_ID:-}" json_eval "${overview_json}" "
    const requested = process.env.KQ_REQUESTED_AGENT_ID || '';
    const agents = data.agents || [];
    const agent = requested
      ? agents.find((item) => item.agentId === requested)
      : agents.find((item) => item.controlChannelOnline);
    if (!agent) {
      console.error(requested
        ? 'requested agent not found: ' + requested
        : 'no agent with an online control channel was found');
      process.exit(2);
    }
    if (!agent.controlChannelOnline) {
      console.error('agent control channel is offline: ' + agent.agentId);
      process.exit(3);
    }
    process.stdout.write(agent.agentId);
  "
}

validate_batch_specs() {
  KQ_SPECS="${batch_specs}" bun -e "
    const lines = (process.env.KQ_SPECS || '').split(/\\r?\\n/);
    if (lines.length > 2000) {
      console.error('KQ_SPACK_SMOKE_BATCH_SPECS contains ' + lines.length + ' raw lines; max is 2000');
      process.exit(4);
    }
    const seen = new Set();
    const specs = [];
    for (const raw of lines) {
      const spec = raw.trim();
      if (!spec || seen.has(spec)) continue;
      seen.add(spec);
      specs.push(spec);
    }
    if (specs.length === 0) {
      console.error('KQ_SPACK_SMOKE_BATCH_SPECS must contain at least one non-empty spec');
      process.exit(2);
    }
    if (specs.length > 200) {
      console.error('KQ_SPACK_SMOKE_BATCH_SPECS contains ' + specs.length + ' unique specs; max is 200');
      process.exit(3);
    }
    process.stdout.write(specs.join('\\n'));
  "
}

echo "Logging in to ${base_url} as ${email} (${role})..."
login_payload="$(
  KQ_EMAIL="${email}" KQ_ROLE="${role}" bun -e \
    "console.log(JSON.stringify({ email: process.env.KQ_EMAIL, role: process.env.KQ_ROLE }))"
)"
curl "${curl_args[@]}" \
  -c "${cookie_jar}" \
  -H "Content-Type: application/json" \
  --data "${login_payload}" \
  "${base_url}/api/auth/login" >/dev/null

curl "${curl_args[@]}" -b "${cookie_jar}" "${base_url}/api/cp/software/overview" -o "${overview_json}"

if ! agent_id="$(select_agent_id)"; then
  print_agent_summary
  exit 1
fi

echo "Selected agent: ${agent_id}"
echo "Spack spec: ${spec}"
echo "Actions: ${actions_csv}"

request_operation() {
  local action="$1"
  local payload
  payload="$(
    KQ_AGENT_ID="${agent_id}" KQ_ACTION="${action}" KQ_SPEC="${spec}" bun -e \
      "console.log(JSON.stringify({ agentId: process.env.KQ_AGENT_ID, action: process.env.KQ_ACTION, spec: process.env.KQ_SPEC }))"
  )"
  curl "${curl_args[@]}" \
    -b "${cookie_jar}" \
    -H "Content-Type: application/json" \
    --data "${payload}" \
    "${base_url}/api/cp/software/operations" \
    -o "${operation_json}"
  json_eval "${operation_json}" "process.stdout.write(data.id);"
}

request_batch_operation() {
  local action="$1"
  local payload
  local unique_specs
  unique_specs="$(validate_batch_specs)"
  echo "Batch specs after trim/dedupe validation:" >&2
  printf '%s\n' "${unique_specs}" >&2
  payload="$(
    KQ_AGENT_ID="${agent_id}" KQ_ACTION="${action}" KQ_SPECS="${batch_specs}" bun -e "
      const specs = (process.env.KQ_SPECS || '')
        .split(/\\r?\\n/);
      console.log(JSON.stringify({
        agentId: process.env.KQ_AGENT_ID,
        action: process.env.KQ_ACTION,
        specs,
      }));
    "
  )"
  curl "${curl_args[@]}" \
    -b "${cookie_jar}" \
    -H "Content-Type: application/json" \
    --data "${payload}" \
    "${base_url}/api/cp/software/operations/batch" \
    -o "${operation_json}"
  json_eval "${operation_json}" "
    const items = Array.isArray(data) ? data : data.items;
    if (!Array.isArray(items) || items.length === 0) {
      console.error('batch operation response is empty');
      process.exit(5);
    }
    if (data.summary) {
      console.error([
        'Batch summary:',
        'input=' + data.summary.inputCount,
        'nonEmpty=' + data.summary.nonEmptyCount,
        'unique=' + data.summary.uniqueSpecCount,
        'ignoredEmpty=' + data.summary.ignoredEmptyCount,
        'ignoredDuplicate=' + data.summary.ignoredDuplicateCount,
      ].join(' '));
    }
    for (const operation of items) {
      console.log(operation.id);
    }
  "
}

poll_operation() {
  local operation_id="$1"
  local action="$2"
  local start="${SECONDS}"
  local encoded_agent_id
  encoded_agent_id="$(KQ_VALUE="${agent_id}" bun -e "process.stdout.write(encodeURIComponent(process.env.KQ_VALUE || ''))")"

  while true; do
    curl "${curl_args[@]}" \
      -b "${cookie_jar}" \
      "${base_url}/api/cp/software/operations?agentId=${encoded_agent_id}&limit=500" \
      -o "${operations_json}"

    status="$(
      KQ_OPERATION_ID="${operation_id}" json_eval "${operations_json}" "
        const items = Array.isArray(data) ? data : data.items;
        if (!Array.isArray(items)) {
          console.error('operation history response did not contain an items array');
          process.exit(5);
        }
        const operation = items.find((item) => item.id === process.env.KQ_OPERATION_ID);
        if (!operation) {
          console.error(
            'operation ' + process.env.KQ_OPERATION_ID +
              ' was not found in operation history; returned rows=' + items.length,
          );
          process.exit(4);
        }
        process.stdout.write(operation.status);
      "
    )"

    if [[ "${status}" == "succeeded" ]]; then
      echo "${action} succeeded (${operation_id})"
      verify_operation_ledger "${operation_id}" "${action}"
      return 0
    fi

    if [[ "${status}" == "failed" || "${status}" == "rejected" ]]; then
      echo "${action} ${status} (${operation_id})" >&2
      KQ_OPERATION_ID="${operation_id}" json_eval "${operations_json}" "
        const items = Array.isArray(data) ? data : data.items;
        const operation = Array.isArray(items)
          ? items.find((item) => item.id === process.env.KQ_OPERATION_ID)
          : null;
        console.error(operation.error || operation.stderr || operation.stdout || 'no error details');
      " >&2
      return 1
    fi

    if ((SECONDS - start >= timeout_sec)); then
      echo "timed out waiting for ${action} (${operation_id}); last status=${status}" >&2
      return 1
    fi

    sleep "${poll_sec}"
  done
}

verify_operation_ledger() {
  local operation_id="$1"
  local action="$2"
  local base_action="${action#batch_}"
  if ! ledger_verification_enabled; then
    return 0
  fi
  if [[ "${base_action}" == "load" ]]; then
    return 0
  fi

  curl "${curl_args[@]}" -b "${cookie_jar}" "${base_url}/api/cp/software/overview" -o "${overview_json}"
  KQ_OPERATION_ID="${operation_id}" KQ_ACTION="${base_action}" KQ_AGENT_ID="${agent_id}" \
    KQ_OPERATIONS_JSON="${operations_json}" KQ_OVERVIEW_JSON="${overview_json}" bun -e "
      const fs = require('fs');
      const operationsData = JSON.parse(fs.readFileSync(process.env.KQ_OPERATIONS_JSON, 'utf8'));
      const overview = JSON.parse(fs.readFileSync(process.env.KQ_OVERVIEW_JSON, 'utf8'));
      const items = Array.isArray(operationsData) ? operationsData : operationsData.items;
      if (!Array.isArray(items)) {
        console.error('operation history response did not contain an items array');
        process.exit(5);
      }
      const operation = items.find((item) => item.id === process.env.KQ_OPERATION_ID);
      if (!operation) {
        console.error('operation ' + process.env.KQ_OPERATION_ID + ' was not found for ledger verification');
        process.exit(6);
      }
      const agent = (overview.agents || []).find((item) => item.agentId === process.env.KQ_AGENT_ID);
      if (!agent) {
        console.error('agent ' + process.env.KQ_AGENT_ID + ' was not found in CP software overview');
        process.exit(7);
      }
      const specHead = (raw) => {
        const trimmed = String(raw || '').trim();
        let cut = trimmed.length;
        for (const sep of [' ', '\t', '+', '~', '%', '^']) {
          const index = trimmed.indexOf(sep);
          if (index !== -1 && index < cut) cut = index;
        }
        return trimmed.slice(0, cut);
      };
      const packageName = (raw) => specHead(raw).split('@')[0] || specHead(raw);
      const requestedHead = specHead(operation.spec);
      const requestedName = packageName(operation.spec);
      const installedSpecs = Array.isArray(agent.installedSpecs) ? agent.installedSpecs : [];
      const matched = installedSpecs.some((entry) => {
        const head = specHead(entry);
        return head === requestedHead || head === requestedName || head.startsWith(requestedName + '@');
      });
      const action = process.env.KQ_ACTION;
      if ((action === 'install' || action === 'import_preinstalled') && !matched) {
        console.error(
          'installed ledger does not contain ' + operation.spec +
            ' after ' + action + '; installedSpecs=' + JSON.stringify(installedSpecs),
        );
        process.exit(8);
      }
      if (action === 'uninstall' && matched) {
        console.error(
          'installed ledger still contains ' + operation.spec +
            ' after uninstall; installedSpecs=' + JSON.stringify(installedSpecs),
        );
        process.exit(9);
      }
      console.error('Ledger verification passed for ' + action + ' ' + operation.spec);
    "
}

IFS=',' read -r -a actions <<<"${actions_csv}"
for raw_action in "${actions[@]}"; do
  action="$(KQ_VALUE="${raw_action}" bun -e "process.stdout.write((process.env.KQ_VALUE || '').trim())")"
  if [[ -z "${action}" ]]; then
    continue
  fi
  case "${action}" in
    install | import_preinstalled | load | uninstall) ;;
    batch_install | batch_import_preinstalled) ;;
    *)
      echo "unsupported smoke action: ${action}" >&2
      exit 1
      ;;
  esac
  echo
  echo "Requesting ${action}..."
  if [[ "${action}" == "batch_install" || "${action}" == "batch_import_preinstalled" ]]; then
    batch_action="${action#batch_}"
    operation_ids="$(request_batch_operation "${batch_action}")"
    while IFS= read -r operation_id; do
      if [[ -z "${operation_id}" ]]; then
        continue
      fi
      echo "${action} operation: ${operation_id}"
      poll_operation "${operation_id}" "${action}"
    done <<<"${operation_ids}"
  else
    operation_id="$(request_operation "${action}")"
    echo "${action} operation: ${operation_id}"
    poll_operation "${operation_id}" "${action}"
  fi
done

echo
echo "spack operation smoke passed"
