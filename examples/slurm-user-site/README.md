# Slurm 普通用户站点工具包

本目录包含现场预检、计算节点 inventory、两种 SSH 网络模式、签名发行初始化、服务更新和维护工具。先取得本站 inventory，再由平台准备匹配本站的发行；本地测试与其他环境验收不代替目标 HPC 的现场验收。

真实集群先上传完整工具包，执行本页第 1–3 步，回传计算节点 inventory，再准备本站签名发行；暂不执行 `install`、`services` 或开启 Spack。预检与原生小作业不需要云端地址、注册 token、预装 Spack 或已确定的 `KQ_LOCAL`，也不连接云端。

本站发行准备完成并通过对应验收后，初始化可使用双文件流程：上传 `bootstrap.sh` 与 `site.env.example`，填写环境变量，按 [SSH 接入与离线初始化](SSH-TUNNEL.md)操作；CLI、Agent 与可选 Spack runtime 由平台签名发行接口拉取。安装前 inventory 阶段仍须使用完整工具包。云端部署契约见[平台手册](../../docs/offline-slurm-site.md)。

以下原生 Slurm/modules smoke 步骤保留用于现场验证。`preflight.sh --network` 是旧的单请求诊断，新的双模式连接诊断使用 `bootstrap.sh ... doctor`。

# 本站手动接入步骤

集群命令全部由用户执行。公网 IP 不需要提供给协作者；真实地址只保存在集群的环境变量或私有 `site.env`。模板中的 `cn` 分区、`$HOME/kq-test` 共享目录和 module 名须按本站实际情况核对；不假设未知的 account/QoS。

云端经配置的 SSH Host（示例为 `kq-service`）隧道访问。先配置 SSH 公钥认证；联网注册/下载/Agent 启动前先按 [SSH 隧道配置](SSH-TUNNEL.md)设置转发、TLS 地址和数据通道。本地预检与原生 Slurm 小作业仍不需要云端连接。

本页的 `preflight.sh` 和 `modules-smoke.sh` 只负责现场预检与小作业。新版 `bootstrap.sh` 负责下载、注册、配置及更新服务，完整流程见[SSH 接入与离线初始化](SSH-TUNNEL.md)。

## 1. 上传与配置

通过现有 Web/VPN 的文件上传方式，把工具包解压到 `$HOME/kq-onboarding`；包含配置、预检、小作业、隧道脚本、用户服务模板与说明。无需从集群访问 GitHub。已有 `site.env` 须手动合并新版 SSH 变量，解压不会覆盖它。

同时上传本次可信渠道提供的 `SHA256SUMS`，在上传目录执行 `sha256sum -c SHA256SUMS`，通过后再解包。此校验用于确认交付字节；发行签名公钥另由平台通过可信渠道提供。

```bash
umask 077
mkdir -p "$HOME/kq-onboarding"
tar -xzf /你上传的路径/kq-slurm-user-kit.tar.gz --strip-components=1 -C "$HOME/kq-onboarding"
cd "$HOME/kq-onboarding"
cp -n site.env.example site.env
chmod 600 site.env
```

先不填公网地址。编辑 `site.env`，其中是 Bash 变量赋值，允许 `$HOME` 展开；它与 Agent 的 systemd EnvironmentFile 不同，后者必须写展开后的绝对路径。

首轮保留模板的 `KQ_PARTITION=cn`、Python 与 Apptainer module，以及 `KQ_ENABLE_SPACK=0`。account/QoS 只有站点要求时才填写；`KQ_MODULE_INIT` 仅在非交互登录 shell 无法初始化 module 时补充。云端地址、发布公钥、queue ID 和 `KQ_LOCAL` 此时均可留空。安装前采集须上传完整工具包，双文件 bootstrap 流程生成的小作业脚本在 `install` 后才可用。

业务 URL 保留真实证书域名和业务端口。不要把本地 18443 写入业务 URL；bootstrap 根据 `KQ_GATEWAY_FORWARD` 在底层映射连接，保留原始 SNI/Host。两种模式的完整环境变量见 [SSH 手册](SSH-TUNNEL.md)。

## 2. 先执行预检，不提交任何作业

```bash
cd "$HOME/kq-onboarding"
umask 077
bash -l preflight.sh "$PWD/site.env" > preflight.txt 2>&1
cat preflight.txt
```

重点读取 OS/glibc/架构、非交互 module 初始化、Python、Apptainer 真实文件及父目录权限、文件系统类型、用户服务与 linger。报告包含本机用户名/路径，可自行脱敏；无需发送公网地址、完整环境变量或证书。

即使已有 Apptainer， `module avail` 不能证明网络 namespace/cgroup、可信 SIF 和 site profile 已经就绪。预检只查版本与文件身份，不执行隔离安装。HOME 共享的站点应让 `KQ_LOCAL` 默认留空；/tmp 和 /var/tmp 的存在不证明它们持久、允许长期占用。没有合适状态盘时，暂不启动真实 Agent。

若非交互 shell 找不到 module，在当前交互 shell 执行 `type module` 并查看站点初始化设置，找到实际 init 文件后填入 `KQ_MODULE_INIT`。不要把 modulefile 搜索目录当作可 source 的初始化文件。

隧道启动后的可选网络检查：`bash -l preflight.sh "$PWD/site.env" --network`。curl 强制经 `127.0.0.1:$KQ_HTTP_LOCAL_PORT` 访问 manifest，保留 URL 的 Host/SNI；不修改 CLI/Agent 的解析行为。网络报告的错误文本可能含私有入口，保留在现场即可。

## 3. 提交一个原生 Slurm 小作业

先确认 Python module 预检通过。以下只在用户执行时提交 **1 个 CPU、512 MiB、3 分钟上限**的任务，不加载 MPI 或编译器，不进行科学软件编译：

```bash
cd "$HOME/kq-onboarding"
umask 077
source ./site.env
# 首轮固定本次工具包的脚本，避免命中旧安装生成的 helpers。
SMOKE_SCRIPT="$PWD/modules-smoke.sh"
# 已完成双文件 install 的站点可使用 $KQ_SHARED/helpers/modules-smoke.sh。
mkdir -p "$KQ_SHARED/native-smoke"
RUN_DIR=$(mktemp -d "$KQ_SHARED/native-smoke/run.XXXXXX")
args=(--partition="$KQ_PARTITION" --cpus-per-task=1 --mem=512M --time=00:03:00)
[[ -z $KQ_ACCOUNT ]] || args+=(--account="$KQ_ACCOUNT")
[[ -z $KQ_QOS ]] || args+=(--qos="$KQ_QOS")
JOB_ID=$(sbatch --parsable "${args[@]}" \
  --chdir="$RUN_DIR" --output="$RUN_DIR/slurm-%j.log" \
  "$SMOKE_SCRIPT" "$PWD/site.env")
JOB_ID=${JOB_ID%%;*}
printf 'Job ID: %s\nRun directory: %s\n' "$JOB_ID" "$RUN_DIR"
squeue -j "$JOB_ID"
```

脚本使用登录 Bash 初始化 modules。作业结束后：

```bash
sacct -j "$JOB_ID" --format=JobID,State,ExitCode,Account,Partition,ReqMem
cat "$RUN_DIR/slurm-$JOB_ID.log"
cat "$RUN_DIR/result.json"
sha256sum "$RUN_DIR/result.json"
```

期望 `COMPLETED / 0:0`、partition=cn、JSON 中 `ok=true`、`sum=4950`，日志中 `KQ_SMOKE_STARTED slurm_job_id=...` 与提交 ID 一致。若 accounting 不可用，及时保存 `scontrol show job "$JOB_ID"`、日志和结果；controller 只在有限保留期内提供终态。原生作业有结果不能替代后续 Agent 自动恢复验收。

`result.json` 同时是版本化计算节点 inventory（`schemaVersion=1`）：OS ID/版本、架构、libc、所有已观察 CPU 的共有指令 flags 白名单、实际 Python 模块/版本，以及共享工作目录独占临时文件的写入、fsync、读回和删除证据。报告不包含 hostname、账户、IP、Slurm ID 或共享盘真实路径；日志留在现场用于对账。`ok=true` 只表示小作业与共享路径探测成功，不代表所有可选工具已验证。

默认编译器/MPI 为 `not-tested`，不会加载未选择的 MPI。平台需要匹配站点工具链时，先在 `site.env` 显式填写 `KQ_SMOKE_COMPILER_MODULE` / `KQ_SMOKE_MPI_MODULE`；版本命令默认 `cc` / `mpirun`，可分别选 `cc|gcc|clang|icx|icc` 与 `mpirun|mpiexec`。只有 module load 和实际版本命令都成功才记 `passed`，版本输出只保留数字版本，不保留站点 banner。`module avail` 不作为可用证明；此探测不证明 MPI 跨节点运行或 ABI 兼容。

任务完成后，从登录节点取回 `$RUN_DIR/result.json`（共享盘可直接读取），将该 JSON 与其 SHA-256 交给平台用于准备离线 runtime/SIF 与 site profile；无需交付 `site.env`、Slurm 日志或整个预检目录。每次使用新 `RUN_DIR`，已有结果不会覆盖。异构分区应针对实际目标节点类型分别运行，报告只代表本次分配的一个节点，不包含网络、隔离能力或整个分区能力证明。

另外回报登录节点的 `uname -m`、`getconf GNU_LIBC_VERSION`、`/etc/os-release` 的 `ID`/`VERSION_ID`，以及两项非敏感结论：站点是否提供允许持久保存 SQLite 的本地状态盘，是否允许长期 Agent/user-systemd（含 linger）。尚未确认时直接写“待确认”，不用猜路径。`preflight.txt` 包含用户名和真实路径，留在现场；有失败时仅摘取脱敏错误。收到这些信息后，平台先匹配 CLI/Agent 的主机 ABI，再准备计算节点对应的 runtime/profile/lock，不要把云端 Ubuntu 测试发行复用到未知 HPC。

若 sbatch 要求 account，先按站点给你的真实值填写 `KQ_ACCOUNT`；不要猜成 Unix 用户名或分区名。共享目录让登录节点可以直接读计算节点输出，无需计算节点访问腾讯云。

## 4. Agent 配置与 KQ 作业

本地预检通过且 `KQ_LOCAL` 确认后，按[初始化手册](SSH-TUNNEL.md)下载校验 Agent、注册、配置用户服务。Agent 的 `AGENT_JOB_WORK_ROOT` 指向 `$KQ_SHARED/jobs` 的展开值，`AGENT_DB_PATH` 指向 `$KQ_LOCAL/state/agent.db` 的展开值；首次保持 Spack 安装开关关闭。

bootstrap 会将 `KQ_ACCOUNT`、`KQ_QOS` 写入生成的 Agent 配置；修改后须在维护窗口重新生成配置。平台 queue 映射 cn 和需要的 QoS。首先固定本站 queue ID，避免任务被派到其他测试集群。

下面在集群生成无 token 的 KQ 作业 JSON；需要已配置真实 `KQ_QUEUE_ID`，但无需在集群登录平台：

```bash
cd "$HOME/kq-onboarding"
source ./site.env
module load "$KQ_PYTHON_MODULE"
python3 - <<'PY'
import json, os, shlex, uuid
from pathlib import Path
queue = os.environ.get('KQ_QUEUE_ID')
if not queue:
    raise SystemExit('请先填写平台的 KQ_QUEUE_ID；它不是 Slurm partition 名称')
root = Path.cwd()
job = {
    'name': 'cn-modules-smoke',
    'command': '/bin/bash -l ' + shlex.quote(str(Path(os.environ['KQ_SHARED']) / 'helpers' / 'modules-smoke.sh')) + ' ' + shlex.quote(str(root / 'site.env')),
    'resources': {'cpus': 1, 'memoryMb': 512, 'wallTimeSec': 180},
    'schedulingStrategy': {'queueId': queue},
    'workingDir': str(Path(os.environ['KQ_SHARED']) / 'jobs' / ('smoke-' + uuid.uuid4().hex)),
    'expectedOutputs': [{'descriptor': 'result', 'path': 'result.json', 'isBatch': False}],
    'fileOutputDescriptors': ['result'],
}
with open('smoke-job.json', 'x') as output:
    json.dump(job, output, indent=2)
print('已生成 smoke-job.json；尚未提交任务')
PY
```

已有 `smoke-job.json` 时先另存前次证据，再重新生成；不覆盖已经提交的记录。将该 JSON 传到已登录平台的控制端，运行 `kq submit smoke-job.json`，不要加 `--local`。对比 KQ 和 Slurm job ID、日志，以及平台收集的 `result` 文本与共享盘 JSON 内容。需要验收云盘文件、摘要及上传中断恢复时，再运行带文件输出的 Workflow，并按[输出发布恢复](../../docs/workflow-output-recovery.md)核对文件 ID 与传输状态；原生小作业本身不证明文件已自动发布到云盘。

## 5. 第二轮的软件与恢复验证

- Python 小作业通过后，可选择本站已有的 CP2K 或 GROMACS module 运行对应版本的官方小样例。不同 MPI 实现不要混载。先 `module show` 确认依赖，MPI 启动方式/PMI 插件也要单独确认；本 kit 不猜测 `srun --mpi` 参数。
- 新软件离线包必须对齐本站 OS/ABI、编译器、MPI 与 externals。已有 modules 优先利用，不为验证接入重复编译整套工具链。
- 同一 kit 的 `KQ_SMOKE_SLEEP_SEC=90` 可留出 Agent 重启窗口。只在原测试进程结束后修改；重新生成新 job/工作目录。重启 Agent 后应仍对应同一个 Slurm ID，不产生第二次提交。
- 不修改真实科学任务运行中使用的 site.env/module 栈；后续正式用例要冻结配置与软件版本。科学软件 checkpoint 续算与这个 sleep 小作业的控制面接管是不同验收。
- 自动更新仍按“拉取/校验 → staging → 维护窗口激活”处理；大材料 Range 和持久分片恢复已补充源码与测试，但仍须现场专项验收。

回传第 3 节要求的脱敏 inventory、摘要与站点条件结论即可推进；完整预检报告留在现场，不需要提供公网 IP 或开放远程登录。

## 从仓库生成现场工具包

在已审阅的 main checkout 根目录执行以下命令。归档使用公开文件白名单，不包含 `site.env`、缓存、私钥或外部验收回执；输出目录放在仓库之外。生成的归档可按第 1 节的 `--strip-components=1` 解压。SHA-256 校验确认交付字节，发行公钥仍须独立可信分发；归档中的仓内文档链接在完整源码 checkout 中阅读。

```bash
KIT_OUTPUT=$(mktemp -d /tmp/kq-site-kit.XXXXXX)
tar -czf "$KIT_OUTPUT/kq-slurm-user-kit.tar.gz" -C examples \
  slurm-user-site/README.md slurm-user-site/SSH-TUNNEL.md \
  slurm-user-site/bootstrap.sh slurm-user-site/onboard.py \
  slurm-user-site/maintenance.py slurm-user-site/preflight.sh \
  slurm-user-site/modules-smoke.sh slurm-user-site/tunnel.sh \
  slurm-user-site/site.env.example slurm-user-site/kq-tunnel.service.example
(cd "$KIT_OUTPUT" && sha256sum kq-slurm-user-kit.tar.gz > SHA256SUMS)
printf '交付目录：%s\n' "$KIT_OUTPUT"
```

## 本地回归检查

在仓库根目录执行以下命令。测试使用临时目录、受控 CLI/Agent fixture 和回环 TLS/HTTP CONNECT，不连接真实集群，也不能代替 CSR 注册、OpenSSH 认证及真实软件验收。需要 Python 3、Bash、curl 和 OpenSSL；不依赖第三方 Python 包。

```bash
for test_file in tests/test_site_bootstrap.py tests/test_site_bootstrap_integration.py tests/test_site_maintenance.py tests/test_site_shared_recovery.py tests/test_slurm_user_site.py; do
  python3 "$test_file" || exit
done
```

维护与受管软件前置条件见[站点维护](../../docs/slurm-site-maintenance.md)和[能力与预算](../../docs/slurm-site-capabilities-and-budgets.md)。完整验收范围见[交付与验收清单](../../docs/offline-slurm-acceptance.md)。
