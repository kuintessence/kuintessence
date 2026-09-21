#!/usr/bin/env bash
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$root"
name="kq-rustfs-ci-$(openssl rand -hex 6)"
image="${name}:test"
export KQ_DATA_MARKET_COMMITTER_SECRET_KEY
KQ_DATA_MARKET_COMMITTER_SECRET_KEY="$(openssl rand -hex 24)"

cleanup() {
  docker rm -fv "$name" >/dev/null 2>&1 || true
  docker image rm "$image" >/dev/null 2>&1 || true
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

for profile in dev schedulers aio; do
  docker compose --project-directory . --env-file /dev/null \
    -f "deploy/compose/docker-compose.${profile}.yml" config --quiet
done
docker compose --project-directory . --env-file /dev/null \
  -f deploy/compose/docker-compose.yml config --quiet
docker compose --env-file /dev/null -f examples/docker-compose.demo.yml config --quiet

docker build -t "$image" -f deploy/aio/Dockerfile .
docker run -d --name "$name" \
  --env DATA_MARKET_COMMITTER_SECRET_KEY="$KQ_DATA_MARKET_COMMITTER_SECRET_KEY" \
  --env NODE_ENV=development --env AUTHZ_MODE=off \
  "$image" >/dev/null

for ((attempt = 0; attempt < 90; attempt++)); do
  state="$(docker inspect -f '{{.State.Status}}' "$name")"
  health="$(docker inspect -f '{{if .State.Health}}{{.State.Health.Status}}{{end}}' "$name")"
  if [ "$health" = healthy ]; then
    echo "RustFS AIO: storage bootstrap, Server, Registry, and Web are healthy"
    exit 0
  fi
  if [ "$state" != running ] || [ "$health" = unhealthy ]; then
    echo "RustFS AIO failed: state=$state health=$health" >&2
    docker logs --tail 80 "$name"
    exit 1
  fi
  sleep 2
done
echo "RustFS AIO did not become healthy within 180 seconds" >&2
docker logs --tail 80 "$name"
exit 1
