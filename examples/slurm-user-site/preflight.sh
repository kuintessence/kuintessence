#!/bin/bash
# 由用户在登录节点执行；只探测，不提交作业、不安装、不启动服务。
set -eo pipefail
if [[ $# -lt 1 || $# -gt 2 || ( $# -eq 2 && $2 != --network ) ]]; then
  echo '用法: bash -l preflight.sh /绝对路径/site.env [--network]' >&2
  exit 2
fi
source "$1"

probe() {
  printf '\n[%s]\n' "$1"
  shift
  "$@" || printf '未通过/不可读取（继续收集其他信息）\n'
}

probe 'OS' cat /etc/os-release
probe 'architecture' uname -m
probe 'glibc' getconf GNU_LIBC_VERSION
probe 'CPU' lscpu
probe 'Slurm version' sbatch --version
probe 'partition' sinfo -p "$KQ_PARTITION" -o '%P %a %l %D'
probe 'tools' bash -c 'for tool in ssh sbatch squeue sacct scontrol scancel curl sha256sum python3 flock systemctl; do command -v "$tool" || :; done'
probe 'HOME filesystem' findmnt -T "$HOME" -o TARGET,FSTYPE,OPTIONS
probe 'HOME capacity' df -h "$HOME"
probe 'HOME inodes' df -i "$HOME"
if [[ -n $KQ_LOCAL ]]; then
  if [[ $KQ_LOCAL != /* || ! -d $KQ_LOCAL || ! -w $KQ_LOCAL ]]; then
    echo 'KQ_LOCAL 不是现有可写的绝对目录；Agent 状态盘尚未就绪。'
  else
    probe 'configured state filesystem (persistence still needs confirmation)' findmnt -T "$KQ_LOCAL" -o TARGET,FSTYPE,OPTIONS
  fi
else
  echo 'KQ_LOCAL 未配置；不自动选择 HOME、/tmp 或 /var/tmp 作为 Agent 状态盘。'
fi
for candidate in /var/tmp /tmp /local /scratch; do
  if [[ -d $candidate ]]; then
    probe "local disk candidate: $candidate (not approved for persistence)" findmnt -T "$candidate" -o TARGET,FSTYPE,OPTIONS
  fi
done

if [[ -n $KQ_MODULE_INIT ]]; then
  source "$KQ_MODULE_INIT"
fi
if type module >/dev/null 2>&1; then
  probe 'module initialization' type module
  probe 'module stack currently loaded' module list
  probe 'Python module definition' module show "$KQ_PYTHON_MODULE"
  probe 'Apptainer module definition' module show "$KQ_APPTAINER_MODULE"
  probe 'GCC module definition' module show gcc/14.3.0
  probe 'MPI module definition' module show openmpi/5.0.11_gcc14.3
  # 模块仅在子 shell 加载，避免污染当前 shell 或混合 MPI 栈。
  printf '\n[Python module execution]\n'
  ( module load "$KQ_PYTHON_MODULE" && python3 --version ) || echo 'Python module 未就绪'
  printf '\n[Apptainer executable identity]\n'
  (
    module load "$KQ_APPTAINER_MODULE" || exit 1
    executable=$(command -v apptainer) || exit 1
    apptainer --version || exit 1
    executable=$(readlink -f "$executable") || exit 1
    stat -c '%U:%G %a %n' "$executable"
    if command -v namei >/dev/null 2>&1; then namei -l "$executable"; fi
  ) || echo 'Apptainer 未就绪'
else
  echo 'module 在非交互登录 shell 中不可用；请设置 KQ_MODULE_INIT。'
fi

probe 'user service availability' systemctl --user is-system-running
probe 'linger' loginctl show-user "$(id -un)" -p Linger

if [[ ${2:-} == --network ]]; then
  if [[ -z $SERVER_HTTP_URL ]]; then
    echo '网络检查需要先在本机配置 SERVER_HTTP_URL 或 KQ_ORIGIN。' >&2
    exit 2
  fi
  [[ $KQ_HTTP_LOCAL_PORT =~ ^[0-9]{1,5}$ ]] || { echo '无效的 KQ_HTTP_LOCAL_PORT' >&2; exit 2; }
  local_port=$((10#$KQ_HTTP_LOCAL_PORT))
  ((local_port >= 1024 && local_port <= 65535)) || { echo 'KQ_HTTP_LOCAL_PORT 超出范围' >&2; exit 2; }
  curl_options=(--connect-to "::127.0.0.1:$local_port" --noproxy '*')
  if [[ -n $KQ_TLS_CA_FILE ]]; then curl_options+=(--cacert "$KQ_TLS_CA_FILE"); fi
  printf '\n[Agent manifest via local SSH tunnel; address omitted]\n'
  code=$(curl --proto '=https' --silent --show-error --fail \
    --connect-timeout 10 --max-time 30 --output /dev/null --write-out '%{http_code}' \
    "${curl_options[@]}" \
    "${SERVER_HTTP_URL%/}/api/agent-binaries")
  [[ $code == 200 ]] || { echo "期望 HTTP 200，得到 $code" >&2; exit 1; }
  echo 'HTTP 200（curl 专用隧道映射）；仍需验证 manifest、CLI/Agent 解析、HTTP/2/mTLS 和对象存储。'
else
  echo '未执行任何云端网络请求；需要时显式使用 --network。'
fi
printf '\n[managed installation capability evidence]\n'
for evidence in KQ_LOCAL_RETENTION_CONFIRMED KQ_APPROVED_SUPERVISOR_CONFIRMED; do
  if [[ ${!evidence:-0} == 1 ]]; then
    printf '%s: passed (site confirmation)\n' "$evidence"
  else
    printf '%s: not-tested\n' "$evidence"
  fi
done
echo 'compute ABI / scratch / user-manager / cgroup isolation: not-tested on login node'
echo '在计算节点执行 modules-smoke.sh，采集 result.json；module show/avail 不能证明运行能力。'
echo '受管安装由 bootstrap install / stage 检查持久条件与新鲜inventory；不会自动修改linger或管理员策略。'
echo '预检采集结束；本输出不是部署通过报告。' 
