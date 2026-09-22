#!/usr/bin/env bash
set -euo pipefail
umask 077

fail() { printf '%s\n' "$*" >&2; exit 2; }
[[ "${GITHUB_ACTIONS:-}" == true ]] || fail "Material artifact checks require a disposable Actions runner"
[[ $# -eq 3 ]] || fail "Usage: run.sh hello|samtools RECIPE_REPOSITORY MATERIAL_REPOSITORY"
[[ "$1" == hello || "$1" == samtools ]] || fail "Unsupported material case"
[[ -n "${RUNNER_TEMP:-}" && "$RUNNER_TEMP" == /* && -d "$RUNNER_TEMP" ]] || fail "Missing Actions temporary directory"
repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
cd "$repo_root"
command -v docker >/dev/null || fail "Docker is required"
command -v bun >/dev/null || fail "Bun is required"
command -v openssl >/dev/null || fail "OpenSSL is required"

unset COMPOSE_FILE COMPOSE_PROFILES COMPOSE_ENV_FILES KQ_PR_APT_MIRROR
unset KQ_ARTIFACT_RECIPE_BOOTSTRAP KQ_ARTIFACT_MATERIAL_BOOTSTRAP
export COMPOSE_PROJECT_NAME="kq-material-artifact-$(openssl rand -hex 8)"
export KQ_PR_SCHEDULER=slurm KQ_PR_REGISTRATION_SCHEDULER=slurm KQ_PR_PRIVILEGED=false
export KQ_PR_SPACK_CASE="$1"
export KQ_PR_DB_PASSWORD="$(openssl rand -hex 32)"
export KQ_PR_JWT_SECRET="$(openssl rand -hex 32)"
printf '::add-mask::%s\n' "$KQ_PR_DB_PASSWORD" "$KQ_PR_JWT_SECRET"
work="$(mktemp -d "$RUNNER_TEMP/kq-spack-export.XXXXXXXX")"
export KQ_ARTIFACT_DIRECTORY="$work/delivery"
export KQ_ARTIFACT_RESULT_PATH="$work/web-binding.json"
export KQ_ARTIFACT_REFERENCE_PATH="$work/bootstrap-binding.json"
export KQ_ARTIFACT_WEB_URL=http://127.0.0.1:15173
output="$RUNNER_TEMP/kq-spack-material-artifact"
[[ ! -e "$output" && ! -L "$output" ]] || fail "Artifact destination must not already exist"
exporter="$COMPOSE_PROJECT_NAME-export"
compose=(docker compose --project-directory "$repo_root" --env-file /dev/null
  -p "$COMPOSE_PROJECT_NAME"
  -f "$repo_root/deploy/compose/docker-compose.pr-test.yml"
  -f "$repo_root/deploy/compose/docker-compose.pr-spack-artifacts.yml"
  --profile images)

cleanup() {
  local result=$?
  trap - EXIT INT TERM
  # Never print application/container logs: these services issue real temporary credentials.
  docker rm -f "$exporter" >/dev/null 2>&1 || true
  if ! "${compose[@]}" down --volumes --remove-orphans --rmi local --timeout 15; then
    printf '%s\n' "Spack artifact cleanup: status=failed" >&2
    result=1
  fi
  docker image rm "$COMPOSE_PROJECT_NAME-artifact-operator" "$COMPOSE_PROJECT_NAME-workspace" >/dev/null 2>&1 || true
  rm -rf -- "$work"
  exit "$result"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

start_stack() {
  "${compose[@]}" up -d --no-build --wait --wait-timeout 300 server registry
  local server_address registry_address
  server_address="$("${compose[@]}" port server 3000)"
  registry_address="$("${compose[@]}" port registry 3100)"
  [[ "$server_address" =~ ^127\.0\.0\.1:[0-9]+$ && "$registry_address" =~ ^127\.0\.0\.1:[0-9]+$ ]] || fail "Unexpected test listener"
  export KQ_WEB_SERVER_PROXY_TARGET="http://$server_address"
  export KQ_WEB_REGISTRY_PROXY_TARGET="http://$registry_address"
}

verify() {
  timeout --signal=TERM --kill-after=10s 600s bun deploy/pr-test/spack-artifacts/verify.ts "$1"
}

"${compose[@]}" config --quiet
"${compose[@]}" build artifact-operator
"${compose[@]}" run --name "$exporter" --no-deps --entrypoint bash artifact-operator \
  -euc 'mkdir -m 0755 /out
exec bun deploy/pr-test/spack-artifacts/export.ts "$@"' \
  export /opt/kq-case /out/delivery "$1" "$2" "$3"
docker cp "$exporter:/out/delivery" "$KQ_ARTIFACT_DIRECTORY"
docker rm "$exporter" >/dev/null

export KQ_ARTIFACT_RECIPE_BOOTSTRAP=/imports/recipe-pack/manifest.json
export KQ_ARTIFACT_MATERIAL_BOOTSTRAP=/imports/material-pack/manifest.json
start_stack
verify bootstrap
"${compose[@]}" restart registry server
start_stack
verify bootstrap-restart
"${compose[@]}" down --volumes --remove-orphans --timeout 15

# The Web route must succeed without the first route's database, receipts or Git snapshots.
unset KQ_ARTIFACT_RECIPE_BOOTSTRAP KQ_ARTIFACT_MATERIAL_BOOTSTRAP
start_stack
verify empty
timeout --signal=TERM --kill-after=10s 900s \
  bun run --cwd packages/web e2e --config e2e/material-artifacts.config.ts
verify web
"${compose[@]}" restart registry server
start_stack
verify web-restart

# Verify the exported bytes again after both consumers, including the read-only bind mount.
(cd "$KQ_ARTIFACT_DIRECTORY" && sha256sum --strict --check checksums.txt)
mv -- "$KQ_ARTIFACT_DIRECTORY" "$output"
printf '%s\n' "Spack artifact export and import regression: status=succeeded"
