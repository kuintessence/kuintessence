#!/usr/bin/env bash
set -euo pipefail
[[ "${KQ_PR_TEST:-}" == 1 && "$(id -u)" == 0 ]]
mkdir -p /run/kq-pr
chmod 0700 /run/kq-pr
# systemd does not propagate the container environment into system services.
# This protected, allowlisted file is never printed or mounted in the worker.
bun /workspace/deploy/pr-test/spack-managed/environment.ts
exec /sbin/init
