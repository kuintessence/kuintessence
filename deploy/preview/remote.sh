#!/usr/bin/env bash
set -euo pipefail
umask 077

fail() { printf '%s\n' "$1" >&2; exit 1; }
mode="${1:-}"
[[ "$mode" == deploy || "$mode" == cleanup ]] || fail "Expected deploy or cleanup."
inspection="${PREVIEW_INSPECTION:-false}"
[[ "$inspection" == true || "$inspection" == false ]] || fail "Invalid inspection mode."
if [[ "$inspection" == true ]]; then
  [[ "${GITHUB_EVENT_NAME:-}" == workflow_dispatch ]] || fail "Inspection requires manual dispatch."
fi
[[ "${PREVIEW_PR:-}" =~ ^[1-9][0-9]{0,14}$ ]] || fail "Invalid PR number."
[[ "${GITHUB_REPOSITORY:-}" =~ ^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$ ]] || fail "Invalid repository."
[[ "${SSH_HOST:-}" =~ ^[A-Za-z0-9][A-Za-z0-9.:-]*$ ]] || fail "Invalid SSH host."
[[ "${SSH_USER:-}" =~ ^[a-zA-Z_][a-zA-Z0-9_-]*$ ]] || fail "Invalid SSH user."
[[ "${SSH_PORT:-}" =~ ^[0-9]{1,5}$ ]] || fail "Invalid SSH port."
(( 10#$SSH_PORT >= 1 && 10#$SSH_PORT <= 65535 )) || fail "Invalid SSH port."
[[ -n "${SSH_KEY:-}" && -n "${KUBE_CONFIG:-}" ]] || fail "Missing SSH_KEY or KUBE_CONFIG."
[[ -n "${RUNNER_TEMP:-}" ]] || fail "This command requires an Actions runner."
export PREVIEW_NAMESPACE="preview"
export PREVIEW_RELEASE="kq-pr-$PREVIEW_PR"
export HELM_DRIVER="secret"
namespace="$PREVIEW_NAMESPACE"
release="$PREVIEW_RELEASE"

tooling="$(cd "$(dirname "$0")" && pwd)"
if [[ "$mode" == deploy ]]; then
  node "$tooling/credentials.cjs" validate
fi
state="$(mktemp -d "$RUNNER_TEMP/kq-preview-remote.XXXXXX")"
ssh_pid=""
observer_pid=""
stop_observer() {
  if [[ -n "$observer_pid" ]]; then
    kill "$observer_pid" 2>/dev/null || true
    wait "$observer_pid" 2>/dev/null || true
    observer_pid=""
  fi
}
cleanup_local() {
  stop_observer
  if [[ -n "$ssh_pid" ]]; then
    kill "$ssh_pid" 2>/dev/null || true
    wait "$ssh_pid" 2>/dev/null || true
  fi
  rm -rf -- "$state"
}
trap cleanup_local EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

printf '%s\n' "$SSH_KEY" > "$state/id"
printf '%s\n' "$KUBE_CONFIG" > "$state/input-config"
chmod 600 "$state/id" "$state/input-config"
unset SSH_KEY KUBE_CONFIG
# config view parses configuration only. Do not use --flatten: it reads local files.
kubectl --kubeconfig="$state/input-config" config view --raw -o json 2>"$state/config-error" |
  node "$tooling/kubeconfig.cjs" "$state/kubeconfig"
rm "$state/input-config"
export KUBECONFIG="$state/kubeconfig"

# Explicit operator choice for this preview host. Kubernetes CA validation stays on.
ssh -NT -i "$state/id" -p "$SSH_PORT" \
  -o BatchMode=yes -o IdentitiesOnly=yes -o ConnectTimeout=15 \
  -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null \
  -o GlobalKnownHostsFile=/dev/null -o LogLevel=ERROR \
  -o ExitOnForwardFailure=yes -o ServerAliveInterval=30 -o ServerAliveCountMax=3 \
  -L 127.0.0.1:16443:127.0.0.1:6443 \
  "$SSH_USER@$SSH_HOST" >"$state/ssh-log" 2>&1 &
ssh_pid="$!"
ready=false
for _ in {1..20}; do
  kill -0 "$ssh_pid" 2>/dev/null || fail "SSH tunnel could not be established."
  if kubectl -n "$namespace" --request-timeout=5s get configmap "$release-preview-owner" \
      --ignore-not-found -o name >"$state/api-ready" 2>/dev/null; then
    ready=true
    break
  fi
  sleep 3
done
[[ "$ready" == true ]] || fail "The TLS-verified k3s API did not become reachable through SSH."

if [[ "$mode" == cleanup ]]; then
  node "$tooling/resources.cjs" cleanup
  echo "Owned PR release, residual claims and credentials removed from preview."
  exit 0
fi

[[ "${PREVIEW_SHA:-}" =~ ^[a-f0-9]{40}$ ]] || fail "Invalid tested revision."
[[ "${IMAGE_OWNER:-}" =~ ^[a-z0-9][a-z0-9-]*$ ]] || fail "Invalid image owner."
node "$tooling/images.cjs" verify "${IMAGE_MANIFEST:?Image manifest is required}"
node "$tooling/resources.cjs" prepare "$state/previous-secret"
node "$tooling/credentials.cjs" "$state/previous-secret" "$state/secret"
node "$tooling/resources.cjs" credentials "$state/secret"
export PREVIEW_SECRET_FILE="$state/secret"

node "$tooling/values.cjs" values "$state/values.json"
chart="$tooling/../helm/kq-preview"
helm dependency build "$chart" >"$state/dependencies-log" 2>&1 ||
  fail "Unable to package the local preview chart dependency."
helm_flags=(--atomic --wait --wait-for-jobs --timeout 15m)
if [[ "$inspection" == true ]]; then
  helm_flags=(--wait --wait-for-jobs --timeout 15m)
fi
printf 'inspection=%s\nattempted=true\n' "$inspection" >> "${GITHUB_OUTPUT:?Actions step output is required}"
# Observe without publishing raw Kubernetes data; inspection retains failed workloads.
node "$tooling/workload-status.cjs" watch 2>"$state/observer-error" &
observer_pid="$!"
if helm upgrade --install "$release" "$chart" -n "$namespace" \
  --values "$state/values.json" "${helm_flags[@]}" \
  --history-max 3 >"$state/helm-log" 2>&1; then
  printf 'applied=true\n' >> "${GITHUB_OUTPUT:?Actions step output is required}"
  stop_observer
  echo "KQ_PREVIEW_HELM code=READY"
else
  stop_observer
  node "$tooling/workload-status.cjs" helm-error "$state/helm-log" \
    2>"$state/diagnostic-error" || true
  fail "Helm deployment failed or timed out; inspect the namespace privately. No raw manifests or logs were published."
fi

if [[ "$inspection" == true ]]; then
  echo "KQ_PREVIEW_HELM code=RETAINED_FOR_INSPECTION"
  echo "Helm completed. Resources and image tags are retained; HTTPS awaits manual inspection."
  exit 0
fi
node "$tooling/https.cjs" "$state/secret"
echo "Preview is ready with verified HTTPS and an authenticated gateway."
