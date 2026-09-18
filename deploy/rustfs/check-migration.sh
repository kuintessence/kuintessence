#!/usr/bin/env bash
set -euo pipefail

project="${1:?Compose project name is required}"
if [[ "${KQ_RUSTFS_MIGRATION_VERIFIED:-false}" == "true" ]]; then
  echo "RustFS migration verification acknowledged for project ${project}"
  exit 0
fi

refuse() {
  echo "Legacy MinIO storage exists for Compose project ${project}; refusing to switch to RustFS." >&2
  echo "Migrate and verify objects, fixed version references, and retention first. See deploy/rustfs/README.md." >&2
  echo "Only after verification, set KQ_RUSTFS_MIGRATION_VERIFIED=true. Do not delete old volumes to bypass this check." >&2
  exit 1
}

containers="$(docker ps -aq \
  --filter "label=com.docker.compose.project=${project}" \
  --filter "label=com.docker.compose.service=minio")"
if [[ -n "$containers" ]]; then refuse; fi

for volume in minio-data minio_data scheduler-minio-data; do
  volumes="$(docker volume ls -q \
    --filter "label=com.docker.compose.project=${project}" \
    --filter "label=com.docker.compose.volume=${volume}")"
  if [[ -n "$volumes" ]]; then refuse; fi
done
