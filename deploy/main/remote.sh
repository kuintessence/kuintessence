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

transport="${MAIN_IMAGE_TRANSPORT:-relay}"
[[ "$transport" == relay || "$transport" == archive ]] || fail "Invalid MAIN_IMAGE_TRANSPORT."

state="$(mktemp -d "$RUNNER_TEMP/kq-main-deploy.XXXXXX")"
relay_container=""
cleanup() {
  code=$?
  if [[ -S "$state/control" ]]; then
    "${ssh_control[@]}" -S "$state/control" -O exit "$MAIN_SSH_HOST" >/dev/null 2>&1 ||
      printf '%s\n' "Could not close the image relay SSH tunnel." >&2
  fi
  if [[ -n "$relay_container" ]]; then
    docker rm -fv "$relay_container" >/dev/null || printf '%s\n' "Could not remove the temporary image relay." >&2
  fi
  rm -rf -- "$state"
  return "$code"
}
trap cleanup EXIT
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
printf '%s\n' "$GITHUB_SHA" > "$state/revision"
printf '%s\n' "$transport" > "$state/transport"
transfer_files=(images.identities revision transport)
checksum_files=(images.identities revision transport)
if [[ "$transport" == relay ]]; then
  # Docker only requests missing registry blobs; the registry is reachable over SSH loopback.
  relay_container=$(docker run --detach --publish 127.0.0.1::5000 registry:2.8.3)
  local_port=$(docker port "$relay_container" 5000/tcp)
  local_port="${local_port##*:}"
  [[ "$local_port" =~ ^[0-9]{1,5}$ ]] || fail "Invalid local registry port."
  ready=false
  for _attempt in {1..20}; do
    if curl --fail --silent --max-time 2 "http://127.0.0.1:$local_port/v2/" > /dev/null; then
      ready=true
      break
    fi
    sleep 1
  done
  [[ "$ready" == true ]] || fail "Temporary image relay did not become ready."
  expanded_bytes=0
  for image in "${images[@]}"; do
    repository="${image#ghcr.io/}"
    relay_image="127.0.0.1:$local_port/${repository%:*}:sha-$GITHUB_SHA"
    docker tag "$image" "$relay_image"
    docker push "$relay_image"
    image_bytes=$(docker image inspect --format '{{.Size}}' "$image")
    [[ "$image_bytes" =~ ^[1-9][0-9]*$ ]] || fail "Invalid image size."
    expanded_bytes=$((expanded_bytes + image_bytes))
  done
  archive_kib=$(docker exec "$relay_container" du -sk /var/lib/registry | awk '{print $1}')
  [[ "$archive_kib" =~ ^[1-9][0-9]*$ ]] || fail "Invalid registry size."
  archive_bytes=$((archive_kib * 1024))
  ssh_control=("${ssh_command[@]:0:${#ssh_command[@]}-1}")
  "${ssh_control[@]}" -M -S "$state/control" -o ExitOnForwardFailure=yes -fNT "$MAIN_SSH_HOST"
  remote_port=$("${ssh_control[@]}" -S "$state/control" -O forward -R "127.0.0.1:0:127.0.0.1:$local_port" "$MAIN_SSH_HOST")
  [[ "$remote_port" =~ ^[0-9]{1,5}$ ]] && (( remote_port >= 1 && remote_port <= 65535 )) || fail "Invalid remote registry port."
  printf '%s\n' "$remote_port" > "$state/relay.port"
  for image in "${images[@]}"; do
    repository="${image#ghcr.io/}"
    printf '%s %s\n' "$image" "127.0.0.1:$remote_port/${repository%:*}:sha-$GITHUB_SHA" >> "$state/relay.images"
  done
  transfer_files+=(relay.port relay.images)
  checksum_files+=(relay.port relay.images)
else
  docker save "${images[@]}" | gzip -1 > "$state/images.tar.gz"
  (cd "$state" && sha256sum images.tar.gz > images.sha256)
  archive_bytes=$(wc -c < "$state/images.tar.gz")
  expanded_bytes=$(gzip -dc "$state/images.tar.gz" | wc -c)
  transfer_files+=(images.tar.gz images.sha256)
  checksum_files+=(images.sha256)
fi
"${ssh_command[@]}" "cd /opt/deploy && /opt/deploy/run.sh prepare-space --expected-revision '$GITHUB_SHA' --archive-bytes '$archive_bytes' --expanded-bytes '$expanded_bytes'" < /dev/null
(cd "$state" && sha256sum "${checksum_files[@]}" > delivery.sha256)
transfer_files+=(delivery.sha256)

# Accept the first host key for this job; keep it in the private temporary state.
tar -C "$source_dir" -cf - "${files[@]}" -C "$state" "${transfer_files[@]}" |
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
(cd "$stage" && sha256sum --check delivery.sha256)
transport=$(cat "$stage/transport")
if [ "$transport" = relay ]; then
  relay_port=$(cat "$stage/relay.port")
  listeners=$(ss -H -ltn "sport = :$relay_port")
  [ -n "$listeners" ] || exit 1
  printf "%s\n" "$listeners" | awk '\''{print $4}'\'' | while read -r address; do
    case "$address" in
      "127.0.0.1:$relay_port"|"[::1]:$relay_port") ;;
      *) printf "%s\n" "Image relay must listen only on loopback." >&2; exit 1 ;;
    esac
  done
  while read -r image relay_image; do
    docker pull --platform linux/amd64 "$relay_image"
    expected_identity=$(grep -F "$image " "$stage/images.identities")
    actual_identity=$(docker image inspect --format '\''{{.Os}}/{{.Architecture}} {{index .Config.Labels "org.opencontainers.image.revision"}} {{index .Config.Labels "org.opencontainers.image.source"}} {{json .RootFS.Layers}}'\'' "$relay_image")
    if [ "$image $actual_identity" != "$expected_identity" ]; then
      printf "Relayed image content does not match this build: %s\n" "$image" >&2
      exit 1
    fi
  done < "$stage/relay.images"
  while read -r image relay_image; do
    docker tag "$relay_image" "$image"
    docker image rm "$relay_image" > /dev/null
  done < "$stage/relay.images"
elif [ "$transport" = archive ]; then
  (cd "$stage" && sha256sum --check images.sha256)
  docker load -i "$stage/images.tar.gz"
else
  exit 1
fi
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
