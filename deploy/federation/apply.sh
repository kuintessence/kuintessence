#!/usr/bin/env bash
set -euo pipefail
umask 077

mode=${1:-}
revision=${2:-}
case "$mode" in direct|fabric) ;; *) echo 'Select direct or fabric.' >&2; exit 2 ;; esac
[[ "$revision" =~ ^[a-f0-9]{40}$ ]] || exit 2
root=/opt/kuintessence-federation
mkdir -p "$root/releases"
exec 9>"$root/deploy.lock"
flock -n 9 || { echo 'Another deployment is running.' >&2; exit 1; }
if [[ -e "$root/mode" && "$(cat "$root/mode")" != "$mode" ]]; then
  echo 'Changing federation mode requires an explicit maintenance procedure for in-flight work.' >&2
  exit 1
fi
export KQ_DEPLOY_ENV_FILE=/etc/kuintessence/deployment.env
[[ -f "$KQ_DEPLOY_ENV_FILE" ]] || { echo 'Provision /etc/kuintessence/deployment.env first.' >&2; exit 1; }
export KQ_IMAGE_TAG=sha-$revision
export COMPOSE_PROJECT_NAME=kuintessence-federation
source_root=$(cd "$(dirname "$0")/../.." && pwd)
release=$(mktemp -d "$root/releases/$revision.XXXXXX")
cp -R "$source_root/deploy" "$release/"
compose=(bash "$release/deploy/federation/compose.sh" "$mode")
"${compose[@]}" config --quiet
"${compose[@]}" pull --policy always
# Include the administrative tools image even though its profile is not started.
image_list=$("${compose[@]}" config --images)
if [[ "$mode" == fabric ]]; then
  image_list=$("${compose[@]}" --profile fabric-admin config --images)
  "${compose[@]}" --profile fabric-admin pull fabric-admin
fi
mapfile -t images <<< "$image_list"
for image in "${images[@]}"; do
  case "$image" in
    ghcr.io/*/kuintessence-*)
      actual=$(docker image inspect --format '{{index .Config.Labels "org.opencontainers.image.revision"}}' "$image")
      [[ "$actual" == "$revision" ]] || { echo 'Published image revision mismatch.' >&2; exit 1; } ;;
  esac
done
printf '%s\n' "$mode" > "$root/mode"
"${compose[@]}" up -d --no-build --pull never --wait --wait-timeout 300
printf '%s\n' "$mode" > "$release/mode"
printf '%s\n' "$revision" > "$release/revision"
rm -f "$root/.current-next"
ln -s "$release" "$root/.current-next"
mv -Tf "$root/.current-next" "$root/current"
printf 'Deployment ready: %s (%s)\n' "$revision" "$mode"
