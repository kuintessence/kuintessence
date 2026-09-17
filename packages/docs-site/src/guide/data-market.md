# Data Market 数据使用

Data Market 用于登记科学数据资产、管理版本和授权，用户入口为 `/data-market`。它不提供公共数据下载，也不分发生态 bundle 或受限材料文件。作业与工作流通过不可变 `DataInputRef` 引用数据；Web 目录页提供资产发现、授权申请和私有数据管理。

## 概念与边界

- `DataAsset`：记录数据名称、归属、可见性、敏感级别和 access mode。
- `DataAssetVersion`：某一版本的不可变 manifest；只有具备 `manifestDigest` 的版本才能绑定到作业。
- location：版本的实际位置，可为 `platform-object`、`user-private-object` 或 `cp-local`。
- replica：某版本在特定 `agentId/siteId/clusterId` 上的可用副本，用于确定数据 affinity 和可运行中心。其他中心不能因此下载该版本。

`public` 资产可能处于 `reviewing`：审核完成前可在目录中查看，但不能作为运行输入。`private` 资产仅属于创建用户，不能从用户页直接共享或发布。

## 浏览与申请

1. 在 `/data-market` 搜索目录，阅读 lifecycle、access mode、敏感级别和中心限制。
2. 对 request/entitlement 资产提交 access request；状态会显示为 `pending`、`approved`、`rejected`、`canceled` 或 `expired`。
3. 创建 Job 软件用例时，强类型 `Dataset` 输入只列出当前账号有 `use` 权限、至少存在一个可交付 location 且符合 descriptor 约束的 immutable version。可按资产名称或版本搜索并加载更多。选择后，Server 返回完整的 `assetId`、`versionId` 与 `manifestDigest`，浏览器将该引用绑定到对应 descriptor。
4. required Dataset 必须选择后才能预览或提交，optional Dataset 可留空。已选版本被撤回或暂时无法验证时，页面保留选择并显示原因，同时阻止提交。切换软件用例会清除原绑定。
5. Workflow 按节点选择 Dataset，同名 descriptor 可在不同节点绑定不同 immutable version。引用写入节点的 `inputSlots.contents`，保存草稿和重新载入时均保留。

Job 选择结果会原样写入 materialize、placement preview 和最终 submit 的 `dataInputs`。Server 在 materialize 和 Job 入库前分别检查当前 actor 的 `use` 权限。Job 草稿按当前用户与 active organization 保存在当前浏览器 tab 的 `sessionStorage`，刷新后提示恢复，成功提交或主动丢弃后清除。草稿不保存本地 `File`、presigned URL、token、密码或 secret 输入。

Workflow 的 Dataset 仅适用于 `SoftwareUsecaseComputing`，source 固定为 Data Market；不支持 `Script`/`NoAction`、NetDrive 引用或动态 `from`/`sources`/`select`。`SubWorkflow ByVersion` 会读取引用的 template：没有 Dataset 或必填 Dataset 已冻结时可提交；缺少绑定、版本不可读、YAML 无效或出现循环时，按 version ID 显示阻断原因。父页面不提供外部版本的 Dataset picker，因为选择无法写回该版本。

提交前，Server 递归检查顶层、Loop 和 Inline/ByVersion SubWorkflow，通过权限与 typed constraints 校验后才创建 run。run 保存提交时的 active organization，执行或恢复到叶子 Job 时仍按该组织校验，并将绑定写入 `jobDataBindings`，用于 placement 和数据交付。

Workflow 草稿中的 Dataset 使用完整引用校验，保留 `selectedEntries` 和 `targetPath`。撤权、manifest 变化、元素不存在或不符合 Usecase 约束时会阻止提交。required slot 的 `contents` 缺省或为 `null` 时均视为未绑定。

Server 提交校验涵盖 selector、格式、schema、tags、大小、access mode、敏感级别、私有数据许可和元素集合，并冻结 asset/version/manifest、selected entries、delivery policy 与可用 location。调度和 dispatch 还会检查 view/use、grant 有效期、版本状态、manifest 与 replica digest、24 小时 freshness，以及 CP-local 数据是否有共同的可运行中心。

## 三种输入来源

| 来源 | 适用场景 | 作业引用 |
|---|---|---|
| 本地上传 | 普通文件或需要持久化的私有 Dataset/受限材料 | 普通 File 可上传到 NetDrive 并在当前 Web 输入槽绑定；Dataset/`licensed-material` 上传会建立 user-private DataAssetVersion，可在匹配的软件用例 Dataset 输入中选择。 |
| NetDrive | 已存在的个人或授权文件 | 当前 Web Job/Workflow 输入槽使用 `fileMetadataId` 与目标路径。 |
| Data Market | 已审核/授权的版本化数据 | Job 与 Workflow 软件用例按 descriptor 从 Server 的可用候选中选择，并提交 `assetId`、`versionId`、`manifestDigest` 与可选 entries；Workflow 按节点持久化并恢复绑定。 |

数据市场绑定必须指定版本，不能使用文件名、目录路径或“latest”代替。没有 immutable manifest 的版本会被拒绝。

## CP 本地数据导入

CP 管理员在 `/cp/data` 选择 Organization、Agent、已启用的 managed root 和相对路径后，可以发起 `cp-local` 扫描。“等待 Agent 上线”表示请求已保存但尚未送达，导入保持 `pending`；Agent 接收请求后进入 `running`。页面会自动刷新活跃任务，并显示完成、失败、取消状态及错误原因。

导入请求使用持久化的 `Idempotency-Key`。网络重试、Server 重启或多实例接收相同 key 与 payload 时返回原任务，不会重复创建版本或派发扫描。若首次请求只创建了 import，pending 请求重放时会补建 scan request 并恢复派发。相同 key 携带不同资产、版本、Agent、managed root 或路径会返回 409。

原任务已完成、失败或取消时，重放返回保存的终态与错误原因。跨中心 replica 创建尚未开放，页面只能查看已有副本。

## 私有数据上传

普通 `File` 输入仍可上传至 NetDrive。Dataset、训练数据、科学数据和 POTCAR 等受限材料应在 `/data-market` 创建私有数据资产。浏览器按以下顺序执行：

1. `POST /api/data-market/private/assets` 创建 `visibility=private` 的 metadata。
2. `POST /api/data-market/assets/:assetId/upload-sessions` 取得一次性 `uploadUrl`。
3. 浏览器对 `uploadUrl` 执行 HTTP `PUT`。
4. 本地计算 SHA-256，调用 `POST /api/data-market/upload-sessions/:sessionId/commit` 固化版本。

PUT 未完成、对象不存在、大小或 SHA-256 不一致时，commit 不会创建可用版本。文件持久化保存在用户私有对象 namespace，不出现在普通 NetDrive 列表，也不会复制到 Registry。私有数据不能分享、公开发布、公共下载或跨用户授权。

普通私有数据可由 owner 直接作为受控输入使用，无需申请公共访问权限。`licensed-material` 则需要额外的 `use` 授权：owner 在资产详情填写许可依据，提交“申请自有使用授权”，经平台管理员批准后才能用于受限任务。

页面通过 `GET /api/data-market/access-requests/mine?assetIds=...` 批量读取目录资产的最新申请与 effective use；刷新或重新登录后仍会显示 pending、active 或 inactive 状态。access-state 加载中或加载失败时，申请入口禁用。grant 被撤销或申请被拒绝后，提交和 dispatch 会被阻止；用户可以补充许可依据后再次申请。

创建 `licensed-material` 时，asset metadata 必须提供所需元素集合（`elements`）。该集合与 immutable manifest digest 用于 VASP 等 usecase 的元素、版本匹配和完整性校验。Server 只保存 metadata、不可变 manifest 和审批记录，不保存 POTCAR 文件内容、license key、合同或 CP 本地路径。

## 权限与下载

权限分为 `view`、`use`、`download`、`derive`、`manage`，可见资产仍需单独取得下载或复制权限。CP-local 数据只能在拥有 digest 一致、未过期 `available` replica 的中心使用；下载、派生与跨中心复制还受数据策略限制。

受限材料、以及 `restricted/regulated` 且 policy 禁止 download 或 redistribution 的数据，会以 no-egress 任务执行：只有可信签名生态 usecase/workflow 可以提交，运行期间不返回 stdout、日志、输出文件或 artifact；不能把这类文件作为下游 NetDrive 输入或公共下载。若数据需要后处理，必须把无受限挂载、无受限 binding 的后续节点建成独立任务。

常见失败：

- `Authorization denied`：没有对应 capability，或 access request 尚未批准。
- `Data asset version not found`：版本号不正确或已撤销。
- `manifest` 不可用：版本仍在 validating/failed，不能绑定。
- 无可运行中心：该版本的 CP-local replica 不在候选中心，或副本状态不是 `available`。
