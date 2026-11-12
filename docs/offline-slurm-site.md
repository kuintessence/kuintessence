# 离线 Slurm 普通用户站点

本页描述源码能力与部署契约。现场基线：普通用户、HOME 共享、分区 `cn`、SSH Host `kq-service`、预置 Python 3 和 Apptainer modules。平台和站点均须升级后才能使用新增契约。集群操作由现场用户执行；本文未代表真实集群验收。

现场源码、配置模板和先 inventory 后发行的操作步骤见[普通用户站点工具包](../examples/slurm-user-site/README.md)，初始化见[SSH 接入手册](../examples/slurm-user-site/SSH-TUNNEL.md)。不要将云端 Ubuntu 测试发行直接用于未知 HPC。

## 网络：一个入口，两种客户端方式

默认 `ssh-forward`：Agent/CLI 使用真实 HTTPS URL，底层连接映射到 `127.0.0.1:18443`，SSH 转发到云端统一入口。平台域名和 Agent 域名使用不同 TLS SNI，共用入口端口。普通 API 经原有 HTTPS 网关，Agent SNI 透传到 Server direct mTLS listener；后者仍完成证书链、有效期、撤销与 Agent 身份校验。

可选 `http-proxy`：SSH 转发云端 HTTP CONNECT 代理端口，客户端显式使用本地代理。CONNECT 不解密 TLS。只设置系统 `HTTPS_PROXY` 不构成配置，必须设置 KQ 的传输模式。

| 参数 | 契约 |
| --- | --- |
| `KQ_TRANSPORT_MODE` | `ssh-forward` 或 `http-proxy`；不配置时保留既有客户端行为 |
| `KQ_ALLOWED_ORIGINS` | 空格分隔的 HTTPS origins，无 path；每个目的端必须在表内 |
| `KQ_FORWARD_MAP` | JSON，例如 `{"https://platform.example.com":{"host":"127.0.0.1","port":18443},"https://agent.example.com":{"host":"127.0.0.1","port":18443}}` |
| `KQ_HTTP_PROXY_URL` | HTTP 代理 origin；本轮使用 SSH 认证，不支持 URL 内代理密码 |
| `KQ_TLS_CA_FILE` | 可选 PEM 信任包；同时覆盖业务入口和 Agent 服务端证书链 |
| `SERVER_HTTP_URL` | API base，如 `https://platform.example.com/platform` |
| `SERVER_GRPC_URL` | Agent SNI origin，如 `https://agent.example.com` |

初始化脚本根据两条业务 URL 自动生成 allowlist、连接映射及代理地址，写入 Agent 启动配置。额外业务域名须显式加入 `KQ_ALLOWED_ORIGINS` 并在网关配置对应路由。Bun fetch、HTTP/2、宿主 curl 均使用同一策略，保留 HTTP Host、TLS SNI 和预签名 path/query。自动重定向被拒绝，平台必须给机器客户端返回最终可达 URL。没有公网直连回退。

容器内 localhost 与登录节点不同；启用站点传输时拒绝旧的容器内 curl 下载，改用宿主 Agent 预先准备共享文件。计算节点不连接本地隧道。

## 云端准备

1. 按正常发布流程构建修改后的 Server、CLI 和 Agent。先执行数据库迁移，再启用 Server。新增迁移 `0073_classy_dagger.sql` 为 `file_transfers` 增加 nullable `resume_session`，`0074_neat_zarda.sql` 为 `agents` 增加 nullable `site_operations`，`0075_workflow_output_publications.sql` 增加普通 Workflow 输出发布 outbox，`0076_workflow_output_publication_pending_index.sql` 增加待处理记录局部索引，`0077_workflow_output_publication_intents.sql` 保存与 Workflow job 同事务创建的输出发布意图。先升级 Server，再升级 Agent：新版分片 URL 响应关联字段需要 Server 回显；旧 Server 不能为新 Agent 提供该保证。本次没有运行远端迁移。
2. 在既有 platform Docker network 上配置 `deploy/site-gateway/compose.yml`：`PLATFORM_HOST`、`AGENT_HOST`、`HTTP_GATEWAY_UPSTREAM`、`AGENT_MTLS_UPSTREAM` 均填实际值，两个主机名必须不同。`KQ_SITE_BIND` 默认 `127.0.0.1:18443`，供 SSH Host 转发。已有 HTTP 网关继续提供 TLS；Agent upstream 配置 `MTLS_MODE=direct` 及真实服务端证书。模板默认拒绝未知 SNI。
3. 校验 OCI `/v2/`、材料 API、对象 bucket 路径和认证挑战。对象 URL 由 Server 按统一入口签名，客户端不修改签名 authority；不能添加额外 S3 path prefix。普通 HTTP 网关的大文件路由关闭缓冲，设置适合大文件的超时。平台域名 DNS 从云端解析；集群通过连接映射无需解析该域名。
4. 正向代理模式可使用现有合规 HTTP CONNECT 代理。新增 `deploy/site-gateway/squid.conf.example` 提供只允许两个平台域名和 TCP 443 的配置样例；监听仅开放给 SSH 可达的内部地址，不做 TLS 解密。
5. 配置 `SITE_RELEASES_DIR` 并把同一个发布目录以只读卷挂载到 Server。未配置时不开放站点发布接口。签名私钥保留在发布端，不挂载到 Server 或集群。
6. 注册后核对本站 queue 与 Agent/partition 绑定；同时通过 `POST /platform/api/admin/cluster-file-roots` 登记所需的共享文件根，明确 `providerOrgId`、本站 `agentId`、绝对 `path`、`enabled=true` 和必要的 `visibleOrgIds`，再调用 `POST /platform/api/admin/cluster-file-roots/:id/check`。仅注册Agent不会自动授权文件访问；已有其他站点的文件根也不会覆盖新Agent。只开放实际输入/输出测试目录，不把整个HOME或本地状态盘开放。文件根缺失时手动传输会在创建记录前返回403，须先由有权限的操作者补根配置，再重试原创建请求；已有transferId时用原ID恢复。

统一入口部署示例（值由运维填写）：

```bash
export PLATFORM_HOST='平台证书中的域名'
export AGENT_HOST='Agent证书中的域名'
export HTTP_GATEWAY_UPSTREAM='已有HTTPS网关主机:端口'
export AGENT_MTLS_UPSTREAM='direct-mTLS监听主机:端口'
export PLATFORM_NETWORK='已有Docker网络名'
export KQ_SITE_BIND='127.0.0.1:18443'
docker compose -f deploy/site-gateway/compose.yml config
# 审阅渲染配置、证书、上游后，由部署方执行 up -d。
```

Nginx 模板依赖 stream/ssl_preread 模块；固定的 `nginx:1.27-alpine` 镜像已静态编译这些模块，无需 `load_module` 加载 `.so`。云端容器未在此次本地验证中启动，部署方须执行 `nginx -t`，并实际测试 HTTP/2 双向流；仅访问 HTTP health 不算验收。

## 签名站点发行包

平台通过以下只读接口交付：

- `GET /api/site-releases/:channel/manifest.json`：当前通道清单。
- `GET|HEAD /api/site-releases/releases/:sha256/:name`：固定清单目录下的签名及文件，支持 `Range: bytes=N-`、ETag、If-Range。

Web path 部署在上述地址前加 `/platform`。这些接口与既有 Agent 下载一样不授予注册或材料授权。只发布可公开分发、不含凭据的工具；受限软件继续走材料票据链路，不能放进公开发行目录。

manifest v1 必须包括 `sequence`（单调递增）、`serverRevision`（真实 40 位构建提交）、`stateFormat`、`architecture`、`minGlibc`、`cpuFlags`、`redistribution: unrestricted`，以及文件数组。每项包含 `name/role/size/sha256/executable`；必须各有一个 `agent` 和 `cli`。Spack 接入再提供 `runtime-sif`、`site-profile` 和可执行 `spack` 入口。

本版新增失败安装依赖复用的严格记录、旧 worker 停止证明及恢复验证证据，正式发行使用 `slurm-site-v5`。旧 `slurm-site-v4` 已包含作业提交中标记、持久终态快照和 Slurm worker generation，但不能读取新增安装记录。初始化继续拒绝 v4→v5 原地激活及 v5→v4 普通回滚；旧站点须另行审查迁移，新站点可首次安装 v5。此字段是发行契约，不能为了允许切换而伪造相同值。

`spack` 入口可作为与同目录 SIF 配套的可移植启动脚本，支持平台现有 `SpackManager` 的版本/查询调用。其自身也需摘要校验。SIF 内的固定 `/opt/spack` 必须包含离线 solver/bootstrap 依赖；仅提供 Spack 源码压缩包不足以初始化受管运行环境。

```bash
# 一次生成 Ed25519 发布密钥；私钥权限 0600，公钥通过可信渠道放入现场配置。
openssl genpkey -algorithm ED25519 -out release-key.pem
chmod 600 release-key.pem
openssl pkey -in release-key.pem -pubout -out release-key.pub.pem
# 按发行准备手册填写request.json，构建独立CLI/Agent及可信附加文件：
bun deploy/site-release/prepare.ts request.json /tmp/kq-release-review
# 审核manifest.json和prepare.json后，单独签名发布：
bun deploy/site-release/publish.ts /tmp/kq-release-review/manifest.json /tmp/kq-release-review/artifacts /站点发布根目录 stable release-key.pem
```

发布工具校验复制后的文件大小和摘要、签名原始 manifest 字节，再原子切换通道指针；同一内容可重复发布，通道拒绝降低序号或复用序号发布不同内容，不重启服务。同一通道使用发布锁互斥，竞争者明确失败；崩溃遗留锁必须先核实发布进程已停止，不自动抢锁。清单 SHA-256 是不可变发行目录 ID。初始化端先取清单，再按其 digest 获取签名，避免通道切换时混用两次响应。

准备工具与签名发布独立，显式记录目标架构、Bun target、glibc/CPU、状态格式和源码是否含未提交修改；可绑定计算节点 inventory 的原始摘要，并在 `requireSpack=true` 时拒绝缺失或不匹配的 SIF/profile/Spack 入口。具体输入与审核步骤见[发行准备手册](site-release-preparation.md)。已构建 CLI 可以执行 `--help`，不通过启动 Agent main 验证产物。

Forge OCI 源码布局不等于 runtime SIF。科学软件的 recipe、lock、源码、resource、patch 及编译依赖继续通过现有离线交付导入、绑定和 material preflight。未完成闭包或未匹配本站 OS/CPU/MPI 的包不会因此变成可安装。匹配本站的 SIF、site profile 与材料需由平台准备和发布，本次没有制造虚假的现场构建产物。明确启用离线传输的站点，在尚未安装且缺少可信闭包证明时不会显示“可安装”；仍可显式发起隔离安装审计，成功 build/verify 后才成为已安装。材料证明边界及原生 OCI 认证限制见[材料就绪说明](offline-slurm-material-readiness.md)。

受管软件的Workflow还须声明与已安装记录一致的完整Spack spec。解析器优先使用冻结软件revision的`spack.defaultSpec`，缺省为`package@version`；用例的`software.argumentList`可声明编译器、依赖和变体后缀，由执行器拼接后进行正常激活。已安装记录包含额外依赖约束时，只有`package@version`的简写不等于该完整spec。遇到`Workflow Spack activation failed`，先核对冻结revision及用例参数与本站安装记录，不重新编译、不修改ready记录，也不把PATH写入命令绕过激活。参数修正必须作为新的受治理用例版本发布，已冻结的失败Workflow不自动换版本续跑。

## 普通用户执行与恢复

`AGENT_SPACK_TRUST_MODE=single-user` 允许 root 或当前 UID 持有的已固定文件，仍检查所有者、父路径、摘要和只读 SIF；默认 `administrator` 保持原有保护。这个模式不隔离同一 Unix UID 的恶意进程。`AGENT_SPACK_EXECUTOR=slurm` 将 audit/install/verify/load worker 提交到 Slurm，`AGENT_SLURM_BIN_DIR`、`AGENT_SPACK_BUILD_PARTITION/ACCOUNT/QOS` 控制调用路径和资源归属。

初始化配置 `KQ_SPACK_MANAGED_MEMORY_MIB` 默认为 4096，允许 1024..1048576 MiB（1 TiB），贯通 Agent、Slurm、Apptainer 与 worker。Slurm 申请 `max(2048, budget)+512` MiB，必须不超过站点显式填写的 `KQ_SLURM_MEMORY_LIMIT_MIB`；对应 Agent 配置为 `AGENT_SPACK_SLURM_MEMORY_LIMIT_MIB`。小节点可按实际负载与容量明确配置，例如预算 2816 对应申请 3328 MiB，不降低容器隔离。新版普通用户受管初始化还要求新鲜、绑定分区/runtime/预算的计算节点隔离与能力报告。controller 保留明确终态时可在未开启 accounting 的站点完成维护对账；controller 与 accounting 均无记录时仍须保留现场，不推断作业已结束。

材料、SIF、site profile 和 worker staging 必须在共享盘。初始化复制 SIF/profile/Spack 时采用同目录临时文件、摘要校验和原子发布，中断重跑不会复用半件文件。SQLite/WAL 和 Agent 锁必须放可靠持久本地盘。初始化对共享或未知类型的状态盘报错，不静默写入共享 HOME。

`bootstrap ... check` 只读确认状态路径不位于 HOME、配置的共享根或常见临时目录，挂载可写且为允许的本地文件系统；同时有界查询所选 Slurm 分区是否存在且 UP，并分别报告 Python/Apptainer module、user-systemd、linger 的观测结果。它不提交作业、不建立云端连接，也不证明本地盘保留期限、account/QoS 授权或计算节点能力；这些仍须现场验收。

Slurm 构建先 `sbatch --hold`，保存带唯一 job name 的 `slurm.json`，再 release；身份未知、取消结果未确认时保留 staging 和 writer lock，不重复提交。worker 在计算节点采集 namespace 元数据。Apptainer 的网络隔离、PID namespace、cgroup 限额仍强制验证，未提供所需能力的集群会明确失败。

rootless Apptainer 的 cgroup 管理由**计算节点**的用户 systemd 提供；该管理器必须在整个作业期间存活，不能仅由 Slurm prolog 的短暂 PAM 会话启动。否则会话退出后的清理可能向 Apptainer scope 发送 SIGTERM，表现为退出 143。站点可通过正确的 Slurm/PAM 生命周期集成或管理员维护的用户管理器实现；登录节点的 linger 不证明计算节点已具备该能力，普通用户初始化不会自动更改系统策略。

managed install 当前保持容器本地 tmpfs scratch，并由 worker 检查其边界。Apptainer 的 `sessiondir max size` 默认可能只有 64 MiB，无法承载真实源码、solver 和构建临时文件；站点需提供足够容量并结合 worker cgroup 内存预算。腾讯云验收将此容量设为 2048 MiB；源码审计保持 2048 MiB cgroup，managed worker 在 2048 MiB 预算下触发 OOM 后改用 2816 MiB 预算，保留 cgroup 限额；这是测试节点的管理员配置，不表示普通用户可覆盖任意站点策略。source audit 使用独立私有磁盘 scratch；失败保留目录会占共享盘配额，应确认没有活动 worker 后再归档清理。

worker 优先查询 Slurm controller，核验精确 JobId、JobName、JobState、ExitCode 与 `Requeue=0`；controller 明确报告作业 ID 已不存在时才回退 accounting。accounting 未启用不妨碍仍由 controller 证明的等待、终态收集或显式恢复；没有记录或身份冲突仍保留现场，不视为已停止。丢失提交响应时，唯一的实时 squeue 记录可用于接管原作业，不重复 sbatch。

Slurm 内存请求为 `max(2048, AGENT_SPACK_MANAGED_MEMORY_MIB) + 512` MiB，覆盖固定 2 GiB source audit 与配置的 managed worker 预算并保留余量；默认请求 4608 MiB，配置 managed 2048 时请求 2560 MiB。该请求不改变 worker 内部隔离限额或宿主内存准入检查。预算必须覆盖 Spack recipe 加载、编译子进程和 tmpfs 的总峰值，不能只按软件可执行文件大小估算。调度器明确返回 `OUT_OF_MEMORY` 时，平台提示提高 managed 预算及匹配的 Slurm 申请；`FAILED 137:0` 或 `0:9` 仅报告进程被杀并建议检查资源，不将任意 stderr 中的 OOM 字样当作证明。

| 中断点 | 行为／恢复 |
| --- | --- |
| SSH 断线 | 用户服务保活重启；Agent 重连，运行中的 Slurm 作业不取消；仍在准备输入的派发不被重连误判为失败 |
| 网关 HTTP/2 平滑重启 | 收到 GOAWAY 后为新请求重新建立经过验证的隧道；已接受的旧流继续完成。新隧道 TLS 验证失败也不主动终止旧流；不会重放已经提交到流中的业务消息 |
| 普通作业提交后 Agent 崩溃或 sbatch 返回丢失 | 提交前保存完整 spec 和输出约定；返回未知、空/无效 ID 或提交进程被终止时保留记录；重连/重启以及默认每 30 秒串行查询同一 UUID 的 squeue/sacct，默认 sacct 查询失败时自动回退严格 controller 对账（精确 UUID comment、稳定名称及 account/当前 UID；controller 无保留记录仍视为不确定），恢复同一作业；查不到或不确定时不上报虚假失败、不重复提交。查询有超时，未知状态继续重试；未知提交的取消也须先确认真实 scheduler ID |
| 用户取消 | scancel 成功仅代表请求受理；Slurm 必须返回同一 ID 的明确终态后才清理输入和账本、发送取消确认。取消失败或仍运行时保留撤销记录，周期重试；关停不会重新接管已撤销作业 |
| 材料下载 | 保留 digest 绑定的部分文件，新实例从已有长度续传；完成后全量摘要校验才发布 |
| 登录节点对象下载 | 已授权 NetDrive 大小和摘要绑定 `.part`，短读自动重试，URL续签后继续；整件校验及原子发布，详见[下载与上传恢复](offline-slurm-multipart-recovery.md) |
| 材料票据过期 | Agent 私钥签名申请新票据，Server 核验当前证书、连接身份、权限、operation 和同一 manifest；签名时间窗口 60 秒 |
| 构建中断 | 相同 staging 重入查询旧作业；进程重启后用 `kq site recover-spack` 核对原 owner、operation、release、staging 和 Slurm 唯一终态，追加恢复记录后重新安装；见[恢复命令](offline-slurm-recovery.md) |
| 作业输出采集暂时失败 | 普通作业遇到已识别的临时 I/O 错误，保留活动账本并重试原作业的采集；新版已有真实终态快照时，重启后直接采集，不再依赖 Slurm/accounting 历史；旧记录仍需查询历史。不重新提交。缺文件、权限或安全错误不冒充网络故障；见[输出采集恢复](slurm-submission-recovery.md) |
| 结果上传 | Agent 保存分片摘要与 ETag；Server 保存 owner/Agent/source/target/uploadId 绑定，无长期 bearer token |
| 普通 Workflow 输出发布中断 | 普通 Workflow 在 job 提交事务内保存 intent，终态及采集事实持久化后可自动补建 publication；再复用逐文件 transferId、上传会话及已发布结果；全部文件提交成功后才释放工作目录。DAG 状态与文件恢复分开，见[输出发布恢复](workflow-output-recovery.md) |
| Server 重启 | 普通 Workflow 已入库 publication 自动扫描恢复；用户手动传输通过下述接口显式恢复，重新授权后复用同一上传会话，不重跑科学作业 |
| 科学应用被终止 | 需要应用自己的 checkpoint；KQ 不推断计算检查点 |

恢复传输使用已登录平台客户端调用 `POST /platform/api/files/transfers/<id>/resume`。仅允许恢复自己的 failed 传输，重查来源授权和集群路径权限。Agent 在线且原始输出未改变、对象存储会话未被清理时可跳过已上传分片。取消 failed 传输会清理其持久上传会话。若对象存储已完成该 uploadId，Server 使用持久 completion 重放最终提交，校验实际对象 SHA-256 并返回原 file id；网盘记录与授权 outbox 同事务。此时 Agent 可以离线。若 uploadId 与对象都已被清理，须新建传输。详见[最终提交恢复](offline-slurm-multipart-recovery.md)。

材料 Range 当前节省 SSH/集群链路字节：Server 仍读取并校验完整 Registry blob 后跳过前缀，不声称内部 Registry 链路已节省同样流量。Agent 的主机下载、材料缓存与上传本地 spool 新增字节/inode admission，明确它不代表共享盘用户配额。部分文件和上传回执继续保留恢复；站点维护可清理无引用工具发行、旧完整材料和已有终态证明的过期失败现场。手动清理、可选空闲 timer、一致 SQLite 备份与跨格式恢复步骤见[站点维护](slurm-site-maintenance.md)。

## 更新、诊断与现场验收

初始化工具支持 `check/doctor/install/stage/prepare-capabilities/activate/rollback/services/maintain`。首次注册可用终端隐藏输入，或 `KQ_REGISTRATION_TOKEN_FILE` 指定私密文件/标准输入；复用身份前验证完整配置与证书，注册结果不明时保留证据、不重复注册。默认更新 timer 每六小时检查、随机延迟最多 30 分钟，只暂存。暂存检查签名、摘要及profile绑定，不因旧计算能力报告过期而阻止拉取；启用新Spack配置仍要求新鲜且匹配的能力报告。激活或回滚须显式设置 `KQ_MAINTENANCE_WINDOW=1`，停止 Agent，并成功取得同一状态锁；仍有 Slurm 构建或其状态不明时拒绝激活。stateFormat 不同会拒绝切换。版本序号和发行摘要作为一条原子反降级记录写入，再发布暂存指针；普通激活也检查该记录，只有显式 rollback 能回退且不会降低已接受序号。完整命令见现场工具包说明，完整实施覆盖及验收顺序见[交付清单](offline-slurm-acceptance.md)。

平台 Agent 卡片新增可展开的站点运行状态，分别展示连接方式、单用户/管理员信任边界、安装执行位置、材料、安装、作业、传输和更新。报告只包含枚举、计数、时间与摘要；不上传本机路径、URL、token 或自由文本错误。报告过期或 Agent 离线时明确标为最后观测；旧 Agent 显示未上报。诊断证据为 `doctor.json`、`status.json`、systemd journal 和 Slurm `slurm.json`。

`kq site doctor` 使用现存 Agent 证书的签名证明自动取得短期诊断材料，检查 HTTPS、注册身份、独立 HTTP/2 mTLS 双向流、材料 HTTP GET、对象 GET/PUT 与 multipart 上传/下载。独立诊断流不注册或替换运行中的 Agent。没有凭据或服务未提供诊断端点时报告 `not-tested` 并返回非零，不能算通过。材料探针验证传输链路，真实 Spack 材料授权与闭包仍由安装验收验证。

平台须启用 `NETDRIVE_ENABLED`，正确配置 `NETDRIVE_PUBLIC_URL` 为无 path 的可达 origin。显式出口配置无效时启动失败，不回退内部地址。诊断对象使用独立 `site-diagnostics/` 前缀、五分钟会话，客户端结束时清理，服务定时清理失败会重试。Server 重启会失去内存中的探针会话，因此部署方还须为该前缀配置对象生命周期和未完成分片清理；不要把该策略应用到用户数据。

本地 bootstrap 测试已分别覆盖 SSH-forward 与真实回环 HTTP CONNECT 代理，检查原始 Host/SNI、签名下载、注册请求和代理失败不直连。测试中的 CLI/Agent 和注册 API 为受控 fixture，不能替代真实 CSR 注册及 OpenSSH 认证验收。

Agent 真实回环 mTLS/HTTP2 测试还覆盖两种模式的 GOAWAY、重连 TLS 失败及随后并发重连：原有流保留，新的并发请求共用一个新会话。此行为适用于网关平滑排空；TCP 已断开的流仍按既有消息回执与持久作业账本恢复。

现场验收顺序：两种网络模式的注册与 mTLS 双向流 → modules 作业 → 空缓存离线材料安装与真实软件作业 → SSH 中断 → Agent SIGKILL → 材料续传/票据过期 → 上传失败与 Server 重启恢复 → 更新损坏/不兼容和回滚。每项核对 jobId、uploadId、digest 与文件内容；未进行真实现场验收前不标记生产就绪。

## 现场发布与验收边界

代码和本地测试不代替现场运行。部署前仍须准备本站 OS/CPU/glibc、编译器与 MPI 匹配的签名 CLI/Agent、SIF、Spack 入口、site profile、lock 与完整离线材料。`module avail` 不是计算节点可运行证据；先执行 modules 小作业，再验真实软件。工具包的 `result.json` 提供版本化、脱敏的计算节点 inventory；编译器/MPI 只对明确选择的 module 做版本探测。该报告用于准备本站发行物，不证明整个异构分区或 Apptainer 隔离能力。

构建恢复先确认旧 Slurm worker 已停止且不会重新排队，并私密保留失败 attempt。相同 spec、材料、profile、runtime 下可在原 record/prefix 恢复：独立只读 Slurm 验证已完成依赖的安装清单、依赖闭包与文件内容；安装前后重查摘要、权限和 mtime，未完成根包重新构建，最后另起完整验证才发布 ready。不承诺从任意编译指令继续。无法证明原 owner 停止、缺少 staging 绑定、依赖损坏或 Slurm 记账不明确时拒绝，保留现场给站点调查。更新自动下载与维护激活分开，回滚必须满足相同 stateFormat 与停止 Agent/构建的条件。

本地已覆盖核心恢复分支、真实回环 TLS/HTTP2、真实 Ed25519 签名的双文件初始化全流程和界面状态。隔离 PostgreSQL 验收入口为 `bun run test:unit --suite offline-slurm-pg`，复用已有 CI PostgreSQL service，见[执行范围与数据库隔离说明](offline-slurm-pg-acceptance.md)。2026-11-11 已在授权的腾讯云环境完成独立 PostgreSQL、材料导入、两种真实 SSH 接入、普通用户初始化和真实 Slurm 作业恢复；冷安装与更新结果按独立证据记录，见[当前状态](status/current-state.md)。用户真实集群的 Slurm/Apptainer 权限、计算节点 ABI 及持久本地盘仍须现场验收。
