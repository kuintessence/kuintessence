#!/usr/bin/env bash
set -euo pipefail

source_dir="${1:-/workspace}"
node_modules_dir="${2:-${source_dir}/node_modules}"
work_dir="$(mktemp -d /tmp/kq-agent-deps.XXXXXX)"

cleanup() {
  rm -rf "${work_dir}"
}
trap cleanup EXIT

if [[ ! -f "${source_dir}/package.json" || ! -d "${source_dir}/packages/agent" ]]; then
  echo "${source_dir} must contain the Kuintessence repository" >&2
  exit 2
fi

mkdir -p "${node_modules_dir}"
find "${node_modules_dir}" -mindepth 1 -maxdepth 1 -exec rm -rf {} +

tar \
  --exclude="./.git" \
  --exclude="./node_modules" \
  --exclude="./temp" \
  --exclude="./**/dist" \
  -cf - \
  -C "${source_dir}" \
  . | tar -xf - -C "${work_dir}"

cd "${work_dir}"
bun install --frozen-lockfile --ignore-scripts --backend=copyfile
tar -cf - -C "${work_dir}/node_modules" . | tar --overwrite -xf - -C "${node_modules_dir}"
