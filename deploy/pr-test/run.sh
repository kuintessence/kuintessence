#!/usr/bin/env bash
set -euo pipefail
unset KQ_PR_MATERIAL_EPOCH KQ_PR_SPACK_CASE
export KQ_PR_SPACK_CASE=hello

fail() { printf '%s\n' "$*" >&2; exit 2; }
case "${1:-}" in
  slurm) export KQ_PR_SCHEDULER=slurm KQ_PR_REGISTRATION_SCHEDULER=slurm KQ_PR_PRIVILEGED=false ;;
  pbs) export KQ_PR_SCHEDULER=pbs KQ_PR_REGISTRATION_SCHEDULER=pbs-pro KQ_PR_PRIVILEGED=true ;;
  *) fail "Usage: bash deploy/pr-test/run.sh slurm|pbs [--config|--spack-case|--spack-managed|--spack-samtools|--spack-artifact-hello|--spack-artifact-samtools]" ;;
esac
[[ $# -le 2 && ( $# -eq 1 || "$2" == "--config" || "$2" == "--spack-case" || "$2" == "--spack-managed" || "$2" == "--spack-samtools" || "$2" == "--spack-artifact-hello" || "$2" == "--spack-artifact-samtools" ) ]] || fail "Unsupported flag"
spack_case=false
spack_managed=false
spack_artifact=false
if [[ "${2:-}" == "--spack-artifact-hello" || "${2:-}" == "--spack-artifact-samtools" ]]; then
  spack_artifact=true
fi
if [[ "${2:-}" == "--spack-managed" || "${2:-}" == "--spack-samtools" ]] || "$spack_artifact"; then
  [[ "${GITHUB_ACTIONS:-}" == true ]] || fail "Managed case runs only on disposable GitHub Actions runners"
  spack_managed=true
fi
if [[ "${2:-}" == "--spack-samtools" || "${2:-}" == "--spack-artifact-samtools" ]]; then
  export KQ_PR_SPACK_CASE=samtools
fi
if [[ "${2:-}" == "--spack-case" ]] || "$spack_managed"; then
  [[ "$KQ_PR_SCHEDULER" == slurm ]] || fail "The Spack single-step case currently requires Slurm"
  spack_case=true
fi
if "$spack_artifact"; then
  [[ -n "${RUNNER_TEMP:-}" && "$RUNNER_TEMP" == /* && -d "$RUNNER_TEMP" ]] || fail "Missing Actions temporary directory"
  # Artifact paths and bootstrap inputs are owned exclusively by this invocation.
  for name in ${!KQ_ARTIFACT_@}; do unset "$name"; done
  unset KQ_PR_APT_MIRROR
  command -v sha256sum >/dev/null || fail "SHA-256 checksum tool is required"
fi

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
command -v docker >/dev/null || fail "Docker is required"
command -v openssl >/dev/null || fail "OpenSSL is required"
docker compose version >/dev/null

# Never inherit a deployment's project, env file, profiles or image tags.
unset COMPOSE_FILE COMPOSE_PROFILES COMPOSE_ENV_FILES
export COMPOSE_PROJECT_NAME="kq-pr-test-${KQ_PR_SCHEDULER}-$(openssl rand -hex 8)"
export KQ_PR_DB_PASSWORD="$(openssl rand -hex 32)"
export KQ_PR_JWT_SECRET="$(openssl rand -hex 32)"
export KQ_PR_TICKET_SECRET="$(openssl rand -hex 32)"
if [[ "${GITHUB_ACTIONS:-}" == "true" ]]; then
  printf '::add-mask::%s\n' "$KQ_PR_DB_PASSWORD" "$KQ_PR_JWT_SECRET" "$KQ_PR_TICKET_SECRET"
fi
compose=(docker compose --project-directory "$repo_root" --env-file /dev/null
  -p "$COMPOSE_PROJECT_NAME" -f "$repo_root/deploy/compose/docker-compose.pr-test.yml")
if "$spack_case"; then
  compose+=(-f "$repo_root/deploy/compose/docker-compose.pr-spack-case.yml")
fi
if "$spack_managed"; then
  compose+=(-f "$repo_root/deploy/compose/docker-compose.pr-spack-managed.yml")
fi
if "$spack_artifact"; then
  compose+=(-f "$repo_root/deploy/compose/docker-compose.pr-spack-artifact-managed.yml")
fi
compose+=(--profile images)
artifact_work=""
artifact_exporter=""

legacy_probe_status() {
  "${compose[@]}" exec -T --user kq scheduler \
    head -c 512 /var/lib/kuintessence/legacy-probe-status 2>/dev/null |
    grep -Ex 'ci-legacy-find:result=(ok|nonzero|spawn|timeout|output-limit) reason=(none|store-permission|repo-init|config-permission|cache-permission|permission-other|other) json=(empty-array|array|non-array|invalid|unavailable)' || true
}

pbs_entrypoint_status() {
  "${compose[@]}" logs --no-color --no-log-prefix --tail 200 scheduler 2>/dev/null |
    grep -Ex 'ci-pbs-entrypoint:event=(ERR|EXIT) line=[0-9]{1,5} exit=([0-9]|[1-9][0-9]|1[0-9]{2}|2[0-4][0-9]|25[0-5])' || true
}

cleanup() {
  local result=$?
  trap - EXIT INT TERM
  if [[ "$KQ_PR_SCHEDULER" == pbs && "$result" -ne 0 ]]; then
    pbs_entrypoint_status
  fi
  if "$spack_case" && ! "$spack_artifact" && [[ "$result" -ne 0 ]]; then
    "${compose[@]}" logs --no-color --no-log-prefix registry 2>/dev/null |
      "${compose[@]}" exec -T registry bun deploy/pr-test/spack-case/diagnostics.ts || true
  fi
  if "$spack_managed" && ! "$spack_artifact" && [[ "$result" -ne 0 ]]; then
    legacy_probe_status
    "${compose[@]}" exec -T scheduler cat /run/kq-pr/status || true
    "${compose[@]}" exec -T scheduler systemctl show kq-pr-scheduler.service \
      --property=ActiveState --property=Result --property=ExecMainStatus || true
  fi
  if "$spack_artifact"; then
    if [[ -z "$artifact_work" ]]; then
      exit "$result"
    fi
    docker rm -f "$artifact_exporter" >/dev/null 2>&1 || true
  fi
  # Do not print container logs: Agent registration can include ephemeral credentials.
  "${compose[@]}" ps --all || true
  if ! "${compose[@]}" down --volumes --remove-orphans --rmi local --timeout 15; then
    printf 'PR test cleanup failed: %s\n' "$COMPOSE_PROJECT_NAME" >&2
    result=1
  fi
  # Explicit tags are unique to this invocation; never remove shared base/cache images.
  if "$spack_artifact"; then
    for image in scheduler workspace managed-builder artifact-exporter; do
      if docker image inspect "$COMPOSE_PROJECT_NAME-$image" >/dev/null 2>&1; then
        if ! docker image rm "$COMPOSE_PROJECT_NAME-$image" >/dev/null 2>&1; then
          printf '%s\n' "Spack artifact managed: stage=cleanup-images code=FAILED" >&2
          result=1
        fi
      fi
    done
    if ! rm -rf -- "$artifact_work"; then
      printf '%s\n' "Spack artifact managed: stage=cleanup code=FAILED" >&2
      result=1
    fi
    if [[ "$result" -eq 0 ]]; then
      printf '%s\n' "Spack artifact managed: stage=cleanup code=OK"
      printf 'PR scheduler and material regression passed: %s\n' "$KQ_PR_SCHEDULER"
    fi
  else
    if ! docker image rm "$COMPOSE_PROJECT_NAME-scheduler" "$COMPOSE_PROJECT_NAME-workspace" >/dev/null 2>&1; then
      printf 'Some PR image tags were absent or could not be removed: %s\n' "$COMPOSE_PROJECT_NAME" >&2
    fi
    if "$spack_case"; then
      docker image rm "$COMPOSE_PROJECT_NAME-case-operator" "$COMPOSE_PROJECT_NAME-case-native" >/dev/null 2>&1 || true
    fi
    if "$spack_managed"; then
      docker image rm "$COMPOSE_PROJECT_NAME-managed-builder" >/dev/null 2>&1 || true
    fi
  fi
  exit "$result"
}
if "$spack_artifact"; then
  trap cleanup EXIT
  trap 'exit 130' INT
  trap 'exit 143' TERM
  artifact_exporter="$COMPOSE_PROJECT_NAME-export"
  artifact_work="$(mktemp -d "$RUNNER_TEMP/kq-spack-managed.XXXXXXXX")"
  export KQ_ARTIFACT_DIRECTORY="$artifact_work/delivery"
  export KQ_ARTIFACT_RECIPE_BOOTSTRAP=/imports/delivery/recipe-pack/manifest.json
  export KQ_ARTIFACT_MATERIAL_BOOTSTRAP=/imports/delivery/material-pack/manifest.json
fi

"${compose[@]}" config --quiet
if [[ "${2:-}" == "--config" ]]; then
  printf 'PR Compose valid: %s (no containers started)\n' "$KQ_PR_SCHEDULER"
  exit 0
fi
docker info >/dev/null 2>&1 || fail "Docker daemon is unavailable; no build or tests ran"
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

artifact_checksums() {
  if ! (cd "$KQ_ARTIFACT_DIRECTORY" && sha256sum --strict --check checksums.txt) >/dev/null 2>&1; then
    fail "Spack artifact managed: stage=checksum-$1 code=FAILED"
  fi
  printf 'Spack artifact managed: stage=checksum-%s code=OK\n' "$1"
}

printf 'Building isolated PR test project: %s\n' "$COMPOSE_PROJECT_NAME"
"${compose[@]}" build scheduler
if "$spack_case"; then
  if "$spack_artifact"; then
    "${compose[@]}" build artifact-exporter managed-builder
    "${compose[@]}" run --rm --no-deps managed-builder
    "${compose[@]}" run --rm --no-deps --entrypoint chmod managed-builder 0444 /runtime/spack.sif
    "${compose[@]}" run --name "$artifact_exporter" --no-deps --entrypoint bash artifact-exporter \
      -euc 'mkdir -m 0755 /out
exec bun deploy/pr-test/spack-artifacts/export.ts "$@"' \
      export /opt/kq-case /out/delivery "$KQ_PR_SPACK_CASE" \
      "public/pr-$KQ_PR_SPACK_CASE-recipes" "public/pr-$KQ_PR_SPACK_CASE-sources"
    docker cp "$artifact_exporter:/out/delivery" "$KQ_ARTIFACT_DIRECTORY"
    docker rm "$artifact_exporter" >/dev/null
    artifact_checksums initial
    "${compose[@]}" run --rm --no-deps artifact-control bun deploy/pr-test/spack-case/setup.ts
  elif "$spack_managed"; then
    "${compose[@]}" build case-operator managed-builder
    "${compose[@]}" run --rm --no-deps managed-builder
    "${compose[@]}" run --rm --no-deps --entrypoint chmod managed-builder 0444 /runtime/spack.sif
    "${compose[@]}" run --rm --no-deps case-operator bun deploy/pr-test/spack-managed/export-lock.ts
  else
    "${compose[@]}" build case-operator case-native
  fi
  if ! "$spack_artifact"; then
    "${compose[@]}" run --rm --no-deps case-operator bun deploy/pr-test/spack-case/setup.ts
  fi
  "${compose[@]}" up -d --no-build --wait --wait-timeout 300 server registry
  if "$spack_artifact"; then
    "${compose[@]}" run --rm --no-deps artifact-control bun deploy/pr-test/spack-artifacts/managed-handoff.ts prepare
    # Persistence must be verified without startup re-import repairing missing content.
    unset KQ_ARTIFACT_RECIPE_BOOTSTRAP KQ_ARTIFACT_MATERIAL_BOOTSTRAP
    "${compose[@]}" up -d --force-recreate --no-build --wait --wait-timeout 300 registry server
    "${compose[@]}" run --rm --no-deps artifact-control bun deploy/pr-test/spack-artifacts/managed-handoff.ts verify
  else
    "${compose[@]}" run --rm --no-deps case-operator bun deploy/pr-test/spack-case/publish.ts
    "${compose[@]}" restart server
  fi
fi
"${compose[@]}" up -d --no-build --wait --wait-timeout 300 scheduler registry
if "$spack_case"; then
  # Query only from Server's trusted workspace; never pass database credentials to Agent.
  "${compose[@]}" exec -T server timeout --signal=TERM --kill-after=5s 60s bun deploy/pr-test/spack-case/references.ts configured
fi
if "$spack_managed"; then
  legacy_probe_status
  "${compose[@]}" exec -T --user kq scheduler bun deploy/pr-test/spack-managed/probe.ts
  "${compose[@]}" exec -T --user kq scheduler bun node_modules/typescript/bin/tsc --project deploy/pr-test/tsconfig.json
  "${compose[@]}" exec -T --user kq scheduler timeout --signal=TERM --kill-after=10s 1500s bun deploy/pr-test/spack-managed/case.ts install
  "${compose[@]}" exec -T server timeout --signal=TERM --kill-after=5s 60s bun deploy/pr-test/spack-case/references.ts managed-terminal
  "${compose[@]}" restart registry scheduler server
  "${compose[@]}" up -d --no-build --wait --wait-timeout 300 scheduler registry server
  "${compose[@]}" exec -T server timeout --signal=TERM --kill-after=5s 60s bun deploy/pr-test/spack-case/references.ts managed-restart
  if "$spack_artifact"; then
    "${compose[@]}" run --rm --no-deps artifact-control bun deploy/pr-test/spack-artifacts/managed-handoff.ts verify
  else
    "${compose[@]}" run --rm --no-deps case-operator bun deploy/pr-test/spack-case/publish.ts --verify
  fi
  "${compose[@]}" exec -T --user kq scheduler timeout --signal=TERM --kill-after=10s 900s bun deploy/pr-test/spack-managed/case.ts restart
  "${compose[@]}" exec -T --user kq scheduler timeout --signal=TERM --kill-after=10s 180s bun deploy/pr-test/spack-managed/case.ts uninstall
  "${compose[@]}" exec -T server timeout --signal=TERM --kill-after=5s 60s bun deploy/pr-test/spack-case/references.ts managed-uninstall
elif "$spack_case"; then
  "${compose[@]}" exec -T scheduler timeout --signal=TERM --kill-after=10s 180s bun deploy/pr-test/spack-case/consume.ts
  "${compose[@]}" exec -T server timeout --signal=TERM --kill-after=5s 60s bun deploy/pr-test/spack-case/references.ts native-terminal
  "${compose[@]}" exec -T --user kq scheduler bun node_modules/typescript/bin/tsc --project deploy/pr-test/tsconfig.json
  "${compose[@]}" run --rm --no-deps case-native timeout --signal=TERM --kill-after=10s 900s bash deploy/pr-test/spack-case/check.sh
  "${compose[@]}" exec -T --user kq scheduler timeout --signal=TERM --kill-after=10s 180s bun deploy/pr-test/spack-case/job.ts
  # Recreate processes while retaining this project's volumes, then verify both
  # registry releases and the compiled executable rather than trusting old logs.
  "${compose[@]}" restart registry scheduler server
  "${compose[@]}" up -d --no-build --wait --wait-timeout 300 scheduler registry server
  "${compose[@]}" exec -T server timeout --signal=TERM --kill-after=5s 60s bun deploy/pr-test/spack-case/references.ts native-restart
  "${compose[@]}" run --rm --no-deps case-operator bun deploy/pr-test/spack-case/publish.ts --verify
  "${compose[@]}" exec -T --user kq scheduler timeout --signal=TERM --kill-after=10s 180s bun deploy/pr-test/spack-case/job.ts
else
  "${compose[@]}" exec -T --user kq scheduler timeout --signal=TERM --kill-after=10s 600s bash /workspace/deploy/pr-test/check.sh
fi
if "$spack_case"; then
  # Run only after every original case/reference assertion. Capture no token or raw DB output.
  if ! KQ_PR_MATERIAL_EPOCH="$("${compose[@]}" exec -T server timeout --signal=TERM --kill-after=5s 60s bun deploy/pr-test/spack-case/rollout.ts activate)"; then
    fail "Spack rollout: stage=activate code=FAILED"
  fi
  [[ "$KQ_PR_MATERIAL_EPOCH" =~ ^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$ ]] || fail "Spack rollout: stage=epoch code=INVALID"
  export KQ_PR_MATERIAL_EPOCH
  # A restart cannot load a new environment. Recreate only these services, retaining volumes.
  "${compose[@]}" up -d --force-recreate --no-build --wait --wait-timeout 300 server registry
  "${compose[@]}" exec -T server timeout --signal=TERM --kill-after=5s 60s bun deploy/pr-test/spack-case/rollout.ts verify
fi
if "$spack_artifact"; then
  artifact_checksums final
else
  printf 'PR scheduler and material regression passed: %s\n' "$KQ_PR_SCHEDULER"
fi
