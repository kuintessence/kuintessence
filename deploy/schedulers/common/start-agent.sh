#!/usr/bin/env bash
set -euo pipefail

if [[ "${KQ_AGENT_ENABLED:-1}" != "1" ]]; then
  echo "KQ_AGENT_ENABLED is not 1; skip agent startup"
  exit 0
fi

if [[ -n "${KQ_AGENT_ENV_FILE:-}" && -f "${KQ_AGENT_ENV_FILE}" ]]; then
  set -a
  # shellcheck disable=SC1090
  source "${KQ_AGENT_ENV_FILE}"
  set +a
elif [[ -n "${AGENT_ID:-}" && -f "/var/lib/kuintessence/agent/${AGENT_ID}/agent.env" ]]; then
  set -a
  # shellcheck disable=SC1090
  source "/var/lib/kuintessence/agent/${AGENT_ID}/agent.env"
  set +a
fi

if [[ -z "${SERVER_GRPC_URL:-}" || -z "${AGENT_ID:-}" || -z "${AGENT_SITE_NAME:-}" ]]; then
  echo "SERVER_GRPC_URL, AGENT_ID, and AGENT_SITE_NAME are required for the agent" >&2
  exit 2
fi

cd /workspace

if [[ ! -f package.json || ! -d packages/agent ]]; then
  echo "/workspace must mount the Kuintessence repository" >&2
  exit 2
fi

mkdir -p "$(dirname "${AGENT_DB_PATH:-/var/lib/kuintessence/agent.db}")" "${BUN_INSTALL_CACHE_DIR:-/var/cache/bun}"

if [[ ! -d node_modules/pino || ! -d node_modules/ssh2 || ! -e node_modules/@kuintessence/db ]]; then
  echo "workspace dependencies are missing; bootstrapping node_modules"
  kq-install-agent-deps /workspace /workspace/node_modules
fi

exec bun run --filter @kuintessence/agent start
