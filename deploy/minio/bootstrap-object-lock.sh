#!/usr/bin/env sh
set -eu

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

: "${MINIO_ENDPOINT:?MINIO_ENDPOINT is required}"
: "${MINIO_ROOT_USER:?MINIO_ROOT_USER is required}"
: "${MINIO_ROOT_PASSWORD:?MINIO_ROOT_PASSWORD is required}"
committer_access_key="${DATA_MARKET_COMMITTER_ACCESS_KEY:-kq-data-market-committer}"
: "${DATA_MARKET_COMMITTER_SECRET_KEY:?DATA_MARKET_COMMITTER_SECRET_KEY is required}"
if [ "${committer_access_key}" = "${MINIO_ROOT_USER}" ]; then
  echo "DATA_MARKET_COMMITTER_ACCESS_KEY must not be MINIO_ROOT_USER" >&2
  exit 1
fi
ready_timeout_seconds="${MINIO_READY_TIMEOUT_SECONDS:-300}"

case "${ready_timeout_seconds}" in
  "" | *[!0-9]* | 0)
    echo "MINIO_READY_TIMEOUT_SECONDS must be a positive integer" >&2
    exit 1
    ;;
esac

mc alias set local "${MINIO_ENDPOINT}" "${MINIO_ROOT_USER}" "${MINIO_ROOT_PASSWORD}" >/dev/null
elapsed_seconds=0
until mc ready local >/dev/null 2>&1; do
  if [ "${elapsed_seconds}" -ge "${ready_timeout_seconds}" ]; then
    echo "MinIO did not become ready within ${ready_timeout_seconds} seconds" >&2
    exit 1
  fi
  sleep 2
  elapsed_seconds=$((elapsed_seconds + 2))
done

mc mb --ignore-existing "local/${netdrive_bucket}" >/dev/null
mc mb --ignore-existing "local/${staging_bucket}" >/dev/null
mc mb --ignore-existing --with-lock "local/${immutable_bucket}" >/dev/null
mc version enable "local/${immutable_bucket}" >/dev/null
mc retention set --default COMPLIANCE "${retention_days}d" "local/${immutable_bucket}" >/dev/null
case "$(mc retention info "local/${immutable_bucket}")" in
  *"Object locking 'COMPLIANCE' is configured"*) ;;
  *)
    echo "DATA_MARKET_IMMUTABLE_BUCKET must support COMPLIANCE Object Lock" >&2
    exit 1
    ;;
esac

cat >/tmp/kq-netdrive-cors.xml <<'EOF'
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
  if ! mc cors set "local/${bucket}" /tmp/kq-netdrive-cors.xml >/dev/null; then
    echo "Warning: unable to configure bucket CORS for ${bucket}; configure and verify equivalent browser CORS separately" >&2
  fi
}

configure_cors "${netdrive_bucket}"
configure_cors "${staging_bucket}"
configure_cors "${immutable_bucket}"
mc ilm rule add --expire-days "${staging_expiry_days}" --prefix "data-market/staging/" "local/${staging_bucket}" >/dev/null
cat >/tmp/kq-data-market-staging-lifecycle.json <<EOF
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
mc ilm rule import "local/${staging_bucket}" </tmp/kq-data-market-staging-lifecycle.json >/dev/null

cat >/tmp/kq-data-market-committer-policy.json <<EOF
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
mc admin user add local "${committer_access_key}" "${DATA_MARKET_COMMITTER_SECRET_KEY}" >/dev/null
mc admin policy create local kq-data-market-committer-policy /tmp/kq-data-market-committer-policy.json >/dev/null
mc admin policy attach local kq-data-market-committer-policy --user "${committer_access_key}" >/dev/null
case "$(mc admin user info local "${committer_access_key}")" in
  *"kq-data-market-committer-policy"*) ;;
  *)
    echo "Data Market committer IAM policy was not attached" >&2
    exit 1
    ;;
esac
