#!/usr/bin/env bash
set -euo pipefail

if [[ "${KQ_AGENT_REGISTRATION_ENABLED:-1}" != "1" ]]; then
  echo "KQ_AGENT_REGISTRATION_ENABLED is not 1; skip agent registration"
  exit 0
fi

if [[ -z "${AGENT_ID:-}" || -z "${AGENT_SITE_NAME:-}" || -z "${SERVER_GRPC_URL:-}" ]]; then
  echo "AGENT_ID, AGENT_SITE_NAME, and SERVER_GRPC_URL are required for compose agent registration" >&2
  exit 2
fi

server_http_url="${SERVER_HTTP_URL:-http://server:3000}"
server_api_url="${server_http_url%/}/api"
scheduler="${KQ_AGENT_REGISTRATION_SCHEDULER:-}"
output_dir="${KQ_AGENT_REGISTRATION_OUTPUT_DIR:-/var/lib/kuintessence/agent/${AGENT_ID}}"
env_file="${output_dir}/agent.env"
cert_dir="${output_dir}/certs"

if [[ -z "${scheduler}" ]]; then
  echo "KQ_AGENT_REGISTRATION_SCHEDULER is required for compose agent registration" >&2
  exit 2
fi

if [[ "${KQ_AGENT_REGISTRATION_FORCE:-0}" != "1" \
  && -f "${env_file}" \
  && -f "${cert_dir}/client.crt" \
  && -f "${cert_dir}/client.key" \
  && -f "${cert_dir}/ca.crt" ]]; then
  echo "Agent ${AGENT_ID} already has a local registration bundle at ${output_dir}"
  exit 0
fi

cd /workspace

if [[ ! -f package.json || ! -d packages/cli || ! -d packages/agent ]]; then
  echo "/workspace must mount the Kuintessence repository" >&2
  exit 2
fi

mkdir -p "${output_dir}" "${BUN_INSTALL_CACHE_DIR:-/var/cache/bun}"

if [[ ! -d node_modules/pino || ! -d node_modules/ssh2 || ! -e node_modules/@kuintessence/db ]]; then
  echo "workspace dependencies are missing; bootstrapping node_modules"
  kq-install-agent-deps /workspace /workspace/node_modules
fi

tmp_dir="$(mktemp -d /tmp/kq-agent-register.XXXXXX)"
cleanup() {
  rm -rf "${tmp_dir}"
}
trap cleanup EXIT

json_field() {
  local json="$1"
  local script="$2"
  KQ_JSON="${json}" bun -e "${script}"
}

login_json="$(
  curl -fsS --retry 60 --retry-delay 1 --retry-connrefused \
    -X POST "${server_api_url}/auth/login" \
    -H "Content-Type: application/json" \
    --data "$(KQ_EMAIL="${KQ_AGENT_REGISTRATION_EMAIL:-scheduler-compose-seed@kuintessence.test}" \
      KQ_ROLE="${KQ_AGENT_REGISTRATION_ROLE:-platform_admin}" \
      bun -e 'process.stdout.write(JSON.stringify({email: process.env.KQ_EMAIL, role: process.env.KQ_ROLE}))')"
)"
jwt="$(
  json_field "${login_json}" \
    'const data = JSON.parse(process.env.KQ_JSON ?? "{}"); if (!data.token) process.exit(1); process.stdout.write(data.token);'
)"

context_json="$(
  curl -fsS --retry 10 --retry-delay 1 \
    -H "Authorization: Bearer ${jwt}" \
    "${server_api_url}/cp/agent-registration-context"
)"
provider_org_id="${KQ_AGENT_REGISTRATION_PROVIDER_ORG_ID:-}"
if [[ -z "${provider_org_id}" ]]; then
  provider_org_id="$(
    KQ_JSON="${context_json}" \
    KQ_PROVIDER_NAME="${KQ_AGENT_REGISTRATION_PROVIDER_NAME:-Development Compute Provider}" \
    bun -e '
      const data = JSON.parse(process.env.KQ_JSON ?? "{}");
      const orgs = Array.isArray(data.providerOrgs) ? data.providerOrgs : [];
      const preferred = orgs.find((org) => org.name === process.env.KQ_PROVIDER_NAME) ?? orgs[0];
      if (!preferred?.id) process.exit(1);
      process.stdout.write(preferred.id);
    '
  )"
fi

token_body="${tmp_dir}/token-body.json"
KQ_PROVIDER_ORG_ID="${provider_org_id}" \
KQ_AGENT_ID="${AGENT_ID}" \
KQ_AGENT_SITE_NAME="${AGENT_SITE_NAME}" \
KQ_TTL_SEC="${KQ_AGENT_REGISTRATION_TTL_SEC:-86400}" \
bun -e '
  const ttl = Number(process.env.KQ_TTL_SEC ?? "86400");
  if (!Number.isInteger(ttl) || ttl <= 0) process.exit(1);
  process.stdout.write(JSON.stringify({
    providerOrgId: process.env.KQ_PROVIDER_ORG_ID,
    agentId: process.env.KQ_AGENT_ID,
    siteName: process.env.KQ_AGENT_SITE_NAME,
    expiresInSec: ttl,
  }));
' >"${token_body}"

token_json="$(
  curl -fsS \
    -X POST "${server_api_url}/cp/agent-registration-tokens" \
    -H "Authorization: Bearer ${jwt}" \
    -H "Content-Type: application/json" \
    --data @"${token_body}"
)"
registration_token="$(
  json_field "${token_json}" \
    'const data = JSON.parse(process.env.KQ_JSON ?? "{}"); if (!data.token) process.exit(1); process.stdout.write(data.token);'
)"

bun run /workspace/packages/cli/src/index.ts agent register \
  --url "${server_http_url}" \
  --grpc-url "${SERVER_GRPC_URL}" \
  --token "${registration_token}" \
  --output-dir "${output_dir}" \
  --scheduler "${scheduler}"

echo "Agent ${AGENT_ID} registered through Server registration intent"
