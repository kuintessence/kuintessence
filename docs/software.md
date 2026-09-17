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
| `install` | `spack install --yes <spec>`，受 allow/deny/lock 约束 |
| `uninstall` | 策略通过并确认后删除 |
| `load` | 返回一次性 `spack load --sh` fragment，不改变未来作业环境 |
| `import_preinstalled` | 验证现存 spec 并刷新 ledger，不安装 |

批量请求最多 2000 条原始行，trim/去空/去重后最多 200 个唯一 spec。
响应摘要包含 input、nonEmpty、unique、ignoredEmpty、ignoredDuplicate 计数。
先验证 Agent 存在及 CP scope，再逐 item 返回结果；批量请求可能部分成功、部分失败。
Web 保留失败输入，重试只回填待确认表单，不自动重放非幂等操作。

operation 使用 `queued → running → succeeded/failed/rejected` 单调状态机。
result 必须匹配 operation、Agent 与 action；已终态不被乱序消息覆盖。
安装/删除/导入成功后刷新 `spack find --json`。
即使 CLI 成功，ledger 刷新失败也会将 operation 记录为 failed。

Agent 断线期间的结果写 SQLite outbound queue，重连回放；Server 已 push 却未收到 running
时保持 queued，不自动判为失败或重发。离线时新操作直接 failed。
CP 页面应同时观察 DB 心跳与 live stream；“投递状态不确定”时先恢复连接、核对历史。
操作详情保留 error/stderr/stdout 和退出码。

镜像源同步、buildcache 后台 worker、signed air-gap bundle 导入导出及完整在线
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
`executionMode` 属于签名协议，升级需先 drain/暂停 Sandbox，再协调 Server/Agent 升级；
混用版本会拒绝任务。

受限 HPC 任务使用 signed `executionProfile` 固定 Apptainer、SIF 和 trusted wrapper 的
canonical path/SHA-256。compute node 的 root-owned
`/usr/libexec/kuintessence/kq-sandbox-wrapper` 读取
`/etc/kuintessence/restricted-execution-profile.conf`，在 exec 前核对全部文件、
owner、权限、path 和摘要。Agent 上的 lstat 检查只覆盖 Agent 本机，
compute node 仍须独立校验。
每台承接受限任务的节点均须部署
[`kq-sandbox-wrapper`](../packages/agent/scripts/kq-sandbox-wrapper)：
wrapper 为 `root:root/0755`，profile 不得被非特权用户写入。

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
Kubernetes 另配 `AGENT_SANDBOX_K8S_ARTIFACT_PVC`。
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
