# 软件治理、生态与 Sandbox

Server 负责授权、审核、运行策略和调度判定；Registry 负责 catalog、不可变发布、
OCI 与 Spack buildcache；Agent 执行已授权的软件操作和计算。
目录条目记录软件信息；目标环境的安装状态和软件、数据许可需分别确认。

- [资产与发布](#governance)
- [CP 软件操作](#spack)
- [签名生态与数据](#ecosystem)
- [Sandbox 脚本](#sandbox)
- [Kubernetes 隔离](#kubernetes)

Registry JWT、namespace 和 artifact 回收见[安全指南](security.md#registry)，
工作流执行见[工作流指南](workflow-schema/README.md)，对象与计量见[存储指南](storage.md)。

<a id="governance"></a>
## 资产与发布

资产、版本和授权分别保存在 `software_assets/software_asset_revisions/software_asset_grants`。
`app_templates/usecase_packages/workflow_templates` 保存对应 API 数据，
写入时同步资产和 revision，工作流使用同一套 DSL。

| 来源 | 初始状态 |
|---|---|
| official-upstream Spack | `published/platform-public/trustedForGlobalUse`，来自本地 catalog metadata |
| platform-fork | 平台公开发布，默认公共 view/use/install |
| cp-private | provider 私有 draft，默认组织 view/use/install/edit |
| usecase / workflow template | 固定发布内容，记录 package/usecase 依赖 |

### 不可变版本

Workflow template 仅允许数据库当前角色为 `platform_admin/super_admin` 的有效用户写入。
发布前执行工作流 Schema 和跨字段静态校验，不允许 `advanced.skipStaticValidation`。
发布新版本创建新 template ID，原版本供 `SubWorkflow ByVersion` 与历史 run 解析。
相同 name/version 且 YAML、说明、标签一致时幂等复用，否则返回 409。
首次创建返回 201，重放返回 200；均包含 Location。
已发布 template 不允许删除。

Usecase 按 namespace、owner、name/version 做同样的不可变发布。
新版本使用新 package ID，已发布版本不可删除；内容冲突返回 409。
读可见性由 canonical principal 和 active organization 决定，不可见详情返回 404。
运行预检、preview、提交、恢复和叶子执行都会重查 scope。
退组、停用或权限撤销后，已有 ID 也受当前权限限制。

行、asset、revision 和 grant 在同一数据库 transaction 内提交。
通用 `/api/app-templates` 的写入仅限平台管理员，且排除 `spack-catalog` 行；
custom Spack 由 `/api/spack/catalog/packages` 管理，vendor 创建须显式传 `orgId`。

目录查询：

```text
GET /api/workflow-templates?page=1&pageSize=24&q=...&tag=...
GET /api/workflow-templates/:id
```

列表返回 templates、tags、total、分页信息；无效 page/pageSize 返回 400。
目录超过默认首 100 条时，需按返回的分页信息继续查询。

### 固定上游版本

`official-upstream/<name>/upstream` 是 catalog identity，不满足 exact workflow selector。
平台管理员调用：

```text
POST /api/spack/catalog/upstream/:name/versions/:version/snapshot
```

源必须是唯一、active、公开且 trusted 的 asset，包名与版本须精确匹配 metadata。
创建 `official-upstream/<name>/<version>`、revision 1、`defaultSpec=<name>@<version>`、
provenance、公开 grant、AuthZ outbox 和 audit。相同 identity 由 transaction advisory lock
串行化；重放返回原结果，不新增 revision。无权限 403、源不存在 404、
无效版本/源 422、冲突 409。grant 行写入后，还须等待 outbox 投递完成才能使用授权。

已存在的历史 direct-SQL fixture 不被 snapshot 自动领养。
经管理员逐项核对后，才使用显式接口：

```text
POST /api/spack/catalog/upstream/:name/versions/:version/supersede-legacy
{"legacyAssetId":"<uuid>","legacyRevisionId":"<uuid>","reason":"<reason>"}
```

它仅接受严格匹配的已知 fixture 形状，原子归档隐藏旧 asset、撤销旧投影、创建
canonical snapshot 和审计。旧 ID、payload、revision 与 provenance 保留，
相同参数重放幂等，不同参数或不符事实返回 409。
按名解析只取唯一 published 对象；不能删除 immutable revision 作为回滚。

### 审核与授权

生命周期为 `draft → submitted → approved/forked → published`，
随后可 hidden、deprecated、revoked 或 archived。
approve 仅表示审核通过；全平台可信 revision 由 official fork 创建并公开。
deprecated 通常只提示，revoked、hidden、缺 use grant 或 CP 拒绝会阻断运行。

| API | 用途 |
|---|---|
| `GET /api/software/review-queue` | 待审队列 |
| `POST /api/software/assets/:assetId/submit` | owner 或获准发布者提交 |
| `POST /api/software/assets/:assetId/review` | 平台审核 |
| `POST /api/software/assets/:assetId/fork-official` | 平台可信 fork |
| `POST /api/software/assets/:assetId/lifecycle` | 状态变更，拒绝/下架/撤销须 reason |
| `GET/PUT /api/software/assets/:assetId/grants` | view/use/install/edit/publish/review/admin |
| `POST /api/software/grants/complete-downstream` | 幂等补齐依赖 use grant |
| `GET/POST /api/software/access-requests` | 申请 view/use/install |
| `POST /api/software/access-requests/:requestId/review` | 批准后写 grant，拒绝保留原因 |
| `GET /api/software/assets/:assetId/review-detail` | revision、diff、依赖与 fork |
| `GET /api/software/assets/:assetId/impact` | 下游、授权、请求和 cache 影响 |
| `GET /api/software/mirror-cache/status` | mirror/cache 状态 |

普通 owner 提交自己的 draft 需要 `software_provider` capability；
平台管理员可维护所有资产。审核、fork、发布和撤销属于平台管理员。
运行时逐项检查 root asset、usecase、package、CP policy、Agent 和安装能力。
分享根资产后，下游依赖仍需分别授权。

<a id="spack"></a>
## CP 软件操作

`software_policy_overlays` 按 provider → cluster → agent 合并：

- `installMode/trustedPublicAutoInstall` 取最具体值。
- allow/deny/mirror/preinstall 名单去空、合并、去重；deny 优先。
- 任一层 `lockEnabled=true` 即锁定。
- `usecaseDefaultAllow/usecaseAllowList/usecaseDenyList` 控制用例准入。
  同一 spec 或 usecase 不可同时出现在 allow 与 deny 名单。
- 裸包名和 `name@version` 通配均可匹配；variant/compiler 不改变 name/version head 判定。

保存后生成 Agent effective policy，重连补推最新策略。
Server 与 Web 的 availability、preview、operation precheck，以及 Agent 守卫使用一致语义。

| CP API | 用途 |
|---|---|
| `GET /api/cp/software/overview` | policy、installed ledger、心跳与实时控制通道 |
| `PUT /api/cp/software/policies/provider` | provider 默认策略 |
| `PUT /api/cp/software/policies/clusters/:clusterId` | cluster 覆盖 |
| `PUT /api/cp/software/policies/agents/:agentId` | agent 覆盖 |
| `POST /api/cp/software/availability-preview` | spec/usecase 可用性 |
| `GET/POST /api/cp/software/operations` | 查询/创建单操作 |
| `POST /api/cp/software/operations/batch` | 批量 install/import_preinstalled |

| Action | 语义 |
|---|---|
| `install` | 默认材料准备/预检及可选 source audit 后仍 `rejected`；实验性 `AGENT_SPACK_INSTALL_ENABLED` opt-in 才进入持久化安装编排，未完成真实验收 |
| `uninstall` | 策略通过并确认后删除；受管安装以 DAG root 为单位清理独占 store 及其私有依赖 |
| `load` | 返回一次性 shell fragment，不改变未来作业环境；受管 root 须为当前 site profile 的 `ready` 记录，并经 readonly runtime 复验 |
| `import_preinstalled` | 验证现存 spec 并刷新 ledger，不安装 |

批量请求最多 2000 条原始行，trim/去空/去重后最多 200 个唯一 spec。
响应摘要包含 input、nonEmpty、unique、ignoredEmpty、ignoredDuplicate 计数。
先验证 Agent 存在及 CP scope，再逐 item 返回结果；批量请求可能部分成功、部分失败。
Web 保留失败输入，重试只回填待确认表单，不自动重放非幂等操作。

operation 使用 `queued → running → succeeded/failed/rejected` 单调状态机。
result 必须匹配 operation、Agent 与 action；已终态不被乱序消息覆盖。
安装/删除/导入成功后刷新 inventory：保留宿主 `spack find --json`，
并合并当前 site profile 下的 managed `ready` roots。
即使执行成功，ledger 刷新失败也会将 operation 记录为 failed。
已发布的受管安装复验失败会撤下 `ready` 状态及 Agent 后续心跳中的对应条目，
保留文件供诊断；显式复验通过后才能恢复，不把失败软件继续上报为可用。

Agent 断线期间的结果写 SQLite outbound queue，重连回放；Server 已 push 却未收到 running
时保持 queued，不自动判为失败或重发。离线时新操作直接 failed。
CP 页面应同时观察 DB 心跳与 live stream；“投递状态不确定”时先恢复连接、核对历史。
操作详情保留 error/stderr/stdout 和退出码。

Recipe 仓库支持本地 Git 持久化、初始化与 Web 导入 Git bundle、静态诊断、快照激活/回滚
和鉴权导出，见 [Spack Recipe 仓库](spack-recipe-repositories.md)。
源码/lock 支持本地材料 manifest 初始化及批量导入，先完成 recipe bootstrap，再复用
上传/发布校验。平台与 CP 门户可使用同一材料包 Web 上传，支持未完成项重试、
取消及按 binding 查阅；发布响应丢失显示结果待确认，不当作回滚。
材料目录支持按当前权限发现已有发布、精确仓库筛选、刷新和分页查阅；
单次最多返回 200 项，超限明确失败并提示缩小查询，不静默截断。
成功 binding 需显式配置到 Server，不自动激活 recipe、启用安装或执行内容。
Agent 已接入经 Server 下载固定 recipe archive 和源码、SHA-256 校验及持久缓存，
并提供默认关闭、固定 digest SIF 内的 source audit。默认仅审计路径通过后保留报告，
安装仍为 `rejected`；审计报告不代表 recipe 可信、完整依赖已正确求解或目标集群已就绪。

默认关闭的实验性 `AGENT_SPACK_INSTALL_ENABLED` 要求同时开启 source audit，
使用 host backend、非 Kubernetes adapter 和固定 site profile digest。
TypeScript 已接入 **隔离 build → 独立 readonly verify → ready**；
每次新安装事务独占共享持久化 `storeRoot/releases/<installation-id>/`，不共用可写依赖树。
managed inventory/load/uninstall 为 root-only，这里的 root 是 DAG root，不是系统 root 用户；
依赖不独立列出或管理，卸载清理该 root 的整个事务 store。
site profile 固定 target、runtime、宿主文件和 external 绑定；
shared storage、compute ABI、quota、recipe trust 的人工声明不等于自动验证。
Python install worker 已实现并通过模拟 native API 的 fixture 测试；
真实 Linux/Spack/Apptainer/SIF 与集群验收未执行，
`ready` 不等于生产就绪。配置与限制详见 [材料发布与 Agent 下载](spack-material-delivery.md)。

升级后平台的未受管 install/buildcache 导入被阻断；不能将这一阶段视为部署故障已修复。
Recipe 激活尚不自动应用到 Agent；静态诊断不等于实际 concretize 或安装成功。
受限厂商安装包/许可证授权、HTTP/SOCKS 上游代理、大规模材料索引/删除/可见范围变更及 15 个工作流的
目标 Linux 材料、lock 和端到端安装/运行验收仍未完成。
源码镜像同步、buildcache 后台 worker、signed air-gap bundle 导入导出及完整在线
`package.py` 编辑/构建执行器尚未全部具备，使用前需确认所需执行器已部署。

<a id="ecosystem"></a>
## 签名生态与数据

生态内容从签名 OCI bundle 导入。
软件、usecase、Sandbox script、workflow template 由 active release 和不可变 revision
管理。[示例目录](../examples/workflows/) 用于说明 DSL，使用时需绑定已发布的生态资产。
导入不触发 Spack install、script 执行或科学数据下载。

| 配置 | 含义 |
|---|---|
| `ECOSYSTEM_RELEASE_TRUSTED_KEYS` | `keyId -> base64 DER/SPKI` 公钥 JSON |
| `BLOB_STORE_DIR` | 持久 OCI blob 目录 |
| `ECOSYSTEM_RELEASE_OCI_REPOSITORY` / `ECOSYSTEM_RELEASE_OCI_DIGEST` | 成对指定启动同步来源，digest 不可变 |
| `ECOSYSTEM_RELEASE_AUTO_ACTIVATE` | 默认 false，显式开启才自动激活 |

```text
POST /api/ecosystem-releases/import
{"oci":{"repository":"public/scientific-ecosystem","digest":"sha256:<digest>"}}
POST /api/ecosystem-releases/<release-id>/activate
POST /api/ecosystem-releases/<release-key>/rollback/<target-release-id>
```

bundle layer 限制 32 MiB。导入先验 Ed25519 与 schema；
缺少可选 `specDigest` 时从已签名 canonical spec 推导，已有错误 digest 则拒绝。
激活时重新校验持久化 payload，即使内容已经 staged 也须通过检查。
data-product 只生成 metadata 与 immutable version placeholder，不携带数据 bytes。

### 数据引用与受限材料

治理能力包（`GovernedUsecasePackage`）的 Dataset 输入引用 Data Market；`dataInputs/dataRequirements`
在提交前匹配 selector、版本、schema、format、tags、大小、access mode、敏感级别、
许可与元素集合。未知 descriptor、latest、零匹配或多匹配均拒绝。
Server 冻结 asset/version/digest、selected entries、delivery policy 和 location，
历史 run 不重新解析浮动版本。

CP-local replica 必须 available、digest 一致且 `verifiedAt` 未超过 24 小时；
调度器取全部输入可用中心的交集。

Agent 使用 `AGENT_DATASET_ROOT/AGENT_JOB_WORK_ROOT` 受管根；
CP import 传 `agentId + managedRootId + relativePath`，不把 CP 绝对路径写入 Server。
非受限对象走短时 URL object-download，非受限本地数据走 stage-copy，
受限本地数据只走可信 readonly-mount。

POTCAR 仅由 Agent 本地 selector 或获 entitlement 的受限 runtime 解析，
只传 selector 与证明，不进入 Server、Registry、NetDrive、公共下载或任务输出。
licensed mapping 的 `auditMetadata` 只允许说明性字段且总量不超过 16 KiB，
拒绝 bytes、base64、content、path、credential、key、token、secret 类内容。

`licensed-material`，以及禁止 download/redistribution 的 restricted/regulated binding
冻结为 `restrictedNoEgress`。仅 active signed release 的可信 usecase/exact script
revision 可执行；禁止 raw command、日志/stdout 导出、普通 symlink 和 artifact 发布。
身份、签名、release、revision、source hash、grant、location 或 mount 不符均拒绝，
禁止回退 SelfAccount 或普通 Job。

受保护 delivery 的清理上下文会持久化，正常结束和重启恢复时均执行清理，
清理失败必须记录并处理。

<a id="sandbox"></a>
## Sandbox 脚本

Workflow `Script` 使用受管 Python、Node.js 或 Bash runtime。
镜像经扫描、签名并固定 OCI/SIF digest，运行时不允许 pip/npm 安装或外网下载。
Slurm/PBS/Torque 使用 Apptainer，与宿主共享 kernel，不提供 microVM 级多租户隔离。
Kubernetes 的网络边界见[下一节](#kubernetes)。

### DSL 与执行契约

节点固定 `AssetRevision`、asset ID、revision、SHA-256、runtime 与 I/O；
创建器从受管脚本库选择，不生成 Inline/Git 占位内容。
I/O 类型为 `Text/JSON/File/FileBatch`。
`locality` 可选 Auto/FollowInput/FollowConsumer/TargetSite/TargetStorage，
`durability` 可选 Ephemeral/Checkpoint/Persistent。
字段细节见[工作流规范](workflow-schema/README.md#dsl)。

| 容器路径 | 用途 |
|---|---|
| `/kq/context.json` | Job 与强类型 I/O context |
| `/kq/inputs/<descriptor>` | 只读输入 |
| `/kq/outputs/<descriptor>` | 独立可写输出 |

Agent 先验证 manifest 签名、nonce、runtime、identity 和 policy，再写入数据。
下载禁止 redirect，按签名上限 streaming 处理并校验 size/hash、entry 与 symlink。
输出只有在退出码为 0 且 required output 的路径、类型、大小、hash 和逃逸检查通过后成功。
stdout/stderr 有容量上限；受限 no-egress 路径不返回日志。

### 身份与受限执行

Inline/draft/AI 生成内容及实际 test run 只能使用 MappedAuto/MappedAccount。
published revision 仅在 source hash、runtime digest、扫描和有效 platform/provider
attestation 都匹配时可用 SharedService；attestation 不跨 revision 或 CP 继承。
原始 command 与 terminal 只用映射账号，执行前核对 username/uid/gid，拒绝 root 身份。

SelfAccount 默认关闭，只适用于 Slurm 且映射 Unix 身份等于 Agent 自身非 root 身份。
须有匹配 runtime、签名、compute node、有效 evidence ID/有效期的 attestation；
PBS/Torque 不可用，restrictedNoEgress 也不可用。
另须配置 `AGENT_SANDBOX_CGROUP_CHECK_PATH`、`AGENT_SANDBOX_CGROUP_CHECK_SHA256` 和
`AGENT_SANDBOX_ATTESTATION_QUEUE`。检查器须为 root 管理的规范绝对路径，完整父目录链
不可被组或其他用户写入；节点提供 Python 3.8+。启动探测在该明确队列申请 1 CPU/128 MiB，
实际核对本作业内核 CPU、内存及 swap 上限，再检查运行时隔离，不接受仅匹配 cgroup 路径。
证明 ID 绑定检查器路径/摘要及队列。队列随运行时能力上报，Server 签发前核对实际选中队列；
联邦续租还核对原 Job 与原 outbox 的队列。SelfAccount 需显式选择已探测队列，不能依赖
可能变化的调度器默认队列；Agent 也会在提交前核对。

运行时镜像须提供 `/bin/bash`、`/bin/true`、`/bin/uname`、`/usr/bin/timeout`。
启动探测先在相同隔离参数、未加载待测 seccomp 文件的条件下执行固定对照命令：
`uname` 成功，回环 TCP 连接因无监听或无路由返回明确错误。加载正式策略后，socket
必须返回 EPERM；专用 probe 策略须令 `uname` 返回 EPERM。正式策略无需禁止 `uname`。
两类错误检查均固定 C locale 并核对退出码，命令缺失、超时或容器启动失败不能当成通过。
同时检查容器 `/proc/net/dev` 只能包含回环接口；探测不访问公网。
证明 ID 也绑定 probe 策略摘要。切换策略或升级探测实现后须重新获取证明。

SIF 签名验证支持两种互斥的信任配置：PEM 使用现有
`AGENT_SANDBOX_SIF_PUBLIC_KEY_PATH`/`AGENT_SANDBOX_SIF_PUBLIC_KEY_SHA256`；
OpenPGP 使用 `AGENT_SANDBOX_SIF_PGP_FINGERPRINT`（40 位指纹，大小写归一化）。
OpenPGP 通过 `apptainer verify --all --local --json` 离线验证全部对象，要求文件系统对象
及所有验证记录均匹配固定指纹，签名和数据校验全部成功。全局受信 keyring 中的密钥
可能报告 `KeyLocal=false`，该字段不代表验证失败；禁止依赖在线 keyserver 临时获取信任。

root 原生探测接口已支持 `AGENT_SANDBOX_ATTESTATION_ACCOUNT`：明确指定已存在的非 root
Unix 账户，getent 返回的用户名、UID、GID 和 home 须合法。调度 CLI 通过 setpriv 和最小环境
以该身份执行，脚本再核对实际 UID/GID。root 探测要求 OpenPGP 指纹及固定 ECL 文件摘要、
结构合法的未签名反例 SIF。计算节点核对 Apptainer buildcfg 的实际配置目录、ECL 文件和
反例 SIF 摘要；只有明确的 ECL 签名拒绝及预期退出码才通过，普通启动失败不能替代。
证明 ID 绑定探测账户、PGP 指纹、ECL 和反例摘要。
首次探测会创建受保护的沙箱目录，再核对规范路径、所有权及权限。
Agent 的 HPC root 启动、周期刷新和能力发布现统一使用实际运行证明，不再以布尔开关或
手填 `signatureVerified` 作为就绪依据。首次探测失败仍保留派发处理器，后续证明通过后可恢复；
每次验签和提交仍独立检查有效性。受限执行 profile 随证明重新验证并同步更新。
Server 首次签发、Agent 验签/提交及联邦续租均绑定相同证明；续租同时核对原 Job 与原派发消息
中的队列，并把租约期限限制在证明到期前。已有旧作业可继续监控和停止，缺证明的新提交会拒绝。

所有 HPC 作业均固定已验证 Apptainer、seccomp 与 cgroup 检查器；普通 root 作业直接加载策略，
受限 profile 继续由可信 wrapper 加载本地固定策略。提交 CLI 清除继承环境，作业不传入用户环境变量。
Slurm 使用 nodelist，PBS Pro 使用 host 资源，Torque 使用 nodes，选择证明中的首个节点；
执行前再次核对 hostname。当前证明来自单节点探测，尚不表示整个队列或其他节点通过验证。
PBS host/Torque 节点名须与实际 hostname 一致；别名不一致会拒绝执行，不能去掉节点约束绕过。
SelfAccount 仍仅支持 Slurm；Kubernetes 保持其独立的 OCI/节点策略验证路径。

真实 Slurm 已通过 root 普通账户签名任务执行及输入/输出校验；PBS 双平台链路已通过真实
启动证明、加密介质交付、DATA_WAITING 自动恢复、受限作业读取数据及来源撤权后确认停机。
Torque 原生运行、跨节点及掉电恢复仍待验收。

原生探测通过实际调度器适配器提交 1 CPU/128 MiB、最长运行 120 秒的作业，
逐次 CLI 调用最多 10 秒，完成观察窗口为 150 秒。只有原作业成功终止且输出合法节点标记，
才生成证明。等待超时或状态查询异常时取消原 Job，并要求正向停止确认后才删除文件；
取消请求成功本身不作为停止证明。
未取得提交结果、无法确认停止或 Agent 中断时，保留 `AGENT_SANDBOX_ROOT/.attest-active/`
内的脚本及版本化 `job.json` 收据（原 KQ UUID、调度器、队列、执行账号、提交时间、阶段和已知 scheduler ID）。
Linux Agent 需要 util-linux `flock`；同一 root 的 `.attestation.lock` 持久文件串行化恢复、提交和清理，
进程退出释放内核锁。不得删除或替换锁文件；存储必须支持可靠的文件锁、原子 rename 和文件/目录 fsync。
收据先同步到磁盘，再提交原生作业；未提交的准备目录和已确认停止的清理目录可继续回收。

重启或周期刷新会按原 UUID、名称、提交时间与执行身份查询原任务；队列、账号和调度器必须保持一致。
只有唯一匹配原作业且正向确认停止，才能清理并重新运行探测；旧输出不会成为新证明。
提交响应丢失时也使用原 UUID 查找，查无结果、查询不确定、原生编号不匹配、停止未确认或收据损坏均保留现场，
不会因等待时间较长而重复提交。旧版无版本收据及其他遗留 `.attest-*` 仍需管理员核对原任务，不能直接删除后重投。
普通任务仍使用既有持久 inbox。本机制不构成跨主机锁、共享存储故障或实际掉电验收。

每次 SelfAccount 作业执行均通过系统 Python 的 `-I` 模式读取 root 管理的检查器，
核对权限与摘要后执行同一份已核验字节，使用已签名 CPU/内存和原生 Slurm Job ID。
失败则在用户脚本启动前退出 126。新字段只在本地保存运行时事实，不改变 Sandbox manifest
结构；运行时证明 ID 会变化，protobuf 能力新增 `attested_queue`。升级先排空/取消旧任务，
再同步 Server/Agent 并重新探测；不以空队列兼容旧证明。旧 Agent 持久记录仍可恢复轮询/停止，
但缺少检查器/队列证明时不可重新提交。
`executionMode` 属于签名协议，升级需先 drain/暂停 Sandbox，再协调 Server/Agent 升级；
混用版本会拒绝任务。

Sandbox 清单必须包含签名 `resources: { cpus, memoryMb }`，内存单位为 MiB。
Server 取实际持久化 Job 的资源值；追加只读数据挂载及续签保留这些值。
Agent 在消费 nonce、下载输入及清理重试目录前核对派发值，在 Slurm/PBS/Torque/Kubernetes
提交入口再次核对实际调度参数。联邦续期还要求持久化 Job、原始 outbox 与签名资源一致，
即使改动后仍低于政策上限也不接受。CPU 必须为正 int32，内存必须为正整数且换算字节不丢精度。

升级须先停止新 Sandbox 提交，并排空或取消旧的待派发/运行任务，再同步 Server 与 Agent；
旧清单不补默认资源，也不自动重新签名。Agent 仍可恢复旧运行记录以轮询、收尾或取消，
但不能据此重新提交；联邦旧清单不能续期，仍按原租约到期停止。
此约束证明资源需求没有被替换，尚不证明 HPC 节点的逐作业 CPU/内存 cgroup 已强制生效。
需另行验收实际内核限额，不能使用 Agent 配置开关、cgroup 路径或整个 Pod 的限额代替。

受限 HPC 任务使用 signed `executionProfile` 固定 Apptainer、SIF 和 trusted wrapper 的
canonical path/SHA-256。compute node 的 root-owned
`/usr/libexec/kuintessence/kq-sandbox-wrapper` 读取
`/etc/kuintessence/restricted-execution-profile.conf`，在 exec 前核对全部文件、
owner、权限、path 和摘要。Agent 上的 lstat 检查只覆盖 Agent 本机，
compute node 仍须独立校验。
每台承接受限任务的节点均须部署
[`kq-sandbox-wrapper`](../packages/agent/scripts/kq-sandbox-wrapper)：
wrapper 为 `root:root/0755`，profile 不得被非特权用户写入。

节点 profile 另须配置 `KQ_SECCOMP_PATH` 和 `KQ_SECCOMP_SHA256`，固定本地 seccomp
JSON 的规范绝对路径和摘要。策略文件及其全部父目录必须由 root 所有且不可被组或其他用户
写入；SIF 必须只读。可采用仓库的
[`seccomp-kubernetes-no-network.json`](../deploy/schedulers/k3s/seccomp-kubernetes-no-network.json)
作为 amd64 Apptainer 策略，禁止非 Unix socket、io_uring 和列出的特权系统调用；
其他架构需提供对应策略并实际验证。wrapper 在执行前强制传入
`--security no-new-privs,seccomp:<本地策略>`，拒绝重复安全参数、可写挂载和附加命令。
Agent 启动时调用 wrapper 的 `--check-profile`，本地检查失败则不发布可用的受限执行 profile。
该检查验证文件配置，不替代每台计算节点上的真实调度执行、安全策略或 cgroup 验收。

同一 profile 还须设置 `KQ_CGROUP_CHECK_PATH`、`KQ_CGROUP_CHECK_SHA256` 和
`KQ_SCHEDULER`（`slurm`、`pbs-pro` 或 `torque`）。检查器及其父目录须由 root 管理；
wrapper 在执行前使用 `/usr/bin/python3 -I` 调用固定摘要的检查器，将 Agent 从签名清单
传入的 CPU/内存值与本作业内核限额核对。原生 `SLURM_JOB_ID` 或 `PBS_JOBID` 必须
匹配当前进程的 cgroup；父容器限额或伪造环境编号均不足以通过。检查失败退出 126，
用户脚本不会启动；`--check-profile` 不运行这项逐作业核验。详见
[节点资源检查](../deploy/federation/sandbox-cgroup-lab.md)。

升级须暂停受限派发，在 Agent 和计算节点部署新 wrapper/策略/检查器、配置原生逐作业 cgroup、更新配置中的 wrapper
摘要及 `AGENT_RESTRICTED_EXECUTION_WRAPPER_SHA256`，再重启 Agent；不得省略策略恢复执行。
本约束适用于 signed `executionProfile` 的受限 HPC 任务；普通非受限 root 代运行路径
尚未强制加载这份本地 seccomp 策略，整套运行时证明仍需补齐，
不能只凭 `AGENT_SANDBOX_SECCOMP=true` 宣称已验收。

相关 Agent 配置为 `AGENT_RESTRICTED_EXECUTION_PROFILE_ID`、
`AGENT_RESTRICTED_EXECUTION_APPTAINER_PATH`、`AGENT_RESTRICTED_EXECUTION_SIF_DIGEST`、
`AGENT_RESTRICTED_EXECUTION_WRAPPER_PATH`、
`AGENT_RESTRICTED_EXECUTION_WRAPPER_SHA256`，缺失时拒绝 restricted dispatch。

### 规划、Artifact 与管理

Global 用 beam-search 联合规划静态可见图（默认 width 64），Lookahead 看节点及直接
消费者，Greedy 看当前输入、队列和候选成本。Require、禁止搬运和合规策略为硬约束。
软计划在 dispatch 前重查全部硬过滤，保存 plan version、目标分解与替代原因，
预算超 cap 进入 awaiting_approval。

Ephemeral 本地 replica 默认 workflow terminal 后 24 小时过期；
Checkpoint 可先同站消费，但 workflow 完成前须持久化；
Persistent 必须上传并完成 size/hash 校验后才成功。
跨站和最终输出走 NetDrive；TTL GC 等待 Agent release ACK，只删除受管安全路径。

`/software/scripts` 提供目录、draft 和 revision 编辑。
保存新 revision 与更新资产在同一 transaction；draft 删除需 owner/组织/平台权限，
非 draft 不硬删。test run 使用已保存 revision 与正式身份/调度/审计链路。
当前 Prompt 功能只生成文本，不调用 LLM。
非 restricted Data Market Sandbox mount 未实现时，placement 会拒绝请求，不会带空 mount 执行。

| Server 配置 | 用途 |
|---|---|
| `SANDBOX_ENABLED` | 默认 false |
| `SANDBOX_SIGNING_KEY_ID/SANDBOX_SIGNING_PRIVATE_KEY_PEM` | 签名身份与私钥 |
| `SANDBOX_IMPERSONATION_ENABLED/SANDBOX_SELF_ACCOUNT_ENABLED` | 默认关闭的身份模式 |
| `SANDBOX_DEGRADED_IMPERSONATION_ALLOWED/SANDBOX_SHARED_SERVICE_ALLOWED` | 默认关闭 |
| `SANDBOX_MAX_CPU_CORES`、`SANDBOX_MAX_MEMORY_MB`、`SANDBOX_MAX_WALL_TIME_SEC` | CPU、内存与运行时长限制 |
| `SANDBOX_MAX_PIDS`、`SANDBOX_MAX_OUTPUT_BYTES`、`SANDBOX_MAX_LOG_BYTES` | 进程、输出与日志限制 |
| `SANDBOX_ARTIFACT_GC_INTERVAL_SEC` | 默认 300 |

Agent 使用 `AGENT_SANDBOX_ENABLED`、专用绝对 `AGENT_SANDBOX_ROOT`、
`AGENT_SANDBOX_PUBLIC_KEYS_JSON`、`AGENT_SANDBOX_RUNTIME_CACHE_JSON`，
以及 `AGENT_SANDBOX_ROOT_IMPERSONATION`、`AGENT_SANDBOX_SHARED_SERVICE_ALLOWED`、
`AGENT_SANDBOX_NETWORK_ISOLATION`、`AGENT_SANDBOX_CGROUPS`、`AGENT_SANDBOX_SECCOMP`、
`AGENT_SANDBOX_SIF_SIGNATURE_VERIFICATION`、`AGENT_SANDBOX_ECL`。
Kubernetes 文件输入或输出另配 `AGENT_SANDBOX_K8S_ARTIFACT_PVC`。PVC 位于执行账号的 namespace，须预先绑定到已证明 seccomp 的执行节点，并允许受信任镜像的非 root UID 写入。使用 `WaitForFirstConsumer` 的存储类时，应由部署配置完成节点选定与卷绑定；Sandbox 固定 nodeName，不会触发默认调度器替它选卷。

每次准备在 PVC 中分配 `jobs/<jobId>/<随机准备ID>/`，该路径随原作业快照保存；业务 Pod 只挂载自己的输入和输出目录。输入经原摘要校验后复制，输出准备器只创建目录，不制造空的可选文件。产物收集到 Agent 本地后按原大小、摘要及类型规则检查，Text/JSON 从本地受管目录读取，File/FileBatch 通过产物服务发布，不读入普通日志。未生成的可选输出跳过；收集命令失败仍报错。准备器和收集器沿用禁网、非 root、只读根目录和固定节点要求，辅助 Pod 退出宽限为 5 秒。

PVC 内的运行目录尚未接入自动回收，不能将 Agent 本地副本释放当作 PVC 字节已经删除。生产配置应为此卷设置容量与保留管理，清理前确认对应作业已终止且所需产物已发布。
任何 capability、签名、账号、隔离或 policy 不满足时拒绝，不降级普通 command。
Git 固化导入与隐式 usecase pre/main/post 编排尚未完成，生产 GA 验收也未完成。

<a id="kubernetes"></a>
## Kubernetes 网络隔离

OCI cache location 必须为 `name@sha256:<digest>` 且与 cache key 一致。
离线导入 containerd 要建立精确 digest alias。
script/context ConfigMap 使用只读 `0444`，不为未知 non-root UID 增加写权限。

NetworkPolicy 的生效时机无法保证脚本从第一条指令起就禁止外联。
网络隔离依赖内核限制，固定 sleep 或 init probe 不提供这一保证。
当前 Localhost seccomp 契约只信任一个 Agent 本机 kubelet 节点：

```dotenv
AGENT_SANDBOX_K8S_SECCOMP_PROFILE=kuintessence/kq-no-network.json
AGENT_SANDBOX_K8S_SECCOMP_PROFILE_SHA256=<64-lowercase-hex>
AGENT_SANDBOX_K8S_SECCOMP_NODE_NAME=<agent-hostname-and-kubernetes-node-name>
AGENT_SANDBOX_K8S_SECCOMP_ROOT=/var/lib/kubelet/seccomp
AGENT_SANDBOX_NETWORK_ISOLATION=true
AGENT_SANDBOX_SECCOMP=true
```

Agent 核对 canonical regular-file/non-symlink、root ownership、父目录写保护、
SHA-256、唯一 x86-64 architecture 和 EPERM。profile 只允许 AF_UNIX，
拒绝其余 socket family，并无条件拒绝 `io_uring_setup`。
资产位于
[`seccomp-kubernetes-no-network.json`](../deploy/schedulers/k3s/seccomp-kubernetes-no-network.json)。

Agent 周期刷新证据，漂移即降级 capability；启动时未绑定 profile 的情况需要 restart。
workload、stager、collector 固定同一 node/profile，每次创建资源前重查 identity，
没有 RuntimeDefault fallback。无 WriteOnly output 的 OCI Sandbox 不创建 collector。
Sandbox 当前只使用上述已验证节点；其他节点需要独立 attestation。

Agent 保持非 root。若 kubelet root 不可遍历，不放宽宿主目录或把 Agent 加入 root group；
使用 systemd namespace 中的同目录只读 bind view：

```ini
[Service]
BindReadOnlyPaths=/var/lib/kubelet/seccomp:/opt/kuintessence-agent-seccomp
```

目标 mount point 预建为 root:root/0755，再设置 `AGENT_SANDBOX_K8S_SECCOMP_ROOT`。
这必须是同一目录树，不能用可能漂移的副本或 symlink。
隔离条件未满足时保持 `AGENT_SANDBOX_NETWORK_ISOLATION=false` 和 critical capability；
不能借普通 Job、SelfAccount 或 RootImpersonation 绕过。

### 工作流缺包自动安装

正式 `SoftwareUsecaseComputing` 在 named refs 解析时冻结软件和用例 revision。
签名用例的 `usecasePackageRevisionId` 指向不可变 spec；执行前数据输入校验也使用冻结引用。
Registry 普通 API 写入资产时，在同一事务内更新权限 outbox；须由既有 outbox worker
处理后才能在 enforce 模式使用，新建、替换与归档均不需要手工补资产关系。

缺包需求经资产 use/install 权限、提供方策略和许可证判断后，调度器选择节点并复用
现有 software operation 和精确 spec 的材料 binding。作业保持 `pending`，
`softwareRequirements[].operationId` 关联安装；同一 Agent/spec 的并发需求复用在途操作。
安装成功且库存确认后重新调度，Agent 按受控 `spackExecution` 激活并执行。
安装失败、拒绝或等待超时会使节点失败；取消作业停止等待，不取消其他作业共享的安装。
等待超时沿用 `SERVER_JOB_COMPLETION_TIMEOUT_SEC`。Server 重启后的运行恢复仍受现有
工作流恢复机制限制；本次没有增加独立安装调度器或持久工作流恢复器。

`NOASSERTION`/unknown 不默认允许自动安装。签名 LicensePolicy 的 `autoInstall` 必须是
`review-required`，并且同一资产同时具备以下未过期、未撤销的平台审批：

- 提供方组织的 `provider-source-install` claim；
- 使用者用户或其当前组织的 `consumer-use` claim。

Registry 正式入口为 `POST /api/license-entitlement-claims`（经 Server 代理时加 `/software`），
请求包含 `assetId`、`entitlement`、`claimantKind`、`claimantId`、证据引用和说明，建议设置
`expiresAt`。提供方 claim 还应填写 `providerOrgId`，并由对应组织管理员提交。
平台管理员通过 `POST /api/license-entitlement-claims/<id>/approved` 审批，body 可含 `reason`；
撤销用同一路径的 `/revoked`。审批按资产和主体匹配，不改变 signed policy；
`autoInstall: denied` 不能通过 entitlement 绕过。

审批也不替代资产安装权限、Agent operate 权限、安装策略、受信 release、精确材料 binding
及 Agent 的安装开关/site profile 配置。用户脚本无需也不得注入可信加载 shell；
后续 Bash Script 节点仍使用自己的签名 runtime。

### 算力方本地数据导入的根目录配置

平台的文件传输根目录不自动成为数据导入根目录。先登记专用数据目录，
再把其 UUID 写入 Agent 的 `AGENT_DATASET_ROOTS_JSON`，值为相对于
`AGENT_DATASET_ROOT` 的子目录（例如 `{"00000000-0000-4000-8000-000000000001":"public"}`）。
平台登记的绝对路径应与该目录相同。数据目录与作业工作区、受限材料目录不得重叠。
重启或重连 Agent 后，注册消息会上报配置的根目录 ID；导入页仅展示双方匹配的启用目录，
服务端在创建版本和扫描请求前再次检查。旧 Agent 未上报时需升级并重新注册。
导入的相对路径必须指向包含材料文件的目录，而非单个文件。

### 工作流版本与作业输出

工作流定义允许导出器携带 `schemaVersion: 2`，也兼容未声明版本的现有定义；
其他版本及未知字段仍会被拒绝，节点和连线仍需通过静态校验。

`expectedOutputs` 默认收集文本到作业的 `collectedOutputs`。
需要发布为云盘文件的输出还须在 `fileOutputDescriptors` 中声明相同的 descriptor。
文件页分别展示文本内容和文件下载状态；文本输出没有云盘文件不属于发布失败。

隔离运行环境页面将 Agent 明确关闭 Sandbox 的状态展示为“未启用”；
已启用但不满足安全条件的节点仍显示降级或严重异常，调度安全检查不变。
