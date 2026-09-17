# 算力提供者手册

Compute Provider、集群管理员和现场运维可在此查找 Agent 接入、集群软件策略、节点可用性和计量审计操作。

## 入口

- CP 控制台：`/cp`
- 软件治理：`/cp/software`
- 节点与 Agent：`/cp/agents`
- 用户与授权：`/cp/users`
- 审计：`/cp/audit`
- 计量：`/cp/metering`
- 数据管理：`/cp/data`

## 接入流程

1. 平台运营创建 provider organization。
2. 在目标集群部署 Agent，并配置 Server URL、Agent id、provider org 与调度器类型。
3. Agent 启动后通过 connectRPC 注册并持续上报 heartbeat。
4. 在 `/cp/agents` 确认 Agent online、scheduler type 识别正确。
5. 配置队列、SSH credential、文件 root、软件策略和计量口径。

本地多调度器 smoke 可使用：

```bash
bun run dev:scheduler:compose
bun run dev:scheduler:compose:build
bash deploy/schedulers/verify-recognition.sh deploy/compose/docker-compose.schedulers.yml deploy/schedulers/ports-alt.env
```

## 软件策略

`/cp/software` 是 CP 运行侧策略控制台。策略按三层合并：

`provider -> cluster -> agent`

合并规则：

- `installMode` 下层覆盖上层。
- `allowList`、`denyList`、`mirrors`、`preinstallList` 合并去重。
- `denyList` 优先阻断。
- 任一层 `lockEnabled=true` 即锁定。
- 保存后 Server 会生成 `software_policies`，通过 Agent policy push 下发。

常用 install mode：

- `preinstalled-only`：只允许运行预装软件。
- `trusted-public-auto-install`：允许安装平台可信 public package。
- `explicit-install-grant`：需要用户或组织具备显式 install grant。

## 预装软件上报与映射

Agent 会上报预装 Spack/module 软件。CP 可以声明映射到 official package 或 usecase：

- 用于让 resolver 识别“已安装可用”。
- 平台可对高风险映射进行审核、锁定或驳回。
- 同名 module/spec 冲突时，应优先选择 official upstream 或 platform fork。

当前 UI 只展示 mapping 摘要，详细的映射审核操作尚未实现。

## 可用性预览

在 `/cp/software` 输入 raw Spack spec，例如：

```text
openfoam
hdf5+mpi %gcc@13.2.0
```

系统会返回：

- `installedAvailable`：已安装可运行节点。
- `installableAvailable`：可按策略安装后运行的节点。
- `blocked`：被 ACL、CP policy、Agent 状态或 lifecycle 阻断的节点。

该结果与调度 software stage 使用同一 resolver。`agent_software` 中的 `name@version` 不能单独作为可运行依据。

## Sandbox runtime 与 VASP 本地材料

在 `/cp/software` 的“受管 Runtime 与受限材料”登记 `python-3.12-stdlib-v1` 的已签名 runtime profile 与 digest。未绑定时脚本可浏览但不能提交。

若提供 VASP，POTCAR 文件必须保存在 Agent 本地受限目录；控制台只登记 selector、版本、元素集合和 fingerprint。不要通过 NetDrive、Registry 或 workflow output 传递 POTCAR。任务会检查 provider entitlement、consumer entitlement，以及 selector 是否匹配当前 Agent 和所需元素集合。

## Data Market 数据管理

`/cp/data` 管理 provider 的 DataAsset、版本、location/replica 和 access request。创建 public 数据时，资产可能进入 `reviewing`；审核完成且版本可用后，才能用于计算。

import 只接受以下三种 source：

- `cp-local`：必须提供 `agentId`、`managedRootId`、相对 `relativePath`，由 mTLS Agent 控制通道发起 scan/attestation。
- `netdrive`：必须提供 `netdriveFileId`。当前复制执行器尚未配置，返回 `503 DATA_IMPORT_UNAVAILABLE`，不会创建可用版本。
- `platform-object`：先通过 upload session、浏览器 PUT 与 SHA-256 commit 持久化对象，再提交 `uploadSessionId`；后续 import worker 未配置时返回 UNAVAILABLE。

为已完成版本创建 replica 时，记录 `agentId/siteId/clusterId` 和 location。多个 `available` replica 可提高不同中心的调度候选并形成 data affinity，但不能绕过数据权限或跨中心复制策略。访问申请可在该页查看详情并 approve/reject；审批会产生可审计的授权投影。

`AGENT_DATASET_ROOT` 必须指向 Agent 受管数据集根，`AGENT_JOB_WORK_ROOT` 用于 Agent 宿主机上的作业临时工作目录；两者不得指向任意用户路径、Registry bundle 或 POTCAR 存储目录。Server 只保存 `managedRootId + relativePath`，不保存或传输 CP 的绝对路径。

受限数据派发需要配置 `AGENT_RESTRICTED_DATA_ISOLATION=true` 与 `AGENT_DATA_READONLY_MOUNT_DRIVER=linux-bind`。`linux-bind` 在 Agent 宿主机上建立 readonly mount，容器化 scheduler 使用 Agent 已准备的工作目录视图。只读挂载本身不能提供受限执行隔离，Agent 还需验证签名运行环境。

`licensed-material`、以及禁止 download/redistribution 的 `restricted/regulated` 数据禁止普通 symlink，只能由签名生态的可信 usecase/workflow 使用，不能用于 generic/raw job。这些任务以 no-egress 模式运行，不返回 stdout、日志、输出文件或 artifact。

## 计量与审计

CP 计量入口位于 `/cp/metering`：

- 支持 raw/hourly/daily/monthly rollup 查询。
- 支持 CSV/JSON export。
- webhook 可推送 `usage.daily` 和 `usage.monthly`。
- NetDrive transfer attribution 会尽量按 `jobId` 与 `workflowRunId` 归因。

审计入口位于 `/cp/audit`，重点关注：

- 软件策略修改。
- SSH session open/close。
- credential vault 修改。
- access request 审批。
- lifecycle 或 official fork 影响到本 provider 的节点。

## 排障

### Agent 未上线

检查 Agent 进程、Server URL、证书/fingerprint、网络和调度器 CLI：

```bash
docker compose --project-directory . -p kq-schedulers -f deploy/compose/docker-compose.schedulers.yml ps
docker compose --project-directory . -p kq-schedulers -f deploy/compose/docker-compose.schedulers.yml logs --tail=120 server
```

### 策略保存后节点未生效

确认 Agent 在线，并查看 policy push 状态。若 Agent 离线，Server 会保留 effective policy，待重连后下发。

### 用户任务被软件策略阻断

在 `/cp/software` 用同一 spec 做 availability preview。若命中 deny list 或 lock，修改 provider/cluster/agent overlay；若缺 install grant，让用户走 access request。
