# 存储、传输与计量

本文介绍 NetDrive、集群文件根、Data Market 对象上传、配额和传输审计。
RustFS/S3 存储对象内容，PostgreSQL 保存文件 metadata、授权、传输记录与配额。
部署身份与代理要求见[安全指南](security.md)，数据资产与受限材料见[软件生态](software.md)。

- [对象存储配置](#configuration)
- [上传与集群传输](#transfers)
- [Data Market 不可变对象](#data-market)
- [存储配额](#quota)
- [计量口径](#metering)
- [传输审计](#audit)
- [故障排查](#troubleshooting)

<a id="configuration"></a>
## 对象存储配置

Server 仅在 `NETDRIVE_ENABLED=true` 时挂载 `/api/netdrive/*`。以下为配置示例，
所有 secret 必须从部署环境注入：

```dotenv
NETDRIVE_ENABLED=true
NETDRIVE_ENDPOINT=localhost
NETDRIVE_PORT=9000
NETDRIVE_USE_SSL=false
NETDRIVE_ACCESS_KEY=kq-data-market-committer
NETDRIVE_SECRET_KEY=<ordinary-iam-user-secret>
NETDRIVE_BUCKET=kq-netdrive
NETDRIVE_PUBLIC_URL=http://localhost:9000
NETDRIVE_MULTIPART_PART_SIZE_MB=64
NETDRIVE_MULTIPART_THRESHOLD_MB=64
NETDRIVE_MULTIPART_TTL_SEC=3600
DATA_MARKET_COMMITTER_ACCESS_KEY=kq-data-market-committer
DATA_MARKET_COMMITTER_SECRET_KEY=<ordinary-iam-user-secret>
DATA_MARKET_STAGING_BUCKET=kq-data-market-staging
DATA_MARKET_IMMUTABLE_BUCKET=kq-data-market-immutable
DATA_MARKET_STAGING_EXPIRY_DAYS=1
DATA_MARKET_IMMUTABLE_RETENTION_DAYS=365
```

Server 配置与部署模板中 `DATA_MARKET_IMMUTABLE_BUCKET` 的默认名称为 `kq-data-market-immutable`。
已有部署需显式指定当前使用的 bucket 名称，保持既有对象及引用指向同一存储。

`NETDRIVE_ENDPOINT`、access key、secret key、bucket 缺失时启动失败。
Server 的 `NETDRIVE_ACCESS_KEY` 必须等于 `DATA_MARKET_COMMITTER_ACCESS_KEY`，
不能使用 `RUSTFS_ACCESS_KEY`。三类 bucket 的职责不同：

| Bucket | 用途 | 必要控制 |
|---|---|---|
| `NETDRIVE_BUCKET` | 用户可变文件与 workflow artifact | 授权读写与配额 |
| `DATA_MARKET_STAGING_BUCKET` | 浏览器临时上传 | 不启用 Object Lock；配置临时对象 lifecycle |
| `DATA_MARKET_IMMUTABLE_BUCKET` | 已提交数据版本 | Versioning、Object Lock、COMPLIANCE retention |

staging 与 immutable bucket 必须分离。既有未启用 Object Lock 的 bucket 不作为
immutable bucket 使用，应新建并切换配置，不删除旧 bucket 或 volume。
`DATA_MARKET_STAGING_EXPIRY_DAYS` 和 `DATA_MARKET_IMMUTABLE_RETENTION_DAYS`
均须为正整数。

Compose/AIO 的 bootstrap 使用 root 初始化 bucket 与普通 IAM user，Server 随后只使用普通
user。AIO 必须提供 `KQ_DATA_MARKET_COMMITTER_SECRET_KEY`。
Helm 自托管 RustFS 在 `rustfs.enabled=true` 且 `netdrive.enabled=true` 时执行同一
bootstrap；轮换 `netdrive.secretKey` 后递增非敏感的 `netdrive.bootstrapRevision`。
外部 S3/RustFS 必须在部署前完成[Helm 控制清单](../deploy/helm/kq-platform/README.md)。

`NETDRIVE_PUBLIC_URL` 必须同时满足实际下载方的可达性和 SigV4 签名要求。
反向代理保留原始 Host、bucket path 和 query，不插入额外路径前缀。
浏览器 PUT/GET/HEAD/OPTIONS 需要对象存储或代理提供 CORS。
bootstrap 出现 CORS warning 时，需核对对象存储或代理的 CORS 配置，并验证浏览器上传。

Agent 不接收 RustFS 凭据。`AGENT_FILE_TRANSFER_CONNECT_TO` 用于 Agent 进程网络，
`AGENT_CONTAINER_FILE_TRANSFER_CONNECT_TO` 用于 scheduler container 网络，后者
未设置时回退前者。连接重写保留签名 Host。
`AGENT_FILE_TRANSFER_MAX_RETRIES` 与 `AGENT_FILE_TRANSFER_RETRY_BACKOFF_SEC`
控制有界重试。

<a id="transfers"></a>
## 上传与集群传输

### 单段与 Multipart

所有请求均受当前用户身份、文件授权和配额约束：

| 步骤 | API / 操作 | 必要数据 |
|---|---|---|
| 单段签名 | `POST /api/netdrive/upload-url` | `path/size/sha256/contentType` |
| 单段上传 | 对返回的 `uploadUrl` 执行 PUT | 文件字节 |
| 单段提交 | `POST /api/netdrive/files` | 原声明、`storageKey/commitToken` |
| 分片初始化 | `POST /api/netdrive/uploads/multipart` | `path/size/contentType` |
| 分片签名 | `POST /api/netdrive/uploads/multipart/part-urls` | `storageKey/uploadId/commitToken/partNumbers` |
| 分片上传 | 对各 part URL 执行 PUT | 保存各片 `ETag` |
| 恢复查询 | `POST /api/netdrive/uploads/multipart/list-parts` | `storageKey/uploadId/commitToken` |
| 分片完成 | `POST /api/netdrive/uploads/multipart/complete` | 文件声明、上传标识、`parts: [{partNumber, etag}]` |
| 放弃分片 | `DELETE /api/netdrive/uploads/multipart` | `storageKey/uploadId/commitToken` |

commit token 绑定 owner、对象和上传声明；对象不存在、大小或 SHA-256 不符时不能提交。
Server 不代理上传字节；客户端保留恢复所需的 upload ID、commit token 和 part 信息。
分片大小至少 5 MiB，最后一片除外；URL 与 token 有有效期。
`NETDRIVE_MULTIPART_THRESHOLD_MB` 只影响浏览器/REST 上传面的选择，
Agent 的集群到云端路径始终使用 multipart。

提交后通过 `GET /api/netdrive/files?prefix=...`、
`GET /api/netdrive/files/:fileId` 和 `GET /api/netdrive/files/:fileId/download-url`
访问文件。`AUTHZ_MODE=enforce` 时由 SpiceDB 判断可见范围；缺少 canonical
`users.id` 时拒绝操作，不以 email 或 OIDC subject 代替。

### 集群文件根与取消

集群路径由持久化 `cluster_file_roots` 授权，不向用户开放任意绝对路径。
管理员登记 Agent、provider、visible organizations、路径与启用状态，并通过
`POST /api/admin/cluster-file-roots/:id/check` 核对实际可达性。

- 云端到集群以 `sourceFileId` 为准；过期 path 按 ID 当前 metadata 更正。
  只有 path 的请求必须唯一匹配 active 文件，存在多个同名对象时拒绝请求。
- 集群到云端要求源为真实 regular file；目标 Agent 必须在线。
- 云端到集群的直接父目录可尚不存在，但最近的已存在祖先必须可进入、可写；
  preflight 不创建目录，Agent dispatch 后才创建。
- transfer 创建后持久化为 `queued`，dispatch 前再次验证 root 授权。
  撤销或授权服务不可用分别产生 `TRANSFER_ROOT_AUTHORIZATION_REVOKED` /
  `TRANSFER_ROOT_AUTHORIZATION_UNAVAILABLE`。
- 已 dispatch 的传输不因 root 变更自动中止，但记录 root revision 和
  `file_transfer.root_policy_changed_during_run` 审计；失败后从当前授权上下文重新发起。

owner 调用 `POST /api/files/transfers/:id/cancel` 发起协作式取消。
Server 移除 listener、尝试 abort 未完成 multipart，并向原 Agent 下发
`FileTransferCancel`。云端下载使用 hidden partial、有界 Range resume 和完成后的原子
publish。若 terminal commit 已开始，取消会被拒绝，传输记录等待提交结束后更新终态，
不得手动强写 cancelled。

Server 重启不会自动恢复未完成传输的 I/O。被中断的记录使用
`TRANSFER_INTERRUPTED_BY_SERVER_RESTART` 标记，用户核对源、目标和当前授权后再重试。

### Workflow Artifact

工作流的 `File` / `File[]` output 由 output collection 发布到 NetDrive，并将 metadata
传给下游。Job completed 只标记作业完成，artifact 发布状态需另行检查；缺少文件时核对 output descriptor、
工作目录、collection error 和对象 commit。

在 Files tab 排障时，需区分运行中未收集、失败、取消前未发布、未匹配 artifact 与 API/权限故障。
NetDrive list error 表示查询失败，应先处理查询错误，再确认输出是否存在。工作流生命周期见
[工作流指南](workflow-schema/README.md#operations)。

<a id="data-market"></a>
## Data Market 不可变对象

Data Market 使用独立于 NetDrive promote 的上传流程：

1. `POST /api/data-market/assets/:assetId/upload-sessions` 创建持久 upload session。
2. 浏览器向 staging presigned URL PUT 字节。
3. 计算 SHA-256，调用 `POST /api/data-market/upload-sessions/:sessionId/commit`。
4. 校验和 metadata transaction 成功后，才产生 `DataAssetVersion` 与 immutable manifest。

Server 从 staging 向 immutable bucket 执行带源 ETag 和 `COMPLIANCE` retention 的
CopyObject。每次 copy 必须取得 `VersionId`，按该 version 回读并校验 SHA-256/size，
再固定到 location、session 和 delivery binding。下载 URL 必须携带该 version ID。
平台不把 `If-None-Match: *` 作为跨 S3 后端的不可变性保证。
对象引用固定到 version ID，同 key 后续版本不改变已绑定的旧版本。

Server 启动时核验 versioning、Object Lock、bucket 分离和 immutable delete 拒绝策略。
普通 IAM user 仅允许从 staging copy 且写入 COMPLIANCE retention，禁止 direct immutable
PUT、非 staging copy 和 immutable delete。以下为 delete-deny 片段，部署时还需配置其余 IAM policy：

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Sid": "DenyDataMarketImmutableDelete",
      "Effect": "Deny",
      "Principal": "*",
      "Action": ["s3:DeleteObject", "s3:DeleteObjectVersion"],
      "Resource": "arn:aws:s3:::<bucket>/data-market/immutable/*"
    }
  ]
}
```

metadata commit 后删除 staging；清理失败可重试，遗留对象由 lifecycle 清理。
CP strict import 的后续 worker 和 NetDrive promote copy backend 未配置时返回
`503 DATA_IMPORT_UNAVAILABLE`，导入不会完成。
生态 bundle 由 Registry 管理；POTCAR 与其他受限材料不得进入公共对象上传链路。

<a id="quota"></a>
## 存储配额

平台只提供一份逻辑云盘，固定 `scope=cloud&scopeId=global`；
集群存储为 `scope=cluster_root&scopeId=<rootId>`。

| 数据表 | 职责 |
|---|---|
| `storage_quota_policies` | 默认配额、单用户上限、申请模式和自动审批上限 |
| `storage_quota_requests` | 申请、理由、期望到期时间和审批结果 |
| `storage_quota_grants` | 永久、临时、自动或人工分配，可到期或撤销 |
| `netdrive_files` | 云盘实际对象字节和对象数 |
| `netdrive_transfer_log` | 上传、下载与 mirror 流量 |

有效配额取默认配额与有效 grant 的较大值。grant 到期不删除文件，但新增/覆盖写入
重新校验。覆盖按“当前占用 - 旧文件 + 新文件”计算；单段、multipart 初始化/完成和
commit 超额时拒绝，返回 `STORAGE_QUOTA_EXCEEDED`。

申请模式为 `auto`、`manual`、`disabled`。自动审批受两类上限约束；人工批准会重查
当前策略。每个用户每个范围只能保留一条待审批申请。
云盘申请由平台管理员处理，集群申请由拥有该 root 管理权的 CP 处理。

| 入口 | 用途 |
|---|---|
| `/files` | 用户占用、剩余容量和申请历史 |
| `/operations#metering` | 云盘策略、审批、分配与计量 |
| `/operations#compute` | Cluster File Root 容量与策略 |
| `GET /api/storage/summary` | 用户配额与占用 |
| `GET/POST /api/storage/quota-requests` | 用户申请 |
| `GET /api/admin/storage/overview` | 管理总览 |
| `GET/PUT /api/admin/storage/policy` | 范围策略 |
| `GET /api/admin/storage/quota-requests` | 待处理申请 |
| `POST /api/admin/storage/quota-requests/:id/decision` | 审批 |
| `POST /api/admin/storage/grants` | 分配 |

Cluster File Root 的 `capacityBytes` 是 CP 声明容量，不是 Agent 实时磁盘采样。
当前未提供高并发 durable reservation ledger；URL 签发和 commit 会校验额度，但不预留额度。

<a id="metering"></a>
## 计量口径

- `download` 与 `mirror` transfer 计入 `networkEgressMb`；upload 只计入传输统计。
- Job 终态优先按 `jobId` 精确关联 transfer 与 `netdriveFileIds`，以文件大小乘运行时长
  记录 `storageMbSeconds`；缺精确记录时才回退同 user/org/time window 的可审计估算。
- `storageMbSeconds` 统计 Job 运行期间关联文件的容量与时间乘积，不计对象长期驻留费用。
- 长期存储归属 owner，读取者承担自己的 download egress。
  同一文件可出现在多个 Job 关联视图，但不据此重复计算 owner 存储账单。
- 跨组织聚合必须受当前 principal 的 tenant scope 限制。
- 当前展示实际字节、对象数、近 30 天 transfer bytes 和对象存续窗口的 byte-hours；
  尚无独立的生产账务 storage snapshot 管线。

`GET /api/metering/workflow-runs/:runId/netdrive-attribution` 提供 run-level 聚合；
准确性依赖 `jobId/workflowRunId/netdriveFileIds` 上下文。
`netdrive_replicas.status=available` 会记录 mirror egress，并为 scheduler 提供 locality；
pending/syncing/failed 状态下尚未确认数据就绪。复制执行器尚未生产化。
CSV/JSON 导出可用，Parquet 返回 422。实际账单由外部计费系统处理。

<a id="audit"></a>
## 文件传输审计

“平台管理 → 平台审计”提供策略配置。operator 和具备只读审计能力的成员可查看，
只有 `platform_admin/super_admin` 可修改。

| 配置 | 默认值 | 范围 |
|---|---|---|
| 用户与平台保留期 | 365 天 | 1–3650 天 |
| 平台与集群保留期 | 180 天 | 1–3650 天 |
| 下载证据模式 | `controlled_gateway` | 或 `direct_authorization_only` |

`controlled_gateway` 用于采集实际字节和完成/中断状态；
`direct_authorization_only` 只记录授权签发，不记录下载 completed。
策略接口为 `GET/PUT /api/admin/file-transfer-audit/config`，
持久化于 `file_transfer_audit_config`。

修改须给出原因；实际变更递增 `policyVersion` 并写
`file_transfer_audit.config.update`，重复保存相同值不生成新版本。
保留期在事件创建时固化，缩短配置只影响后续事件，提前删除存量需独立审批。
WORM、备份到期与恢复后清理由基础设施执行，页面不能关闭审计采集。
执行组件未全部交付的部署中，配置仅保存版本化策略；直连下载的完成证据仍需相应采集组件提供。

<a id="troubleshooting"></a>
## 故障排查

| 现象 / 错误 | 检查重点 |
|---|---|
| NetDrive 404 | 开关、启动配置、bucket 初始化 |
| presigned PUT 失败 | CORS、URL 可达性、Host/path 签名、有效期 |
| commit missing / hash mismatch | PUT 是否完成、文件大小/摘要、token 绑定 |
| multipart complete 失败 | part 顺序、ETag、总大小、token kind |
| `NETDRIVE_SOURCE_FILE_UNAVAILABLE` | ID 对应文件不存在或已 tombstone |
| `NETDRIVE_SOURCE_PATH_AMBIGUOUS` | 同路径多个 active metadata，需重选文件 |
| `CLUSTER_TARGET_DIR_NOT_WRITABLE` | 最近存在祖先的真实权限，不以创建目录绕过 |
| `CLUSTER_TRANSFER_PREFLIGHT_UNAVAILABLE` | 指定 Agent 在线、shell channel、root check |
| `PATH_OUTSIDE_ALLOWED_ROOT` | root 被撤销或无授权，重新发现可用 root |
| 上传成功但无 `netdriveFileIds` | transfer commit 与持久化 metadata 是否一致 |
| cancel 后短暂 running | terminal commit 是否已开始；查回调和 RustFS 完成状态 |
| Job 完成但无 artifact | descriptor/glob、`WORKFLOW_RUN_BASE`、Agent workingDir、collection error |
| attribution 为空 | tenant scope 与 transfer 上下文 |

运行态检查会创建文件、作业或传输，必须单独授权并使用隔离环境。
对象存储与调度器需在部署环境中验收，静态链接、类型和 lint 检查不覆盖这些运行行为。
