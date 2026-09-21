#!/usr/bin/env bash
set -euo pipefail
[[ "${KQ_PR_TEST:-}" == 1 && "$(id -u)" == 1000 ]]
set -a
source /etc/kuintessence/managed/runtime.env
set +a
(
  set -a
  if [[ -n "${KQ_AGENT_ENV_FILE:-}" && -f "${KQ_AGENT_ENV_FILE}" ]]; then
    source "${KQ_AGENT_ENV_FILE}"
  elif [[ -n "${AGENT_ID:-}" && -f "/var/lib/kuintessence/agent/${AGENT_ID}/agent.env" ]]; then
    source "/var/lib/kuintessence/agent/${AGENT_ID}/agent.env"
  fi
  set +a
  cd /workspace/packages/agent
  timeout --signal=TERM --kill-after=2s 20s \
    python3 -I -B /workspace/deploy/pr-test/spack-managed/legacy-probe.py
) >/dev/null 2>&1 || :
exec /usr/local/bin/kq-start-agent
