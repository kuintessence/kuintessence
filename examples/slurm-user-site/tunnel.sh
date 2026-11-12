#!/bin/bash
# 前台单个 SSH 进程；由用户服务负责重启，既不后台 fork，也不启用代理转发。
set -eo pipefail
if [[ $# -lt 1 || $# -gt 2 || ( $# -eq 2 && $2 != --check ) ]]; then
  echo '用法: bash tunnel.sh /绝对路径/site.env [--check]' >&2
  exit 2
fi
source "$1"
fail() { echo "$1" >&2; exit 2; }
[[ $KQ_SSH_HOST =~ ^[A-Za-z0-9][A-Za-z0-9_.-]*$ ]] || fail 'KQ_SSH_HOST 必须是 SSH Host 别名'
[[ -n $KQ_TUNNEL_FORWARDS ]] || fail '请填写 KQ_TUNNEL_FORWARDS，远端目标不能从 SSH Host 别名推断'

args=(-N -T -o BatchMode=yes -o StrictHostKeyChecking=yes
      -o ExitOnForwardFailure=yes -o ConnectTimeout=15 -o ConnectionAttempts=1
      -o ServerAliveInterval=30 -o ServerAliveCountMax=3
      -o ForwardAgent=no -o ControlMaster=no -o ControlPath=none)
declare -A ports=()
while IFS= read -r mapping; do
  [[ -z $mapping || $mapping == \#* ]] && continue
  [[ $mapping =~ ^([0-9]{1,5}):([A-Za-z0-9_][A-Za-z0-9_.-]*):([0-9]{1,5})$ ]] || fail '转发格式应为 本地端口:远端IPv4或主机名:远端端口'
  local_port=$((10#${BASH_REMATCH[1]}))
  target=${BASH_REMATCH[2]}
  remote_port=$((10#${BASH_REMATCH[3]}))
  ((local_port >= 1024 && local_port <= 65535 && remote_port >= 1 && remote_port <= 65535)) || fail '本地端口须为 1024..65535，远端端口须为 1..65535'
  [[ -z ${ports[$local_port]:-} ]] || fail '本地转发端口重复'
  ports[$local_port]=1
  args+=(-L "127.0.0.1:$local_port:$target:$remote_port")
done <<< "$KQ_TUNNEL_FORWARDS"
((${#ports[@]} > 0)) || fail '至少需要一条转发映射'
if [[ ${2:-} == --check ]]; then
  printf '%q ' ssh "${args[@]}" "$KQ_SSH_HOST"
  printf '\n仅检查参数；未连接 SSH，未验证远端监听或证书。\n'
  exit 0
fi
exec ssh "${args[@]}" "$KQ_SSH_HOST"
