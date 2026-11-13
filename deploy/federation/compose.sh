#!/usr/bin/env bash
set -euo pipefail

mode=${1:-}
case "$mode" in direct|fabric) shift ;; *) echo 'Usage: compose.sh direct|fabric [docker compose arguments]' >&2; exit 2 ;; esac
root=$(cd "$(dirname "$0")/../.." && pwd)
# Explicit files avoid ambient COMPOSE_FILE/profile settings silently enabling services.
unset COMPOSE_FILE COMPOSE_PROFILES
args=(--project-directory "$root" --env-file "${KQ_DEPLOY_ENV_FILE:-$root/deploy/main/.env}")
args+=(-f "$root/deploy/main/compose.yml" -f "$root/deploy/federation/compose.ingress.yml")
if [[ "$mode" == fabric ]]; then
  args+=(-f "$root/deploy/federation/compose.fabric.yml")
fi
exec docker compose "${args[@]}" "$@"
