#!/usr/bin/env bash
set -euo pipefail
umask 077

fail() { printf '%s\n' "$1" >&2; exit 1; }
[[ "${GITHUB_REF:-}" == refs/heads/main ]] || fail "Main operations require the main branch."
case "${GITHUB_EVENT_NAME:-}" in
  push) ;;
  workflow_dispatch)
    [[ "${KQ_ACCEPTANCE_REVISION:-}" =~ ^[a-f0-9]{40}$ ]] || fail "Acceptance retry requires a full deployed revision." ;;
  *) fail "Main operations require a main push or explicit acceptance retry." ;;
esac
[[ "${MAIN_SSH_HOST:-}" =~ ^[A-Za-z0-9][A-Za-z0-9.:-]*$ ]] || fail "Invalid MAIN_SSH_HOST."
[[ "${MAIN_SSH_USER:-}" =~ ^[a-zA-Z_][a-zA-Z0-9_-]*$ ]] || fail "Invalid MAIN_SSH_USER."
[[ "${MAIN_SSH_PORT:-}" =~ ^[0-9]{1,5}$ ]] || fail "Invalid MAIN_SSH_PORT."
(( 10#$MAIN_SSH_PORT >= 1 && 10#$MAIN_SSH_PORT <= 65535 )) || fail "Invalid MAIN_SSH_PORT."
[[ -n "${MAIN_SSH_KEY:-}" ]] || fail "Missing MAIN_SSH_KEY."
[[ -n "${RUNNER_TEMP:-}" ]] || fail "This command requires an Actions runner."
[[ "${GITHUB_SHA:-}" =~ ^[a-f0-9]{40}$ ]] || fail "Invalid GITHUB_SHA."
[[ "${GITHUB_REPOSITORY:-}" =~ ^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$ ]] || fail "Invalid GITHUB_REPOSITORY."

state="$(mktemp -d "$RUNNER_TEMP/kq-main-deploy.XXXXXX")"
trap 'rm -rf -- "$state"' EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
printf '%s\n' "$MAIN_SSH_KEY" > "$state/id"
chmod 600 "$state/id"
unset MAIN_SSH_KEY

ssh_command=(ssh -T -i "$state/id" -p "$MAIN_SSH_PORT" -l "$MAIN_SSH_USER"
  -o BatchMode=yes -o IdentitiesOnly=yes -o ConnectTimeout=15
  -o StrictHostKeyChecking=accept-new -o UserKnownHostsFile="$state/known_hosts"
  -o ServerAliveInterval=30 -o ServerAliveCountMax=3 "$MAIN_SSH_HOST")

if [[ "$GITHUB_EVENT_NAME" == workflow_dispatch ]]; then
  "${ssh_command[@]}" "cd /opt/deploy && /opt/deploy/run.sh acceptance --expected-revision '$KQ_ACCEPTANCE_REVISION'" < /dev/null
  exit 0
fi

source_dir="$(cd "$(dirname "$0")" && pwd)"
[[ -f "$source_dir/compose.yml" && ! -L "$source_dir/compose.yml" ]] || fail "Missing main compose.yml."
files=(compose.yml)
if [[ -e "$source_dir/env.example" ]]; then
  [[ -f "$source_dir/env.example" && ! -L "$source_dir/env.example" ]] || fail "Invalid env.example."
  files+=(env.example)
fi

owner="${GITHUB_REPOSITORY%%/*}"
images=()
for component in server registry web db-migrate; do
  image="ghcr.io/${owner,,}/kuintessence-$component:main"
  docker pull --platform linux/amd64 "$image"
  identity="$(docker image inspect --format '{{.Os}}/{{.Architecture}} {{index .Config.Labels "org.opencontainers.image.revision"}} {{index .Config.Labels "org.opencontainers.image.source"}}' "$image")"
  [[ "$identity" == "linux/amd64 $GITHUB_SHA ${GITHUB_SERVER_URL:-https://github.com}/$GITHUB_REPOSITORY" ]] ||
    fail "Published image does not match this build: $image"
  layers="$(docker image inspect --format '{{json .RootFS.Layers}}' "$image")"
  printf '%s %s %s\n' "$image" "$identity" "$layers" >> "$state/images.identities"
  images+=("$image")
done
docker save "${images[@]}" | gzip -1 > "$state/images.tar.gz"
(cd "$state" && sha256sum images.tar.gz > images.sha256)
printf '%s\n' "$GITHUB_SHA" > "$state/revision"

# Accept the first host key for this job; keep it in the private temporary state.
tar -C "$source_dir" -cf - "${files[@]}" -C "$state" images.tar.gz images.sha256 images.identities revision |
  "${ssh_command[@]}" '
set -eu
umask 077
mkdir -p /opt/deploy
cd /opt/deploy
test -x /opt/deploy/run.sh
stage=$(mktemp -d /opt/deploy/.main-deploy.XXXXXX)
trap '\''rm -rf -- "$stage"'\'' EXIT
tar -xf - -C "$stage"
test -f "$stage/compose.yml"
(cd "$stage" && sha256sum --check images.sha256)
docker load -i "$stage/images.tar.gz"
# Docker stores can expose a config or manifest digest as Id; compare portable content instead.
while read -r image expected_identity; do
  actual_identity=$(docker image inspect --format '\''{{.Os}}/{{.Architecture}} {{index .Config.Labels "org.opencontainers.image.revision"}} {{index .Config.Labels "org.opencontainers.image.source"}} {{json .RootFS.Layers}}'\'' "$image")
  if [ "$actual_identity" != "$expected_identity" ]; then
    printf "Loaded image content does not match this build: %s\n" "$image" >&2
    exit 1
  fi
done < "$stage/images.identities"
revision=$(cat "$stage/revision")
mv -f "$stage/compose.yml" /opt/deploy/compose.yml
if [ -f "$stage/env.example" ]; then
  mv -f "$stage/env.example" /opt/deploy/env.example
fi
/opt/deploy/run.sh deploy --expected-revision "$revision"
'
