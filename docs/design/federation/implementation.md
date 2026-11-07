# 算力联邦 V2：具体实现方案

日期：2026-11-06。设计基线 `4f359a42dd10e2fc1b355ab76d43fa2b0c74b1d5`。范围见 [蓝图](blueprint.md)，发现与证据见 [评估](assessment.md)。下列新目录、类型和接口均为拟实现内容；现有代码链接用于定位接入点。

本方案定义一份完整交付，不分成缩减范围的上线阶段。模块依赖代表代码组织关系，不代表只验收其中一部分。

## 1. 固定业务契约

`AgreementRevision.mode` 只能为：

- `bilateral_direct`：本地双边额度、签名接单与对账；不创建上链待办、不要求 Fabric SDK/服务。
- `bilateral_attested`：完整复用直接模式；业务事务内保存证据和 outbox，后台补交 PDC；链离线不影响有效双边授权内任务。
- `ledger_coordinated`：接收请求前核验链上认领/锁额/许可；无有效提交不得新启动。

协议的 `executionTargets` 明确列出接收方允许的 `providerOrgId + clusterId + agentId + queueId`。这些本地资源 ID 属于双方签署的接收方资源范围，不接受委派请求另填目标。调度只能在其中继续通过本地队列授权的目标上选择；已批准队列不可用时保留等待，不能把它当软偏好退回其他集群。最终投递再次核对 Agent 归属、队列配置与资源上限，并强制 Agent 执行队列校验。历史协议缺少该字段可以读取和核对，但不获得执行范围，需要通过新协议修订明确批准，不能给旧运行自动补全全部资源。

每次调用和持久化记录绑定 `agreementRevisionId + budgetDomainId + epoch + taskId + attempt`。模式不可由请求参数任意覆盖，协议续期生成新 revision，旧任务与待存证义务继续收尾。

金额用单位明确的整数定点值，接口用十进制字符串传输，数据库用 `numeric(38,0)` 并做范围约束，Node/Bun 内用 BigInt 计算；不能复用 JavaScript number 作为跨机构计费金额。资源量独立记录单位与来源，不能把 CPU 核时和 GPU 时直接相加。

## 2. 代码边界与实际接入点

| 模块 | 拟增代码 | 复用/修改位置 | 交付要求 |
| --- | --- | --- | --- |
| 协议契约 | `packages/shared/src/federation/` | [shared 导出](../../../packages/shared/src/index.ts)、[package exports](../../../packages/shared/package.json) | Zod、签名信封、状态、模式、回执、纯确定性数据类型 |
| 存储 | `packages/db/src/pg/schema-federation.ts` 及访问函数 | [schema](../../../packages/db/src/pg/schema.ts)、正常 Drizzle 生成流程 | 唯一键、事务预留、事件持久化、审计、约束与升级路径 |
| 联邦业务 | `packages/server/src/federation/` | [JobService](../../../packages/server/src/services/job-service.ts)、[placement](../../../packages/server/src/services/placement-orchestrator.ts) | 协议、授权、接单、额度、发送/恢复 worker 与状态核对 |
| 入口 | `routes/federation.ts`、`middleware/federation-principal.ts` | [principal binder](../../../packages/server/src/middleware/principal-binder.ts)、[mTLS](../../../packages/server/src/auth/mtls-wire.ts) | 人员管理入口与机构协议入口分开；同一权限口径 |
| Workflow | durable checkpoint 与 invocation 存储 | [engine](../../../packages/shared/src/workflow/engine.ts)、[async runner](../../../packages/server/src/workflow/async-runner.ts)、[job submitter](../../../packages/server/src/workflow/job-submitter.ts) | 真正支持等待/恢复，不能把进程 Promise 当持久状态 |
| 资产/数据 | `federation/asset-resolver.ts`、`data-delivery/package-service.ts` | [data-market schema](../../../packages/shared/src/data-market/data-assets.ts)、[data-delivery](../../../packages/server/src/services/data-delivery.ts)、[Agent delivery](../../../packages/agent/src/data-market/data-delivery.ts) | 跨实例 ID 映射、授权租期、软件修订与流式介质包 |
| 证据 | `federation/evidence-service.ts`、`attestation-worker.ts` | [计量](../../../packages/server/src/services/metering.ts)、[取消 outbox 模式](../../../packages/server/src/grpc/dispatcher.ts) | 自己的持久记录和保留策略；不绑定计量汇总删除 |
| Fabric | `packages/fabric-adapter/`、`contracts/fabric/{market,commercial,evidence}/` | 现有代码没有对应接入 | Node 官方 Gateway，机构私钥隔离，策略/提交/事件语义 |
| Web/CLI | 联邦协议、任务、证据与交付入口 | [工作区导航](../../../packages/web/src/components/workspace-navigation.ts)、[capability schema](../../../packages/shared/src/schemas/me-capabilities.ts) | 执行、账单、存证分开，中文/英文及原有设备策略一致 |
| 部署与运维 | `deploy/federation/`、Compose/Helm 配置 | [现有 Compose](../../../deploy/compose/README.md)、[部署](../../deployment.md) | direct 不加载链；密钥与站点数据不进交付包 |

不增加独立消息中间件、通用分布式工作流平台或第二套集群调度器。新增 Adapter 是 Node SDK 的进程边界，不承载另一套业务数据库。

### Node/Bun 边界

新增 `@kuintessence/shared/federation` 纯协议子入口；Bun 使用源文件，Node/链码构建使用编译的 ESM JavaScript。适配器和链码不从 shared 根入口引入配置加载、整个工作流引擎或日志副作用。不把新增 Node 依赖带入直接模式 Server 的启动依赖图。

根工作区 build/typecheck、Adapter 镜像、链码 CCAAS 构建及 lockfile 在实际实现时一起接入。当前分支不安装候选依赖，也不手工改 lockfile。

## 3. 机构身份与授权：复用机器账号，独立联邦信任

当前已有 `users.serviceAccount` 和机器凭据，并拒绝机器身份换取普通浏览器/CLI JWT，见 [自动化凭据](../../automation-credentials.md)。接收方按“本地组织＋合作域＋远端机构”创建受限本地服务身份，复用现有用户/组织/软件/队列/数据权限检查及执行账号映射。

该身份不是远端真实用户的复制，不接收其邮箱、密码或普通 session，也不设置管理员角色。服务身份本地字段可用系统生成标识，不能将原机构个人身份写进跨机构账本。

联邦入口先形成独立 `FederationPrincipal`，包含受验证的 site/member、协议 revision、能力和映射身份，再进入既有 JobService。不能让远端填写 `submittedBy` 或 `orgId` 后直接伪装普通 principal。现有 automation token 的 scope 不自动扩大；跨机构使用 mTLS + JWS，而非转交本地 automation token。

部署采用独立的机构 mTLS 入口和现有可信代理模式：代理验证客户端证书、清除客户端伪造身份头，私有上游采用同 UID、0700 目录内的 0600 Unix socket；Server 核对证书登记、吊销及 JWS 机构绑定。Node Gateway 从真实 TLS 上下文取得证书，普通 HTTP 端口没有机构接单路由。联邦 trust registry 与 `agent_certs` 分开，不能把其他机构登记成本地 Agent。Compose 与 Helm 必须提供实际握手、伪造头和绕过代理的负向测试。

现有 mTLS 实现针对 Agent，且说明了 Bun 取证书上下文的限制；本方案不假设对普通 Hono 路由加一个 header 校验即完成机构认证。外联目标只允许协议登记的端点，限制重定向、超时与响应大小，避免把委派或回执 URL 变成任意内网请求入口。

## 4. 数据库对象与不可破坏的约束

对象分组，避免每个业务名称都机械对应一个表：

| 表组 | 主要记录与硬约束 |
| --- | --- |
| members / identities | 稳定 site ID、受信证书/签名 keyId、机构映射、撤销；密钥只引用 secret |
| agreements / revisions / approvals | 不可变条款、mode、授权范围、签署、有效期；活动 revision 用 CAS 切换 |
| budgets / reservations / postings | budgetDomain、epoch、unit、limit/available/reserved；预留唯一 `(domain, task, attempt)`；借贷更新原子完成 |
| tasks / attempts / invocations | 源机构、稳定操作键、payloadDigest、本地 Job ID、执行/账单/存证状态；每个 attempt 的执行映射唯一 |
| outbox / inbox | 持久命令、事件、目标、lease/version、重试；接收键 `(senderSite, operationId)` 唯一，相同键不同摘要拒绝 |
| evidence / batches / anchors | 原始签名记录、序列、批次成员、双签、链 txId；相同批次 ID 不允许换摘要 |
| deliveries / receipts | packageId、版本、介质/批次/交接、导入状态、副本映射、授权引用 |
| workflow checkpoints / node invocations | scope path、控制流进度、输出引用、任务映射、版本及租约；不使用 static nodeId 作为循环执行唯一键 |
| ledger observations / archive manifests | chain/channel、游标、提交状态、归档/快照元数据；不存无权访问的私有字段 |

网络、签名和调度器请求均在数据库事务之外。worker 先短事务领取待办，执行外部动作后用租约/版本 CAS 记录结果；崩溃后的重试使用原 operationId，不生成新的逻辑请求。

### 接单的事务边界

接收方的 `GET /api/federation/agreements/:revisionId/reservations` 分别返回接单预留、材料准备和本地 Workflow 状态。`preparation.state=resolved` 只表示引用已解析，不能据此显示“执行成功”；`workflow` 在未绑定运行时为 null，绑定后包含 `runId/status/errorCode/updatedAt`。查询沿用协议读取能力与当前组织检查，不返回脚本、输入、结果或原始错误文本；此接口是接收方本地管理查询；源站的跨机构查询见下文“签名运行状态查询”。

接收端自动入队前先复用现有 PlacementPlanService 生成持久资源计划，供 Script 按目标解析本地运行契约。联邦规划候选必须匹配双签目标中的提供方、集群与 Agent；Script 镜像类型和摘要必须匹配签署的环境锁。规划不授予派发权，最终派发及续期继续检查队列、账号、软件、数据和协议当前授权。

接收方一个事务内完成：去重 → 锁协议/预算行并核验 revision → 预留额度 → 建 task/attempt → 保存接单回执待签材料与发送待办。机器签名失败时不得发出“已完成接单”的虚假签名回执；恢复 worker 仍只能处理这个原有 attempt。

生成最终签名可采用事务前构造稳定材料并签名、事务内 CAS 验证版本后写入，冲突则重做；或事务内保存不可变材料，由恢复 worker 签名并标记可发送。选后者时，B 只有在必要签名证据已可靠保存后才允许启动，避免“运行了但没有可验证接单凭证”。

数据/软件未就绪时只建联邦 attempt，不创建空的调度器作业。就绪后锁定 attempt，在同一事务创建本地 Job、绑定唯一 Job ID 和 dispatch intent。为此将 JobService 的创建事务核心提取为接受事务上下文的内部方法，保留全部数据/许可校验；不得先调用 `submit()` 再另写绑定，留下崩溃窗口。

本地 dispatchEpoch/revokedEpoch 和取消 outbox 继续使用。远端 operation/attempt epoch 是另一层标识，不能以重试网络请求为由递增调度器作业代次。租约到期仅允许 worker 恢复处理，不能证明旧集群作业已停止。

## 5. API 与签名格式

### 管理 API

`/api/federation/agreements`、`members`、`tasks`、`evidence-batches`、`deliveries`、`settlements`：由本机构登录用户调用，使用对应 capability 和机构范围；不通过现有 operator 角色自动继承所有商业审批权限。

### 源站持久发送

源站管理入口为 `POST /api/federation/outbound`、`GET /api/federation/outbound`、`POST /api/federation/outbound/:operationId/retry`。提交使用 FederationDelegationSchema 的原委派字段；本机必须是 sender，目标必须属于该组织已双签的协议。提交者须有当前组织的 `delegation.submit`，查询须有 `delegation.read`（submit 包含 read）；平台管理员不自动获得这些业务权限。HTTP 202 只表示原请求已经持久保存。列表保留组织隔离和分页，不返回原请求 JWS、脚本或本地提交者身份。

先在源站按本地审批与材料管理接口登记模板/固定修订映射、inputs 和 environment-lock。首次提交和实际发送均复查原提交者、双签协议、机构密钥、材料映射及软件 use/数据访问权限；材料准备不替代目标平台自己的执行授权。源站保留请求、原始 JWS、SHA-256、原提交者和目标端点，远端只收到协议定义的机构/任务字段。

发送配置在 `FEDERATION_ENABLED=true` 基础上同时设置三个绝对文件路径：

```dotenv
FEDERATION_CLIENT_CERT_FILE=/run/secrets/federation-client.crt
FEDERATION_CLIENT_KEY_FILE=/run/secrets/federation-client.key
FEDERATION_CLIENT_CA_FILE=/run/secrets/federation-peer-ca.crt
```

私钥文件须由 Server UID 持有，组/其他用户无权限。接收方信任登记须包含该客户端证书及源站机构签名公钥；源站须登记接收机构的协议/回执公钥，并为 HTTPS hostname 配置匹配证书与可信 CA。启用后 Server 启动持久发送 worker；未配置时不挂载出站 API，也不隐式使用 Agent 证书。修改部署凭据后重启加载。

worker 用短事务领取最多 60 秒的处理租约，在网络发送前完成当前授权检查；网络调用不占数据库事务，单次绝对超时 10 秒、响应最多 512 KiB，不跟随重定向，不读取响应提供的任意 URL。端点来自本机 trust registry，排队后端点变化先进入 needs_review；有提交权限的人员明确 retry 后可采用同一接收机构当前登记的端点，保留原请求/JWS 并审计端点变更。查询结果的状态含义：

| 状态 | 含义 |
| --- | --- |
| queued | 等待首次发送或原请求重投，不能推断远端没有接单 |
| sending | 某 worker 已领取发送租约，崩溃后可按原操作恢复 |
| accepted | 已验证接收方签名回执，并逐项匹配请求摘要、协议/预算域、任务/attempt、金额及有效接单时间；不表示运行完成 |
| needs_review | 当前授权、端点或回执不满足要求；保留原意图和额度，供核对及显式重试 |

接单窗口过后，仅重放原 JWS 以取回接收方已保存的回执，不续签新期限，不生成新操作；没有既有预留的接收端仍按原期限拒绝首次接单。未知交付、超时、坏回执不释放额度。源站在预算域/epoch 锁内汇总原请求金额与数量，阻止并发超额及复制到其他协议；当前尚无结算释放，accepted 也继续占用原预留。新 worker 领取后，旧 worker 不能覆盖其状态。

发送后的接单回执是历史事实：本地授权在网络调用期间失效，不会把已收到的可信接单回执抹掉。后续不得未经授权再发送；远端撤销/停止确认使用下述独立取消协议。当前出站入口是独立的委派 API，普通 Workflow 的远端节点选择、结果交付、退款与结算尚待接通；源站按需查询运行状态见下节。原 `ledger_coordinated` 仍受链许可门槛限制。

### 签名运行状态查询

源站 `GET /api/federation/outbound/:operationId/remote-status` 要求当前组织的 `delegation.read`（submit 包含 read），仅查询已验收接单回执的原操作。接收方独立 mTLS 网关新增 `POST /federation/v1/status`，仍只转发固定路径及由真实 TLS 证书生成的指纹；普通 Web 端口不挂载该机构入口。

每次查询签署新的 `status-query`，包含随机 queryId、原委派 operation/task/attempt、协议修订、reservationId、requestDigest 和最长 60 秒的期限。响应 `status-report` 绑定完整查询摘要、queryId 和原任务身份，返回 observedAt、材料准备与 Workflow 状态及各自更新时间；未准备/未绑定为 null。`cancelling` 不等于 `cancelled`；`completed` 是接收方声明的 Workflow 终态，不证明结果已传回、科学结果正确或已经结算。响应禁止脚本、结果正文、原始错误、日志和本地用户/运行标识。

两端必须在 trust registry 显式为机构签名密钥登记新用途：源端 `status-query`、接收端 `status-report`。旧记录不会自动扩权；既有密钥用途不可原地覆盖，按原轮换流程登记新 keyId、向对端提供对应公钥并更新 Server 签名配置，保留原委派/接单验签所需旧记录。mTLS 客户端配置沿用上一节。用途缺失拒绝查询，不能退回 unsigned JSON。

历史状态查询不重新批准作业，所以不以原接单窗口、执行期限或协议到期为查询截止，也不复用执行身份或材料 use 权限。必须保持当前机构/证书/签名密钥可信，以及源站查询者的当前组织读取权限。接收方按原预留的 sender、接收机构和完整任务身份限制查询；签署前后复核信任。源站在网络请求后再次核对读取权限及签名信任，校验查询有效期、身份、摘要和观测时间（最多 60 秒时钟偏差）。签署及网络不占数据库事务。

接口按需向原登记端点请求，不缓存/持久化为最新运行状态；无通用后台状态轮询、结果下载或自动推进源站 Workflow。网络故障返回 503，坏传输响应为 502，签名/身份冲突拒绝；均不改写 accepted、预算或任务状态。返回 report、reportJws 和 verifiedAt，HTTP 设置 no-store。端点与委派记录不符时返回冲突，目前已接单操作的端点迁移仍待专用维护流程。

### 签名结果清单

双方在新的协议修订中显式签署 `resultPolicy`，例如：

```json
{"scope":"persistent-files","maxFiles":256,"maxBytes":1073741824,"availableUntil":"2027-01-01T00:00:00.000Z"}
```

范围仅为原 Workflow 的 Persistent File/FileBatch 产物，不包含 Checkpoint、Ephemeral、日志或任意目录。`maxFiles` 为全部批次成员加单文件的总数（协议清单当前最多 256 个文件和 256 个输出，且受统一 256 KiB 签名正文限制）；`maxBytes` 为所有输出的合计字节数。超限明确拒绝，不截断。`availableUntil` 是独立的结果披露期限，允许晚于计算协议的执行窗口；仍要求协议未暂停/撤销、原双签密钥与当前机构信任有效。缺少该字段的旧协议不开放清单，不能编辑已签署 JSON 来补权；应签署新修订并用于新任务。

源站 `GET /api/federation/outbound/:operationId/results` 需要当前组织的独立 `result.read` 权限，submit/read/cancel 不隐含数据读取权。源站签署一分钟内有效的 `result-query`，经固定 mTLS `/federation/v1/results` 请求接收方 `result-report`。密钥用途分别显式登记。请求/响应绑定随机 queryId、原任务/attempt、预留和请求摘要；运行状态查询仍只返回状态。

接收方核对原签署协议、原委派、执行身份、不可变运行快照和 completed 运行，只列已持久发布且仍属于该执行身份的文件。生产 Job 必须属于该运行、已完成且允许导出；批次逐成员核对已发布云盘记录、大小和 SHA-256。缺失记录、被删文件、所有权或摘要变化、未持久化和禁止导出均拒绝整个清单；原结果引用的产物被删不能被误报为空结果。签署后再次读取并复查，状态或清单改变即拒绝返回旧快照。

清单包含稳定的输出摘要 ID、节点/输出名称、类型、相对成员路径、大小、SHA-256，以及原模板、输入清单和环境锁引用；不包含本地 Workflow/Job/用户/云盘 ID、存储路径或下载凭据。源站核对清单摘要、原输入/模板/环境锁、时间和协议限额，并在网络返回后重查当前结果读取权限与签名信任。该签名是机构对清单的声明，不证明科学结论正确，也不新增数据所有权或第三方再分发权。

本接口目前只提供**签名清单**，不发送文件字节、不登记源站副本，也不把任务改为“已交付”或“已结算”。接下来以这份清单绑定独立的数据搬运和接收回执，复用云盘/Agent 的流式传输及校验路径；大文件不得通过 Server 全量缓冲或以任意对端 URL 绕过登记端点与授权。

### Agent 结果文件搬运基础

Agent 的 `copyFederationResultFile` 已提供内部文件搬运函数：绑定签名清单中的一个成员、transferId 和 generation，向平台回调逐次申请短期下载/分片上传授权；核对对象、方向、分片、有效期及运维配置的 HTTPS origin，禁止重定向。函数依赖调用方先验签；自身检查清单摘要与成员，不替代机构签名验证。所有字节直接经 Agent 与存储端交换，Server 不缓冲大文件。

下载要求准确的 206/Content-Range，以 1 MiB 窗口读取并校验 SHA-256；共用恢复下载器以 64 KiB 块重算已有前缀，拒绝忽略 Range 的全对象响应、超长/截短/压缩响应，损坏的完整文件会删除后重新下载。上传逐分片申请 URL，使用文件支持的 Blob 流式发送并重新计算摘要，检查源文件大小和修改时间；错误、取消及授权过期不会返回完成结果。只返回未提交的 multipart parts，尚不执行 CompleteMultipart、发布云盘副本或签署接收回执。

暂存目录须归 Agent 用户所有、权限 0700、无符号链接；单文件受配置容量与可用空间检查，成功失败均清理。当前每次尝试从头创建暂存，不能跨进程续传，也没有全 Agent 并发磁盘容量预留。测试覆盖真实 HTTPS 搬运 5 MiB + 123 字节；不代表 TB 规模、真实 S3 完成发布或双平台结果回传验收。下载 grant 协议已接通，见下节；持久传输任务、目的端上传授权、AgentStream 派发和后台清理仍待接通。

### 独立的结果下载授权

接收方私有 mTLS `POST /federation/v1/result-downloads` 接受 `result-download-query`，返回 `result-download-grant`。双方须为新 keyId 显式登记对应用途，清单/状态用途不隐含文件字节授权。查询绑定原委派/协议/预留及独立 challenge，再绑定 transferId、generation、清单摘要、输出 ID、成员路径、大小、SHA-256 和上传分片大小。接收方重新执行原清单的全部授权与归属检查，不能仅凭一个 fileId 或对端自行声明的 URL 下载。

接收方读取本地已发布文件的 storageKey，以配置的 NetDrive backend 检查对象大小，并在存储支持时固定 versionId；只生成 HTTPS S3 预签名地址，不读取文件字节。允许的存储 origin 由 `FEDERATION_RESULT_DOWNLOAD_ORIGINS` 指定，默认空则关闭。有效期不超过 30 秒、查询期限及原 resultPolicy.availableUntil；额外解析地址中的实际 SigV4 签署时间/有效期，避免仅缩短回执期限。签发及签名后再次检查权限、清单与文件映射，任何变化都拒绝释放旧地址。

源站内部 `FederationResultReader.downloadGrant` 复用当前组织结果读取权限和双签条款，检查登记端点，发送签名 challenge 后验证对端用途、签名、查询绑定、对象/尝试、origin、正文与实际 S3 期限，并在返回前再授权。返回短期下载 grant，不持久保存 URL 或 JWS，不登记已交付。transferId/generation 当前只用于绑定；其持久租约和旧 worker 隔离必须由待接通的传输管理器维护，接收方不能单凭来源生成的 generation 判断它是否最新。

预签名地址是短期 bearer 凭据，受控接收方能看到其存储定位信息；不得向普通清单、日志或审计正文扩散。已发地址不可即时召回；撤权阻止续发，受管 Agent 在截止时主动取消，不能宣称 S3 会立即断开已建立连接。双方采用这个有界撤权窗口；要求立即阻断在途数据时需更换为逐请求授权的数据网关。

当前已有数据库授权/签名协议与真实 TLS 路由测试，存储签发在数据库测试中使用替身，尚无完整真实 S3/两平台回传验收。目的端 multipart 管理、持久恢复、AgentStream 派发、原子副本发布及接收完成回执继续接线。

### 结果搬运 AgentStream 通道

新增兼容 protobuf 消息与 `federationResultCopyV1`/`federationResultVerifyV1` 协商；Server 只给同时支持复制和目的校验的 Agent 分配任务。Agent 显式配置 `AGENT_FEDERATION_RESULT_COPY` JSON 后才上报能力，包含 stagingRoot、maxStagingBytes、allowedSourceOrigins、allowedDestinationOrigins；默认 null。Server 同时要求 mTLS 已认证且为当前连接，旧 Agent/Server 不会误接派发。

任务、绑定、grant 与 copied 回报使用共享严格 schema；正文分别限制为 256 KiB、8 KiB、16 KiB 与 4 MiB，仅传元数据。Server 每连接最多同时处理两条结果请求，机构网络/S3 调用不阻塞心跳；响应只发给原连接，重连期间分配成功的旧上传保留清理责任。Agent 同时只搬一个文件，重复同 generation 不重启；不同 generation 在忙碌时报告失败。短期地址不入持久队列，断线、退出或两分钟租约结束停止当前搬运，迟到 grant 按 requestId 丢弃。上传报告丢失时由持久租约过期后清理和重新尝试，不承诺跨进程续传。

Server 启用 NetDrive、联邦签名/发送器并同时配置 `FEDERATION_RESULT_IMPORT_SOURCE_ORIGINS`（对端存储）及 `FEDERATION_RESULT_DOWNLOAD_ORIGINS`（本端存储）后构造传输服务；仍不会自动派发 pending 导入，整单发布内部入口已接齐，须待接收回执与后台接线后自动处理。端到端业务交付尚未完成。

### 分片组装与目的对象字节校验

上传报告持久保存后，协调器重新检查尝试/权限并执行 CompleteMultipart。完成结果丢失时可通过该尝试的独立 key 找到待校验对象，HEAD 只用于绑定大小、ETag 和可用的 versionId，不能据此发布。对象定位信息与 verifying 状态一起持久保存；完成调用超时不改变可能由并发完成者推进的状态，旧 key 仍由租约到期清理负责，原定期复扫处理清理后才完成的副作用。

Server 通过相同 mTLS Agent 通道派发独立校验任务，逐次签发最多 30 秒的目的 GET grant，限定当前尝试、对象、期限、HTTPS origin 和 versionId；签发前后再次授权。Agent 以 If-Match 读取，检查响应 ETag；有版本号时同时检查 URL 和响应版本。每次只读取准确的 1 MiB 范围并累计 SHA-256，不写临时完整文件，也不把对象正文经过 Server。空文件同样通过真实授权 GET 验证零字节；错误范围、超量/截短正文、损坏内容、过期与撤权均拒绝。

Server 接收校验报告后重新检查当前权限、租约、对象 HEAD 和报告摘要，再记录 verifiedAt/verified。在授权与租约有效时，完全相同的 copied/verified 回报可以重放，复制回报不会让 verified 回退，校验过程中重复 copied 可重新派发原对象。存储支持版本时读取已选定历史版本，不受同名新版本覆盖影响；无版本号时使用条件读取和摘要校验，不承诺历史版本保留。

迁移 0100 增加目的 ETag/versionId 和 verifiedAt 约束，由生成命令产生。上述为字节搬运完整性，已增加下述整份清单发布与源站云盘文件登记，尚无接收完成回执；后台自动派发保持关闭。

### 持久结果导入与传输尝试

源站增加三个组织/所有者隔离的 API：

- `POST /api/federation/outbound/:operationId/result-imports`，正文 `{ "importId": "UUID" }`，202 只表示接收了导入意图。
- `GET /api/federation/outbound/:operationId/result-imports/:importId`，返回整体与成员状态、摘要和大小，不返回签名正文、存储 key、uploadId 或下载凭据。
- `POST /api/federation/outbound/:operationId/result-imports/:importId/cancel`，保存取消并阻止继续授权；不意味着存储或 Agent 已完成清理。

新导入先通过现有生产结果查询验证远端签名清单，再于事务中重新检查本地当前权限和协议。原始 report/JWS、不可变文件成员和每次传输尝试分别持久保存，事务审计不含凭据。相同 importId 重放不重新请求远端；同一所有者/操作/清单的未取消导入去重。旧取消 ID 永不重启；重新导入须提交新 ID 并重新授权，保留旧记录及清理责任。

每个成员每次尝试有独立 generation、预先落库的目标 storageKey、Agent、uploadId、parts 和两分钟租约，租约不能越过结果披露期限。当前只允许本组织拥有且 online 的 Agent，传输层另要求当前 mTLS 连接及 federationResultCopyV1 能力协商；不允许任意用户指定其他组织的节点。数据库防止同一成员/Agent 重复领取活动尝试，取消后尚未到期的旧租约仍占用 Agent 名额。每次授权续发及上传报告均重查所有者当前权限、原协议、Agent 归属和 generation。

过期、失败或取消后保留旧尝试，等待独立存储清理，不覆盖 uploadId 或删除历史。创建上传的响应即使迟到到新尝试之后，也保留到旧 storageKey 下并重新等待清理，不改变新尝试状态。已复制报告必须匹配文件摘要/大小和完整有序 parts；完全相同的重放幂等，不同报告拒绝。上传报告先记录 assembling，存储协调器随后组装对象并派发独立目的读取；只有版本/ETag、完整字节数及 SHA-256 均通过才记录 verified，仍不能发布可用副本。

当前 API 只持久排队；存储协调器已实现 S3 分配、目的端短期授权和精确残留清理，并通过 AgentStream 传输层连接；已增加整单原子发布内部入口，尚未接入后台自动扫描。`storageCleaned` 是内部状态入口，由存储协调器在确认旧 key 的全部对象版本、delete markers 和所有 multipart 上传均不存在后调用；没有公开接口允许用户或 Agent 自报清理完成；已清理 key 每 24 小时可复扫，保留迟到副作用的清理责任。六项隔离数据库/生产路由测试证明状态与隔离，不是实际 Server/Agent 进程崩溃恢复或存储清理验收。签名接收回执仍待完成。

### 远端取消与停止确认

源站 `POST /api/federation/outbound/:operationId/cancel` 要求当前组织的 `delegation.cancel`（submit 包含 cancel，cancel 包含 read）。HTTP 202 表示永久停止意图已保存，不能直接显示“已停止”。`cancel-retry` 在机构密钥或登记端点修复后重签同一停止正文并审计，不更改原 operation/task/attempt/请求摘要；已确认停止不重启。列表中的 `cancellation` 与原接单 state 分开：queued/sending/pending/needs_review 都不等于 stopped，原 accepted 和额度保持。

取消允许在接单回执未知时发起。源站保存独立 `cancellation` 签名正文、摘要、操作者和重试租约；该意图一旦被授权并落库，即使操作者随后失去提交权限仍继续发送停止，不授予任何新执行权。普通发送扫描排除已请求取消的操作，已在途的接单回执仍作为事实保存。暂时网络故障按原停止正文重投，旧租约 worker 不能覆盖新的确认。机构/签名信任失效或端点变化进入 needs_review；有当前取消权限的人可显式 retry 采用当前可信密钥/端点。

接收方新增固定 mTLS 路径 `/federation/v1/cancellations`，显式要求源站密钥的 `cancellation` 和接收站密钥的 `cancellation-receipt` 用途。请求绑定原机构、协议、operation/task/attempt 和 requestDigest。它是不可逆的撤回，没有用于再次授权执行的有效期；拒绝超过 60 秒容差的未来 issuedAt，处理时仍要求当前证书/机构/签名信任。协议到期、暂停或执行身份停用不阻止原合作的停止请求。

接收站以接单和最终派发共用的协议行锁写入永久停止记录；即使请求先于委派到达，也会阻止迟到委派创建预留。已有接单回执仍可重放，不抹掉历史接单。准备快照最终检查、入队、计算/安装派发及续期均检查该停止记录，旧准备结果不能绕过；准备扫描不再反复处理已取消操作。持锁期间不调用网络或调度器，也不反向获取 Workflow 行锁。

独立取消监视器每 10 秒扫描至多 8 条未确认记录，每条失败至少间隔 30 秒重试；复用原 Workflow 取消和 Job 停止/清理链路，包括终态 Job 遗留的安装操作。即使关闭新联邦入口也继续收尾已记录的停止。只有不存在待运行的绑定，或已绑定 Workflow/所有 Job 均为终态且安装/作业取消、数据撤销回执均已确认，才持久记录 confirmedAt。未知 Job、停止或清理失败均保持 pending。重复 worker 的停止调用幂等，签名回执同时复查实时状态，不凭超时、失联或一个 failed 字段确认。

源站持续重投原停止请求取得签名进展，直到 stopped 或需要人工处理。回执匹配原请求和停止摘要，含 recordedAt/observedAt、预留 ID（未知接单可为空）及原 Workflow 状态。已经完成或失败的运行保持原状态；stopped 只证明在接收方当前记录和停止回执下已收敛、原操作不再获准执行，不代表结果交付、退款或结算。全过程不依赖 Fabric，也不释放预算。

Agent 与独立看守共用 SQLite 时，两端连接均设置 5 秒 busy_timeout，允许短写事务完成后继续；不无限重试或跳过写入。Agent 的等待在启用 WAL 和迁移前设置，持久化失败仍明确报错，不能把失败当作已保存收据。

### 机构协议 API

`/federation/v1/delegations`、`operations/:id`、`receipts`、`revocations`、`data-authorizations`：独立 mTLS listener，验证机构签名和协议能力，不接受浏览器 session 代替机构授权。

写请求返回持久操作 ID 与可核对状态，不能用 HTTP 202 代表任务已运行。查询返回签名回执或明确的未知/待核对结果；重复委派返回原结果，相同 ID 换正文为 409。403 表示授权拒绝，版本冲突和需要人工处理各有机器可识别错误码。

信封字段：`protocolVersion, operationId, senderSiteId, recipientSiteId, agreementRevisionId, mode, budgetDomainId, epoch, taskId, attempt, issuedAt, expiresAt, executionExpiresAt?, payload`。JWS protected header 限定 `alg=RS256`、`kid`、类型和版本；对实际 UTF-8 payload 字节签名并保存原始 JWS，使用原字节摘要，不在接收端重排 JSON 验签。

委派的 `expiresAt` 只限定首次接单窗口，仍须在 `issuedAt` 后一小时内；可选 `executionExpiresAt` 限定已经接单后允许准备材料、启动安装/验证 worker、提交调度器的最终期限。它必须覆盖接单窗口且不超过协议 `validUntil`，由原请求签名和接单回执的 `requestDigest` 共同绑定。缺少该字段的历史请求继续使用原 `expiresAt`，不自动延长；同一 operationId 不能用重新签名的不同期限覆盖原接单记录。接单超时后的同请求重放只返回原回执，不重新预留或授予新执行权。

执行期限不代替逐次许可：当前协议、机构密钥、资源、软件及数据授权仍须有效，计算/安装的短期许可不得超出执行期限，数据/Sandbox 的更早期限继续生效。到期后禁止新许可；Server 执行监视器也复查已绑定运行并发起持久取消。检测到期不等于调度器作业或编译进程已经停止，Workflow 保持 cancelling 直到原取消链路收到停止/清理确认；单个计算作业继续受已声明 wall time 约束。Agent 已能把收到的 Job 取消传给原安装操作，Server 向全部安装 Agent 持久投递并等待专用停止确认。受管安装、验证与源码审计已通过运行中续期和宿主进程守护在本地执行许可期限；计算作业与 Sandbox 的完整本地到期控制仍待接通。


不要直接复用现有通用 `canonicalJson()` 作为跨机构密码协议：它用 `localeCompare` 排序，且忽略 undefined；也不要更改旧生态包签名算法以适配联邦。批次签署精确编码的 manifest 字节，严格 schema、重复字段/非法值处理、固定定点金额和跨运行时测试向量一起交付。

接收状态检查时钟容差与过期，记录 source time、received time、anchored time；历史补交只能表示“现在记录了过去声明的事件”，不能凭源方自报时间证明事发时即上链。

运行许可与派发许可分开：`FederationExecutionRequest.runtime_renewal=true` 只请求原 Job/epoch 的计算延续权，响应回显用途且不携带任何派发、安装或下载消息。原运行和作业状态、资源/软件/数据授权及最终事务锁仍需有效；旧响应未回显用途不能被 Agent 当作运行许可。已交付数据的源副本可离线，过期下载地址不代表使用授权到期，反过来文件已到也不能绕过 use 授权撤销。此接口已接通内部 Server/client，Agent 运行期自动续期与本地停止尚待接入，受保护 Sandbox/受限材料路径仍保留门槛。

## 6. Workflow 等待与恢复的具体改造

Agent 收件时保存原 Job/epoch 的不可变派发指纹及原有可续期输入的位置，不额外保存完整环境变量、下载凭据或执行许可。重启后的未提交准备，从 Server 原 outbox 重新获取当前授权的派发，按同一规则验证指纹，再经过正常准备与提交许可；不会删除收据来绕过去重。旧收据缺少指纹时保留待核对，不自动补造授权。

在最终提交许可后、调度器调用前，将“已进入提交”标记及准备完成的 JobSpec/输出规则原子写入收据，写入后再次检查许可期限和取消信号。准备快照包含执行所需环境和 Sandbox 本地路径，按原活动作业记录的本机存储权限保护；它只用于接回监控，不是可重复执行的许可。活动记录同时保存原 dispatchId，Sandbox 身份、命名空间、运行配置、挂载和输出约束完整保留。

Agent 启动和心跳期间核对未确认提交，同一进程只运行一个核对器。已知 schedulerJobId 继续使用原 ID；响应丢失时按原 KQ Job UUID 查找，找到后持久化并接回监控，查询失败/重复匹配/未找到都不重新提交。Slurm 先查询活动队列，未找到再按收件日期查询 sacct；PBS 请求包含历史的 qstat。历史恢复要求调度器保留相应记录与 UUID 元数据（Slurm accounting 的 job comment、PBS job history）；记录已清理或权限不足时保持待核对，不猜测作业未执行。恢复后的第一条状态来自真实查询，不将本地监控器存在当成 running。

Agent 收到取消或数据撤权后先保存撤销 epoch，再等待原准备任务收尾并阻止其提交；已有调度器任务使用统一取消/停止确认路径，确认停止和清理成功后才回确认。相同 Job 的并发取消共享收尾等待，旧 epoch 的撤销不能杀死已知新 epoch 的作业。启动与心跳会重试已持久化的撤销，包括只写入 tombstone 就退出的窗口；查询不明或清理失败保留记录和输入。

Slurm/PBS/Torque 用调度器终态确认停止。Kubernetes 使用 foreground 删除且不阻塞等待，之后在原命名空间检查 Job 已消失或已有终态条件，再检查关联 Pod 均已终止；失败 Pod 计数、删除请求成功和 HTTP 查询异常均不能代替停止证据。即使已丢失完整 JobSpec，取消与确认仍使用清理日志保存的命名空间。自定义适配器缺少 `confirmStopped` 时不能确认取消成功或清理输入。

Server 的 `FederationExecutionMonitor` 启动后即扫描，并每 10 秒处理最多 25 个联邦运行，按 ID 游标轮转，失败记录不会饿死后续任务；并非所有规模下都保证 10 秒内停止。扫描包括 held/queued/running 状态、丢失绑定但仍有联邦标记的运行，普通运行和终态排除。它复用派发授权准备与最终事务检查，协议失效、源/接收签名密钥撤销、机构或执行身份停用、明确材料撤销、软件 use 权限拒绝、快照冲突及执行期限到期触发 Workflow 取消，原子记录原因。取消仍由既有 Workflow 恢复与 Job outbox 补投完成，恢复权限不会重新激活原运行；禁用联邦后监视器继续处理遗留任务。检查和取消均不访问 Fabric。

缺副本/未就绪材料、数据库或授权服务异常不作为明确撤权，后续扫描重试；新许可仍走原授权检查。资源目标/队列变化、完整软件运行许可及数据租约的主动监控、安装 worker 运行中撤权、Agent 全部历史不完整记录恢复尚待接通。准备操作暂不支持取消时会等待其真正收尾，不提前确认；真实集群联合验收仍待完成。

当前引擎是基于 Promise 的内存控制流，`stepJobs` 只按 nodeId 记录 Job；运行中 Server 恢复会转入取消。需要增加持久执行契约，不是给原枚举加 `DATA_WAITING` 就结束。

在同一 shared 引擎加入可选 checkpoint 接口，Server 的 durable run 使用它；嵌入式本地调用保留原默认行为。带联邦节点的新 run 固定 `executionModel=durable-v2`，旧运行仍按其原格式处理，不能凭不完整历史冒然续跑。

checkpoint 保存：固定 Workflow/引用软件修订、动态 scope path、已判定分支、ForEach/While 迭代位置、子工作流路径、已完成节点输出引用、pending invocation、取消状态及 executor lease。大数据与日志存 artifact，只保存不可变引用。

例如 `/root/loop:align/iteration:3/script:solve` 与下一迭代是不同 invocation，即使静态 nodeId 相同。每个有外部副作用的 invocation 使用唯一键；写入意图后再委派，完成 checkpoint 落库后再推进下一个节点。

恢复先读取 checkpoint、已绑定任务和持久状态，重新订阅事件/查询远端；不得从头重新执行已完成脚本。完成事件可能早于等待注册，数据库是事实来源，现有内存 JobCompletionRegistry 仅作为通知加速，不承担唯一状态。

等待数据、软件、链许可和远端结果保存在 node invocation 的 `waitingReason`。实际 Job 仍使用现有 pending/queued/running/terminal 状态，避免直接把联邦等待状态塞进 Agent 协议。无关可运行节点继续，取消先停止新 invocation，再确认所有已委派 attempt 的结果。

Loop、Switch、子工作流和相同节点重复调用都必须覆盖，不能用只支持单层 DAG 的实现宣称完成当前 Workflow DSL 的联邦支持。缺失/矛盾 checkpoint 标记 RECONCILING，不自动重复作业。

## 7. 计量与证据必须独立

现有 `recordUsage()` 是终态后尽力写计量，失败仅记日志；默认 raw 记录 7 天后汇总删除。因此联邦不能用“以后定时扫 metering_usage_raw”实现可靠存证。

为关联联邦任务的 Job 在终态事务里写入持久 terminal-evidence intent，保留原始终态快照、资源请求、调度器观测及引用；worker 再生成签名报告/账单。任务已经完成但证据尚待整理时显示“结果已完成，报告待核对”，不能捏造零用量或因链离线重跑。

计量口径明确为资源分配时长还是调度器实际采样；当前 CPU×运行时长不能改名为“进程实际 CPU 消耗”。缺失数据标记来源/质量和待补采，计费引用双方批准的口径与价格版本。

独立 evidence 保留与 raw rollup 删除解耦；签名证据正文/引用及对象备份验证后才允许按协议清理源证据。执行存储失败与存证服务失败分开：前者可阻止新增任务，后者进入队列。

存证 worker 只读取 `bilateral_attested` 的证据；direct 为 NOT_REQUIRED，无链探测。链上协调记录进入其对应状态投影，不让批次补交执行第二次财务扣减。

批次限定同机构可见范围和协议/epoch，保存原记录 ID、序列清单、签名和摘要。双签只确认记录清单及其类型；单方报告仍标明单方。有效提交后写 ANCHORED，超时查原 txId/批次键，非法配置进入 NEEDS_REVIEW，禁止自动改用公共集合。

## 8. 资产、软件与介质包的接入

新联邦引用 `FederationAssetRef` 包含源 site、kind、源 ID、不可变 revision、digest。A/B 的本地 UUID 不互认；接收方解析为自己的 Registry/Data Market ID，结合签名发布、recipe commit、目标架构锁和本地许可证验证。

本地物化后的 Spack intent 必须携带完整 DAG、material manifest、原始 lockfile 摘要、引擎版本与目标三元组的 pin。安装选择和运行激活须引用同一授权材料；Agent 使用受管安装校验，不能以同名软件代替。旧 Agent 通过能力协商和专用失败占位被拒绝，升级/重连不得丢弃 pin。

联邦软件安装操作通过 `software_operations.federation_job_id` 固定到原 Job，其请求人、Agent、spec 和材料摘要一起构成不可变授权归属。它不与其他 Job 的安装操作合并，也不被普通安装操作借用；同一 Job 的重试继续复用原 operationId。这里隔离的是控制操作，不要求重复编译已安装的相同材料；本地已安装软件仍须通过各自授权与精确版本校验后才能使用。历史操作缺少归属时拒绝联邦补投，不自动为旧安装赋予新授权。该字段保留在历史记录中，原 Job 删除后不允许恢复执行。

安装派发和执行许可要求 `federationInstallationV1` 与 `federationInstallationLeaseV1` 能力协商；仅支持启动前授权的旧 Agent 不获得新安装派发或许可，升级须先停止历史联邦安装。Agent 收到原操作并排到队首后申请当前许可和材料票据；安装/验证 worker 启动前再次申请最多 10 秒的许可，Server 事务复核原作业、操作、协议、软件与目标授权。许可不改变原 operationId 或材料版本。安装存储锁内的网络授权等待最多 15 秒，超时进入持久等待并释放锁；原 operationId 重投后沿原检查点恢复，已完成编译不会重复执行。源码审计、安装及验证运行期间继续续期，Agent 与独立宿主守护共同执行本地到期停止，守护停顿还有 systemd 运行时限兜底；停止后沿原 cgroup 证明再释放写锁，运行中许可丢失不会自动重编译。长下载及计算/Sandbox 运行许可仍须分别完成。

Agent 的软件执行收据保存 `jobScope`（原联邦 Job UUID、普通操作 local、历史未知 null）和 `stoppedAt`。取消只中断该 Job 的安装：排队中的操作持久拒绝并阻止将来到达队首时运行，不等待其他 Job 的安装；已进入执行的操作传递中断信号，等收尾后再检查原安装存储锁。操作返回 failed 不代表 worker 已停止；活动/不确定的 writer、已开始但无存储停止证据的失败操作都不能回取消确认。证明停止后保存时间，重试不反复创建锁代次；启动/心跳从收据与撤销记录继续检查。旧收据只能由匹配原指纹的重放补齐归属，不匹配或缺指纹不猜测；历史未知且已开始的操作可能阻止取消确认，须恢复核对。

安装和源码审计已使用启动前持久绑定的 systemd/cgroup 监督，统一资源限制与完整后代停止检查；先持久封锁晚到启动，再停止并核对原单元，确认前不释放输入/写锁。监督引用保存到软件操作账本和 store 锁代次，原 Agent 退出后可在可信同宿主机上核对恢复；源码审计也支持无 storeRoot 的停止确认。历史未监督记录、未知宿主身份和查询失败仍保留待维护。Server 已向实际安装所在的全部 Agent 持久投递取消并等待专用证明，Workflow 结束事务阻止数据撤权提前收尾。真实进程/cgroup/SQLite 恢复已验证；实际 Apptainer 编译撤权和 Slurm/PBS/Fabric 联合验收尚未完成。

源端只传批准模板及参数/版本，不通过“预授权”允许任意远端 command、绝对路径或环境变量。内部物化后的 Job 可以复用现有命令执行，但模板解析必须发生在已验证的本地权限边界内。

数据授权租期不等于文件已到，文件已到也不等于授权有效。DATA_WAITING 是联邦 invocation 的持久等待，缺少输入时不调用当前会抛 NOT_FOUND 的本地数据规划器去假装运行；导入并映射成功后再进入本地前置检查。

Agent 增加独立的介质导入/导出命令，服务于受管目录；age 使用固定版本、SHA-256 校验的官方二进制，归档流限制条目、路径、链接、空间与内存。既有数据下载/复制/只读挂载继续复用，不将加密逻辑塞进每次常规 `prepare()`。

校验完整后发布副本，再由 Server 签署导入回执；key 通过独立认证通道交付，不能放命令行、介质或日志。原型与真实科学材料标识清楚，模拟安装独立前缀且可恢复。

## 9. Fabric Adapter 与链码边界

Adapter 只有机构内服务接口：submit/evaluate/commit-status/events，检查允许的 network/channel/chaincode/function、机构签署身份与集合。Server 管理业务操作及 outbox，Adapter 不对普通用户开放原始任意链码调用，也不另存业务余额。

- `kq-evidence`：仅验证与追加存证批次，不管理实时任务额度。
- `kq-market`：公共需求/单一分配/不含商业字段的激活与终态，公共背书策略。
- `kq-commercial`：对应 PDC 的条款/额度/许可/结算，集合级机构背书。

raw transaction args、chaincode response、events、trace 均不能携带私有正文；transient 限定发送至集合成员。背景重试不可扩大背书集合。PDC 中的余额和冻结额也属私有数据。

公共激活读取商业链码当前 executionGate 的 hash/version，取消/退款更新 gate；商业释放反向读取公共任务状态。这是必须用真实 Fabric 验证的跨链码读集竞态，不能只靠应用先读后写或 mock 单测判断正确。

公共交易 MAJORITY、合作域 AND、关键治理 ALL 及指定仲裁模板由部署/lifecycle 策略表达。ALL 导致成员离线时升级受阻，这属于明确选择的治理边界，不由平台管理员绕过。

## 10. UI 与配置

复用现有工作区、capability 投影和列表/详情组件，增加机构范围内的联邦管理入口。协议编辑显示三种业务模式、范围、限额、有效期、批准人与指定可见机构；不使用一个模糊“启用区块链”开关。

执行、对账、存证分别展示；直接模式显示“不要求存证”，异步模式可以“成功 / 账单已确认 / 待存证”。轮询/事件只更新变更数据，避免切回标签页重新清空页面。延续现有移动端策略、错误重试、翻译和资源归属显示，不堆积技术说明。

平台运营者只管理本实例可管的联邦配置；合作方商业字段和业务审批必须另有范围授权。API、导出、CLI 和图表使用同一权限判断，不以隐藏按钮代替服务端拒绝。

direct 模式不要求 Fabric URL、镜像或证书；attested 模式任务 readiness 不绑定链连接，但单独展示存证 readiness；coordinated 的新增激活受链确认约束。服务的存活、业务可用性与链可用性分别检查。

## 11. 存储与运维交付

实现证据保留、归档 manifest、容量预测、存证积压和错误状态；提供经人工审查的 Peer 快照/替换操作契约及回执。不能编写定时脚本直接删除运行中的 blockfile，也不能把快照当作完整备份。

快照替换核对多个机构相同高度的摘要，补齐授权私有数据并验证余额/许可后才接流量；历史查询路由到承担保留职责的 Peer/归档。Orderer 存储独立预算。当前状态、交易 ID 与历史总量仍增长，没有无限固定磁盘的承诺。

通道代际迁移作为明确的受控运维过程交付：停止旧域新增、核对未结任务与资金、唯一结转 epoch、验证恢复和历史访问。不能自动双写两个可花费余额或假设跨通道原子性。

原软件离线包导入不变；联邦信任/协议/额度与 Fabric 配置不是软件 seed 可自行批准的内容。配置示例用虚构身份，密钥由站点管理。

## 12. 完整交付范围与验证方式

交付包括全部三模式、无人值守、持久 Workflow、数据/软件准备、三链码、Web/CLI、可选部署、归档/恢复和异常验收。模块之间存在先决依赖，但不将依赖顺序包装成已经完成的部分产品。

真实修改后按仓库约定运行 lint/typecheck，配套数据库事务、权限、跨运行时签名、持久执行和链码测试。端到端场景以小文件和轻量任务覆盖真实 Slurm/PBS 入口；Fabric 隐私/背书/VALID 与故障恢复要用真实网络验证，不用 SDK mock 代替。具体范围见 [验收契约](acceptance.md)。

本方案是完整目标；分支正在实现，已完成的代码与实际验证见 [实现进展](progress.md)。未接入的模块不能视为已交付。

### 结果导入配额与云盘版本

接收清单时按全部成员字节在同一事务预留空间；普通上传提交和联邦预留共用按用户的事务锁，防止同时占用最后一份额度。同清单重放不重复预留，失败重试保留预留，取消仅在所有尝试完成实际清理后释放（没有尝试可立即释放）。用量继续表示已发布文件，reservedBytes 单独计入可用空间。整单发布在同一锁和事务中把预留转为真实文件用量。

普通云盘上传与 multipart 提交保存存储 versionId，下载及联邦结果导出按该版本读取，并核对大小和 ETag；旧的无版本记录保持兼容。版本固定不代替 Agent 对目的对象的 SHA-256 实读验证。

### 整份结果清单发布

存储协调器的内部 publish 先锁定导入读取快照，检查所有清单成员均为 verified，再在事务外逐个 HEAD 固定目的版本，并重新向对端请求/验签相同摘要的清单。最终事务重新检查本地授权、签名信任、成员与尝试快照，拒绝取消、清单改变和旧快照。远端授权查询完成后最多 30 秒内提交，且不得超过披露期限；这是一份短期远端签署的授权快照，不是跨数据库同时锁住双方授权。

采用已有成员 UUID 作为云盘 fileId，路径为 federation-results/<importId>/<outputDigestHex>/<原相对路径>。原签名清单、成员、历史尝试与云盘记录保留可追溯对应；普通详情只新增成员 fileId，不暴露 storageKey 或下载地址。目标路径已有活动文件时整单拒绝，不覆盖用户文件。配额预留转换、全部云盘记录、成员/尝试 available 及审计在同一事务中提交；任何失败全部回滚。重复发布返回原结果，空清单也可完成。

发布要求目的存储具有真实 versionId，普通云盘下载将使用该固定版本；无版本对象仍可完成内部字节验证，但不能发布长期可用副本。已发布对象不进入尝试过期清理，用户仍可按普通云盘操作删除自己的文件；available 表示曾完成本地登记，不是永久保存保证、对端签收或商务验收。自动后台与签名接收回执仍待接通。
