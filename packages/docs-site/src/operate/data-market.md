# Data Market CP 运维

Compute Provider 的数据管理员通过 `/cp/data` 管理 provider 数据资产、导入、版本、副本和 access request 审批。该入口处理 metadata，不传输科学数据或受限材料文件。

## CP 数据对象

- `DataAsset` 归属于 provider organization，可为 `organization` 或 `public`；非平台管理员创建 public 资产时 lifecycle 为 `reviewing`。
- `DataAssetVersion` 由 object commit 或 CP-local scan 产生，状态必须为可用才能投入调度。
- location/replica 固定绑定 `agentId`、`siteId`、`clusterId`。调度时只选择 digest 一致、`verifiedAt` 距今不超过 24 小时的 `available` replica 所在中心。多个副本可增加候选中心，但仍受数据策略限制。
- access request 按 capability 和 subject 审批。CP 可在 `/cp/data` 查看详情并 approve/reject；审批会写入 grant 与授权投影。

## 三来源严格导入

CP 数据导入使用：

```text
POST /api/cp/data/imports
```

请求中的 `source` 按类型校验必填字段：

| source.kind | 必填字段 | 当前行为 |
|---|---|---|
| `cp-local` | `agentId`、`managedRootId`、`relativePath` | 创建 import 并请求 Agent scan。相对路径禁止绝对路径和 `..` traversal。 |
| `netdrive` | `netdriveFileId` | 复制执行器尚未配置，Server 返回 `503 DATA_IMPORT_UNAVAILABLE`；页面显示 UNAVAILABLE，不生成 manifest。 |
| `platform-object` | `uploadSessionId` | 先完成对象 upload session、浏览器 PUT 与 SHA-256 commit；当前后续 import worker 未配置时也返回 `503 DATA_IMPORT_UNAVAILABLE`。已 commit 的持久版本仍可查询。 |

`/api/data-market/cp/assets/:assetId/versions` 不接受直接创建 manifest，请使用 `/api/cp/data/imports`。

## CP-local scan 与 mTLS attestation

CP-local 输入通过受管 root 和相对路径定位。`AGENT_DATASET_ROOT` 是所有数据根的受控父目录，`AGENT_DATASET_ROOTS_JSON` 将 Server 登记的 `managedRootId` 映射为该父目录下的 canonical relative path，例如 `{"<managed-root-uuid>":"provider-a"}`。未配置的 ID、绝对路径、父目录穿越和符号链接都会被拒绝。

Agent 通过已注册的 mTLS connectRPC 控制通道接收 scan 请求。canonical attestation 绑定 `requestId`、`importId`、`agentId`、`providerOrgId`、`managedRootId`、`relativePath`、`manifestDigest`、entries digest 与 `scannedAt`。Server 使用 `agent_certs` 中属于该 Agent、未撤销且有效的证书公钥验证签名。

scan request、deadline、attempt、状态、attestation payload 与 signature 保存在 `data_scan_requests` 中，Server 重启或 Agent 重连后可继续处理 pending scan。排查时依次核对：

1. Agent online 且证书/fingerprint ledger 有效；
2. `managedRootId` 已登记并属于该 provider；
3. `relativePath` 不越过 root；
4. import 是否从 `pending/running` 转为 `completed` 或 `failed`，失败时查看原因；
5. 版本是否为 immutable `ready`，replica 的 manifest digest 是否一致、`verifiedAt` 是否在 24 小时内、状态是否为 `available`。这些条件满足后，版本才能用于计算。

## 对象上传与副本

平台对象上传依次执行 create session、HTTP PUT 和 SHA-256 commit。PUT URL 只能写入 session 的临时对象。commit 校验 size、Content-Type、SHA-256 和 source ETag 后，由 Server 将对象复制到以 SHA-256 命名的 immutable key，记录该 key 与对象 version 或等价写保护标识，再删除临时对象。

完成 commit 后，对象和 metadata 才组成可用版本；只创建 metadata 不算完成导入。旧 PUT URL 即使尚未过期，也不能修改已提交版本的文件内容。

为版本创建 replica 时使用：

```text
POST /api/data-market/cp/versions/:versionId/replicas
```

请求需携带 `agentId`、`siteId`、`clusterId`、`locationKind`；CP-local 还需提供 `managedRootId` 和 `relativePath`。scheduler 优先选择拥有 `available` replica 且满足许可条件的中心。登记副本不会自动授予数据复制权限。

## 审批与排障

查询接口：

```text
GET /api/cp/data/assets
GET /api/cp/data/assets/:assetId/versions
GET /api/cp/data/versions/:versionId/replicas
GET /api/cp/data/imports
GET /api/cp/data/access-requests
GET /api/cp/data/access-requests/:requestId
POST /api/cp/data/access-requests/:requestId/review
```

`review` 的 `decision` 只能为 `approve` 或 `reject`。下载、使用、派生和跨中心复制应按 request capability、资产 policy 和审计记录处理。

private `licensed-material` 的 owner 仍需单独申请 `use` 授权：

```text
POST /api/data-market/private/assets/:assetId/owner-entitlement-requests
```

platform_admin 通过以下接口 approve/reject 或撤销 active grant。这些操作都会写入 audit，撤销后，后续 dispatch 无法通过访问检查：

```text
POST /api/admin/data-market/owner-entitlement-requests/:requestId/review
POST /api/admin/data-market/owner-entitlements/:grantId/revoke
```

重点故障码：

- `DATA_IMPORT_UNAVAILABLE`：NetDrive promote 或 platform-object import worker 未部署，导入未完成。
- `Authorization denied`：CP scope、manage 或审批权限不足。
- `Data asset version not found`：asset/version 归属不匹配，或版本尚未由 commit/scan 产生。
- 上传 commit 的 blob missing、size/hash mismatch：检查浏览器 PUT、RustFS CORS、presigned URL 与 SHA-256。

生产升级使用 migration `0036`–`0043`。先完成数据库迁移和 Server/Agent 兼容部署，再配置 `AGENT_DATASET_ROOTS_JSON`，启用 CP-local scan。迁移不包含科学数据、POTCAR 或 OCI bundle。

`bun run db:migrate` 在执行 generated `0043` 的同一 PostgreSQL transaction 内取得 advisory/table lock，预检 `input_descriptor` 的 canonical stage path，并将未经可信验证的 `available` replica 标为 `stale`。随后执行 `0043`，按预检计划为每个既有 binding 回填唯一 `stage_path`，最后写入 migration journal。

descriptor 无法归一化或同一 job 内归一化后出现冲突时，整个事务回滚。须先清理冲突再重试，不能用 `bunx drizzle-kit migrate` 绕过该入口。生产升级前，应在备份副本上演练迁移。

## Agent 数据交付与受限数据隔离

选定 Agent 后，Server 重新检查冻结的 asset/version/manifest、access grant 和 location/replica，再生成短时 object GET URL。对象数据逐文件校验后写入 Agent 宿主机上的 `AGENT_JOB_WORK_ROOT/<jobId>`。CP-local 数据只传递 `managedRootId` 与逻辑相对路径，Agent 不接收、记录或下发绝对路径。容器化 scheduler 使用 Agent 已准备的 job root 视图，不能自行解析对象存储或 CP-local 文件。

dispatch 前，Server 检查 requested/returned manifest path 集合是否完全一致，并计算所有 `stagePath + entryPath` 的最终目标。目标重复或存在祖先/子路径冲突时，dispatch 会被拒绝。所有 delivery target 都必须是 job root 下的 canonical relative path；符号链接、manifest 不匹配、失效副本或缺少 location 也会阻止交付。

交付策略由 Server 冻结：`platform-object`/`user-private-object` 使用 `object-download`；非受限 CP-local 数据使用 `stage-copy`；restricted CP-local 数据使用 `readonly-mount`。调度器不能自行复制或跨中心复制数据；新建副本必须经过 replica 操作审批。

`licensed-material`、`restricted`、`regulated` 的 CP-local 数据只能通过 readonly mount 交付，禁止普通 symlink。只读挂载不提供 restricted execution capability，也不能阻止原始 Slurm/PBS/Torque command 访问网络、宿主机或复制输入。

restricted execution capability 默认禁用。Agent 只有在完整验证固定 SIF 后才会上报 `restrictedDataIsolation=true`：

```text
AGENT_RESTRICTED_DATA_ISOLATION=true
AGENT_RESTRICTED_EXECUTION_SIF_DIGEST=sha256:<64-hex>
AGENT_RESTRICTED_EXECUTION_APPTAINER_PATH=/opt/kq/bin/apptainer
AGENT_SANDBOX_ENABLED=true
AGENT_SANDBOX_ROOT_IMPERSONATION=true
AGENT_SANDBOX_NETWORK_ISOLATION=true
AGENT_SANDBOX_CGROUPS=true
AGENT_SANDBOX_SECCOMP=true
AGENT_SANDBOX_SIF_SIGNATURE_VERIFICATION=true
AGENT_SANDBOX_ECL=true
AGENT_SANDBOX_PUBLIC_KEYS_JSON=<non-empty key map>
AGENT_SANDBOX_RUNTIME_CACHE_JSON=<pinned SIF entry>
```

启动时，Agent 会确认 digest 对应已签名的 SIF cache entry，SIF 是不可写、非符号链接的常规文件，且 SHA-256 与 pin 一致。`AGENT_RESTRICTED_EXECUTION_APPTAINER_PATH` 必须为 canonical 绝对路径，指向 root-owned、非符号链接的常规可执行文件，且 group/other 不可写。

Agent 记录该二进制的 dev/inode/SHA-256，通过绝对路径执行 `<absolute-apptainer> verify <path>`。restricted Sandbox job spec 绑定该路径，向 Slurm/PBS Pro/Torque 提交任务时，不从 `PATH` 查找 `apptainer`，并在提交前再次校验二进制身份。

所有可能运行该任务的 compute node 都必须通过受保护共享路径提供同一二进制。使用 node-local 路径、出现版本漂移或二进制被替换时，Agent 会拒绝执行。任一检查失败都不会上报 capability；仅有 `linux-bind` 配置或普通 Sandbox cache entry 也不足以启用该能力。`linux-bind` 可用于非 profile 的受控 readonly 交付，但不能据此调度受限任务。

Agent 保存不含 URL 的清理元数据（binding、target、method），在任务结束或重启恢复时卸载并删除私有交付目标。清理失败时保留恢复记录，以便重试。

所有 `licensed-material`，以及 policy 禁止 download 或 redistribution 的 `restricted/regulated` binding，均按 `restrictedNoEgress` 任务执行。这些任务只能来自 active、signed ecosystem release 的可信 usecase/workflow revision；Server 拒绝 generic/raw job。Agent 也会拒绝缺少 signed Sandbox execution 的 restricted dispatch，不将 `DispatchJob.command` 交给 Slurm/PBS/Torque。

profile 必须匹配 Agent 的 pinned SIF，使用 MappedAccount Unix identity，设置 `networkDisabled=true`，且不能包含 writable output mount。`dataDeliveries` / licensed readonly mount 必须先物化为签名 manifest 中逐项校验的 Sandbox input mount，不能直接附加到 profile。

Apptainer 使用独立 containment/mount namespace、`--network none`、`--cleanenv`、`--no-home`、`--no-mount hostfs,cwd,home`、`--writable-tmpfs`、capability drop 和 no-new-privs，只暴露 profile 私有 work root 所需的脚本与只读输入。任务结束后销毁整个 private run root；运行期间不收集 scheduler logs，不返回 stdout，不执行 output collection，也不能上传 artifact。

release 尚未物化符合 signed Sandbox input contract 的受限 usecase 时，Agent 会拒绝执行，不回退到 raw command 或 host readonly bind。
