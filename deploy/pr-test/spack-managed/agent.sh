#!/usr/bin/env bash
set -euo pipefail
[[ "${KQ_PR_TEST:-}" == 1 && "$(id -u)" == 1000 ]]
set -a
source /etc/kuintessence/managed/runtime.env
set +a
exec /usr/local/bin/kq-start-agent
