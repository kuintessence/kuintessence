#!/usr/bin/env bash
set -euo pipefail
umask 077

fail() { printf '%s\n' "$1" >&2; exit 1; }
case "${KQ_FEDERATION_MODE:-}" in direct|fabric) ;; *) fail 'Select direct or fabric.' ;; esac
[[ "${KQ_DEPLOY_REVISION:-}" =~ ^[a-f0-9]{40}$ ]] || fail 'Require a full published revision.'
[[ "${FEDERATION_SSH_HOST:-}" =~ ^[A-Za-z0-9][A-Za-z0-9.:-]*$ ]] || fail 'Invalid SSH host.'
[[ "${FEDERATION_SSH_USER:-}" =~ ^[a-zA-Z_][a-zA-Z0-9_-]*$ ]] || fail 'Invalid SSH user.'
[[ "${FEDERATION_SSH_PORT:-22}" =~ ^[0-9]{1,5}$ ]] || fail 'Invalid SSH port.'
((10#${FEDERATION_SSH_PORT:-22} > 0 && 10#${FEDERATION_SSH_PORT:-22} <= 65535)) || fail 'Invalid SSH port.'
[[ -n "${FEDERATION_SSH_KEY:-}" && -n "${FEDERATION_SSH_KNOWN_HOSTS:-}" && -n "${RUNNER_TEMP:-}" ]] || fail 'Missing deployment credentials or pinned host key.'
state=$(mktemp -d "$RUNNER_TEMP/kq-federation-deploy.XXXXXX")
trap 'rm -rf -- "$state"' EXIT
printf '%s\n' "$FEDERATION_SSH_KEY" > "$state/id"
printf '%s\n' "$FEDERATION_SSH_KNOWN_HOSTS" > "$state/known_hosts"
chmod 600 "$state/id" "$state/known_hosts"
unset FEDERATION_SSH_KEY FEDERATION_SSH_KNOWN_HOSTS
ssh_command=(ssh -T -i "$state/id" -p "${FEDERATION_SSH_PORT:-22}" -l "$FEDERATION_SSH_USER"
  -o BatchMode=yes -o IdentitiesOnly=yes -o ConnectTimeout=15
  -o StrictHostKeyChecking=yes -o UserKnownHostsFile="$state/known_hosts"
  -o ServerAliveInterval=30 -o ServerAliveCountMax=3 "$FEDERATION_SSH_HOST")
# A dedicated root prevents collision with the existing /opt/deploy migration/rollback manager.
# Credentials and governance artifacts must already exist on the target; they never transit CI.
tar -cf - deploy/main/compose.yml deploy/federation/compose.ingress.yml \
  deploy/federation/compose.fabric.yml deploy/federation/compose.sh deploy/federation/apply.sh |
  "${ssh_command[@]}" "set -eu
umask 077
mkdir -p /opt/kuintessence-federation/releases
stage=\$(mktemp -d /opt/kuintessence-federation/releases/.upload.XXXXXX)
trap 'rm -rf -- \"\$stage\"' EXIT
tar -xf - -C \"\$stage\"
bash \"\$stage/deploy/federation/apply.sh\" '$KQ_FEDERATION_MODE' '$KQ_DEPLOY_REVISION'"
