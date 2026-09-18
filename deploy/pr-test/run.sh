#!/usr/bin/env bash
set -euo pipefail

fail() { printf '%s\n' "$*" >&2; exit 2; }
case "${1:-}" in
  slurm) export KQ_PR_SCHEDULER=slurm KQ_PR_REGISTRATION_SCHEDULER=slurm KQ_PR_PRIVILEGED=false ;;
  pbs) export KQ_PR_SCHEDULER=pbs KQ_PR_REGISTRATION_SCHEDULER=pbs-pro KQ_PR_PRIVILEGED=true ;;
  *) fail "Usage: bash deploy/pr-test/run.sh slurm|pbs [--config]" ;;
esac
[[ $# -le 2 && ( $# -eq 1 || "$2" == "--config" ) ]] || fail "Only --config is supported"

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
command -v docker >/dev/null || fail "Docker is required"
command -v openssl >/dev/null || fail "OpenSSL is required"
docker compose version >/dev/null

# Never inherit a deployment's project, env file, profiles or image tags.
unset COMPOSE_FILE COMPOSE_PROFILES COMPOSE_ENV_FILES
export COMPOSE_PROJECT_NAME="kq-pr-test-${KQ_PR_SCHEDULER}-$(openssl rand -hex 8)"
export KQ_PR_DB_PASSWORD="$(openssl rand -hex 32)"
export KQ_PR_JWT_SECRET="$(openssl rand -hex 32)"
if [[ "${GITHUB_ACTIONS:-}" == "true" ]]; then
  printf '::add-mask::%s\n' "$KQ_PR_DB_PASSWORD" "$KQ_PR_JWT_SECRET"
fi
compose=(docker compose --project-directory "$repo_root" --env-file /dev/null
  -p "$COMPOSE_PROJECT_NAME" -f "$repo_root/deploy/compose/docker-compose.pr-test.yml")

"${compose[@]}" --profile images config --quiet
if [[ "${2:-}" == "--config" ]]; then
  printf 'PR Compose valid: %s (no containers started)\n' "$KQ_PR_SCHEDULER"
  exit 0
fi
docker info >/dev/null 2>&1 || fail "Docker daemon is unavailable; no build or tests ran"

cleanup() {
  local result=$?
  trap - EXIT INT TERM
  # Do not print container logs: Agent registration can include ephemeral credentials.
  "${compose[@]}" ps --all || true
  if ! "${compose[@]}" --profile images down --volumes --remove-orphans --rmi local --timeout 15; then
    printf 'PR test cleanup failed: %s\n' "$COMPOSE_PROJECT_NAME" >&2
    result=1
  fi
  # Explicit tags are unique to this invocation; never remove shared base/cache images.
  if ! docker image rm "$COMPOSE_PROJECT_NAME-scheduler" "$COMPOSE_PROJECT_NAME-workspace" >/dev/null 2>&1; then
    printf 'Some PR image tags were absent or could not be removed: %s\n' "$COMPOSE_PROJECT_NAME" >&2
  fi
  exit "$result"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

printf 'Building isolated PR test project: %s\n' "$COMPOSE_PROJECT_NAME"
"${compose[@]}" --profile images build scheduler
"${compose[@]}" up -d --wait --wait-timeout 300 scheduler registry
"${compose[@]}" exec -T --user kq scheduler timeout --signal=TERM --kill-after=10s 600s bash /workspace/deploy/pr-test/check.sh
printf 'PR scheduler and material regression passed: %s\n' "$KQ_PR_SCHEDULER"
