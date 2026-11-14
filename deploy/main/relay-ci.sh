#!/usr/bin/env bash
set -euo pipefail
umask 077

# This endpoint is created only on an ephemeral Actions runner, never on a deployed site.
[[ "${GITHUB_ACTIONS:-}" == true && -n "${RUNNER_TEMP:-}" ]] || exit 1
source_dir="$(cd "$(dirname "$0")" && pwd)"
state=$(mktemp -d "$RUNNER_TEMP/kq-relay-ci.XXXXXX")
remote_root="/opt/kq-relay-ci-$$"
fixture_id=""
cleanup() {
  code=$?
  if [[ -f "$state/sshd.pid" ]]; then sudo kill "$(sudo cat "$state/sshd.pid")" || true; fi
  if [[ -n "$fixture_id" ]]; then docker image rm -f "$fixture_id" > /dev/null || true; fi
  sudo rm -rf -- "$remote_root"
  rm -rf -- "$state"
  return "$code"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
mkdir -p "$state/bin" "$state/source" "$state/runner"
sudo mkdir -p /run/sshd "$remote_root"
sudo chown "$(id -u):$(id -g)" "$remote_root"
ssh-keygen -q -t ed25519 -N '' -f "$state/host"
ssh-keygen -q -t ed25519 -N '' -f "$state/client"
port=$(python3 - <<'PY'
import socket
with socket.socket() as s:
    s.bind(('127.0.0.1', 0))
    print(s.getsockname()[1])
PY
)
cat > "$state/sshd.conf" <<CONF
HostKey $state/host
PidFile $state/sshd.pid
ListenAddress 127.0.0.1
Port $port
AuthorizedKeysFile $state/client.pub
StrictModes no
PasswordAuthentication no
KbdInteractiveAuthentication no
UsePAM yes
AllowUsers $(id -un)
AllowTcpForwarding yes
GatewayPorts no
CONF
sudo /usr/sbin/sshd -f "$state/sshd.conf" -E "$state/sshd.log"
cat > "$remote_root/run.sh" <<'STUB'
#!/bin/sh
set -eu
case "$1" in
  prepare-space) exit 0 ;;
  deploy) touch "$PWD/deployed" ;;
  *) exit 1 ;;
esac
STUB
chmod 700 "$remote_root/run.sh"
owner="kq-ci-relay-$$"
export KQ_RELAY_CI_OWNER="$owner"
export KQ_RELAY_CI_DOCKER
KQ_RELAY_CI_DOCKER=$(command -v docker)
cat > "$state/bin/docker" <<'WRAPPER'
#!/bin/sh
# The fixture has no public GHCR tag. Every registry and SSH operation below is real.
if [ "$1" = pull ]; then
  case "$4" in "ghcr.io/$KQ_RELAY_CI_OWNER/"*) exit 0 ;; esac
fi
if [ "$1" = save ]; then printf '%s\n' 'Relay must not export an archive.' >&2; exit 1; fi
exec "$KQ_RELAY_CI_DOCKER" "$@"
WRAPPER
chmod 700 "$state/bin/docker"
printf 'FROM busybox:1.37.0\n' | docker build --quiet \
  --label "org.opencontainers.image.revision=$GITHUB_SHA" \
  --label "org.opencontainers.image.source=https://github.com/$owner/fixture" \
  --iidfile "$state/image-id" - > /dev/null
fixture_id=$(cat "$state/image-id")
for component in server registry web db-migrate; do
  docker tag "$fixture_id" "ghcr.io/$owner/kuintessence-$component:main"
done
sed "s@/opt/deploy@$remote_root@g" "$source_dir/remote.sh" > "$state/source/remote.sh"
cp "$source_dir/compose.yml" "$source_dir/env.example" "$state/source/"
PATH="$state/bin:$PATH" RUNNER_TEMP="$state/runner" \
  GITHUB_EVENT_NAME=push GITHUB_REF=refs/heads/main GITHUB_REPOSITORY="$owner/fixture" \
  MAIN_IMAGE_TRANSPORT=relay MAIN_SSH_HOST=127.0.0.1 MAIN_SSH_PORT="$port" \
  MAIN_SSH_USER="$(id -un)" MAIN_SSH_KEY="$(cat "$state/client")" \
  bash "$state/source/remote.sh"
test -f "$remote_root/deployed"
printf '%s\n' 'Real SSH forwarding, registry layer reuse and image identity checks passed.'
