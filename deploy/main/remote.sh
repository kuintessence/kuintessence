#!/usr/bin/env bash
set -euo pipefail
umask 077

fail() { printf '%s\n' "$1" >&2; exit 1; }
[[ "${GITHUB_EVENT_NAME:-}" == push && "${GITHUB_REF:-}" == refs/heads/main ]] ||
  fail "Main deployment requires a push to main."
[[ "${MAIN_SSH_HOST:-}" =~ ^[A-Za-z0-9][A-Za-z0-9.:-]*$ ]] || fail "Invalid MAIN_SSH_HOST."
[[ "${MAIN_SSH_USER:-}" =~ ^[a-zA-Z_][a-zA-Z0-9_-]*$ ]] || fail "Invalid MAIN_SSH_USER."
[[ "${MAIN_SSH_PORT:-}" =~ ^[0-9]{1,5}$ ]] || fail "Invalid MAIN_SSH_PORT."
(( 10#$MAIN_SSH_PORT >= 1 && 10#$MAIN_SSH_PORT <= 65535 )) || fail "Invalid MAIN_SSH_PORT."
[[ -n "${MAIN_SSH_KEY:-}" ]] || fail "Missing MAIN_SSH_KEY."
[[ -n "${RUNNER_TEMP:-}" ]] || fail "This command requires an Actions runner."

source_dir="$(cd "$(dirname "$0")" && pwd)"
[[ -f "$source_dir/compose.yml" && ! -L "$source_dir/compose.yml" ]] || fail "Missing main compose.yml."
files=(compose.yml)
if [[ -e "$source_dir/env.example" ]]; then
  [[ -f "$source_dir/env.example" && ! -L "$source_dir/env.example" ]] || fail "Invalid env.example."
  files+=(env.example)
fi

state="$(mktemp -d "$RUNNER_TEMP/kq-main-deploy.XXXXXX")"
trap 'rm -rf -- "$state"' EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
printf '%s\n' "$MAIN_SSH_KEY" > "$state/id"
chmod 600 "$state/id"
unset MAIN_SSH_KEY

# Accept the first host key for this job; keep it in the private temporary state.
tar -C "$source_dir" -cf - "${files[@]}" |
  ssh -T -i "$state/id" -p "$MAIN_SSH_PORT" -l "$MAIN_SSH_USER" \
    -o BatchMode=yes -o IdentitiesOnly=yes -o ConnectTimeout=15 \
    -o StrictHostKeyChecking=accept-new -o UserKnownHostsFile="$state/known_hosts" \
    -o ServerAliveInterval=30 -o ServerAliveCountMax=3 \
    "$MAIN_SSH_HOST" '
set -eu
umask 077
mkdir -p /opt/deploy
cd /opt/deploy
test -x /opt/deploy/run.sh
stage=$(mktemp -d /opt/deploy/.main-deploy.XXXXXX)
trap '\''rm -rf -- "$stage"'\'' EXIT
tar -xf - -C "$stage"
test -f "$stage/compose.yml"
mv -f "$stage/compose.yml" /opt/deploy/compose.yml
if [ -f "$stage/env.example" ]; then
  mv -f "$stage/env.example" /opt/deploy/env.example
fi
/opt/deploy/run.sh
'
