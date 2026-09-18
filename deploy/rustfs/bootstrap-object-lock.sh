#!/usr/bin/env sh
set -eu
umask 077
work_dir="$(mktemp -d)"
trap 'rm -rf "$work_dir"' EXIT
trap 'exit 129' HUP
trap 'exit 130' INT
trap 'exit 143' TERM
export RC_CONFIG_DIR="${work_dir}/config"

netdrive_bucket="${NETDRIVE_BUCKET:-kq-netdrive}"
staging_bucket="${DATA_MARKET_STAGING_BUCKET:-kq-data-market-staging}"
immutable_bucket="${DATA_MARKET_IMMUTABLE_BUCKET:-kq-data-market-immutable}"
retention_days="${DATA_MARKET_IMMUTABLE_RETENTION_DAYS:-365}"
staging_expiry_days="${DATA_MARKET_STAGING_EXPIRY_DAYS:-1}"

case "${retention_days}" in
  "" | *[!0-9]* | 0)
    echo "DATA_MARKET_IMMUTABLE_RETENTION_DAYS must be a positive integer" >&2
    exit 1
    ;;
esac
case "${staging_expiry_days}" in
  "" | *[!0-9]* | 0)
    echo "DATA_MARKET_STAGING_EXPIRY_DAYS must be a positive integer" >&2
    exit 1
    ;;
esac
if [ "${staging_bucket}" = "${immutable_bucket}" ]; then
  echo "DATA_MARKET_STAGING_BUCKET must differ from DATA_MARKET_IMMUTABLE_BUCKET" >&2
  exit 1
fi
if [ "${netdrive_bucket}" = "${staging_bucket}" ] || [ "${netdrive_bucket}" = "${immutable_bucket}" ]; then
  echo "NETDRIVE_BUCKET must differ from Data Market buckets" >&2
  exit 1
fi

: "${RUSTFS_ENDPOINT:?RUSTFS_ENDPOINT is required}"
: "${RUSTFS_ACCESS_KEY:?RUSTFS_ACCESS_KEY is required}"
: "${RUSTFS_SECRET_KEY:?RUSTFS_SECRET_KEY is required}"
committer_access_key="${DATA_MARKET_COMMITTER_ACCESS_KEY:-kq-data-market-committer}"
: "${DATA_MARKET_COMMITTER_SECRET_KEY:?DATA_MARKET_COMMITTER_SECRET_KEY is required}"
if [ "${committer_access_key}" = "${RUSTFS_ACCESS_KEY}" ]; then
  echo "DATA_MARKET_COMMITTER_ACCESS_KEY must not be RUSTFS_ACCESS_KEY" >&2
  exit 1
fi
ready_timeout_seconds="${RUSTFS_READY_TIMEOUT_SECONDS:-300}"

case "${ready_timeout_seconds}" in
  "" | *[!0-9]* | 0)
    echo "RUSTFS_READY_TIMEOUT_SECONDS must be a positive integer" >&2
    exit 1
    ;;
esac

rc alias set local "${RUSTFS_ENDPOINT}" "${RUSTFS_ACCESS_KEY}" "${RUSTFS_SECRET_KEY}" >/dev/null
elapsed_seconds=0
until rc ready local >/dev/null 2>&1; do
  if [ "${elapsed_seconds}" -ge "${ready_timeout_seconds}" ]; then
    echo "RustFS did not become ready within ${ready_timeout_seconds} seconds" >&2
    exit 1
  fi
  sleep 2
  elapsed_seconds=$((elapsed_seconds + 2))
done

rc mb --ignore-existing "local/${netdrive_bucket}" >/dev/null
rc mb --ignore-existing "local/${staging_bucket}" >/dev/null
rc mb --ignore-existing --with-lock "local/${immutable_bucket}" >/dev/null
rc version enable "local/${immutable_bucket}" >/dev/null
rc retention set --default compliance "${retention_days}d" "local/${immutable_bucket}" >/dev/null
rc --json retention info --default "local/${immutable_bucket}" >"${work_dir}/retention.json"
if ! jq -e --arg bucket "${immutable_bucket}" --argjson days "${retention_days}" '
  .status == "success" and .type == "locks" and
  (.data.items | length) == 1 and
  .data.items[0].bucket == $bucket and
  .data.items[0].object_lock_enabled == true and
  .data.items[0].default_retention.mode == "compliance" and
  .data.items[0].default_retention.duration == {"unit": "days", "value": $days}
' "${work_dir}/retention.json" >/dev/null; then
  echo "DATA_MARKET_IMMUTABLE_BUCKET must support COMPLIANCE Object Lock" >&2
  exit 1
fi

cat >"${work_dir}/cors.xml" <<'EOF'
<CORSConfiguration>
  <CORSRule>
    <AllowedOrigin>*</AllowedOrigin>
    <AllowedMethod>GET</AllowedMethod>
    <AllowedMethod>PUT</AllowedMethod>
    <AllowedMethod>HEAD</AllowedMethod>
    <AllowedHeader>*</AllowedHeader>
    <ExposeHeader>ETag</ExposeHeader>
    <MaxAgeSeconds>3600</MaxAgeSeconds>
  </CORSRule>
</CORSConfiguration>
EOF
configure_cors() {
  bucket="$1"
  if ! rc cors set "local/${bucket}" "${work_dir}/cors.xml" >/dev/null; then
    echo "Warning: unable to configure bucket CORS for ${bucket}; configure and verify equivalent browser CORS separately" >&2
  fi
}

configure_cors "${netdrive_bucket}"
configure_cors "${staging_bucket}"
configure_cors "${immutable_bucket}"
cat >"${work_dir}/lifecycle.json" <<EOF
{
  "Rules": [
    {
      "ID": "kq-data-market-staging-expiry",
      "Status": "Enabled",
      "Filter": {"Prefix": "data-market/staging/"},
      "Expiration": {"Days": ${staging_expiry_days}}
    }
  ]
}
EOF
rc ilm rule import "local/${staging_bucket}" "${work_dir}/lifecycle.json" >/dev/null

cat >"${work_dir}/policy.json" <<EOF
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Sid": "AllowNetDriveAndStagingOperations",
      "Effect": "Allow",
      "Action": [
        "s3:GetBucketLocation",
        "s3:ListBucket",
        "s3:GetObject",
        "s3:PutObject",
        "s3:DeleteObject",
        "s3:AbortMultipartUpload",
        "s3:ListMultipartUploadParts",
        "s3:GetBucketObjectLockConfiguration"
      ],
      "Resource": [
        "arn:aws:s3:::${netdrive_bucket}",
        "arn:aws:s3:::${netdrive_bucket}/*",
        "arn:aws:s3:::${staging_bucket}",
        "arn:aws:s3:::${staging_bucket}/*"
      ]
    },
    {
      "Sid": "ReadImmutableBucketControls",
      "Effect": "Allow",
      "Action": [
        "s3:GetBucketLocation",
        "s3:ListBucket",
        "s3:GetBucketVersioning",
        "s3:GetBucketObjectLockConfiguration"
      ],
      "Resource": "arn:aws:s3:::${immutable_bucket}"
    },
    {
      "Sid": "AllowStagingCopyWithCompliance",
      "Effect": "Allow",
      "Action": "s3:PutObject",
      "Resource": "arn:aws:s3:::${immutable_bucket}/data-market/immutable/*",
      "Condition": {
        "StringLike": {
          "s3:x-amz-copy-source": "${staging_bucket}/data-market/staging/*"
        },
        "StringEquals": {
          "s3:object-lock-mode": "COMPLIANCE"
        }
      }
    },
    {
      "Sid": "AllowImmutableVersionReadsAndRetention",
      "Effect": "Allow",
      "Action": [
        "s3:GetObject",
        "s3:GetObjectVersion",
        "s3:GetObjectRetention",
        "s3:PutObjectRetention"
      ],
      "Resource": "arn:aws:s3:::${immutable_bucket}/data-market/immutable/*"
    },
    {
      "Sid": "DenyImmutableDeletes",
      "Effect": "Deny",
      "Action": ["s3:DeleteObject", "s3:DeleteObjectVersion"],
      "Resource": "arn:aws:s3:::${immutable_bucket}/data-market/immutable/*"
    }
  ]
}
EOF
rc admin user add local "${committer_access_key}" "${DATA_MARKET_COMMITTER_SECRET_KEY}" >/dev/null
rc admin policy create local kq-data-market-committer-policy "${work_dir}/policy.json" >/dev/null
rc admin policy attach local kq-data-market-committer-policy --user "${committer_access_key}" >/dev/null
rc --json admin user info local "${committer_access_key}" >"${work_dir}/user.json"
if ! jq -e --arg key "${committer_access_key}" '
  .accessKey == $key and .status == "enabled" and
  (.policies | index("kq-data-market-committer-policy")) != null
' "${work_dir}/user.json" >/dev/null; then
  echo "Data Market committer IAM policy was not attached" >&2
  exit 1
fi
