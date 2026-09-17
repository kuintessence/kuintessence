#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat <<'EOF'
Usage:
  bash deploy/netdrive-smoke.sh [env-file]

Environment:
  KQ_NETDRIVE_SMOKE_API_BASE
      Full Server API base URL. Defaults to http://localhost:3010/api.
  KQ_NETDRIVE_SMOKE_BASE_URL
      Server root URL. /api is appended unless already present.
  KQ_NETDRIVE_SMOKE_SERVER_PORT
      Server HTTP port used when neither URL is provided. Defaults to 3010.
  KQ_NETDRIVE_SMOKE_EMAIL
      Dev login email. Defaults to netdrive-smoke@e2e.test.
  KQ_NETDRIVE_SMOKE_ROLE
      Dev login role. Defaults to platform_admin.
  KQ_NETDRIVE_SMOKE_PREFIX
      NetDrive path prefix. Defaults to smoke/netdrive-<timestamp>.
  KQ_NETDRIVE_SMOKE_MULTIPART_SIZE_BYTES
      Multipart object size. Defaults to 6291456 (6 MiB).
  KQ_NETDRIVE_SMOKE_REQUIRE_MULTIPART_PARTS
      Require the multipart upload to use at least 2 S3 parts. Defaults to false.
  KQ_NETDRIVE_SMOKE_KEEP_FILES
      Keep committed NetDrive files instead of deleting them at exit. Defaults to false.

Examples:
  bash deploy/netdrive-smoke.sh
  KQ_NETDRIVE_SMOKE_API_BASE=http://localhost:13000/api bash deploy/netdrive-smoke.sh
  KQ_NETDRIVE_SMOKE_MULTIPART_SIZE_BYTES=68157440 \
    KQ_NETDRIVE_SMOKE_REQUIRE_MULTIPART_PARTS=true \
    bash deploy/netdrive-smoke.sh
EOF
}

if [[ "${1:-}" == "-h" || "${1:-}" == "--help" ]]; then
  usage
  exit 0
fi

if [[ "${1:-}" != "" ]]; then
  env_file="${1}"
  if [[ ! -f "${env_file}" ]]; then
    echo "env file not found: ${env_file}" >&2
    exit 1
  fi
  set -a
  # shellcheck disable=SC1090
  source "${env_file}"
  set +a
fi

if ! command -v curl >/dev/null 2>&1; then
  echo "curl is required" >&2
  exit 1
fi

if ! command -v bun >/dev/null 2>&1; then
  echo "bun is required" >&2
  exit 1
fi

if ! command -v shasum >/dev/null 2>&1; then
  echo "shasum is required" >&2
  exit 1
fi

if [[ -n "${KQ_NETDRIVE_SMOKE_API_BASE:-}" ]]; then
  api_base="${KQ_NETDRIVE_SMOKE_API_BASE%/}"
else
  base_url="${KQ_NETDRIVE_SMOKE_BASE_URL:-http://localhost:${KQ_NETDRIVE_SMOKE_SERVER_PORT:-3010}}"
  api_base="${base_url%/}"
  if [[ "${api_base}" != */api ]]; then
    api_base="${api_base}/api"
  fi
fi

email="${KQ_NETDRIVE_SMOKE_EMAIL:-netdrive-smoke@e2e.test}"
role="${KQ_NETDRIVE_SMOKE_ROLE:-platform_admin}"
prefix="${KQ_NETDRIVE_SMOKE_PREFIX:-smoke/netdrive-$(date +%Y%m%d%H%M%S)}"
multipart_size="${KQ_NETDRIVE_SMOKE_MULTIPART_SIZE_BYTES:-6291456}"
require_multipart_parts="${KQ_NETDRIVE_SMOKE_REQUIRE_MULTIPART_PARTS:-false}"
keep_files="${KQ_NETDRIVE_SMOKE_KEEP_FILES:-false}"

tmp_dir="$(mktemp -d /tmp/kq-netdrive-smoke.XXXXXX)"
token=""
created_file_ids=()
pending_multipart_storage_key=""
pending_multipart_upload_id=""
pending_multipart_commit_token=""

cleanup() {
  if [[ -n "${token}" && -n "${pending_multipart_storage_key}" && -n "${pending_multipart_upload_id}" && -n "${pending_multipart_commit_token}" ]]; then
    local abort_payload
    abort_payload="$(
      KQ_STORAGE_KEY="${pending_multipart_storage_key}" KQ_UPLOAD_ID="${pending_multipart_upload_id}" KQ_COMMIT_TOKEN="${pending_multipart_commit_token}" bun -e '
        process.stdout.write(JSON.stringify({
          storageKey: process.env.KQ_STORAGE_KEY,
          uploadId: process.env.KQ_UPLOAD_ID,
          commitToken: process.env.KQ_COMMIT_TOKEN,
        }));
      '
    )"
    curl -fsS -X DELETE "${api_base}/netdrive/uploads/multipart" \
      -H "Authorization: Bearer ${token}" \
      -H "Content-Type: application/json" \
      --data "${abort_payload}" >/dev/null 2>&1 || true
  fi
  if [[ "${keep_files}" != "true" && -n "${token}" ]]; then
    for file_id in "${created_file_ids[@]}"; do
      curl -fsS -X DELETE "${api_base}/netdrive/files/${file_id}" \
        -H "Authorization: Bearer ${token}" >/dev/null 2>&1 || true
    done
  fi
  rm -rf "${tmp_dir}"
}
trap cleanup EXIT

json_get() {
  local expr="$1"
  KQ_JSON_EXPR="${expr}" bun -e '
    const fs = require("node:fs");
    const data = JSON.parse(fs.readFileSync(0, "utf8"));
    const value = Function("data", `return (${process.env.KQ_JSON_EXPR});`)(data);
    if (value === undefined || value === null) {
      process.exit(2);
    }
    process.stdout.write(typeof value === "string" ? value : JSON.stringify(value));
  '
}

api_json() {
  local method="$1"
  local path="$2"
  local body="${3:-}"
  if [[ -n "${body}" ]]; then
    curl -fsS -X "${method}" "${api_base}${path}" \
      -H "Authorization: Bearer ${token}" \
      -H "Content-Type: application/json" \
      --data "${body}"
  else
    curl -fsS -X "${method}" "${api_base}${path}" \
      -H "Authorization: Bearer ${token}"
  fi
}

api_get() {
  local path="$1"
  curl -fsS "${api_base}${path}" -H "Authorization: Bearer ${token}"
}

sha256_file() {
  shasum -a 256 "$1" | awk '{print $1}'
}

file_size() {
  wc -c <"$1" | tr -d '[:space:]'
}

process_authz_outbox() {
  curl -fsS -X POST "${api_base}/admin/authz/outbox/process" \
    -H "Authorization: Bearer ${token}" >/dev/null 2>&1 || true
}

verify_health() {
  local health_json
  health_json="$(curl -fsS "${api_base}/health")"
  json_get 'data.status ?? data?.data?.status' <<<"${health_json}" | grep -qx "ok"
}

login() {
  local payload login_json
  payload="$(
    KQ_EMAIL="${email}" KQ_ROLE="${role}" bun -e '
      process.stdout.write(JSON.stringify({ email: process.env.KQ_EMAIL, role: process.env.KQ_ROLE }));
    '
  )"
  login_json="$(curl -fsS -X POST "${api_base}/auth/login" -H "Content-Type: application/json" --data "${payload}")"
  token="$(json_get 'data.token' <<<"${login_json}")"
}

verify_download_hash() {
  local file_id="$1"
  local expected_file="$2"
  local label="$3"
  local mint_json download_url downloaded expected_sha downloaded_sha
  mint_json="$(api_get "/netdrive/files/${file_id}/download-url")"
  download_url="$(json_get 'data.data.downloadUrl' <<<"${mint_json}")"
  downloaded="${tmp_dir}/${label}.downloaded"
  curl -fsS "${download_url}" -o "${downloaded}"
  expected_sha="$(sha256_file "${expected_file}")"
  downloaded_sha="$(sha256_file "${downloaded}")"
  if [[ "${downloaded_sha}" != "${expected_sha}" ]]; then
    echo "${label}: downloaded sha256 ${downloaded_sha}, expected ${expected_sha}" >&2
    exit 1
  fi
}

assert_file_listed() {
  local file_id="$1"
  local list_json
  list_json="$(api_get "/netdrive/files?prefix=${prefix}")"
  KQ_FILE_ID="${file_id}" bun -e '
    const fs = require("node:fs");
    const data = JSON.parse(fs.readFileSync(0, "utf8"));
    const files = data?.data?.files ?? [];
    if (!files.some((file) => file.id === process.env.KQ_FILE_ID)) {
      console.error(`file ${process.env.KQ_FILE_ID} was not returned by prefix list`);
      process.exit(1);
    }
  ' <<<"${list_json}"
}

commit_single_upload() {
  local source_file="$1"
  local path="$2"
  local size sha256 payload mint_json upload_url storage_key commit_token commit_payload commit_json file_id
  size="$(file_size "${source_file}")"
  sha256="$(sha256_file "${source_file}")"
  payload="$(
    KQ_PATH="${path}" KQ_SIZE="${size}" KQ_SHA="${sha256}" bun -e '
      process.stdout.write(JSON.stringify({
        path: process.env.KQ_PATH,
        size: Number(process.env.KQ_SIZE),
        sha256: process.env.KQ_SHA,
        contentType: "text/plain",
      }));
    '
  )"
  mint_json="$(api_json POST "/netdrive/upload-url" "${payload}")"
  upload_url="$(json_get 'data.data.uploadUrl' <<<"${mint_json}")"
  storage_key="$(json_get 'data.data.storageKey' <<<"${mint_json}")"
  commit_token="$(json_get 'data.data.commitToken' <<<"${mint_json}")"
  curl -fsS -X PUT "${upload_url}" -H "Content-Type: text/plain" --data-binary "@${source_file}" >/dev/null
  commit_payload="$(
    KQ_PATH="${path}" KQ_SIZE="${size}" KQ_SHA="${sha256}" KQ_STORAGE_KEY="${storage_key}" KQ_COMMIT_TOKEN="${commit_token}" bun -e '
      process.stdout.write(JSON.stringify({
        path: process.env.KQ_PATH,
        size: Number(process.env.KQ_SIZE),
        sha256: process.env.KQ_SHA,
        contentType: "text/plain",
        storageKey: process.env.KQ_STORAGE_KEY,
        commitToken: process.env.KQ_COMMIT_TOKEN,
      }));
    '
  )"
  commit_json="$(api_json POST "/netdrive/files" "${commit_payload}")"
  file_id="$(json_get 'data.data.id' <<<"${commit_json}")"
  created_file_ids+=("${file_id}")
  process_authz_outbox
  assert_file_listed "${file_id}"
  verify_download_hash "${file_id}" "${source_file}" "single-upload"
  echo "single upload OK: ${path} (${file_id})"
}

generate_binary_file() {
  local target="$1"
  local size="$2"
  KQ_TARGET="${target}" KQ_SIZE="${size}" bun -e '
    const fs = require("node:fs");
    const target = process.env.KQ_TARGET;
    const size = Number(process.env.KQ_SIZE);
    if (!target || !Number.isSafeInteger(size) || size <= 0) {
      throw new Error("invalid generated file target or size");
    }
    const fd = fs.openSync(target, "w");
    const chunk = Buffer.alloc(Math.min(1024 * 1024, size));
    for (let i = 0; i < chunk.length; i += 1) {
      chunk[i] = (i * 31 + 17) % 251;
    }
    let remaining = size;
    try {
      while (remaining > 0) {
        const len = Math.min(chunk.length, remaining);
        fs.writeSync(fd, chunk, 0, len);
        remaining -= len;
      }
    } finally {
      fs.closeSync(fd);
    }
  '
}

upload_multipart_parts() {
  local source_file="$1"
  local part_size="$2"
  local part_urls_json="$3"
  KQ_SOURCE_FILE="${source_file}" KQ_PART_SIZE="${part_size}" KQ_PART_URLS_JSON="${part_urls_json}" bun -e '
    const fs = require("node:fs/promises");
    const filePath = process.env.KQ_SOURCE_FILE;
    const partSize = Number(process.env.KQ_PART_SIZE);
    const urls = JSON.parse(process.env.KQ_PART_URLS_JSON).data.urls ?? [];
    if (!filePath || !Number.isSafeInteger(partSize) || partSize <= 0 || urls.length === 0) {
      throw new Error("invalid multipart upload input");
    }
    const byPart = new Map(urls.map((entry) => [entry.partNumber, entry.url]));
    const stat = await fs.stat(filePath);
    const fh = await fs.open(filePath, "r");
    const parts = [];
    try {
      for (let partNumber = 1; partNumber <= Math.ceil(stat.size / partSize); partNumber += 1) {
        const offset = (partNumber - 1) * partSize;
        const len = Math.min(partSize, stat.size - offset);
        const buf = Buffer.alloc(len);
        await fh.read(buf, 0, len, offset);
        const url = byPart.get(partNumber);
        if (!url) {
          throw new Error(`missing presigned URL for part ${partNumber}`);
        }
        const res = await fetch(url, {
          method: "PUT",
          body: buf,
          headers: {
            "Content-Type": "application/octet-stream",
            "Content-Length": String(buf.byteLength),
            Connection: "close",
          },
        });
        if (!res.ok) {
          throw new Error(`part ${partNumber} upload failed with HTTP ${res.status}`);
        }
        const etag = (res.headers.get("etag") ?? "").replace(/^"|"$/g, "");
        if (!etag) {
          throw new Error(`part ${partNumber} upload did not return an ETag`);
        }
        parts.push({ partNumber, etag });
      }
    } finally {
      await fh.close();
    }
    process.stdout.write(JSON.stringify(parts));
  '
}

commit_multipart_upload() {
  local source_file="$1"
  local path="$2"
  local size sha256 init_payload init_json storage_key upload_id commit_token part_size part_count part_numbers part_payload part_urls_json parts_json list_payload list_json listed_count complete_payload complete_json file_id
  size="$(file_size "${source_file}")"
  sha256="$(sha256_file "${source_file}")"
  init_payload="$(
    KQ_PATH="${path}" KQ_SIZE="${size}" bun -e '
      process.stdout.write(JSON.stringify({
        path: process.env.KQ_PATH,
        size: Number(process.env.KQ_SIZE),
        contentType: "application/octet-stream",
      }));
    '
  )"
  init_json="$(api_json POST "/netdrive/uploads/multipart" "${init_payload}")"
  storage_key="$(json_get 'data.data.storageKey' <<<"${init_json}")"
  upload_id="$(json_get 'data.data.uploadId' <<<"${init_json}")"
  commit_token="$(json_get 'data.data.commitToken' <<<"${init_json}")"
  pending_multipart_storage_key="${storage_key}"
  pending_multipart_upload_id="${upload_id}"
  pending_multipart_commit_token="${commit_token}"
  part_size="$(json_get 'data.data.partSize' <<<"${init_json}")"
  part_count="$(
    KQ_SIZE="${size}" KQ_PART_SIZE="${part_size}" bun -e '
      console.log(Math.max(1, Math.ceil(Number(process.env.KQ_SIZE) / Number(process.env.KQ_PART_SIZE))));
    '
  )"
  if [[ "${require_multipart_parts}" == "true" && "${part_count}" -lt 2 ]]; then
    echo "multipart upload used ${part_count} part; increase KQ_NETDRIVE_SMOKE_MULTIPART_SIZE_BYTES above partSize=${part_size}" >&2
    exit 1
  fi
  part_numbers="$(
    KQ_PART_COUNT="${part_count}" bun -e '
      const count = Number(process.env.KQ_PART_COUNT);
      process.stdout.write(JSON.stringify(Array.from({ length: count }, (_, i) => i + 1)));
    '
  )"
  part_payload="$(
    KQ_STORAGE_KEY="${storage_key}" KQ_UPLOAD_ID="${upload_id}" KQ_COMMIT_TOKEN="${commit_token}" KQ_PART_NUMBERS="${part_numbers}" bun -e '
      process.stdout.write(JSON.stringify({
        storageKey: process.env.KQ_STORAGE_KEY,
        uploadId: process.env.KQ_UPLOAD_ID,
        commitToken: process.env.KQ_COMMIT_TOKEN,
        partNumbers: JSON.parse(process.env.KQ_PART_NUMBERS),
      }));
    '
  )"
  part_urls_json="$(api_json POST "/netdrive/uploads/multipart/part-urls" "${part_payload}")"
  parts_json="$(upload_multipart_parts "${source_file}" "${part_size}" "${part_urls_json}")"
  list_payload="$(
    KQ_STORAGE_KEY="${storage_key}" KQ_UPLOAD_ID="${upload_id}" KQ_COMMIT_TOKEN="${commit_token}" bun -e '
      process.stdout.write(JSON.stringify({
        storageKey: process.env.KQ_STORAGE_KEY,
        uploadId: process.env.KQ_UPLOAD_ID,
        commitToken: process.env.KQ_COMMIT_TOKEN,
      }));
    '
  )"
  list_json="$(api_json POST "/netdrive/uploads/multipart/list-parts" "${list_payload}")"
  listed_count="$(json_get 'data.data.parts.length' <<<"${list_json}")"
  if [[ "${listed_count}" != "${part_count}" ]]; then
    echo "multipart list-parts returned ${listed_count}, expected ${part_count}" >&2
    exit 1
  fi
  complete_payload="$(
    KQ_PATH="${path}" KQ_SIZE="${size}" KQ_SHA="${sha256}" KQ_STORAGE_KEY="${storage_key}" KQ_UPLOAD_ID="${upload_id}" KQ_COMMIT_TOKEN="${commit_token}" KQ_PARTS="${parts_json}" bun -e '
      process.stdout.write(JSON.stringify({
        path: process.env.KQ_PATH,
        size: Number(process.env.KQ_SIZE),
        sha256: process.env.KQ_SHA,
        contentType: "application/octet-stream",
        storageKey: process.env.KQ_STORAGE_KEY,
        uploadId: process.env.KQ_UPLOAD_ID,
        commitToken: process.env.KQ_COMMIT_TOKEN,
        parts: JSON.parse(process.env.KQ_PARTS),
      }));
    '
  )"
  complete_json="$(api_json POST "/netdrive/uploads/multipart/complete" "${complete_payload}")"
  pending_multipart_storage_key=""
  pending_multipart_upload_id=""
  pending_multipart_commit_token=""
  file_id="$(json_get 'data.data.id' <<<"${complete_json}")"
  created_file_ids+=("${file_id}")
  process_authz_outbox
  assert_file_listed "${file_id}"
  verify_download_hash "${file_id}" "${source_file}" "multipart-upload"
  echo "multipart upload OK: ${path} (${file_id}, parts=${part_count}, partSize=${part_size})"
}

echo "Smoke target: ${api_base}"
echo "Login user: ${email} (${role})"
echo "NetDrive prefix: ${prefix}"

verify_health
login

single_file="${tmp_dir}/single.txt"
printf "kq netdrive smoke %s\n" "${prefix}" >"${single_file}"
commit_single_upload "${single_file}" "${prefix}/single.txt"

multipart_file="${tmp_dir}/multipart.bin"
generate_binary_file "${multipart_file}" "${multipart_size}"
commit_multipart_upload "${multipart_file}" "${prefix}/multipart.bin"

if [[ "${keep_files}" == "true" ]]; then
  echo "NetDrive smoke OK; kept files: ${created_file_ids[*]}"
else
  echo "NetDrive smoke OK; committed files will be deleted during cleanup"
fi
