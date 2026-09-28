#!/usr/bin/env bash
set -euo pipefail
umask 077

fail() { printf '%s\n' "$1" >&2; exit 1; }
mode="${1:-}"
[[ "$mode" == deploy || "$mode" == cleanup ]] || fail "Expected deploy or cleanup."
[[ "${PREVIEW_PR:-}" =~ ^[1-9][0-9]{0,14}$ ]] || fail "Invalid PR number."
[[ "${GITHUB_REPOSITORY:-}" =~ ^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$ ]] || fail "Invalid repository."
[[ "${SSH_HOST:-}" =~ ^[A-Za-z0-9][A-Za-z0-9.:-]*$ ]] || fail "Invalid SSH host."
[[ "${SSH_USER:-}" =~ ^[a-zA-Z_][a-zA-Z0-9_-]*$ ]] || fail "Invalid SSH user."
[[ "${SSH_PORT:-}" =~ ^[0-9]{1,5}$ ]] || fail "Invalid SSH port."
(( 10#$SSH_PORT >= 1 && 10#$SSH_PORT <= 65535 )) || fail "Invalid SSH port."
[[ -n "${SSH_KEY:-}" && -n "${KUBE_CONFIG:-}" ]] || fail "Missing SSH_KEY or KUBE_CONFIG."
[[ -n "${RUNNER_TEMP:-}" ]] || fail "This command requires an Actions runner."

tooling="$(cd "$(dirname "$0")" && pwd)"
state="$(mktemp -d "$RUNNER_TEMP/kq-preview-remote.XXXXXX")"
ssh_pid=""
cleanup_local() {
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
  if kubectl --request-timeout=5s get --raw=/readyz >"$state/api-ready" 2>/dev/null; then
    ready=true
    break
  fi
  sleep 3
done
[[ "$ready" == true ]] || fail "The TLS-verified k3s API did not become reachable through SSH."

export PREVIEW_NAMESPACE="kq-pr-$PREVIEW_PR"
namespace="$PREVIEW_NAMESPACE"
existing="$(kubectl get namespace "$namespace" --ignore-not-found -o json)"
if [[ -n "$existing" ]]; then
  jq -e --arg repo "$GITHUB_REPOSITORY" --arg pr "$PREVIEW_PR" '
    .metadata.labels["app.kubernetes.io/managed-by"] == "kq-preview" and
    .metadata.labels["kuintessence.com/preview-pr"] == $pr and
    .metadata.annotations["kuintessence.com/repository"] == $repo
  ' <<< "$existing" >/dev/null || fail "Namespace ownership mismatch; refusing to modify it."
elif [[ "$mode" == cleanup ]]; then
  echo "Preview namespace is already absent."
  exit 0
fi

if [[ "$mode" == cleanup ]]; then
  # Namespace ownership is checked above; never run a cluster-wide Helm uninstall.
  kubectl delete namespace "$namespace" --wait=true --timeout=5m
  echo "Managed PR namespace and its disposable data removed."
  exit 0
fi

[[ "${PREVIEW_SHA:-}" =~ ^[a-f0-9]{40}$ ]] || fail "Invalid tested revision."
[[ "${IMAGE_OWNER:-}" =~ ^[a-z0-9][a-z0-9-]*$ ]] || fail "Invalid image owner."
node "$tooling/images.cjs" verify "${IMAGE_MANIFEST:?Image manifest is required}"
kubectl get nodes -o json | jq -e '
  (.items | length) == 1 and
  .items[0].status.nodeInfo.architecture == "amd64" and
  .items[0].status.nodeInfo.operatingSystem == "linux" and
  any(.items[0].status.conditions[]; .type == "Ready" and .status == "True")
' >/dev/null || fail "Preview requires one Ready linux/amd64 node."
if [[ -z "$existing" ]]; then
  jq -n --arg name "$namespace" --arg repo "$GITHUB_REPOSITORY" --arg pr "$PREVIEW_PR" '{
    apiVersion:"v1",kind:"Namespace",
    metadata:{name:$name,labels:{"app.kubernetes.io/managed-by":"kq-preview","kuintessence.com/preview-pr":$pr},
    annotations:{"kuintessence.com/repository":$repo}}
  }' | kubectl create -f -
fi
kubectl -n "$namespace" get secret kq-preview-secrets --ignore-not-found -o json > "$state/previous-secret"
if [[ ! -s "$state/previous-secret" ]]; then printf 'null' > "$state/previous-secret"; fi
node "$tooling/credentials.cjs" "$state/previous-secret" "$state/secret"
kubectl apply --server-side --field-manager=kq-preview -f "$state/secret"
export PREVIEW_SECRET_FILE="$state/secret"

if [[ -n "${GHCR_PULL_TOKEN:-}" ]]; then
  node "$tooling/values.cjs" registry-secret "$state/pull-secret"
  kubectl apply --server-side --field-manager=kq-preview -f "$state/pull-secret"
fi
node "$tooling/values.cjs" values "$state/values.json"
chart="$tooling/../helm/kq-preview"
helm dependency build "$chart" >"$state/dependencies-log" 2>&1 ||
  fail "Unable to package the local preview chart dependency."
helm upgrade --install "$namespace" "$chart" --namespace "$namespace" \
  --values "$state/values.json" --atomic --wait --wait-for-jobs --timeout 15m \
  --history-max 3 >"$state/helm-log" 2>&1 ||
  fail "Helm deployment failed or timed out; inspect the namespace privately. No raw manifests or logs were published."
printf 'applied=true\n' >> "${GITHUB_OUTPUT:?Actions step output is required}"

kubectl -n "$namespace" annotate namespace "$namespace" \
  "kuintessence.com/revision=$PREVIEW_SHA" --overwrite >/dev/null
node "$tooling/https.cjs" "$state/secret"
echo "Preview is ready with verified HTTPS and an authenticated gateway."
