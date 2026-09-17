#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat <<'EOF'
Usage:
  bash deploy/authz-smoke.sh [env-file]

Default env-file:
  (none)

Environment:
  KQ_AUTHZ_SMOKE_WEB_PORT    Web entry port (Server API base port). Defaults to
                             KQ_SCHEDULER_WEB_PORT -> KQ_WEB_PORT -> 5173.
  KQ_AUTHZ_SMOKE_BASE_URL    Override the Server API base URL directly.
  KQ_AUTHZ_SMOKE_EMAIL       Dev login email. Defaults to kq-dev-admin@example.com.
  KQ_AUTHZ_SMOKE_ROLE        Dev login role. Defaults to platform_admin.
  KQ_AUTHZ_SMOKE_FORCE_ENFORCE
                             Force readiness check to require enforceReady=true.
                             Defaults to true.
  KQ_AUTHZ_SMOKE_REQUIRE_NO_PENDING
                             Require authz outbox to have no pending/processing/dead
                             rows. Defaults to true.
  KQ_AUTHZ_SMOKE_READINESS_RETRIES
                             Number of readiness attempts after login/outbox drain.
                             Defaults to 6.
  KQ_AUTHZ_SMOKE_READINESS_SLEEP_SEC
                             Seconds to sleep between readiness attempts.
                             Defaults to 2.
  KQ_AUTHZ_SMOKE_VERIFY_OIDC
                             Verify OIDC public config and /api/auth/oidc/login
                             redirect when SSO is enabled. Defaults to true.

Examples:
  bash deploy/authz-smoke.sh
  KQ_AUTHZ_SMOKE_BASE_URL=http://localhost:3000 bash deploy/authz-smoke.sh
  KQ_AUTHZ_SMOKE_WEB_PORT=15173 bash deploy/authz-smoke.sh
  KQ_AUTHZ_SMOKE_REQUIRE_NO_PENDING=false bash deploy/authz-smoke.sh
EOF
}

if [[ "${1:-}" == "-h" || "${1:-}" == "--help" ]]; then
  usage
  exit 0
fi

if [[ "${1:-}" != "" ]]; then
  env_file="${1}"
  if [[ ! -f "${env_file}" ]]; then
    echo "env file not found: ${env_file}" >&2
    exit 1
  fi
  set -a
  # shellcheck disable=SC1090
  source "${env_file}"
  set +a
fi

base_url="${KQ_AUTHZ_SMOKE_BASE_URL:-http://localhost:${KQ_AUTHZ_SMOKE_WEB_PORT:-${KQ_SCHEDULER_WEB_PORT:-${KQ_WEB_PORT:-5173}}}}"
email="${KQ_AUTHZ_SMOKE_EMAIL:-kq-dev-admin@example.com}"
role="${KQ_AUTHZ_SMOKE_ROLE:-platform_admin}"
force_enforce="${KQ_AUTHZ_SMOKE_FORCE_ENFORCE:-true}"
require_no_pending="${KQ_AUTHZ_SMOKE_REQUIRE_NO_PENDING:-true}"
readiness_retries="${KQ_AUTHZ_SMOKE_READINESS_RETRIES:-6}"
readiness_sleep_sec="${KQ_AUTHZ_SMOKE_READINESS_SLEEP_SEC:-2}"
verify_oidc="${KQ_AUTHZ_SMOKE_VERIFY_OIDC:-true}"

if ! command -v curl >/dev/null 2>&1; then
  echo "curl is required" >&2
  exit 1
fi

if ! command -v bun >/dev/null 2>&1; then
  echo "bun is required" >&2
  exit 1
fi

echo "Smoke target: ${base_url}"
echo "Login user: ${email} (${role})"

tmp_dir="$(mktemp -d /tmp/kq-authz-smoke.XXXXXX)"
trap 'rm -rf "${tmp_dir}"' EXIT

cookie_jar="${tmp_dir}/cookies.txt"
health_json="${tmp_dir}/health.json"
authz_health_json="${tmp_dir}/authz-health.json"
outbox_process_json="${tmp_dir}/outbox-process.json"
readiness_json="${tmp_dir}/readiness.json"
oidc_config_json="${tmp_dir}/oidc-config.json"
oidc_login_headers="${tmp_dir}/oidc-login.headers"

curl_args=(-fsS --connect-timeout 10 --max-time 30)

health_payload="$(
  KQ_EMAIL="${email}" KQ_ROLE="${role}" bun -e \
    "console.log(JSON.stringify({ email: process.env.KQ_EMAIL, role: process.env.KQ_ROLE }))"
)"

curl "${curl_args[@]}" -c "${cookie_jar}" \
  -H "Content-Type: application/json" \
  --data "${health_payload}" \
  "${base_url}/api/auth/login" >/dev/null

curl "${curl_args[@]}" -b "${cookie_jar}" "${base_url}/api/health" -o "${health_json}" >/dev/null
KQ_AUTHZ_SMOKE_HEALTH_JSON="${health_json}" bun -e "
  import fs from 'node:fs';
  const path = process.env.KQ_AUTHZ_SMOKE_HEALTH_JSON;
  if (typeof path !== 'string') {
    console.error('Missing health file path');
    process.exit(1);
  }
  const data = JSON.parse(fs.readFileSync(path, 'utf8'));
  if (data?.status !== 'ok') {
    console.error('Health endpoint returned non-ok status');
    process.exit(1);
  }
  console.log('Health OK');
"

curl "${curl_args[@]}" -b "${cookie_jar}" "${base_url}/api/admin/authz/health" -o "${authz_health_json}" >/dev/null
KQ_AUTHZ_SMOKE_AUTHZ_HEALTH_JSON="${authz_health_json}" bun -e "
  import fs from 'node:fs';
  const path = process.env.KQ_AUTHZ_SMOKE_AUTHZ_HEALTH_JSON;
  if (typeof path !== 'string') {
    console.error('Missing authz health file path');
    process.exit(1);
  }
  const data = JSON.parse(fs.readFileSync(path, 'utf8'));
  if (!data?.success || typeof data.data !== 'object') {
    console.error('AuthZ health API returned unexpected payload');
    process.exit(1);
  }
  const health = data.data;
  if (!health.healthy) {
    console.error('AuthZ health indicates unhealthy');
    process.exit(1);
  }
  if (!health.schemaWritten) {
    console.error('AuthZ schema not written');
    process.exit(1);
  }
  if (!health.schemaMatches) {
    console.error('AuthZ schema mismatch');
    process.exit(1);
  }
  console.log('AuthZ health OK (mode=' + health.mode + ', configured=' + health.configured + ')');
"

curl "${curl_args[@]}" -b "${cookie_jar}" \
  -H "Content-Type: application/json" \
  --data '{"batchSize":500}' \
  "${base_url}/api/admin/authz/outbox/process" -o "${outbox_process_json}" >/dev/null
KQ_AUTHZ_SMOKE_OUTBOX_PROCESS_JSON="${outbox_process_json}" bun -e "
  import fs from 'node:fs';
  const path = process.env.KQ_AUTHZ_SMOKE_OUTBOX_PROCESS_JSON;
  if (typeof path !== 'string') {
    console.error('Missing outbox process file path');
    process.exit(1);
  }
  const data = JSON.parse(fs.readFileSync(path, 'utf8'));
  if (!data?.success || typeof data.data !== 'object') {
    console.error('AuthZ outbox process API returned unexpected payload');
    process.exit(1);
  }
"

attempt=1
while true; do
  curl "${curl_args[@]}" -b "${cookie_jar}" "${base_url}/api/admin/authz/readiness" -o "${readiness_json}" >/dev/null
  if KQ_AUTHZ_SMOKE_READINESS_JSON="${readiness_json}" KQ_AUTHZ_SMOKE_FORCE_ENFORCE="${force_enforce}" KQ_AUTHZ_SMOKE_REQUIRE_NO_PENDING="${require_no_pending}" bun -e "
  import fs from 'node:fs';
  const path = process.env.KQ_AUTHZ_SMOKE_READINESS_JSON;
  if (typeof path !== 'string') {
    console.error('Missing readiness file path');
    process.exit(1);
  }
  const data = JSON.parse(fs.readFileSync(path, 'utf8'));
  if (!data?.success || typeof data.data !== 'object') {
    console.error('AuthZ readiness API returned unexpected payload');
    process.exit(1);
  }
  const readiness = data.data;
  if (readiness.blockers.length > 0) {
    console.error('AuthZ readiness has blockers:');
    for (const blocker of readiness.blockers) {
      console.error('  - ' + blocker);
    }
    process.exit(1);
  }
  if (process.env.KQ_AUTHZ_SMOKE_FORCE_ENFORCE === 'true' && !readiness.enforceReady) {
    console.error('AuthZ readiness enforceReady=false');
    process.exit(1);
  }
  if (process.env.KQ_AUTHZ_SMOKE_REQUIRE_NO_PENDING === 'true') {
    const { outbox } = readiness;
    if ((outbox?.pending ?? 0) !== 0 || (outbox?.processing ?? 0) !== 0 || (outbox?.dead ?? 0) !== 0) {
      console.error('AuthZ outbox is not clean');
      process.exit(1);
    }
  }
  const blocked = readiness.blockers.length === 0 ? 'none' : readiness.blockers.join(', ');
  const outbox = readiness.outbox || {};
  console.log(
    'AuthZ readiness OK (mode=' +
      readiness.mode +
      ', externalSmokeRequired=' +
      readiness.externalSmokeRequired +
      ', outbox={pending:' +
      (outbox.pending ?? 0) +
      ', processing:' +
      (outbox.processing ?? 0) +
      ', dead:' +
      (outbox.dead ?? 0) +
      '}, blockers=' +
      blocked +
      ')'
  );
"; then
    break
  fi
  if [[ "${attempt}" -ge "${readiness_retries}" ]]; then
    exit 1
  fi
  attempt=$((attempt + 1))
  sleep "${readiness_sleep_sec}"
done

if [[ "${verify_oidc}" == "true" ]]; then
  curl "${curl_args[@]}" -b "${cookie_jar}" "${base_url}/api/auth/oidc/config-public" -o "${oidc_config_json}" >/dev/null
  KQ_AUTHZ_SMOKE_OIDC_CONFIG_JSON="${oidc_config_json}" bun -e "
    import fs from 'node:fs';
    const path = process.env.KQ_AUTHZ_SMOKE_OIDC_CONFIG_JSON;
    if (typeof path !== 'string') {
      console.error('Missing oidc config file path');
      process.exit(1);
    }
    const data = JSON.parse(fs.readFileSync(path, 'utf8'));
    if (typeof data?.enabled !== 'boolean') {
      console.error('Invalid OIDC config payload');
      process.exit(1);
    }
    if (!data.enabled) {
      console.log('OIDC smoke skipped (SSO disabled)');
      process.exit(0);
    }
    console.log('OIDC provider = ' + (data.providerName || ''));
  "

  oidc_login_status=$(curl -o /dev/null -D "${oidc_login_headers}" -w '%{http_code}' "${curl_args[@]}" -b "${cookie_jar}" "${base_url}/api/auth/oidc/login")
  if [[ "${oidc_login_status}" != "302" ]]; then
    echo "OIDC login endpoint failed with status ${oidc_login_status}" >&2
    echo "Response headers:" >&2
    cat "${oidc_login_headers}" >&2
    exit 1
  fi

  if ! grep -qi '^Location:' "${oidc_login_headers}" > /dev/null; then
    echo "OIDC login endpoint did not return Location header" >&2
    cat "${oidc_login_headers}" >&2
    exit 1
  fi

  echo "OIDC smoke OK"
fi

echo "AuthZ smoke passed"
