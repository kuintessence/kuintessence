#!/usr/bin/env bash
set -euo pipefail

fail() {
  printf '%s\n' "$*" >&2
  exit 1
}

[[ "${GITHUB_ACTIONS:-}" == true ]] || fail "This entry point is only for GitHub Actions."
: "${RUNNER_TEMP:?}" "${GITHUB_RUN_ID:?}" "${GITHUB_RUN_ATTEMPT:?}"
: "${GITHUB_WORKSPACE:?}" "${GITHUB_STEP_SUMMARY:?}" "${GITHUB_REPOSITORY:?}"
: "${COMPOSE_PROJECT_NAME:?}"
export PREVIEW_STATE="$RUNNER_TEMP/kq-preview-$GITHUB_RUN_ID-$GITHUB_RUN_ATTEMPT"
[[ "$COMPOSE_PROJECT_NAME" == "kq-preview-$GITHUB_RUN_ID-$GITHUB_RUN_ATTEMPT" ]] ||
  fail "Unexpected Compose project."

compose() {
  docker compose --project-directory "$GITHUB_WORKSPACE" \
    --env-file "$PREVIEW_STATE/env" \
    -p "$COMPOSE_PROJECT_NAME" \
    -f "$GITHUB_WORKSPACE/deploy/compose/docker-compose.preview.yml" \
    --profile tunnel "$@"
}

request_current() {
  [[ -n "${PREVIEW_PR:-}" ]] || return 0
  local pr
  pr=$(timeout 20s gh api "repos/$GITHUB_REPOSITORY/pulls/$PREVIEW_PR") || return 1
  jq -e --arg sha "$PREVIEW_HEAD_SHA" --arg repo "$GITHUB_REPOSITORY" '
    .state == "open" and (.draft | not) and .base.ref == "main" and
    .head.sha == $sha and .head.repo.full_name == $repo and
    ([.labels[].name] | index("preview-paused") | not)
  ' <<< "$pr" >/dev/null
}

prepare() {
  : "${PREVIEW_PASSWORD:=}"
  [[ ${#PREVIEW_PASSWORD} -ge 24 ]] ||
    fail "Set repository secret PREVIEW_PASSWORD to a dedicated password of at least 24 characters."
  [[ "$PREVIEW_PASSWORD" != *$'\n'* && "$PREVIEW_PASSWORD" != *$'\r'* ]] ||
    fail "PREVIEW_PASSWORD must be a single line."
  umask 077
  mkdir -p "$PREVIEW_STATE"
  : > "$PREVIEW_STATE/env"
  local key value password_hash
  for key in PREVIEW_DB_PASSWORD PREVIEW_JWT_SECRET PREVIEW_COOKIE; do
    value=$(openssl rand -hex 32)
    printf '::add-mask::%s\n' "$value"
    printf '%s=%s\n' "$key" "$value" >> "$PREVIEW_STATE/env"
  done
  password_hash=$(printf '%s' "$PREVIEW_PASSWORD" | openssl passwd -apr1 -stdin)
  printf 'preview:%s\n' "$password_hash" > "$PREVIEW_STATE/htpasswd"
  chmod 644 "$PREVIEW_STATE/htpasswd"
  unset PREVIEW_PASSWORD password_hash value
}

start() {
  if ! request_current; then
    printf 'PR 已暂停、关闭、更新，或无法确认当前状态；未发布预览。\n' >> "$GITHUB_STEP_SUMMARY"
    return
  fi
  compose up -d --wait --wait-timeout 180 gateway
  local status url=""
  status=$(curl -sS --max-time 10 -o /dev/null -w '%{http_code}' \
    http://127.0.0.1:18080/__preview/unlock)
  [[ "$status" == 401 ]] || fail "Preview gateway did not require authentication."
  compose up -d tunnel
  for ((attempt = 0; attempt < 45; attempt++)); do
    url=$(compose logs --no-color tunnel 2>/dev/null |
      sed -nE 's/.*(https:\/\/[a-z0-9-]+\.trycloudflare\.com).*/\1/p' | head -n 1)
    [[ -z "$url" ]] || break
    sleep 2
  done
  [[ -n "$url" ]] || fail "Quick Tunnel did not provide a preview URL."
  local ready=false
  for ((attempt = 0; attempt < 15; attempt++)); do
    status=$(curl -sS --max-time 5 -o /dev/null -w '%{http_code}' \
      "$url/__preview/unlock") || status=000
    if [[ "$status" == 401 ]]; then
      ready=true
      break
    fi
    sleep 2
  done
  [[ "$ready" == true ]] || fail "Public preview gateway did not become ready."
  if ! request_current; then
    printf 'PR 状态已改变或无法确认；环境将销毁，不发布预览。\n' >> "$GITHUB_STEP_SUMMARY"
    return
  fi
  local deadline
  deadline=$(($(date +%s) + 600))
  printf '%s\n' "$deadline" > "$PREVIEW_STATE/deadline"
  {
    printf '## Kuintessence 预览\n\n'
    printf -- '- 地址：[%s](%s)\n' "$url" "$url"
    printf -- '- 到期：%s（UTC），最多 10 分钟，不自动续期。\n' \
      "$(date -u -d "@$deadline" '+%Y-%m-%d %H:%M:%S')"
    printf -- "- 入口用户名：\`preview\`；口令由维护者通过私密渠道提供（\`PREVIEW_PASSWORD\`）。\n"
    printf -- "- 应用登录使用虚构邮箱，例如 \`reviewer@example.com\`；可选择预览角色。\n"
    printf -- '- 只有临时 Web、Server、Registry、PostgreSQL，不连接真实集群、SSO 或对象存储。\n'
    printf -- "- PR 加 \`preview-paused\` 标签可暂停；main 使用本工作流的 \`pause\` 操作。\n"
    printf -- '- 此地址仅在本次 job 运行期间有效；请以 job 状态为准。\n'
  } >> "$GITHUB_STEP_SUMMARY"
}

watch() {
  [[ -f "$PREVIEW_STATE/deadline" ]] || return 0
  local deadline running service
  deadline=$(< "$PREVIEW_STATE/deadline")
  while (( $(date +%s) < deadline )); do
    if ! request_current; then
      printf '\nPR 状态已改变或无法确认，提前停止预览。\n' >> "$GITHUB_STEP_SUMMARY"
      return
    fi
    running=$(compose ps --status running --services)
    for service in postgres server registry web gateway tunnel; do
      grep -qx "$service" <<< "$running" || fail "Preview service stopped: $service"
    done
    sleep 10
  done
}

hold() {
  [[ -f "$PREVIEW_STATE/deadline" ]] || return 0
  local remaining status=0
  remaining=$(( $(< "$PREVIEW_STATE/deadline") - $(date +%s) ))
  if (( remaining > 0 )); then
    timeout --signal=TERM --kill-after=5s "${remaining}s" \
      bash "$GITHUB_WORKSPACE/deploy/preview/preview.sh" watch || status=$?
  fi
  compose stop --timeout 5 tunnel
  [[ "$status" == 0 || "$status" == 124 ]]
}

cleanup() {
  local result=0
  if [[ -f "$PREVIEW_STATE/env" ]]; then
    compose stop --timeout 5 tunnel || true
    compose down --volumes --remove-orphans --timeout 10 || result=$?
  fi
  rm -rf -- "$PREVIEW_STATE"
  if (( result == 0 )); then
    printf '\n预览清理完成；链接已失效，临时容器与数据卷已删除。\n' >> "$GITHUB_STEP_SUMMARY"
  else
    printf '\nCompose 清理失败；链接不可继续使用，须确认本次 runner 已结束并被回收。\n' >> "$GITHUB_STEP_SUMMARY"
  fi
  return "$result"
}

case "${1:-}" in
  prepare) prepare ;;
  build) compose build ;;
  start) start ;;
  hold) hold ;;
  watch) watch ;;
  cleanup) cleanup ;;
  *) fail "Usage: preview.sh prepare|build|start|hold|cleanup" ;;
esac
