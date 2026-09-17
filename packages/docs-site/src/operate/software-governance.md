# 软件治理

Server 与 Registry 共同管理软件资产，职责如下。

## 权威边界

- Server 负责权限、组织、CP、Agent 和调度可用性。
- Registry 负责 registry/catalog/buildcache 的存储与编辑。
- `app_templates`、`usecase_packages`、`workflow_templates` API 的写路径同步到统一 asset/revision。

## 资产模型

核心表：

- `software_assets`
- `software_asset_revisions`
- `software_asset_grants`
- `software_access_requests`
- `user_capabilities`
- `software_policy_overlays`
- `preinstalled_software_mappings`
- `software_mirror_cache`
- `software_concretize_cache`

核心字段：

- `kind`：`spack-package`、`usecase`、`workflow-template`。
- `source`：`official-upstream`、`platform-fork`、`cp-private`、`sp-submitted` 等。
- `lifecycle`：`draft`、`submitted`、`published`、`deprecated`、`revoked`、`archived`。
- `visibility`：私有、组织可见、平台公开等。
- `trustedForGlobalUse`：是否可作为平台可信运行内容。

## Upstream Mirror

Registry 内置以下官方 Spack package 缓存，运行时无需临时从上游加载：

- `spack-package-catalog.json`
- `spack-package-metadata.json`

启动时会把 upstream recipes/metadata 幂等同步为 `official-upstream` asset。source mirror、buildcache pass-through 和 signed air-gap bundle 的执行器尚未实现。

## Review 与 Official Fork

SP 或 CP 提交后：

1. asset 进入 `submitted`。
2. 平台查看 review detail、diff、dependency refs、impact。
3. 审核通过后可生成 official fork。
4. official fork 写作 `source=platform-fork`、`lifecycle=published`、`trustedForGlobalUse=true`。
5. 原提交资产保留 attribution，但运行默认解析到 official fork。

## ACL 与 Access Request

capability 包括：

- `view`
- `use`
- `install`
- `edit`
- `publish`
- `review`
- `admin`

缺少权限时用户可创建 access request。审批通过后幂等写入 `software_asset_grants`。

workflow/usecase 分享或发布前，可调用 downstream grant 补齐流程，为依赖的 usecase/package 显式补 `use` grant。

## CP Policy

CP runtime policy 使用三层 overlay：

`provider -> cluster -> agent`

Resolver 会同时检查：

- ACL。
- asset lifecycle。
- CP allow/deny/lock/install mode。
- Agent online 状态。
- installed/preinstalled mapping。
- mirror/cache/concretize 记录。

## Availability Resolver

统一入口：

```text
POST /api/software/resolve-availability
```

输入可以是 package/usecase/workflow asset ref 或 raw spec，输出：

- `installedAvailable`
- `installableAvailable`
- `blocked`
- concretized DAG 或 metadata
- ACL、CP policy、mirror/cache、agent status、缺失依赖解释

调度 software stage 应通过 resolver 校验以上条件；只读取 `agent_software` 不足以判断可运行性。

## 科学软件生态 release

科学软件内容由 Registry 的已签名 OCI release 管理。导入前完成 manifest、签名、License、引用与 DAG 静态校验，成功后才原子切换 active release。生态资产使用 stable ecosystem key 和不可变 revision，用户/CP 自建资产不会被覆盖。

License、runtime 和 VASP 等受限材料的操作流程见[治理说明](/operate/license-runtime-governance)；导入、激活和回滚操作见[生态 Release 手册](/operate/ecosystem-release)。

## 数据与受限材料边界

Software asset/revision 不存储科学数据、NetDrive 文件、Data Market payload 或 POTCAR 文件内容。软件或 usecase 可以声明数据前置条件；数据版本、位置与权限由 Data Market 的 `DataAsset`、`DataAssetVersion`、location/replica 和 capability 管理。`AGENT_DATASET_ROOT` 是 Agent 受管数据集根，`JOB_WORK_ROOT` 是短生命周期作业目录；这两个目录不能配置为 Registry bundle 路径。

VASP POTCAR 支持 CP Agent 本地 selector/fingerprint/element set，以及 entitlement 允许的本地受管解析。管理服务只保存 selector、证明和策略，不复制受限文件内容。Data Market 的 CP-local scan 只接收 `agentId + managedRootId + relativePath`，metadata 由 mTLS Agent attestation 验证。

## 当前硬化缺口

以下功能尚未完成：

- sandbox 中的 `spack concretize/install`。
- source mirror/pass-through buildcache worker。
- signed air-gap bundle export/import。
- 通知执行器。
- Monaco + 结构化 `package.py` 编辑器。
- CP 预装映射审核操作和安装成本估算。
