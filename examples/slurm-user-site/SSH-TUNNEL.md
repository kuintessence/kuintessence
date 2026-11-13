# SSH 接入与离线初始化

现场：普通用户，HOME 共享，Slurm `cn`，SSH Host `kq-service`。以下命令由用户执行。云端必须先部署新版平台、统一 SNI 入口和签名发行包；详见[平台部署契约](../../docs/offline-slurm-site.md)。

完整实施覆盖、平台材料准备和集中现场故障验收见[交付与验收清单](../../docs/offline-slurm-acceptance.md)。

真实集群首次接入，先按[手动预检与计算节点 inventory](README.md)第 1–3 步操作，使用完整工具包；这一步不需要云端配置或本地状态盘。平台收到 inventory 并提供匹配本站的签名发行、公钥与入口配置后，再执行下列初始化。双文件流程适用于已确认站点能力并备好发行的情况。

## 1. 上传两个文件并配置

上传 `bootstrap.sh` 和 `site.env.example` 到 `$HOME/kq-onboarding/`，将模板复制为 `site.env`，权限设为 0600。bootstrap 是包含 Python 标准库实现的单文件入口，无需手动上传其他脚本或软件包。

```bash
umask 077
mkdir -p "$HOME/kq-onboarding"
chmod 700 "$HOME/kq-onboarding"
cd "$HOME/kq-onboarding"
cp -n site.env.example site.env
chmod 600 site.env
```

编辑 `site.env`。以下示例域名与端口仅说明格式，不是已部署地址：

```bash
export KQ_SSH_HOST=kq-service
export KQ_TRANSPORT_MODE=ssh-forward
export KQ_GATEWAY_FORWARD='18443:127.0.0.1:18443'
export KQ_ORIGIN='https://platform.example.com'
export SERVER_HTTP_URL="$KQ_ORIGIN/platform"
export SERVER_GRPC_URL='https://agent.example.com'
export KQ_SHARED="$HOME/kq-test"
export KQ_LOCAL='/实际持久本地盘/你的用户/kq-agent'
export KQ_PARTITION=cn
export KQ_ACCOUNT=''
export KQ_QOS=''
export KQ_ENABLE_SPACK=0
export KQ_RELEASE_CHANNEL=stable
# 从平台可信渠道获得完整公钥；保留 PEM 换行。
export KQ_RELEASE_PUBLIC_KEY_PEM='-----BEGIN PUBLIC KEY-----
这里替换为真实发布公钥
-----END PUBLIC KEY-----'
```

`SERVER_GRPC_URL` 的域名用于 SNI 和证书校验；它仍通过同一个本地 18443 端口连接。SSH 别名不会自动变成 HTTP 域名。bootstrap 生成应用层连接映射，无需改 `/etc/hosts`，不关闭证书校验。

私有 CA 配置 `KQ_TLS_CA_FILE=/实际路径/ca-bundle.pem`，信任包须覆盖普通入口和 Agent 服务端链；不要把私钥放进去。已有公钥免密仍需可信 known_hosts，SSH 不会自动接受陌生主机密钥。

若站点使用私有 CA 且希望仍只上传两个文件，可把平台通过可信渠道提供的完整 CA PEM 写入 `site.env` 的以下 Bash 块；每次加载配置时生成同一份公开信任文件。CA 不应从尚未验证的 HTTPS 连接下载。使用系统已信任的证书时不需要此块。

```bash
umask 077
mkdir -p "$HOME/.config/kq"
chmod 700 "$HOME/.config/kq"
export KQ_TLS_CA_FILE="$HOME/.config/kq/platform-ca.pem"
kq_ca_tmp=$(mktemp "$HOME/.config/kq/.platform-ca.XXXXXX")
cat > "$kq_ca_tmp" <<'KQ_TRUSTED_CA'
-----BEGIN CERTIFICATE-----
这里替换为可信渠道提供的完整 CA 内容；多条链可顺序拼接
-----END CERTIFICATE-----
KQ_TRUSTED_CA
chmod 600 "$kq_ca_tmp"
mv -f "$kq_ca_tmp" "$KQ_TLS_CA_FILE"
unset kq_ca_tmp
```

状态盘必须持久且本地。共享 HOME 放材料、软件、作业；SQLite/WAL 放 `KQ_LOCAL`。只读预检拒绝 HOME 或 `KQ_SHARED` 子树，以及 `/tmp`、`/var/tmp`、`/run`、`/dev/shm`；不会因另一个目录与 HOME 位于同一挂载就拒绝整块盘。挂载必须是可写 ext4/xfs/btrfs/zfs；网络、临时、只读与未知文件系统拒绝。挂载类型不能证明保留期限，目录仍须由站点确认不会被定期清理，不靠填写标志绕过。

## 2. HTTP 正向代理模式

需要该方式时只改传输模式和转发目标：

```bash
export KQ_TRANSPORT_MODE=http-proxy
export KQ_PROXY_FORWARD='18080:127.0.0.1:3128'
```

3128 必须是云端真实 HTTP CONNECT 代理，不是普通 HTTPS 反代。客户端通过 `http://127.0.0.1:18080` 使用代理，代理解析平台域名；SSH 负责到云端的访问。代理不解密 HTTPS，Agent mTLS 仍由 Server 校验。

两种方式都是客户端主动连接。非 HTTP 端口按需填 `KQ_EXTRA_FORWARDS`（空格分隔 `本地端口:云端目标:端口`）；不要为没有用途的内部数据库开放转发。只转发 HTTP 统一入口即可覆盖本轮 Agent、材料和对象流量。

## 3. 预检、下载和注册

```bash
cd "$HOME/kq-onboarding"
bash -l bootstrap.sh "$PWD/site.env" check
bash -l bootstrap.sh "$PWD/site.env" install
# install 注册后自动执行完整 doctor；以后可单独重跑：
bash -l bootstrap.sh "$PWD/site.env" doctor
```

- `check` 不需要平台地址或转发端口，只读检查本地工具、Python >=3.9、路径及状态盘，并在5秒超时内用 `sinfo` 确认所选分区存在且 UP；不查询或输出节点/account清单，不提交作业，不联网或创建目录。UP 不代表已验证 account/QoS 权限或计算节点运行。
- module 可用时实际加载 Python；check 在子 shell 探测 Apptainer module 与版本，不污染父 shell。Spack关闭时 Apptainer失败不阻止基础接入，报告明确显示 failed/not-tested；启用Spack时要求实际可用。没有 module 的自带Python模式仍可检查，但不虚报 module通过。
- `check` 同时只读查询 user-systemd 和 linger，缺失显示 unavailable/not-tested；不会启动服务、修改 linger 或将未知常驻条件算通过。持久保留策略、退出登录及重启后的监管效果仍需现场确认。
- `doctor` 拉取已签名的 CLI，自动使用本地 Agent 证书证明申请短期探针，检查 HTTPS、注册身份、独立 mTLS HTTP/2 双向流、材料 HTTP GET、对象 GET/PUT 与分片。它不替换已有 Agent 控制流。缺身份或端点时报告 `not-tested`、返回非零，不能算通过；真正 Slurm/Spack 安装另行验收。报告保存在 `$KQ_LOCAL/doctor.json`，不包含凭据或下载 URL。
- `install` 从平台获取签名清单，验证 Ed25519 签名、平台 revision、版本序号、架构、glibc/CPU 与各文件 SHA-256。下载中断保留 `.part`，重跑可续传。
- 首次注册默认在终端隐藏输入一次性 token，经 CLI stdin 提交，不进入命令行 argv。也可在配置里设置 `KQ_REGISTRATION_TOKEN_FILE=/本机私密路径/token`（权限 `0600`），或设置为 `-` 并使用 `bash -l bootstrap.sh "$PWD/site.env" install < /本机私密路径/token`。不要把 token 正文写进配置或命令。已有身份会检查配置完整性、证书及私钥配对，再决定复用。注册成功后自动生成 `$KQ_SHARED/helpers/modules-smoke.sh` 并执行分通道诊断；无需再上传小作业脚本。
- 若注册中途进程崩溃且 token 消耗结果未知，会保留 `registration/pending` 并停止；先在平台对账 Agent 身份和证书，不自动申请第二个身份。已有 `agent.env` 为空、截断或证书不完整时同样停止，不能删除 pending 后盲目重注册。

基础前提为 Bash、SSH、curl、Python 3、支持 Ed25519 验签的 OpenSSL、flock、findmnt 和 Slurm 命令；Python 通过已有 `bio-python/3.11-2026.07.24` module 加载。缺少系统工具会明确报错，不执行 apt/pip/npm。CLI、Agent、Spack 入口和 SIF 从平台发行包获得。

如果端口已有监听，先核实它是本用户的 KQ 隧道，再在配置中设置 `KQ_REUSE_TUNNEL=1`；脚本不会随意终止占用端口的进程。

## 4. 常驻和首次作业

```bash
bash -l bootstrap.sh "$PWD/site.env" services
systemctl --user status kq-tunnel kq-agent
journalctl --user -u kq-agent -n 60 --no-pager
loginctl show-user "$USER" -p Linger
```

首次服务启动后，将 `KQ_REUSE_TUNNEL=1` 写入 `site.env`，供手动诊断和定时更新复用。更新服务也设置该值，但 `site.env` 中显式的 0 会覆盖它。

没有 user-systemd 或 linger 条件时，用站点批准的进程监管方式运行生成的 `$KQ_LOCAL/run-agent.sh` 和 SSH 命令；这类站点不宣称已实现退出登录或开机自启。模板不会请求 root 权限。

平台应出现本站 Agent、Slurm 队列库存以及 `cn` 映射。用[工具包的 modules 小作业](README.md)验证 native Slurm 和 KQ 两条路径，确认日志、结果与 scheduler job ID。保留脱敏 `result.json` 及摘要，用其中的计算节点 OS/CPU/工具链观测准备本站 SIF/profile；可选编译器与 MPI 需要在配置中显式选择。计算节点只读写共享目录，不把登录节点的 localhost URL 放进作业脚本。

手动传文件前，平台维护者还须登记仅绑定本站Agent的共享文件根并检查可用性；Agent在线不代表任意共享目录已经授权。出现 `Transfer cluster path is outside allowed roots` 的403时，先核对文件根的Agent绑定、路径和启用状态，不能通过扩大到整个HOME或更换Agent绕过。详细步骤见[平台准备](../../docs/offline-slurm-site.md)。

提交 KQ 小作业前，由已登录平台的控制端查询 `GET /platform/api/agents/:agentId`，确认 Agent 在线、控制通道在线、queue 可用，并等待 `computeHealthStatus=ready`、观测距当前不足 60 秒且 `operationalNodeCount>0`。刚启动的 `unknown` 或仅 doctor 通过尚不能派发计算任务；未就绪时查看计算节点探测错误，不反复提交任务。平台地址包含其他 base path 时使用实际 API 路径。

## 5. Spack 从平台拉取

运行软件Workflow前，由平台维护者核对冻结软件revision和用例中的Spack参数，使激活用的完整spec与本站ready安装记录一致；编译器、MPI和依赖变体不能省略为一个版本号。相关配置见[平台准备](../../docs/offline-slurm-site.md)。

平台先发布匹配本站计算节点的 `runtime-sif`、`site-profile` 和可执行 `spack` 入口，并完成 recipe/lock/源码/resource/patch 的离线导入与绑定。不能把 Forge 源码 OCI 包当作已验证的可运行 SIF。

在维护窗口停止 Agent，把 `KQ_ENABLE_SPACK=1` 写入配置，重新执行 `install`。配置修改或发行版本改变时，均需设置 `KQ_MAINTENANCE_WINDOW=1`。相同版本的普通重跑复用现有配置；只有维护模式才重写配置。脚本把验证后的 SIF、站点配置和 Spack 入口复制到共享 release，生成 single-user 信任模式与 Slurm executor 配置，再由用户启动 Agent。共享 SIF/profile/Spack 拷贝先写临时文件，校验并同步后原子发布；中断后可重跑，已有完整内容会复验复用。

软件页面若提示“材料闭包尚未验证”，由有权操作本站 Agent 的用户在 CP 门户显式发起准确 spec 的安装审计；该提示不代表材料已齐全。操作及原生 OCI 客户端限制见[材料就绪说明](../../docs/offline-slurm-material-readiness.md)。

site profile 的 storeRoot、OS 摘要、externals 和 target 必须真实匹配；不能篡改 lock 来绕过匹配检查。audit、install、verify 都走 Slurm，输入只读、网络隔离和 cgroup 限制失败会阻止执行。

启用 Spack 时，签名发行必须同时有 `runtime-sif`、`site-profile` 和可执行 `spack`。初始化在消费一次性注册 token、推进更新高水位或切换配置之前，核对 profile 的 runtime 摘要、本站能力声明和位于共享盘独立子目录的 storeRoot。缺件或绑定错误时旧版本保持可用；主机文件、原生 lock、工具链和计算节点的最终验证仍由 Agent 隔离审计和安装执行。

构建 staging 中的 `slurm.json` 保存唯一 job name、scheduler ID 和输入绑定。激活前逐个核对当前用户队列中没有相同 job ID/name；所有 Slurm 查询限时 5 秒，失败或不确定时保留当前版本。新版 `noRequeue:true` 的持久终态记录在队列为空时可作为已结束证明，不依赖永久保留 accounting。其余记录须有精确 ID 的 accounting 终态；旧格式还须 controller 返回相同 JobId、终态和 `Requeue=0`，仅本地终态或 PREEMPTED 不足以放行。结果不确定时先查 `squeue/sacct`，禁止直接删除 writer lock。新版 `kq site recover-spack` 在确认旧进程、作业终态和绑定后追加恢复记录，再允许正常重试；命令见[Slurm 恢复手册](../../docs/offline-slurm-recovery.md)。

## 6. 更新与回滚

用户服务安装一个每六小时、最多随机延迟三十分钟的更新 timer，只暂存，不自动替换运行版本。若手动操作已持有 bootstrap 锁，定时任务以 75 跳过本次，用户服务将其视为正常结束；不覆盖正在运行操作的状态，下轮继续检查。

```bash
bash -l bootstrap.sh "$PWD/site.env" stage
cat "$KQ_LOCAL/status.json"
# 平台暂停派发新软件操作，确认安装 worker 已结束，再进入维护窗口：
systemctl --user stop kq-agent
KQ_MAINTENANCE_WINDOW=1 bash -l bootstrap.sh "$PWD/site.env" activate
systemctl --user start kq-agent
systemctl --user is-active --quiet kq-agent
```

激活检查 Agent 状态锁、未结束或状态不明的 Slurm 构建以及 stateFormat。格式不兼容时拒绝切换，旧版本保持可用。二进制/配置从同一 current release 读取；运行中的 Slurm 作业不会被切换脚本取消。首次上线到含提交中标记的新版后，不可回滚到不识别该标记的旧 Agent。

同格式的本地回滚：

```bash
systemctl --user stop kq-agent
KQ_MAINTENANCE_WINDOW=1 bash -l bootstrap.sh "$PWD/site.env" rollback
systemctl --user start kq-agent
systemctl --user is-active --quiet kq-agent
```

回滚恢复旧 release 中保存的 Agent 启动配置，不把当前 `site.env` 的故障配置重新写入旧版；仍校验保存配置与现有 Agent 身份、证书及状态路径的绑定。旧配置缺失或身份不一致时停止，不自动重注册。若需要同时变更站点配置，应先修正配置，再按维护窗口执行普通激活。

激活先在同一状态盘准备 current、previous 和状态记录及恢复副本，再切换；空间不足或提交重命名失败时恢复原指针和元数据，反降级高水位不降低。磁盘永久只读、文件系统损坏或进程在提交途中被强杀仍需按实际 `current`、`previous`、残留 `.activate-*/before` 恢复副本及作业状态对账；不要仅凭旧状态文件判断版本。`services` 启动后检查 tunnel、Agent 和 update timer 的 `is-active`，任一失败都会返回非零；这只证明检查时活跃，不代表长期连接或作业验收成功。服务失败不自动回滚，以免已有新 writer 或作业时擅自切版本。

回滚不回退 PostgreSQL/SQLite 数据，也不修改已运行作业固定的软件 release。

## 7. 故障验收

1. 运行 90 秒 modules 作业，停止再恢复隧道；核对同一个 Slurm ID，没有重复 sbatch。
2. 测试 SSH 异常退出和 Agent 被终止后的用户服务重启；人为 `systemctl stop` 不会触发自动重启。
3. 中断材料下载，重跑同一操作，确认 Range offset 和最终 digest；材料票据过期后应刷新同一 manifest 的票据。
4. 上传中断、对象完成响应丢失或 Server 重启后，在平台认证会话调用 `POST /platform/api/files/transfers/<id>/resume`，确认原 uploadId、分片进度或原 file id。已保存 completion 时 Agent 离线也可完成；元数据与授权在同一事务中提交。重新授权失败必须停止；源文件改变不能复用旧分片。
5. 对带文件输出的 Workflow，在计算完成后中断上传或重启 Server，按[输出发布恢复](../../docs/workflow-output-recovery.md)查询同一个 job 的 publication，核对固定 transferId、文件 ID、最终摘要和目录释放顺序。此机制不自动续跑已失败的 DAG。
6. 损坏新发行文件、使用旧序号或不兼容 stateFormat，确认不能激活，旧版仍可启动。

普通作业在 `sbatch` 返回丢失、无有效 ID 或进程被终止时保留提交记录，不上报虚假失败、不重复提交。Agent 在重连、重启及默认每 30 秒串行对账同一作业 UUID。默认 host 路径在 `sacct` 查询非零失败时严格回退 controller，校验完整 UUID、稳定作业名、account 或当前 UID，并要求 scheduler ID 唯一；显式 controller 模式同样遵守这些条件。`sacct` 成功但记录尚不可见时仍等待，不猜测终态。controller 历史受 `MinJobAge` 限制，证据已清除、查询失败或冲突均保持待确认，不重复 `sbatch`。无需为记账延迟反复重启 Agent。取消须找到同一 scheduler ID，并确认 Slurm 明确终态后才清理记录和输入；`scancel` 请求受理不等于已经停止。详见[提交恢复边界](../../docs/slurm-submission-recovery.md)。

材料续传当前只节省集群/SSH 链路，Server 对 Registry 仍做整件校验。部分文件与上传 checkpoint 保留供恢复；旧完整缓存、无引用工具发行和明确失败的过期构建现场可按[站点维护步骤](../../docs/slurm-site-maintenance.md)预览及清理。应用计算 checkpoint 仍由具体软件负责。

工具包提供代码和操作步骤；真实云端网关、实际发布物、Slurm/Apptainer 与共享盘行为须按上述步骤现场验收。

平台 Agent 页面可展开站点运行状态，分别查看材料、安装、作业、文件传输和更新。离线/过期报告与尚未上报会明确显示；`unknown` 不表示空闲，`blocked` 需要先对账。部署方须执行新增两项迁移并启用对象存储诊断，详情见[平台手册](../../docs/offline-slurm-site.md)。

启用 `KQ_ENABLE_SPACK=1` 时，`KQ_SPACK_MANAGED_MEMORY_MIB` 配置托管安装预算，默认 4096 MiB，允许整数 1024..1048576（1 TiB）。Slurm 调度预留 `max(2048,预算)+512 MiB`（source audit 固定使用 2048 MiB），不得超过本站显式填写的 `KQ_SLURM_MEMORY_LIMIT_MIB`。预算须同时满足软件峰值和节点资源；能被调度不代表不会 OOM。云端 `RealMemory=3400` 的 samtools 测试中，2048 MiB 预算曾 OOM；2816 MiB 预算、3328 MiB 申请成功，但不能承诺本站或其他软件也够用。无效预算会在注册、激活或更新发行高水位前被拒绝。

受管安装还要求新鲜、绑定本站分区、runtime 摘要与预算的计算节点能力报告。先保持 Spack 关闭并暂存签名 runtime，再按[能力采集与预算](../../docs/slurm-site-capabilities-and-budgets.md)在计算节点完成实际隔离探测；不能用登录节点的 `module avail` 或 linger 替代。`failed/not-tested` 不放行受管安装，基础 modules 接入可独立进行。

容量、清理预览、可选每日空闲清理、一致备份及受保护的跨 stateFormat 恢复命令见[站点维护](../../docs/slurm-site-maintenance.md)。普通 `rollback` 仍拒绝不兼容格式；恢复备份前出现新作业、nonce 或传输进度时拒绝丢弃新状态。

维护切换先确认 `squeue` 无原 JobId/JobName，再有界查询 `scontrol show job`：只有唯一精确 JobId/JobName、终态且 `Requeue=0` 才放行。未启用 accounting 时依赖 controller 的有限保留期；记录丢失后，仅可使用已有 no-requeue 持久终态证明，或 no-requeue 提交记录加 accounting 终态。未知状态仍需人工对账，不删除 journal 绕过检查。

`services` 为 Agent、隧道、更新 service 和 timer 写入安装时真实主机名的 `ConditionHost`。即使 HOME 与用户 systemd unit 在登录节点和计算节点之间共享，其他主机也会跳过这些 unit，不会因 PAM 启动用户 systemd 而误启服务。主机改名或迁移后须在目标登录节点重新执行 `services`；已有部署也须重跑一次以更新 unit 条件。

`KQ_SPACK_INSTALL_TIMEOUT_MS` 设置托管安装超时（毫秒），默认 21600000（6 小时），允许整数 60000..86400000；启用 Spack 时写入 `AGENT_SPACK_INSTALL_TIMEOUT_MS`，无效值在注册、激活和发行高水位更新前拒绝。必须按实际站点 partition 上限配置，例如 30 分钟上限填写 1800000，以免 Slurm 因 `PartitionTimeLimit` 一直排队；bootstrap 不自动探测或调整 partition 时限。

用户 systemd 不继承登录 shell 的 module 环境。注册配置仅按 release 保存 `KQ_MODULE_INIT`、`KQ_PYTHON_MODULE`、`KQ_APPTAINER_MODULE`，launcher 在执行 Agent 前重载明确选择的 modules，使 `LD_LIBRARY_PATH` 等 module 环境生效，不保存整份登录环境。配置了 module 名却无法初始化 `module` 命令时启动明确失败；没有 module 配置的部署及缺这些字段的旧 release 继续直接启动。签名入口可使用 `/usr/bin/env python3`，以选择 module PATH 中的解释器。
