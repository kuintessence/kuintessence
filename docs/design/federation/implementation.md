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

### 新任务机构签署权限

协调预留增加独立的 `federation_reservation_policies`。策略只能收紧原双签合同，固定本机构和 revision/正文摘要，限定单次金额、累计签署金额、任务数与截止时间；复用合同中的模板和资源范围。策略授权属于机构，原授权人的个人角色变化不隐式撤销。修改或续期显式撤销旧 ID；历史签名、计数和链上义务不撤回。

自动批准仍须已 committed 的本地发布/认领意图与链上当前 CLAIMED 版本，提供方必须核验源方同文签名。策略行锁与签名/计数/审计原子事务防止并发超额；相同记录幂等，正文冲突拒绝。累计签署计数不充当链下资金账本，不随任务结束回补，不修改协调模式的链上预算唯一权威。策略管理 API、内部审批服务和新提案自动投递已接入；市场动作及准入确认编排仍是待接入的调用者，不能使用原授权人的 userId 冒充当前人工审批。

`federation_reservation_proposals` 保存源方原始任务意图和提供方签名提案 inbox；分别固定本机构策略 ID，不隐式替换后续策略。原业务 JWS 直接通过 mTLS 发送，接收回执另用独立用途签署，不扩充原签名正文上限。源方创建任务须当前 `delegation.submit`，对端只接收签名正文，不接收用户或本地政策 ID。后台先按政策签署，再由既有商业交换补齐双方签名；链查询期间不持数据库事务，返回后持有效租约、证书/签名/政策锁重新检查，批准与进度同事务提交。丢回包与重启保留原材料，错误分为可重试和需人工复核。

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

### 自动交换输入清单与环境锁

双方仍先批准模板及本地不可变修订映射。源站提交委派前保存本次 inputs 和 environment-lock；接收方现在可以在准备阶段按原委派摘要自动拉取这两份清单，无需逐任务手工预置。它不复制软件资产、脚本正文、数据集内容、原云盘文件或密钥，也不创建本地映射、软件许可或数据使用授权；缺少这些条件继续等待或拒绝执行。

接收方通过独立 mTLS 入口 POST /federation/v1/materials 发送 material-query，绑定随机 queryId、原 operation/task/attempt、协议修订、预留、请求摘要、所选清单摘要及字节偏移，最长有效 60 秒。源站只开放已确认接单的原接收机构和原委派的两个摘要，逐次检查原提交者当前 delegation.submit、双签协议、原委派签名、材料映射、取消状态与执行期限。即使知道其他材料的摘要，也不能跨任务或机构读取。

每份清单保留既有 1 MiB 上限，按固定 64 KiB 字节块返回签名 material-chunk；偏移按块对齐，最后一块按实际剩余长度。响应绑定完整查询摘要、原任务身份、偏移、总长度、观测时间及 base64 字节，单条签名消息继续受原 256 KiB 正文限制。接收方拒绝重放、错序、长度变化、损坏内容、无效 UTF-8 或非规范 JSON；完整摘要及 schema 校验通过后，在一个事务中登记本次缺失的全部清单和审计。原委派签名中的摘要绑定清单内容与来源。

接收方在每次网络调用前后和最终入库时复查协议、原执行身份、取消、当前机构/签名信任和固定端点；最终提交不得超过最后一次已验证查询的截止时间。源端也在签署后复查当前授权。此处是短期签署观测，不承诺跨站同时撤权；计算派发与续期仍走已有在线授权。网络 I/O 不持数据库锁。中断时不登记半份清单，下次从头拉取缺失的小清单；并发导入由内容地址唯一键和事务去重，已存在的有效清单直接复用。

启用自动交换要求双方均配置机构客户端 TLS、登记对方 HTTPS 端点与客户端证书，并在信任登记中显式给接收方密钥增加 material-query、源方密钥增加 material-chunk 用途。旧密钥不会自动扩权，按现有轮换流程新增 keyId；原委派/协议验签密钥仍需保留。接收方准备后台在 DATA_WAITING 时尝试拉取，失败保留等待/阻塞原因及既有 30 秒重试间隔。尚未配置材料处理器时机构入口返回 503，不能回退到无签名材料。

### 签名运行状态查询

源站 `GET /api/federation/outbound/:operationId/remote-status` 要求当前组织的 `delegation.read`（submit 包含 read），仅查询已验收接单回执的原操作。接收方独立 mTLS 网关新增 `POST /federation/v1/status`，仍只转发固定路径及由真实 TLS 证书生成的指纹；普通 Web 端口不挂载该机构入口。

每次查询签署新的 `status-query`，包含随机 queryId、原委派 operation/task/attempt、协议修订、reservationId、requestDigest 和最长 60 秒的期限。响应 `status-report` 绑定完整查询摘要、queryId 和原任务身份，返回 observedAt、材料准备与 Workflow 状态及各自更新时间；未准备/未绑定为 null。`cancelling` 不等于 `cancelled`；`completed` 是接收方声明的 Workflow 终态，不证明结果已传回、科学结果正确或已经结算。响应禁止脚本、结果正文、原始错误、日志和本地用户/运行标识。

两端必须在 trust registry 显式为机构签名密钥登记新用途：源端 `status-query`、接收端 `status-report`。旧记录不会自动扩权；既有密钥用途不可原地覆盖，按原轮换流程登记新 keyId、向对端提供对应公钥并更新 Server 签名配置，保留原委派/接单验签所需旧记录。mTLS 客户端配置沿用上一节。用途缺失拒绝查询，不能退回 unsigned JSON。

历史状态查询不重新批准作业，所以不以原接单窗口、执行期限或协议到期为查询截止，也不复用执行身份或材料 use 权限。必须保持当前机构/证书/签名密钥可信，以及源站查询者的当前组织读取权限。接收方按原预留的 sender、接收机构和完整任务身份限制查询；签署前后复核信任。源站在网络请求后再次核对读取权限及签名信任，校验查询有效期、身份、摘要和观测时间（最多 60 秒时钟偏差）。签署及网络不占数据库事务。

该 GET 接口仍按需向原登记端点请求，保持只读语义；后台状态同步另行保存可信快照，见下文。尚未自动推进源站 Workflow。网络故障返回 503，坏传输响应为 502，签名/身份冲突拒绝；均不改写 accepted、预算或任务状态。返回 report、reportJws 和 verifiedAt，HTTP 设置 no-store。端点与委派记录不符时返回冲突，目前已接单操作的端点迁移仍待专用维护流程。

### 源站后台状态同步

现有委派后台每 10 秒扫描，每轮至多处理 8 项状态查询；已接受操作在接单后进入待查队列，历史已接受操作随迁移 0105 自动纳入。后台以原提交人的当前组织读取权限，复用上述签名状态协议；网络 I/O 不持有事务。保存前复查权限、机构与密钥信任、查询有效期，并在锁等待后检查密钥期限。无需额外配置或新密钥用途。

每次领取持久保存随机 claim 和 30 秒下次尝试时间。多个 Server 通过行锁及 SKIP LOCKED 分配，过期领取可被接替；成功及失败写入都受 claim 限制，迟到响应不能覆盖后来查询的结果，不依赖对端时钟排序。服务重启后继续扫描到期记录。

数据库保存原签名报告、JWS 和本地 verifiedAt；列表增加 remoteStatus，包含 preparation、workflow、对端 observedAt、本地 verifiedAt、lastError、nextAttemptAt，不泄漏签名正文或内部身份。未取得报告时状态和采样时间为 null。失败仅记录脱敏错误并间隔至少 30 秒重试，保留上次可信报告及时间；accepted 和预算不变，断线不冒充计算失败。普通读取权限仍限制在当前组织。

工作流 completed/failed/cancelled 才停止该操作的后台状态轮询；未绑定、材料 waiting/blocked/resolved、排队及 cancelling 均继续查询。completed 仍不代表文件已回传、商务验收或额度结算。保存的报告是历史观测，不是执行授权；后续 Workflow 桥必须复查当前授权并等待结果实际可用，不能仅据快照放行下游。当前尚未接入该桥。

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

新增兼容 protobuf 消息与 `federationResultCopyV1`/`federationResultVerifyV1` 协商；网络复制仅分配给同时支持复制和目的校验的 Agent；介质上传可独立使用目标校验能力，见[纯介质配置](task-media.md#纯介质目标配置与版本兼容)。Agent 显式配置 `AGENT_FEDERATION_RESULT_COPY` JSON 后才上报能力，包含 stagingRoot、maxStagingBytes、allowedSourceOrigins、allowedDestinationOrigins；默认 null。Server 同时要求 mTLS 已认证且为当前连接，旧 Agent/Server 不会误接派发。

任务、绑定、grant 与 copied 回报使用共享严格 schema；正文分别限制为 256 KiB、8 KiB、16 KiB 与 4 MiB，仅传元数据。Server 每连接最多同时处理两条结果请求，机构网络/S3 调用不阻塞心跳；响应只发给原连接，重连期间分配成功的旧上传保留清理责任。Agent 同时只搬一个文件，重复同 generation 不重启；不同 generation 在忙碌时报告失败。短期地址不入持久队列，断线、退出或两分钟租约结束停止当前搬运，迟到 grant 按 requestId 丢弃。上传报告丢失时由持久租约过期后清理和重新尝试，不承诺跨进程续传。

Server 启用 NetDrive、联邦签名/发送器并同时配置 `FEDERATION_RESULT_IMPORT_SOURCE_ORIGINS`（对端存储）及 `FEDERATION_RESULT_DOWNLOAD_ORIGINS`（本端存储）后构造传输服务；会启动结果后台自动处理 pending 导入，整单发布与接收回执均已接入。端到端业务交付尚未完成。

### 分片组装与目的对象字节校验

上传报告持久保存后，协调器重新检查尝试/权限并执行 CompleteMultipart。完成结果丢失时可通过该尝试的独立 key 找到待校验对象，HEAD 只用于绑定大小、ETag 和可用的 versionId，不能据此发布。对象定位信息与 verifying 状态一起持久保存；完成调用超时不改变可能由并发完成者推进的状态，旧 key 仍由租约到期清理负责，原定期复扫处理清理后才完成的副作用。

Server 通过相同 mTLS Agent 通道派发独立校验任务，逐次签发最多 30 秒的目的 GET grant，限定当前尝试、对象、期限、HTTPS origin 和 versionId；签发前后再次授权。Agent 以 If-Match 读取，检查响应 ETag；有版本号时同时检查 URL 和响应版本。每次只读取准确的 1 MiB 范围并累计 SHA-256，不写临时完整文件，也不把对象正文经过 Server。空文件同样通过真实授权 GET 验证零字节；错误范围、超量/截短正文、损坏内容、过期与撤权均拒绝。

Server 接收校验报告后重新检查当前权限、租约、对象 HEAD 和报告摘要，再记录 verifiedAt/verified。在授权与租约有效时，完全相同的 copied/verified 回报可以重放，复制回报不会让 verified 回退，校验过程中重复 copied 可重新派发原对象。存储支持版本时读取已选定历史版本，不受同名新版本覆盖影响；无版本号时使用条件读取和摘要校验，不承诺历史版本保留。

迁移 0100 增加目的 ETag/versionId 和 verifiedAt 约束，由生成命令产生。上述为字节搬运完整性，已增加下述整份清单发布与源站云盘文件登记，已接入下述接收完成回执与后台自动处理。

### 持久结果导入与传输尝试

源站增加三个组织/所有者隔离的 API：

- `POST /api/federation/outbound/:operationId/result-imports`，正文 `{ "importId": "UUID" }`，202 只表示接收了导入意图。
- `GET /api/federation/outbound/:operationId/result-imports/:importId`，返回整体与成员状态、摘要和大小，不返回签名正文、存储 key、uploadId 或下载凭据。
- `POST /api/federation/outbound/:operationId/result-imports/:importId/cancel`，保存取消并阻止继续授权；不意味着存储或 Agent 已完成清理。

新导入先通过现有生产结果查询验证远端签名清单，再于事务中重新检查本地当前权限和协议。原始 report/JWS、不可变文件成员和每次传输尝试分别持久保存，事务审计不含凭据。相同 importId 重放不重新请求远端；同一所有者/操作/清单的未取消导入去重。旧取消 ID 永不重启；重新导入须提交新 ID 并重新授权，保留旧记录及清理责任。

每个成员每次尝试有独立 generation、预先落库的目标 storageKey、Agent、uploadId、parts 和两分钟租约，租约不能越过结果披露期限。当前只允许本组织拥有且 online 的 Agent，传输层另要求当前 mTLS 连接及 federationResultCopyV1 能力协商；不允许任意用户指定其他组织的节点。数据库防止同一成员/Agent 重复领取活动尝试，取消后尚未到期的旧租约仍占用 Agent 名额。每次授权续发及上传报告均重查所有者当前权限、原协议、Agent 归属和 generation。

过期、失败或取消后保留旧尝试，等待独立存储清理，不覆盖 uploadId 或删除历史。创建上传的响应即使迟到到新尝试之后，也保留到旧 storageKey 下并重新等待清理，不改变新尝试状态。已复制报告必须匹配文件摘要/大小和完整有序 parts；完全相同的重放幂等，不同报告拒绝。上传报告先记录 assembling，存储协调器随后组装对象并派发独立目的读取；只有版本/ETag、完整字节数及 SHA-256 均通过才记录 verified，仍不能发布可用副本。

提交 API 返回持久排队状态，后续由后台处理；存储协调器已实现 S3 分配、目的端短期授权和精确残留清理，并通过 AgentStream 传输层连接；已增加整单原子发布与后台自动扫描。`storageCleaned` 是内部状态入口，由存储协调器在确认旧 key 的全部对象版本、delete markers 和所有 multipart 上传均不存在后调用；没有公开接口允许用户或 Agent 自报清理完成；已清理 key 每 24 小时可复扫，保留迟到副作用的清理责任。六项隔离数据库/生产路由测试证明状态与隔离，不是实际 Server/Agent 进程崩溃恢复或存储清理验收。签名接收回执已接入下述独立交付流程。

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

Server 的 `FederationExecutionMonitor` 启动后即扫描，并每 10 秒处理最多 25 个联邦运行，按 ID 游标轮转，失败记录不会饿死后续任务；并非所有规模下都保证 10 秒内停止。扫描包括 held/queued/running 状态、丢失绑定但仍有联邦标记的运行，普通运行和终态排除。它复用派发授权准备与最终事务检查，协议失效、源/接收签名密钥撤销、机构或执行身份停用、明确材料撤销、软件 use 权限拒绝、快照冲突及执行期限到期触发 Workflow 取消，原子记录原因。取消仍由既有 Workflow 恢复与 Job outbox 补投完成，恢复权限不会重新激活原运行；禁用联邦后监视器继续处理遗留任务。双边模式的检查和取消均不访问 Fabric；协调模式的检查会在事务外尝试续期，短暂断链不被当作撤权或已停止证明，取消本身仍不依赖 Fabric。

缺副本/未就绪材料、数据库或授权服务异常不作为明确撤权，后续扫描重试；新许可仍走原授权检查。资源目标/队列变化、完整软件运行许可及数据租约的主动监控、安装 worker 运行中撤权、Agent 全部历史不完整记录恢复尚待接通。准备操作暂不支持取消时会等待其真正收尾，不提前确认；真实集群联合验收仍待完成。

当前引擎是基于 Promise 的内存控制流，`stepJobs` 只按 nodeId 记录 Job；运行中 Server 恢复会转入取消。需要增加持久执行契约，不是给原枚举加 `DATA_WAITING` 就结束。

在同一 shared 引擎加入可选 checkpoint 接口，Server 的 durable run 使用它；嵌入式本地调用保留原默认行为。带联邦节点的新 run 固定 `executionModel=durable-v2`，旧运行仍按其原格式处理，不能凭不完整历史冒然续跑。

checkpoint 保存：固定 Workflow/引用软件修订、动态 scope path、已判定分支、ForEach/While 迭代位置、子工作流路径、已完成节点输出引用、pending invocation、取消状态及 executor lease。大数据与日志存 artifact，只保存不可变引用。

例如 `/root/loop:align/iteration:3/script:solve` 与下一迭代是不同 invocation，即使静态 nodeId 相同。每个有外部副作用的 invocation 使用唯一键；写入意图后再委派，完成 checkpoint 落库后再推进下一个节点。

引擎现已支持专门的 WorkflowNodeWaiting，原因限定为 DATA_WAITING、SOFTWARE_WAITING、REMOTE_WAITING、RESULT_WAITING、LEDGER_WAITING。调用者必须先持久化外部意图，才可报告等待；这个信号本身不创建任务或发送委派。仅 durable journal 运行接受等待，旧内存执行不能以从头重跑代替恢复。

一个 scope 中的等待节点及其下游不写终态 checkpoint，无关分支继续完成并保存检查点；ForEach 的等待迭代仍占用 maxParallel 名额，不因释放本地调用栈而无限派发其他迭代。嵌套 SubWorkflow/While/ForEach 传播带动态路径的等待；While 不提前进入下一次依赖迭代，Switch 不用缺失结果选择分支。数据库或执行租约故障仍中断所有后续副作用，不能冒充正常业务等待。

可运行分支收尾后，Server 用当前 lease 将等待快照写入 workflow_runs.waiting_invocations（迁移 0106），每项含 path 和 reason，保留 status=running、completedAt=null，errorCode=WORKFLOW_WAITING。已有运行查询权限下可读取快照；后台按原恢复机制重建运行并复用完成检查点。成功/失败终态清除等待快照，取消仍经过既有停止确认回调再结束。该快照是最近一次让出执行时的等待观测，不是外部任务绑定。独立绑定及取消转发的服务边界现已实现，普通 Workflow 联邦节点现已接入这些服务，动态输入物化仍待完成。

源站内部 enqueueForWorkflow 入口先在执行 lease 下写入 workflow_execution_delegations（迁移 0107），以 runId + 动态路径 SHA-256 唯一定位，同时保存原路径以检查碰撞。首次分配 operationId/taskId/attempt=1、issuedAt/expiresAt，固定协议、模板、输入摘要、环境锁、预算和资源参数；相同 invocation 恢复复用原请求，不延长截止时间或生成新 attempt。更改意图/节点身份、其他用户或组织、旧租约及接收站点的隐式再委派均拒绝。材料检查与签名完成后，入队事务再次锁定运行和 lease；取消与入队因此有明确先后，绑定但尚未入队的窗口可安全恢复或取消。

普通委派 API 不得重放已绑定 Workflow 的请求来绕过 lease。后台发送及输入材料披露也检查父运行仍为 running。服务端取消回调同时推进本地 Job 和远端操作，不因一方等待而阻止另一方发出停止请求。内部 requestForWorkflow 只允许已进入 cancelling 的 durable run，核对原提交者、组织及完整绑定请求；其停止权限来自持久运行取消意图，不因原用户被撤权而丢失，但机构签名/信任要求继续有效。未入队的绑定没有远端副作用；已入队的操作必须拿到签名 stopped 回执才可结束取消。接收未知操作的永久撤回机制仍用于防止迟到派单。

运行完成检查会把尚无可信远端终态的活动委派转入取消；执行失败也不能绕过清理直接终态。取消和中断收尾在数据库再次检查停止回执，即便取消回调未配置，也不会提前把运行标为已停止。FederationWorkflowExecutor 现已组合远端 completed 和已回传文件，映射为节点成功；签名状态不能代替结果文件就绪。

普通异步 Workflow 提交已识别 Federation 节点，并自动保存 durable-v2，不要求用户手工指定执行模式。检查递归覆盖 Loop、Inline 和 ByVersion 子工作流，并对引用环去重；联邦节点须有绑定的规范用户与当前组织。执行者引用双方签署的协议修订，从该协议读取对端、模式、预算域、epoch、单位，调用原持久委派服务；executionExpiresAt 未显式缩短时固定为协议 validUntil。每次动态调用首次绑定后仍沿用原操作和截止时间，不在恢复时续期。

节点初次/远端未完成时让出 REMOTE_WAITING；准备状态 waiting 对应 DATA_WAITING。声明结果输出的节点在远端完成后自动以 operationId 为稳定 importId 排队接收，未发布时让出 RESULT_WAITING；相同已存在清单可以复用原导入 ID。仅在整单 available 后映射输出，检查原任务、组织、所有者、每项成员大小/摘要、本地文件未删除，以及发布尝试记录的 storageKey 和 versionId。下游获得源站 FileInputValue，不包含远端内部文件 ID、对象路径或凭据。输出只支持协议已支持的 Persistent File/FileBatch；远端失败/撤回使源节点失败，并先走停止与结果传输清理再结束父运行。已发布的用户文件保留；取消只处理原提交者的派生导入，不触及其他用户的副本。短期搬运租约过期并清理确认前，父运行继续 cancelling。

当前 YAML 契约如下；UUID、摘要及模板修订必须替换为当前组织已批准的真实记录。inputManifestDigest 引用预先登记的基础输入清单。可选 inputSlots 支持 Text 标量和 File 文件选择。Text 通过 from.param、from.node/output、from.expr 或 sources/select 获取字符串、有限数值或布尔值，未提供的 optional 参数保留基础值；Text 中的文件句柄、数组、对象、null 及非有限数值仍拒绝。File 可使用同类动态绑定或显式 contents；isBatch 表示批次，单文件恰好一项，批次可为空。文件先解析受管产物，再进入签名快照和授权交付，源站 ID 不发送给接收站；Dataset 槽不支持，不能把它当普通文件绕过许可。outputs.from 指向远端模板的节点及 Persistent 输出，不是源站节点。无 outputs 的节点只等待远端可信计算完成，不主动导入文件。Web 画布已能显示节点和文件输出端口，协议/材料选择表单尚待完成，当前通过 YAML 配置。

动态参数与基础清单合并后按内容摘要持久保存，基础清单、数据集、软件绑定及环境锁保持原值。派生权限使用原提交者的 delegation.submit，不要求额外的 asset.map；审计只记录摘要和来源，不写参数正文。每个循环调用分别固定派生摘要，恢复沿用原操作和截止时间；同一调用参数变化会报意图冲突，不重新派单。源清单缺失时为 DATA_WAITING，结果搬运等待仍为 RESULT_WAITING。单清单合并后仍不得超过 1 MiB。

```yaml
name: 跨机构计算
parameters:
  - { name: sampleCount, type: int, default: 6 }
spec:
  nodeDrafts:
    - id: remote
      name: 远端计算
      type: Federation
      agreementRevisionId: 00000000-0000-4000-8000-000000000001
      template:
        originSiteId: 00000000-0000-4000-8000-000000000002
        kind: workflow
        id: 00000000-0000-4000-8000-000000000003
        revision: "1"
        digest: sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa
      inputManifestDigest: sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb
      environmentLockDigest: sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc
      resources: { cpus: 1, memoryMb: 128, gpus: 0, wallTimeSec: 30 }
      maxAmount: "1"
      admissionWindowSec: 600
      inputSlots:
        - descriptor: sampleCount
          type: Text
          from: { param: sampleCount }
      outputs:
        - descriptor: result
          type: File
          from: { nodeId: consumer, descriptor: result }
  nodeRelations: []
```

示例的远端模板也须声明 sampleCount 参数；实际参数名和类型以双方批准的模板为准。

恢复先读取 checkpoint、已绑定任务和持久状态，重新订阅事件/查询远端；不得从头重新执行已完成脚本。完成事件可能早于等待注册，数据库是事实来源，现有内存 JobCompletionRegistry 仅作为通知加速，不承担唯一状态。

等待数据、软件、链许可和远端结果保存在 node invocation 的 `waitingReason`。实际 Job 仍使用现有 pending/queued/running/terminal 状态，避免直接把联邦等待状态塞进 Agent 协议。无关可运行节点继续，取消先停止新 invocation，再确认所有已委派 attempt 的结果。

Loop、Switch、子工作流和相同节点重复调用都必须覆盖，不能用只支持单层 DAG 的实现宣称完成当前 Workflow DSL 的联邦支持。缺失/矛盾 checkpoint 标记 RECONCILING，不自动重复作业。

### 源站动态文件快照与清单披露

内部 `enqueueForWorkflow` 现可接收显式文件选择，格式为 `[{ descriptor, type: "File" | "FileBatch", files: [{ path, fileId }] }]`。`path` 是本次交付的相对别名，不自动使用源云盘路径。源站在原执行租约内固定所有者、云盘文件 UUID、对象 key、versionId、SHA-256 和字节数，保存到 `federation_workflow_input_exports`（工具生成迁移 0108）。未启用对象版本管理的文件保持 DATA_WAITING；文件必须属于原提交者，且未删除。相同 runId/动态路径复用原记录，节点、选择、版本或内容发生变化时拒绝继续，不偷偷替换输入。File 必须恰有一项，FileBatch 可为空；单次最多 256 个成员，拒绝路径穿越、同槽重名/父子路径冲突及不安全整数总量。

双方协议须明确签署 `inputPolicy: { scope: "workflow-input-files", maxFiles, maxBytes }`；无此字段的旧协议不允许输入文件披露。委派签署 `inputFilesDigest`，只绑定可传输清单的内容摘要，不传本地 exportId/fileId、存储 key、versionId 或用户身份。源站按原运行、动态路径和节点找到对应快照，再检查签名协议的成员数/总字节上限；仅提供已有摘要不能借用其他 invocation 的快照，也不能通过普通委派 API 绕过绑定。

已接受任务的接收机构可通过既有 `/federation/v1/materials` 与 `material-query/material-chunk` 专用签名用途，按摘要读取第三份 `workflow-input-files` 清单。沿用 mTLS、随机查询标识、任务/预留/请求摘要、64 KiB 分块与 1 MiB 清单上限。清单只包含输入描述符、类型、相对别名、大小及 SHA-256；签署响应前后检查当前双签协议、双方信任、原委派签名、运行取消、提交者权限和固定文件版本。有效期继续受原委派的执行截止与协议期限约束，接单过期不自动延长。

**源站快照、委派绑定、授权清单披露和独立短期下载授权已实现。** 清单本身不是字节下载或数据使用许可。普通 Federation YAML 已支持 File/FileBatch；接收端通过真实 Agent 搬运、独立校验和整单发布后，按原执行身份映射本地固定版本。数据或本地授权未就绪时保留 DATA_WAITING。真实双平台单文件往返及源端强制重启恢复已通过；批次目前为数据库/组件验证。输入交付使用独立业务身份，不能伪造结果回传清单或借用其外键。对象存储仍须保留被活动任务引用的固定版本；本表不负责存储生命周期回收。

输入下载使用 `/federation/v1/input-downloads`，查询/响应分别要求独立的 input-download-query/input-download-grant 密钥用途。签名绑定原接单、任务、请求摘要、输入清单摘要、descriptor/path/SHA-256/大小和接收方的 transferId/generation。Server 复用原材料授权检查，在存储 HEAD/presign 外部 I/O 后再次验证双签协议、双方信任/用途、提交者权限、取消、源文件固定版本与截止；只接受精确 versionId、签名有效期与 HTTPS origin 均符合配置的下载地址。地址及签名响应不持久保存；最长 30 秒，实际 S3 凭据期限必须与响应一致，且不晚于查询、任务、协议和签名密钥期限。已发 bearer URL 的撤销存在最多剩余有效期的窗口。

源站须配置独立 FEDERATION_INPUT_DOWNLOAD_ORIGINS，默认关闭。新云盘单次/分片上传均使用 netdrive/objects/随机UUID 对象 key，不携带用户身份；所有权、配额、commit token 和原文件路径仍按现有数据库规则检查。旧含用户 UUID 的对象不对外签发输入下载地址，普通本地读写兼容；匿名导出副本转换仍待实现，须绑定原固定版本并受存储留存/清理规则约束，不能改写活动快照。完整接收端协议还须验证每份授权对应本地活动尝试、当前执行身份与接收方存储来源白名单，拒绝重放/串单/撤权后的迟到响应，不能直接信任源站 URL。

### 输入文件的 Agent 搬运与目的校验

Agent 的 `input-copy` / `input-verify` 内部入口已有独立输入任务、授权及回报 schema，绑定 transferId/generation、operationId、manifestDigest、descriptor/path、SHA-256 与大小，不接受结果 outputId 或伪造 result-report。Server 派发前核对清单成员与本地活动尝试；内部函数本身不替代接收端授权或发布事务。

输入与结果仅共用 `file-copy` / `file-verify` 的底层字节操作。Agent 使用受限私有临时目录、1 MiB Range 和当前逐次短期授权，完整下载校验后才上传 multipart，返回未提交 parts；取消/到期中止并清理本地临时文件。授权必须精确匹配原任务身份、方向及 partNumber，源/目的 origin 分开允许，禁止重定向；复制、校验错误与回报不包含下载凭据。Server 必须确认 multipart/对象清理，不能凭 Agent 临时文件已删除就释放接收端配额。

目标对象完成后，另行按固定 versionId 和 ETag 条件重新读取，核对真实字节与摘要。输入对象必须有真实版本（拒绝 null 和字符串 "null"），空文件也需授权和目的读取；原结果路径的无版本存储兼容行为保留。组件测试使用内部 Agent 与两个本机 HTTPS 服务，授权回调为替身。接收端持久状态、能力协商、后台搬运与整单发布现已接通（见后文）；DSL 文件输入已接通，真实双平台单文件作业往返已通过；多分片与空文件的结论仍限于组件测试。

### 接收端输入导入意图与配额

准备后台现自动取得第三份 workflow-input-files 清单，复用原分块验签、查询绑定、规范 JSON 和摘要检查，并在接收/登记前后检查当前签名用途、执行身份和授权。清单保存到独立 federation_input_imports（工具生成迁移 0109），按 reservationId 唯一绑定本地机构与原执行服务账号，避免把任务私有输入写入组织材料目录。只保留原签署委派已绑定的清单正文/摘要、导入状态、期限和配额；不保存源站用户、对象地址或下载凭据。

整份清单按成员大小合计预留逻辑空间，受双签 inputPolicy 上限、单文件 5 TiB 和当前云盘配额限制。输入预留、结果预留与普通云盘提交共用 cloud-storage 用户锁和统一配额统计，重复/并发调用及服务重建沿用原 importId；事务失败不留下半份清单或额度。重用时检查原身份、摘要、清单、预留字节与执行截止，拒绝篡改。空 FileBatch 保存为明确的空选择，不凭零字节提前宣布可执行。

当前导入状态为 pending/transferring/available/cancelling/cancelled。每轮准备扫描先复查至多 8 项 pending/transferring/available，使用 SKIP LOCKED 和持久 nextCheckAt 避免重复领取，间隔至少 30 秒。明确取消、到期、撤权或身份/摘要矛盾会不可逆封锁输入；没有存储尝试的导入可直接释放配额，已开始的进入 cancelling，等待全部尝试清理后才变为 cancelled 并释放配额。临时后端故障保留预留与脱敏错误，后续成功复查清除错误。已取消或正在取消的导入不会因重新启用身份而自动重开。跨机构取消监视器复用此路径，停止确认必须同时满足运行停止和输入导入已完全取消；原计算预算/接单保留。

### 输入传输尝试、存储分配和清理

清单登记事务同时创建独立 federation_input_transfers 成员；老 pending 清单在没有任何成员时按原清单初始化，部分成员缺失或内容变化直接拒绝。成员保存 descriptor/path、大小、SHA-256 和固定 partSize。federation_input_attempts 按每次 generation 保留原 Agent、对象 key、分配是否已经发出、uploadId、租约和清理确认标识；表与约束由迁移 0110 生成。对象 key 为 federation-inputs/随机importId/随机generation，不使用结果导入外键或业务身份。

内部 input-storage.allocate 在原双签协议、执行身份、清单和 Agent 归属检查通过后建立持久尝试，最多持有 120 秒且不超过原任务截止。输入/结果 begin 共用 Agent 事务锁和活动租约检查，每个 Agent 同时只接受一项输入或结果搬运；所有续租和结果进入目的验证时的延长也持有同一锁，等待后复查原租约，避免过期交接时复活旧尝试。创建 multipart 前先持久记录一次性分配许可；数据库事务结束后才调用存储，保存响应后再复核权限。重启不为同一代次再次创建上传；旧尝试未清理不得重试同一成员，新尝试始终使用新的对象 key。

分配超时或出错保留清理责任，迟到 uploadId 会落回原代次。若请求可能已发出但 uploadId 未确认，记录 ALLOCATION_UNCONFIRMED 并保留配额，不能用一次空列表证明上传不会迟到。进程退出后可按原 key 找回唯一 uploadId 再清理（见后文）；没有正向证据时仍不会自动放行或释放空间。

准备后台已接通到期封锁和清理：等旧租约到期后，仅对未发出分配或已确认 uploadId 的尝试处理。真实 MinIO backend 使用独立输入清理入口，按精确 key 删除所有 multipart、对象版本和 delete marker，再检查为空；拒绝宽泛前缀、结果 key 和普通云盘 key。未发出分配的尝试无需调用存储。失败保留重试；独立清理 token 拒绝旧 worker 的迟到确认。全部尝试确认清理后，取消导入才释放完整配额；普通重试继续沿用原预留。

这些状态、分配/清理驱动、短期凭据、Agent 派发、上传完成、独立目的校验和整单发布已实现，详见后文对应章节。原执行身份的本地文件映射与运行快照检查现已接通（见后文）；输入未发布时保持 DATA_WAITING，全部发布且本地授权/材料齐全后才能准备运行。


## 7. 计量与证据必须独立

现有 `recordUsage()` 是终态后尽力写计量，失败仅记日志；默认 raw 记录 7 天后汇总删除。因此联邦不能用“以后定时扫 metering_usage_raw”实现可靠存证。

已为关联联邦任务的 Job 在终态事务里写入持久 terminal-evidence，保留任务/尝试、执行快照摘要、动态调用路径摘要、资源请求和平台观测；后续 worker 再生成签名报告，账单独立处理。任务已经完成但证据尚待整理时显示“结果已完成，报告待核对”，不能捏造零用量或因链离线重跑。

计量口径明确为资源分配时长还是调度器实际采样；当前 CPU×运行时长不能改名为“进程实际 CPU 消耗”。缺失数据标记来源/质量和待补采，计费引用双方批准的口径与价格版本。

迁移 0115 建立 federation_terminal_evidence，按 Job 唯一且不级联删除；JobService 的完成/失败/取消与数据集/授权撤销均在原事务保存证据。证据失败则 Job 终态与 Agent 事件去重记录一起回滚，原事件可重试；终态重放不覆盖首份证据。保存不依赖当前商业批准或链可用性，合作撤销后仍能留存取消事实。

当前观测来源为 server-status-observation，不是调度器会计数据：保留终态写入前的 startedAt，避免将 JobService 在终态补写的时间误当开始；没有开始标记 start-unobserved，时钟倒退标记 clock-inconsistent，不计算虚假零用量。未取得调度器计量时标记 unavailable；新 Agent 的有效计量随同一终态事件保存时标 reported，平台取消也不代表远端停止已确认。资源数量用整数字符串保存，memoryMb 直接从 PostgreSQL bigint 文本读取；不复制命令、环境变量、脚本输出、凭据或真实用户身份到证据正文。这里只落本机构受控数据库，不自动向链/对端披露。签名报告、计量口径与合同价格关联及追加技术更正已按后文接入，最终账单仍待实现。

Slurm 从 sacct 精确匹配 JobIDRaw 汇总行读取 ElapsedRaw、AllocCPUS 与 TotalCPU，保留步骤查询以取得正确利用量，不使用会把利用量归零的 --allocations 选项；身份恢复查询仍保留它原有的 --allocations 过滤。--duplicates 暴露重复作业 ID，无法唯一匹配时只保留状态回退，不猜哪一份用量属于本作业。Slurm 同一查询中若步骤仍非终态/状态未知，或步骤时长、CPU 用量超过汇总，保留已知作业终态但不输出本次 accounting，避免将尚未合并的零值直接报告为用量。PBS Pro 从当前或历史 qstat 的 resources_used.walltime/cput/ncpus 读取。CPU 时间与分配核数分别保存，绝不以申请值乘时长填补 CPU 时间。

新增 SchedulerAccounting 可选 protobuf 字段，不改变原状态事件 ID 和 ACK 顺序。JobRunner、SQLite outbound、重连映射、gRPC 和终态证据贯通；Server 核对 registered Agent、持久事件、调度器类型与作业 ID。缺字段保持缺失，合法零值保留；超过 JS 安全整数的值使用字符串/BigInt，时间统一毫秒（亚毫秒截断）。这是调度器断言，不证明测量插件已正确配置或科研结果正确；部署验收仍需验证 Slurm jobacct_gather / PBS 会计能力。Kubernetes、Torque、GPU/内存实际消耗尚无这条数据来源，不能据此生成零账单。

独立 evidence 保留与 raw rollup 删除解耦；签名证据正文/引用及对象备份验证后才允许按协议清理源证据。执行存储失败与存证服务失败分开：前者可阻止新增任务，后者进入队列。

存证 worker 只读取 `bilateral_attested` 的证据；direct 为 NOT_REQUIRED，无链探测。 真实联合验收已覆盖启动业务前停 Orderer，提交前预授权账单/结算，工作与本地账务继续，恢复后原商业待办和接单批次取得实际 VALID 且不改本地余额；见[异步实验](../../../deploy/federation/execution-lab.md#异步存证断链验收)。链上协调记录进入其对应状态投影，不让批次补交执行第二次财务扣减。

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

介质导入/导出将使用独立 Agent 命令，服务于受管目录；age 使用固定版本、SHA-256 校验的官方二进制，归档流限制条目、路径、链接、空间与内存。既有数据下载/复制/只读挂载继续复用，不将加密逻辑塞进每次常规 `prepare()`。

格式与 Agent 归档/加密底层已经实现，真实加解密可返回隔离区；Server 已接入包登记/撤销、接收方本地导入批准、来源方披露许可及密钥加密托管。机构间 mTLS 密钥端点已接入，独立签署用途与 Agent 公钥加密响应已通过隔离数据库/真实 TLS 验证；来源及接收 Agent 命令、持久待办和短期授权已接通，接收端临时私钥解封来源凭证，真实 age 解密后保留私有已校验文件；导入时复查双方授权。独立来源使用审批和 mTLS 短期签发已接通，见[数据使用许可](dataset-use.md)；接收方续租、Data Market 副本发布、签名导入回执及受限 Sandbox 本地输入已接通；同机 Slurm/PBS 执行和停止已有真实验证，跨站 DATA_WAITING 与来源撤权联合验收仍待完成，见[介质包实现边界](media-package.md)。该状态不代表 W07/W08 已完成。

校验完整后发布副本，再由 Server 签署导入回执；key 通过独立认证通道交付，不能放命令行、介质或日志。原型与真实科学材料标识清楚，模拟安装独立前缀且可恢复。

## 9. Fabric Adapter 与链码边界

Adapter 只有机构内服务接口：submit/evaluate/commit-status/events，检查允许的 network/channel/chaincode/function、机构签署身份与集合。Server 管理业务操作及 outbox，Adapter 不对普通用户开放原始任意链码调用，也不另存业务余额。

- `kq-evidence`：仅验证与追加存证批次，不管理实时任务额度。
- `kq-market`：公共需求/单一分配/不含商业字段的激活与终态，公共背书策略。
- `kq-commercial`：对应 PDC 的条款/额度/许可/结算，集合级机构背书。

raw transaction args、chaincode response、events、trace 均不能携带私有正文；transient 限定发送至集合成员。背景重试不可扩大背书集合。PDC 中的余额和冻结额也属私有数据。

公共激活读取商业链码当前 executionGate 的 hash/version，取消/退款更新 gate；商业释放反向读取公共任务状态。这是必须用真实 Fabric 验证的跨链码读集竞态，不能只靠应用先读后写或 mock 单测判断正确。

公共交易 MAJORITY、合作域 AND、关键治理 ALL 及指定仲裁模板由部署/lifecycle 策略表达。ALL 导致成员离线时升级受阻，这属于明确选择的治理边界，不由平台管理员绕过。

争议的具体对象、字段披露、冻结竞争及裁决执行约束见[争议与授权披露](disputes.md)。案件采用独立 A/B/R 集合，原 A/B 商业集合不扩员；R 的裁决与依赖原私有账目的记账分开，不能通过修改原背书政策绕过缺席机构。该部分尚待实现与联合验收。

公共市场链码已增加 OPEN → CLAIMED 或 CANCELLED；按同一需求键的版本读取和写入，由 Fabric 提交时 MVCC 保证单一认领。原请求重试不覆盖，不因截止时间过去自动重新开放；CLAIMED 已增加私有双签预留/gate 约束的链码激活和激活前释放；Server 公开激活审批与待办已接通，实际执行入口必须再取得有期限的 VALID 执行确认。真实三机构验证多数背书和竞争认领，见[部署与验证说明](../../../deploy/federation/fabric-market.md)。市场 Adapter/本机客户端和 Server 持久操作 API 已连接，公共目录查询已接通，私有锁额/gate 已有链码实现，应用执行入口已接入有期限的确认，真实双平台与 Kubernetes Agent 轻量文件工作流已通过；Web 联合验收仍待完成，缺少确认时保留拒绝门槛。

## 10. UI 与配置

已接入现有平台安全的 `security/federation-trust` 页签，按机构列表、详情、公钥与客户端证书组织操作。只有选中页签才请求联邦信任数据；机构分页、登记/编辑、暂停/恢复/永久撤销、公钥用途与有效期、证书登记/撤销均调用现有平台管理 API。客户端和 Server 共用输入 schema，响应按共享 schema 校验；失败保留草稿，刷新失败禁用旧详情写入，迟到详情不覆盖当前选择。机构 ID 不可修改，私钥不经页面上传，永久撤销需确认对象。沿用移动端只读策略和中英文文案。它不授予协议/财务审批权，也不代替其他联邦业务 UI。

复用现有工作区、capability 投影和列表/详情组件，增加机构范围内的联邦管理入口。协议编辑显示三种业务模式、范围、限额、有效期、批准人与指定可见机构；不使用一个模糊“启用区块链”开关。

执行、对账、存证分别展示；直接模式显示“不要求存证”，异步模式可以“成功 / 账单已确认 / 待存证”。轮询/事件只更新变更数据，避免切回标签页重新清空页面。延续现有移动端策略、错误重试、翻译和资源归属显示，不堆积技术说明。

平台运营者只管理本实例可管的联邦配置；合作方商业字段和业务审批必须另有范围授权。API、导出、CLI 和图表使用同一权限判断，不以隐藏按钮代替服务端拒绝。

direct 模式不要求 Fabric URL、镜像或证书；attested 模式任务 readiness 不绑定链连接，但单独展示存证 readiness；coordinated 的新增激活受链确认约束。服务的存活、业务可用性与链可用性分别检查。

直接模式已有独立真实入口 `test:federation:direct`：只生成机构业务身份，复用现有 Server/Agent/存储执行脚本；双方商业与执行协议后台交换，提交前独立账单/结算政策自动收尾，本地余额与调整保持守恒且所有链待办为空。共享身份夹具也供协调测试读取原链身份，未改变协调许可门槛。范围见[无链验收](../../../deploy/federation/execution-lab.md#无链双边合作验收)；异步存证已通过真实 Orderer 中断、完整文件任务/本地账务及恢复补交；全部链组件不可达与真实页面仍待联合验证。


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

发布要求目的存储具有真实 versionId，普通云盘下载将使用该固定版本；无版本对象仍可完成内部字节验证，但不能发布长期可用副本。已发布对象不进入尝试过期清理，用户仍可按普通云盘操作删除自己的文件；available 表示曾完成本地登记，不是永久保存保证、对端签收或商务验收。自动后台与签名接收回执见下文。

### 后台结果处理与签名接收回执

结果后台每 10 秒扫描，先处理至多 4 个过期/待清理尝试，再领取至多 4 个已全部验证（或空清单）的发布意图，最后向具备 copy/verify 能力和当前 mTLS 连接的本组织 Agent 派发。每个 Agent 一次处理一个文件，忙碌节点在数据库候选查询中排除；并发 worker 仍由既有尝试锁和唯一约束防止重复领取。断线或进程退出后，未完成尝试到期清理再重传，verified 成员直接重新授权发布。暂不跨 Agent 进程续传暂存文件。处理错误保存 lastError，至少间隔 30 秒重试；取消不因后台重启而重开。

发布事务同时保存不可变 result-receipt 正文，绑定原操作、协议、预留、请求摘要、结果清单摘要、文件数、字节数与收到时间。它不含内部用户、Job、云盘 fileId、存储 key 或下载凭据。源站独立后台签署并经固定 mTLS /federation/v1/result-receipts 发送，接收方持久登记后签署 result-receipt-ack。两个用途须显式登记，旧密钥不会自动扩权。

回执发送与文件搬运独立：网络失败至少 30 秒后重发相同正文/JWS；对端记录成功但响应丢失时返回原确认。同 receiptId 换正文拒绝，确认须匹配原回执摘要与双方身份，返回后再查当前机构/密钥信任。对端核对原任务预留、完成状态与原结果披露范围，登记的是源站签署的收到声明，不证明科研结果正确或自动确认账单。原披露期限结束、用户权限撤销或后来删除文件，不抹掉已经发布的历史事实；信任失效仍阻止签署/发送。

导入详情的 available 表示本地文件已登记；receipt.pending 表示远端确认未取得，receipt.recorded 表示双方签名与对端记录已保存。无论回执送达是否成功都不会重新搬运已发布文件，不释放计算预算，也不触发结算。0103、0104 迁移分别保存签名回执与后台重试状态。

回执密钥轮换：源站所有者具有 result.read 时可调用 receipt-retry，让后台对原接收事实用当前配置的密钥重新签署；权限、组织与 operation 范围均检查并审计。在途旧签署流程不能覆盖重试后的状态。接收方当前密钥与已存确认的 keyId 不同时，重新签署同一确认正文，保留原 recordedAt，不重复登记或认可新的收到声明。

Docker/Helm 存储初始化默认启用云盘 bucket 版本管理；无版本旧对象需要重新写入才能得到真实版本。保留版本可能使后端物理占用大于用户逻辑配额，不自动按年龄清除仍被记录引用的版本；历史版本回收仍需要运维策略。


### 接收端输入下载验签与上传凭据

input-reader 在接收方当前 Agent/活动尝试授权通过后，使用独立 input-download-query 签名请求源站 input-downloads 固定路由。它核对 input-download-grant 签名、查询摘要/随机标识、双方站点、接单/任务、原清单摘要、descriptor/path/大小/SHA-256 及 transferId/generation；旧响应、结果身份和其他成员不能混用。最终事务同时持有当前传输、身份/协议、站点与密钥锁，并复查双方专用用途及源站 endpoint，防止网络等待期间撤权或换代后释放凭据。

只接受配置的 FEDERATION_INPUT_IMPORT_SOURCE_ORIGINS 下的 HTTPS URL，要求唯一、非空且非字符串 null 的 versionId。签名信封与实际 X-Amz-Date/X-Amz-Expires 必须一致，最长 30 秒且受查询、执行/尝试和当前密钥截止约束；密钥期限在网络期间缩短也重新检查。下载地址/JWS 仅返回内部 Agent 路径，不保存进清单、尝试或审计。

input-storage.grant 对下载和上传均先验证当前尝试并在共用 Agent 锁内续租。上传只允许当前文件所需的 partNumber，签发给本地 FEDERATION_INPUT_DOWNLOAD_ORIGINS 下的原 uploadId/partNumber；实际凭据最长 30 秒，存储 I/O 后再次核对身份、Agent、协议、尝试、uploadId 和截止。两个配置缺失任一项时不发搬运凭据，清单与清理不因此停用。异常 SDK/网络信息不直接返回，避免泄漏票据。

Server 启动已装配这些内部服务与配置。验证使用隔离 PostgreSQL、真实双方签名及受控传输/存储替身；尚非真实 Agent 网络搬运。配置这些变量不等于可以执行文件工作流，还需本地文件映射；上传完成与目的校验的内部持久路径见下文。


### 输入上传完成与目的验证

接收端按原 transferId/generation 保存分片编号与 ETag；重复复制回报必须完全一致，不能换分片重新组装。开始 CompleteMultipartUpload 前持久保存一次性许可，所有存储 I/O 均在事务外进行。重试查询原 key 或已固定的版本，不再次发起合并；找到对象后保存 versionId/ETag，并核对大小。缺少真实版本或大小错误的对象进入待清理，不能成为可用输入。

verificationGrant 只针对当前 verifying 尝试签发最长 30 秒的固定版本下载地址；核对目的 origin、唯一 versionId、实际签名期限和当前租约，网络等待后重新核对身份、协议、Agent 与尝试。Agent 按既有输入验证协议重新读取目的字节并计算 SHA-256，Server 对回报的原清单/成员/代次、版本、大小与摘要逐项匹配后保存 verified。HEAD 或上传成功回报不能代替目的内容验证。此内部路径现已接入生产 Agent 消息与能力协商，协议与部署条件见下文。

合并超时或响应丢失后，已成功返回的迟到响应仍登记到原代次；后台也能通过 HEAD 找回已完成对象。取消或到期后，完成结果尚不明确时不清理确认、不释放配额；找到对象并完成实际清理后才能收尾。单次 HEAD 查无对象不能证明请求未执行。如果进程在保存许可后、发请求前退出，或存储拒绝请求且始终没有对象，当前自动流程将保留待核对状态；不能直接清数据库来释放空间，现可由受信任平台管理员登记外部写入停止/存储排空声明，绑定原快照后让后台实际清理；没有可信依据仍保留配额，见[运维核对](../../../deploy/federation/README.md#输入存储未知请求的运维核对)。

verified 不因传输租约到期而删除，仍占清单预留空间；取消/原授权失效由输入清单扫描进入清理，清理失败继续保留额度。整单发布现已接通（见下文），只有发布事务才能转为本地文件与用量；只有 verified 仍不解除文件 Workflow 的 DATA_WAITING。迁移 0111 由 Drizzle 生成，增加完成请求、固定版本、验证时间和对应状态约束。


### 创建上传响应丢失的恢复

清理扫描对已封锁且租约到期、已发分配许可但缺少 uploadId 的尝试，按原站点和精确 federation-inputs/<importId>/<generation> 路径查找 multipart。完整列表中只有一个 uploadId 才登记回原代次，之后复用现有实际清理/配额释放；不会发第二次 CreateMultipartUpload，也不恢复旧 Agent 的上传权限。查无结果不证明请求未执行，多条不同上传、扫描超过 1000 项或网络错误均保留待核对。迟到的原响应可幂等登记，换 uploadId 拒绝。

该发现能力由真实 MinIO backend 提供，测试替身可缺省而继续保守保留；Docker 与 Helm 初始化策略都授予输入目录的固定版本读取、multipart/版本列举和版本删除权限。列表和删除范围仍只限联邦输入/结果目录，不开放普通云盘历史删除。未知合并继续通过固定对象 HEAD 恢复；始终没有正向存储证据的请求仍不能自动释放空间。


### Agent 输入传输与自动派发

新增独立 FederationInputCopy/Verify、GrantRequest/Response、CopyReport 消息，不借用结果报告身份。网络复制要求 Server/Agent 同时协商 federation_input_copy_v1 与 federation_input_verify_v1，且连接具有已核验的 mTLS 指纹；纯介质上传使用独立目标能力，见[版本兼容规则](task-media.md#纯介质目标配置与版本兼容)。旧 Agent、未配置 Server、缺少目的校验能力或未核验连接均不领取输入任务；默认关闭的独立 Agent 配置为 AGENT_FEDERATION_INPUT_COPY，格式见部署说明。下载与上传/目的校验使用当前代次的短期凭据，不携带存储账号密钥。

Server 接收处理保持异步，存储等待不阻塞心跳；输入/结果共用每连接至多两个在途请求上限。返回凭据前核对原连接仍为当前连接，重连期间完成的旧分配进入待清理，复制回报不能直接生成可用文件。独立 Agent 客户端复用租约/请求关联/断线取消会话，并共用一个传输槽；原结果协议保持兼容。到期或断线中断字节读写、清理暂存，迟到凭据被丢弃。

输入 worker 每 10 秒扫描，至多取得 20 个候选、向 4 个不同 Agent 尝试派发；输入成员创建或失败后至少等待 30 秒。候选查询同时排除输入与结果活动/待清理租约，事务领取仍通过共用 Agent 锁保证多 Server 不重复占用。独立准备扫描处理取消、到期与残留清理，即使关闭派发仍继续收尾。已复制但没有完成目的校验回报的尝试，在租约到期后清理并重新传输，不跨 Agent 进程续传暂存文件；已 verified 成员不会重新复制。

Server 启动/退出已装配输入传输和 worker；前提是双方协议/源站和目的存储 origins、存储版本权限均就绪。后台现会发布整份已验证清单；原身份下受管输入映射和执行检查通过后，文件工作流才可解除 DATA_WAITING。字节搬运组件测试与 RPC/数据库测试分别通过，不冒充完整双平台文件输入验收。


### 输入整单发布与撤销

输入 worker 每轮先领取最多 4 份全部 verified 的清单（含空 FileBatch），再派发新传输。发布前在事务外 HEAD 固定版本并取得源站新签名清单；最终事务重新锁定原身份、协议、输入清单和成员/代次，核对与检查前完全一致。源站授权沿用材料交换的 60 秒披露窗口，锁等待后再次检查截止，不把历史签名当作永久授权。失败保存错误码并至少退避 30 秒。

以成员 UUID 作为本地 fileId，归属原接收执行账号，路径为 federation-inputs/<importId>/<descriptor>/<path>；记录固定目的 versionId、ETag、大小和 SHA-256。目标路径已有活动文件时整单拒绝。按用户共用云盘事务锁，把预留空间、全部文件、成员/尝试 available、清单 publishedAt 和审计一次提交；配额下降或授权过期会全部回滚。并发重试和服务重建返回同一结果，迟到复制/校验回报不会让 available 回退。

取消或本地授权失效后，仅隐藏与原 fileId、owner、key、version 全部匹配的文件，恢复原清单全量清理预留；不覆盖后来替换的文件，也不重复预留。已发布输入必须等绑定 Workflow 和全部关联 Job 终止、取消/撤权确认完成，以及原传输租约到期后才实际删除对象；存储失败保留预留。无运行绑定时无需等待作业；有运行且停止证据不完整时继续等待。最后一个尝试清理确认才释放配额并允许停止回执。

迁移 0112 由 Drizzle 生成，增加 available 状态、发布时间与领取索引。发布是受管副本登记，仍不授予作业使用权；原身份 File/FileBatch 映射及执行时锁定输入状态已接入，未发布或授权未就绪的文件委派继续等待。发布竞态测试使用真实签名/PostgreSQL 和受控存储替身；另已通过双平台小文件真实存储、Agent 和 Kubernetes 作业往返验收。


### 文件暂存下载的版本固定

联邦派发和重投递续期 NetDrive 下载凭据时，同时传入已保存的 storageKey 与 storageVersionId。最终发送事务复查两者均未改变；即使大小与 SHA-256 相同，也不能使用针对旧版本签出的地址发送新快照。普通未记录版本的历史文件保留原读取方式，输入发布生成的文件必须有真实版本。该修复只保证续期沿用当前受管文件版本；跨站输入的原尝试/文件映射仍须在工作流执行授权中核对。


### 普通工作流文件委派与接收执行映射

源端 Federation 节点的 File 槽先复用受管产物解析器，再把 descriptor、File/FileBatch 类型、文件 ID 与安全相对路径交给既有导出服务。ID 只供源站核验所有权和固定版本；大小、SHA-256、存储版本以数据库为准，不使用 YAML 声称的值。单文件可用 expectedFileName 选择交付别名；批次保留 relativePath，否则采用 fileMetadataName。相同动态 invocation 恢复仍使用原快照；选择或固定版本变化会拒绝重用，双边 inputPolicy 和字节/数量限制保持。

接收准备在原身份/协议锁内读取 available 清单、全部成员及已验证尝试，并锁住原账号的活动云盘记录。必须逐项匹配文件 ID、路径、大小、摘要、key、版本及 ETag，缺项或变更不能用当前文件“修好”旧快照。接收文件映射以 receivedInputs 保存在内部运行快照，普通模板投影只包含本地 fileMetadataId、名称、摘要、大小和批次相对路径；存储位置不进入模板。

工作流 File 槽按 descriptor 和单文件/批次类型匹配；允许无绑定的显式文件槽或 from.param 同名文件参数。只替换接收端批准的输入，保留上游节点绑定；表达式、已有源端文件记录、类型不符和未使用的交付项拒绝。文件参数需声明可容纳对象/数组的类型（通常 json），不能同时传同名标量覆盖。独立 Script 模板按原 I/O 声明构造 File 或 FileBatch 槽，缺少可选输入不挂载，空批次保留为空选择。FileInput 新增可选的安全 relativePath，软件用例暂存和脚本批次均保留子目录。

创建、启动、恢复及后续派发沿用相同 receivedInputs 快照；最终锁内再读清单与文件并比较，取消不能从检查与派发之间穿过。已发布但后来删除、换所有者或版本/校验事实改变的文件不再获准使用。该链路不自动批准软件、队列或脚本沙箱权限；这些仍走既有接收机构策略。普通无文件运行的快照格式保持兼容。此项只增加 JSON 快照类型，Drizzle 确认没有新 SQL 迁移。

示例文件槽（其他 Federation 字段仍按上面的完整示例配置）：

```yaml
inputSlots:
  - descriptor: input
    type: File
    from: { param: input_file }
    expectedFileName: input.dat
  - descriptor: samples
    type: File
    isBatch: true
    from: { node: collect, output: samples }
```

源端的 input_file 是当前用户有权访问的受管文件引用；远端模板声明的输入名为 input。远端多节点 Workflow 若通过参数消费，应声明 input/json，并在目标 File 槽使用 from.param: input。数据库/转换测试已验证就绪映射与 held 运行绑定；真实双平台已通过云盘单文件 → 接收端原身份 Script → 结果回传 → 源站云盘下载，源站 SIGKILL 后沿用原委派。使用独立数据库/存储、真实 Agent 与 Kubernetes 沙箱；不代表 Slurm/PBS/Spack/Fabric 或完整蓝图验收。


### 输入未知存储请求的显式运维决定

迁移 0113 为输入 attempt 保存独立 reconciliation，不修改原 uploadId/completionSettledAt 等事实。管理员先查看原站点/清单/代次/对象/请求/租约的规范摘要，只有导入 cancelling、尝试 cleanup_pending、租约已到期、绑定执行及取消/撤权回执已停止，才可登记停止时间、工单号和外部核查证据 SHA-256；该入口是平台 manage 权限，不接受对端签名或普通组织角色。详情和列表 no-store，正文上限 4 KiB。

管理员声明是显式的运维信任边界，不是由 S3 空结果推导出的技术证明。所有原写入者和存储端在途请求必须确实已停止；停止/隔离记录由机构保管。清理 worker 仍须删除精确 key 的全部分片/版本并确认无残留，才能收尾释放；记录本身不授予执行权、不放宽新上传许可。重复正文只返回原决定，变更正文冲突；并发或迟到存储事实会使旧快照/清理 token 无效。API 挂在现有鉴权后的平台管理入口，部署流程见[运维核对](../../../deploy/federation/README.md#输入存储未知请求的运维核对)。


### 输入存储核对页面

平台安全的 `security/federation-storage` 使用现有平台管理 API：最多显示按更新时间排列的 100 条未知请求，可按 generation 直接查询其他请求或已经离开待处理列表的代次。页面展示输入/任务归属 ID、执行停止确认、输入/尝试状态、租约、对象 key 与摘要，详细请求快照按需展开。登记表单要求工单、外部核查证据 SHA-256、本地时间及两个未预选的停写/排空确认，提交前再次确认对象及操作效果。

提交绑定读取时的 snapshotDigest；响应丢失/冲突保留原声明供相同正文重试，不自动重写为新快照。用户刷新后若摘要变化，重新填写并确认，避免沿用旧核查依据；详情刷新失败不提供旧数据上的写入。服务端仍决定当前是否允许登记，客户端检查不替代事务内复查。记录后展示登记人、时间和工单，明确后台实际清理仍待完成；单个 cleaned 不等于整个导入额度均释放。沿用 platform manage 与移动只读策略。此处只覆盖输入未知存储请求，更广的结果存储维护仍待补齐。


### 联邦组织授权管理

平台安全新增 `security/federation-permissions`，使用现有组织目录和新增的限定组织真人成员搜索，按组织分页查看/授予/撤销八种业务 capability。同名组织通过 ID 区分，提交始终绑定所选组织和成员；编辑期间保留草稿，乱序响应不会串组织，错误状态不允许基于旧列表写入。成员不再有效时保留可识别、可撤销的历史授权；移动端只读。它不授予本地软件/数据权限，也不直接签署合同。

权限枚举、输入/响应 schema 和已有包含关系移至 shared；Server 原导出保留，服务端检查与当前权限视图共用包含关系。新增 `GET /api/federation/capabilities` 仅返回当前真人成员在会话活动组织的显式及有效权限，平台角色不作自动扩权。管理成员搜索只返回该组织未停用、非服务账号成员；所有写入仍在事务中复查成员与授权。

平台成员移除流程同步修复旧联邦授权残留：成员关系、该组织 capability 删除、SpiceDB outbox 与包含被撤销 capability 的审计同事务提交。失败全部回滚，其他组织授权保留，重新入会不会恢复原审批权。无迁移；老版本或绕过业务入口产生的无效记录仍能由授权页显式撤销。合作协议页使用该组织权限视图，具体操作继续由协议 API 实时校验。


### 组织协议签署与签名交换页面

资源区 `/federation` 面向获显式业务授权的当前真人成员，不按平台角色推断签署权。机构选择器包含普通成员的组织，按机构与登录版本隔离草稿和查询。新增 context 接口返回本站 ID 和实际支持模式；执行账户目录只向批准者开放，复用签署时的资格条件（当前组织 member、基础 user、未停用服务身份），不把目录结果当作最终授权。两个接口均使用会话主体和 no-store。

导入双方约定的严格协议 JSON 后，页面展示机构、模式、有效期、精确额度、资源、模板、输入/结果授权与完整原文。接收方明确选择执行账户，委派方不提交该字段；签署及不可逆撤销均需确认。双方签名和本地状态分开展示，异步存证不阻塞执行，链上协调模式不能签署或静默降级。合同材料摘要和已签条款摘要分别标识。未知结果保留原请求供幂等重试；暂停/撤销不宣称远端运行已停止。

可选 ApiOrganizationScope 在首次请求及登录续期后的重试均核对活动组织与登录版本，拒绝串用新上下文。组织目录/选择自身也防止迟到响应覆盖新选择；机构切换复用原算力提供方缓存清理逻辑。手机界面沿用平台只读策略，其中协议 approve 不属于普通审批的移动端豁免。无需数据库迁移；完整合同表单、私有商业字段、市场/结算与其余蓝图仍待实现。


### 私有商业合同与用量记录

已新增 contracts/fabric/commercial，独立于存证链码。共享 commercial 子入口定义私有合同（绑定原执行协议/价格版本/整数单价/文本）、提供方用量与追加更正，JWS 用途 commercial-agreement、commercial-usage 单独声明。链码配置沿用公开机构/域映射并增加每把业务公钥的显式用途；策略仍用 Fabric 原生机构 AND，不在应用层模拟背书。

RegisterAgreement 验证双方对同一条款的签名后只写对应 PDC；RecordUsage 绑定已登记合同摘要、提供方、任务/attempt、原执行期间及指标单位。初始报告唯一，更正必须接续当前私有头记录，读集由 MVCC 防并发；旧报告重放保留原字节且不回退头。审批历史已提交后不因旧签名公钥自然到期而消失；新报告的业务签名继续检查当前用途/撤销与有效期。所有普通返回仅随机记录 ID/带盐摘要，禁止用 Get 方法返回原文后误 submit 到公共区块。PDC hash 与字节不符继续等待，不当成空状态。

新增真实 A/B/C Fabric 3.1.5 商业检查，复用隔离网络构建器，通过私有区块投递验证越权不可见、缺机构背书提交无效、并发重复原始用量冲突；CI 已接入。详见[运行配置](../../../deploy/federation/fabric-commercial.md)。Server 商业审批与 Adapter 检查点已接通；公共市场 gate/额度锁定已有链码，相关应用执行与结算尚未接通；登记商业合同不放开 ledger_coordinated 执行门槛，不将提供方用量当成已确认账单。


### 自动签名用量报告

迁移 0116 新增 federation_usage_tasks 与 federation_usage_reports。后台发现已终态、绑定本地执行协议且具有商业双签的接收 Workflow；按预留唯一建待办，SKIP LOCKED 串行推进。同一事务保存签名报告、原始证据集合摘要、reported 状态及可选商业链待办；失败全部回滚，重启继续原工作项。签名使用当前有效且明确允许 commercial-usage 的机构密钥，历史批准人员离职或合作随后撤销不抹除已发生的计量事实。

自动统计仅接受以下精确组合；导入的旧合同不改写，未支持的口径进入 missing_data。

| metric | quantityUnit | 统计方式 |
| --- | --- | --- |
| cpu.time | cpu-millisecond | 调度器累计 CPU 时间相加 |
| cpu.allocated | core-millisecond | 每个 Job 的调度器分配核数乘运行毫秒后相加 |
| job.elapsed | job-millisecond | 每个叶 Job 的调度器运行毫秒相加，并行 Job 分别计算 |

每个 Job 只计一次，每个合同指标须有全部 Job 的相应字段；真正回报的零保留，缺失不补零，不签部分报告。使用 BigInt，超过 38 位整数或超过 4096 个叶 Job 进入 needs_review，不截断。集合按 Job ID 排序，绑定预留、协议修订、价格版本和全部独立证据摘要。Schema、摘要、任务/尝试/运行/执行快照或调度器来源不一致拒绝出报告；统计不读取会过期的普通 raw metering，不从申请量与 Server 时间推算 CPU 消耗。

报告覆盖窗口是接收 Workflow 的 createdAt 至 completedAt，与计量数量独立。无有效终态、时间倒退、未来时间或窗口超出协议有效期进入复核，不能裁剪成有效窗口。原始证据在保存前统一去掉协议转换中的可选 undefined，随后计算摘要并持久保存，严格 canonical encoder 不放宽。

直接模式本地签署后完成，不创建链待办、不探测链；存证模式先等同一商业合同的注册 committed，再由原持久提交服务推进 record-usage。商用 worker 在配置机构签名后即可工作，无需配置商业 socket；未配置 socket 时存证待办保留。每轮最多发现八项并推进八次，无网络 I/O 占用生成事务。报告是单方计量断言，不激活执行、不变更额度、不确认账单。

按组织受控的 GET /api/federation/commercial-agreements/:revisionId/usage 与 /:reservationId 提供状态和报告；POST /:reservationId/retry 仅接受空对象并要求 agreement.approve，其他读取要求 agreement.read。missing_data/needs_review 可以重试，已签报告不能重生成；审计不复制用量正文。响应 no-store，报告仅本机构可读，证据集合未发给链或其他机构。技术更正已按下述规则接入；跨机构报告交换已按下述规则接入，Web 操作已接商业合同详情。


### 终态后的迟到计量补采

迁移 0119 新增独立 federation_accounting_collections。商业 worker 只发现初始报告处于 missing_data、且合同支持的计量字段在原终态证据中缺失的 Job；每轮最多发现 64 项、推进 8 项。请求先在数据库提交 60 秒租约与随机 requestId，再经现有 Server/Agent 流发送，不持锁等网络；离线或旧 Agent 保留待重试。请求绑定原证据摘要、Job、dispatchEpoch、schedulerJobId，注册 Agent 必须声明 federation_accounting_v1。

Agent 只查 Slurm/PBS Pro，要求原 SQLite 派发收据及准备快照仍存在，并已进入提交阶段。读取计量前后分别按原 Job UUID、代次名称及账户定位调度器任务，拒绝 ID 复用、非终态或身份不符。最多两项并发查询，不执行脚本、不重新提交任务。调度器历史已清理、权限不足或旧 Agent 无能力时保持缺失；不会补成零。

Server 重新核对注册 Agent、当前 Job 归属、执行代次和租约。过期回包不能覆盖新请求；身份冲突进入 needs_review，无结果或字段不全间隔 60 秒重试。单份观测必须满足合同全部指标，不拼接不同时间的字段。接收观测、摘要与唤醒报告生成在同一事务保存，原终态证据保持不可变；报告 evidenceSet 的每项保留原 digest 及可选 accountingDigest。直接模式仍无 Fabric 依赖，存证模式复用原报告待办。

既有用量 retry 接口可以重置该预留的补采复核状态，无新公共接口。已签报告不自动重采或更正；首次已有完整但不准确的计量也不属于本补采机制，须通过技术更正追加声明。隔离 PostgreSQL 覆盖并发/重启/过期回包/事务回滚，真实 Slurm 探针覆盖生产查询模块和 SQLite 收据读取；探针的收据与原证据摘要是受控输入。追加验收已通过完整生产 Server/Agent 的正式注册和 mTLS 通道，在 Server 重启后自动补采真实 Slurm 并签署报告，HTTP 读取与原摘要一致；初始完成任务和派发收据仍为受控输入，尚非真实委派提交、双站交换、PBS 或 Fabric 联合验收。


### 用量技术更正

迁移 0117 为 federation_usage_reports 增加 correctionEvidence，只在更正记录中保存提供方声明。POST /api/federation/commercial-agreements/:revisionId/usage/:reservationId/corrections 要求本机构真人拥有 agreement.approve，字段为 reportId、correctionOf、reason 和完整 measurements；每项保留精确 quantity、合同规定的 metric/quantityUnit 及 supportingEvidenceDigest。严格拒绝额外字段，不能修改报告时段、合同、任务或尝试，也不能通过更正把尚无原始报告的 missing_data 任务变为已报告。

reportId 为客户端持久 UUID。事务锁原工作项，再核对最新报告；同一 UUID/同一声明重试返回原签名，即使之后已有新更正也不回退头。同一父报告的不同更正只能接受一份；旧头、新 UUID 或已用 UUID 换内容均冲突。原始报告、终态证据和先前更正不更新。原报告查询支持 limit/offset 和 hasMore，历史超过一页仍可访问。

更正声明保存原因、完整数量、佐证摘要、原报告摘要和随机盐；更正后的 CommercialUsage 通过 evidenceDigest 承诺该声明，并以 correctionOf 引用上一报告。原 evidenceSet 只保留最初观测的出处，不能解释为证明更正数量来自 Agent。supportingEvidenceDigest 是操作人对外部技术材料的声明，当前 API 不接收也不验证佐证文件内容；应由授权人员核验并在机构受控存储保留材料。此记录不是自动补采、商务减免、需求方接受或付款凭证。

当前机构签名用途仍须允许 commercial-usage；报告、更正声明、可选链待办和脱敏审计同事务保存，任一步失败全部回滚。直接模式不创建链待办。异步存证须在合同登记及 correctionOf 对应前一用量报告都 committed 后才推进；前一记录 pending/needs_review 不允许跳过，但也不阻塞双边计算。复用原链码线性更正与 MVCC 规则，不新增自定义背书规则。


### 机构间自动用量交换

新增 CommercialUsageQuery/Page 协议与 FederationUsageExchange。源站在已接单的原委派和本机构商业双签之间按协议修订及组织匹配，建立 federation_usage_syncs；商业 worker 每轮最多发现八项、推进八次。使用现有固定 HTTPS origin、Node mTLS 网关与 /federation/v1/usage 私有 JOSE 入口，禁止重定向/代理/调用方自选 URL。查询和响应分别要求显式 commercial-usage-query、commercial-usage-page 用途；旧密钥不自动扩权。

查询包含原操作、合同摘要、任务/尝试、接单预留、委派摘要、随机 challenge、最长一分钟窗口及前一报告序号/ID。执行方验证客户端证书与签名所属机构、商业双签和原预留绑定，发送前再次检查信任及查询有效期。每页最多一份报告，以新响应签名绑定原查询摘要、可见最新序号及报告状态；未产生报告、缺失和待核对分别保留。报文只含原报告 JWS、报告字段及更正声明，不包含原始 Job ID、执行用户、命令、日志或 evidenceSet。

源站验证响应 challenge 与全部身份字段，再验证报告本身的签名、合同、价格指标/单位、原执行时段与更正链。更正须引用本地已收到的前一份报告和摘要，声明的全部数量与签名报告一致；不接受跳号、回退、缺失前序或仅有有效外层签名的错误内容。自然到期但未撤销的旧签名密钥，可在报告 reportedAt 验证，前提是当前仍可信的提供方以新鲜响应重申原字节；已撤销旧密钥拒绝新导入。已收到的历史不因其后密钥到期消失。

迁移 0118 新增持久读取状态和 federation_received_usage，保留提供方原签名及验过的页签名。60 秒数据库租约、SKIP LOCKED 与 token 复查封锁迟到响应；网络调用不持锁，保存前重验当前机构信任。报告和读取位置同事务提交，写入失败不前进，重启后续读；还有后续更正时立即继续，读到最新后每 60 秒检查。网络失败退避，身份/协议错误进入 needs_review。后台沿用机构商业批准，不以原操作人员离职抹除历史同步权；真人读取仍须当前组织成员及 agreement.read。

GET /api/federation/commercial-agreements/:revisionId/received-usage 及 /:operationId 提供本机构状态和分页报告；POST /:operationId/refresh 仅接受空对象、要求 agreement.approve，只重排同步，不在 HTTP 内等待网络，也不能抢占活动租约。接口 no-store，不返回租约 token 或原始页签名。保留机构签名配置时，未配置发送通道也注册历史读取接口；详情的 syncEnabled 表示当前可否同步。关闭通道不删除记录或改写游标，刷新在检查权限后返回 ASSET_UNAVAILABLE，发现/推进不访问网络。报告收到、技术更正、双方确认账单和链上提交继续是不同事实；本服务不创建额度、账单、付款或新的存证待办，直接模式完全不探测 Fabric。


### 商业用量 Web 操作

商业合同详情分为合同条款与用量报告两个页签。提供方查看本机构工作项、缺失原因、分页原始报告/更正及存证状态；委派方查看接收历史、最近验签时间和同步状态，并可重排刷新。查询按机构、登录版本、合同和工作项隔离；错误时隐藏旧数据操作，切换机构或撤权清除更正草稿。后台更新保留当前内容，仅可见页面轮询，编辑/核对时停止详情轮询；手机只读。

报告数量用整数字符串和 BigInt 格式化，导出保留签名及当前可见证据。本地签名、链待办和 committed 分开展示；已收到报告不代表账单接受或付款。仅最新历史页可发起更正，提交完整指标数量、原因及佐证摘要；核对对话框固定请求 ID/内容，响应不确定时重试原请求。原报告缺失时仅可重新检查材料，不能用人工更正伪造首份报告。

新商业合同提供 cpu.time/cpu-millisecond、cpu.allocated/core-millisecond、job.elapsed/job-millisecond 成对选择；默认首项、每 1000 单位计价，慈善价格为零。自定义/旧口径保留原字段和原值并提示自动计量可能不支持，不转换已签署合同。此界面不增加计量补采、账单、执行 gate 或付款能力。


### 公共市场提交适配

独立 Market Adapter 复用 FabricSubmission 的签名提案、加密检查点、提交状态查询及按原 txId 恢复，采用 kq-market-v1 独立恢复用途。用户输入严格限定发布/认领/撤回未认领需求，本机 Adapter 另支持公开激活；固定本机构和配置中的通道/链码，载荷 canonical SHA-256 与链码回执核对，公开需求使用 Gateway 原生背书发现。检查点中的遗留 domainId 字段用于绑定治理 generationId，不是商业钱包，也不创造额度。

Node 私有 runtime 已支持 KQ_FABRIC_ADAPTER_KIND=market，套接字 market.sock；Server 已有 UnixMarketClient，并接入持久市场待办、机构范围操作 API；已支持公共需求实时分页查询，后台同步与 Web 仍待实现。prepared/pending/committed/invalid 与商业提交保持相同语义，committed 不授予执行权；认领还必须经过私有锁额和公共激活。配置与恢复方法见[部署说明](../../../deploy/federation/fabric-market.md)。


### 市场操作持久待办

迁移 0120 新增 federation_market_submissions/attempts 和 market.read/publish/claim capability。请求内容与 SHA-256、当前机构/请求人、审计同事务保存；相同 ID 同内容重试返回原状态，跨机构或内容冲突拒绝。撤回需要本机构已 committed 的发布，链码最终检查尚未认领。后台复用商业 worker，每轮最多八步；加密 proposal/transaction 检查点先持久保存，原交易 VALID 才 committed。网络在数据库事务外，保存时前后核验 90 秒租约；迟到 owner 不能覆盖新 owner。可复核原操作，未知提交保留原交易 ID；历史尝试不覆盖。

操作 API 使用真人/当前组织和独立 capability，平台角色不默认授权，GET 与重试也重验当前权限。公开字段投影及 no-store，不返回租约/恢复密文；列表与交易历史分页。已受理操作代表机构持久授权，不因原请求人离职自动丢弃；此语义与执行租约撤销不同，既有执行 gate 不因此放宽。配置、接口与边界见[市场部署说明](../../../deploy/federation/fabric-market.md#server-持久提交与权限)。


### 公共需求目录读取

kq-market ListDemands 使用 Fabric 原生分页，GetDemand 保留原单条语义。Adapter 的固定 query 接口仅允许上述两种 evaluate，校验公开 schema、ID/摘要及页长，Server 提供 /api/federation/market/demands 与 /:id，复用 market.read；网络前后重新检查组织权限。结果 observedAt 为读取时间，明确不同于区块时间；跨页不是一致快照，Peer 落后不授予任何执行权限。未配置/断线明确 503，单条不存在 404，不把基础设施故障当作空目录。不新增持久镜像表、迁移或另一轮询 worker。


### 私有预算与同通道执行 gate

商业预留按双方签署的 CommercialReservation 固定完整委派；复用条款校验并明确限定 ledger_coordinated。原 assertDelegationPolicy 仍先拒绝链上协调模式，新增 assertDelegationTerms 仅供链码核对条款，不授予运行权。预算按 domain/budgetDomain/epoch 唯一，修订不能重置额度；私有预算/预留/任务与操作映射/gate 同事务写入。ReleaseExecution 仅处理未激活需求，保持原证据并升版 REVOKED，不把自然到期视为停止。

为避免公开 gate 初次创建需要更宽背书而暴露 transient，gate 存于双方 PDC；Market ActivateDemand 读取 Commercial GetExecutionGateHash 并比较批准公开的原文哈希。真实 Fabric 的同通道 hashed read 与反向公共状态 read 用于激活/释放互斥，不依赖应用先查后写。许可原文只含路由、版本、期限与带盐私有预留摘要，不能带金额、条款或完整委派。部署/边界见[执行许可](../../../deploy/federation/fabric-execution-gate.md)。

生产 Commercial Adapter/Unix 客户端增加 reserve-execution、release-execution 及固定哈希查询，Market Adapter 增加 activate-demand。执行载荷另用 Adapter schema，原 HTTP/持久市场服务输入不扩大；业务签署用途、双方签名、摘要、域/操作标识在发送私有数据前校验。预留/释放明确只向双方 MSP 背书，激活只传批准公开的 gate。复用原恢复协议与加密用途；DATA_WAITING 可重试，其余明确政策/预算拒绝进入复核。真实网络覆盖三操作跨新进程及丢失成功响应恢复，预留经历 Orderer 停机后仍恢复相同 txId；固定查询核对释放/可用许可哈希及 ACTIVE 需求。Server 预留/释放双签审批和持久协调已接通，公开激活已接入专用审批入口与市场待办，实际执行仍未接通。


### 预留与释放的机构审批

迁移 0121 保存按本机构/组织/合同归属的不可变执行审批。完整 CommercialReservation/CommercialRelease 由当前具备 agreement.approve 的真人确认，机构密钥必须有对应专用用途；合同/用量用途不自动扩权，在线信任管理支持为新密钥登记用途。双方已有同文商业合同是前提，预留校验合同摘要、私有条款与当前公共认领；释放必须引用同合同已双签的原预留。源站发布/提供方认领还须是当前本组织的 committed 市场操作，不能用同一 siteId 绕过组织归属。链查询前后重新检查权限，网络失败/非法响应不产生签名。相同内容重试返回原审批，双签附加、待办和摘要审计同事务提交，失败回滚。

复用商业提交服务与 worker：合同 committed 后推进预留，原预留 committed 后推进释放。发送私有提案前重验双方当前密钥与准确用途，所有原交易恢复规则保持；机构签名审批不因原员工离职自动丢弃，实际执行撤权由独立执行策略负责。详情仅公开本组织的签署正文与最近提交状态，不返回恢复密文或租约；复核复用合同提交 retry。API/边界见[Server 双签审批](../../../deploy/federation/fabric-execution-gate.md#server-双签审批与持久待办)。

此处只接通人工双签业务审批与后台提交，未实现双方自动握手；公开激活现已接入独立审批和市场待办，执行 gate 到派发的授权通过下述有期限确认接入，不增加本地双边余额。隔离 PostgreSQL 已验证权限、并发/回滚和恢复；追加联合入口已连接真实 Fabric 并验证私有操作和公开激活，仍未到达 Agent 实际执行。


### 源站公开激活待办

迁移 0122 扩展市场持久记录，允许专用商业审批入口生成 activate-demand；通用 enqueue 和 HTTP schema 保持原三种操作。入口只接受 activationId，要求源站当前组织的 agreement.approve 与 market.publish，核对本组织已确认发布、双签原文/当前机构密钥、私有预留 committed 和完整摘要。gate 固定从原双签预留生成，不接收用户原文；已有本地双签释放阻止新的激活意图。意图、摘要审计与同预留唯一约束同事务保存，重复原 ID 可在期限后读取原结果，不产生新授权。

后台复用 Market worker 的持久恢复，不新增轮询器；复核激活要求同样两个权限。未知结果恢复原 txId，INVALID 追加新尝试而保留原记录。并发释放/期限的最终判断仍依赖真实链读集，不能用本地已 committed 的旧预留推断当前 gate。API 与边界见[源站公开激活](../../../deploy/federation/fabric-execution-gate.md#源站公开激活)。该结果只推进公共 ACTIVE，不授予实际 Job 执行或释放私有锁额；下一步须将提供方执行验权与确切双签委派绑定。


### 真实链与数据库激活联合验证

新增 test:fabric:gate:integration，复用三机构同通道网络及随机隔离 PostgreSQL。源站/提供方业务服务使用不同组织和真实业务签名确认合同、预留和释放，生产 Node Adapter 提交私有操作；源站专用激活服务生成持久市场意图。Orderer 中断和 VALID 响应丢失后保留原 prepared 检查点，服务实例重新建立后使用同一 txId 确认原 ACTIVE，并核对激活 ID/预留归属。真实私有 gate 哈希验证释放，不读取商业正文来生成公开激活。

前置市场发布/认领由真实链探针创建，历史意图作为测试夹具导入各自组织；不是完整 Server 发布入口或双 Server mTLS 交换。没有 Agent/Job。测试与资源边界见[数据库联合检查](../../../deploy/federation/fabric-execution-gate.md#数据库与真实-fabric-联合检查)。CI 的 gate 项现运行联合入口，原无数据库入口保留用于 Adapter 进程恢复定向检查。


### 链上协调协议的本地执行同意

迁移 0123 将已安装协议的本地 budgetDomainId/epoch 外键改为按模式约束：双边模式必须保留与签署条款一致的本地预算，ledger_coordinated 必须两列均为空。完整商业预算标识仍保留在原签署条款中；不会建立零额假预算、复制链上可用额度，也不删除或改写原双边余额。原预算外键、双边 epoch 唯一性和守恒约束保留。

执行协议 approve/counterparty 与底层 installApprovedAgreement 现在允许链上协调协议的本地同意。前提是同站点、同组织、同 revision 已有商业双签，嵌入的完整执行条款必须一致；每次批准/安装重新验证两份商业原文、摘要、当前机构信任和 commercial-agreement 用途。提供方仍须选择当前有效的受限服务账户，普通 agreement 签署权不能替代商业签署权。对方执行签名、安装与审计在原事务内提交，失败回滚；并发同请求只安装一份，不创建本地可用额度。

这里保存的是执行同意，不是运行许可。协调接单、源站发送、材料披露和执行准备现在必须通过下述执行确认服务；单独执行同意仍不足以放行。context.supportedModes 暂仍只列两个双边模式，Web 不提前开放尚未完整验收的协调流程。审批 API 不能把 installed/active 状态当作链上 ACTIVE 或已派发 Job。实际执行还须绑定精确私有预留、公开激活和本地当前授权；旧 Peer 查询或调用方布尔值不能代替这项检查。


### 链上执行确认与新鲜度

新增有绝对期限的 Market AuthorizeExecution，只有 VALID 交易才构成链状态确认。固定公开输入绑定申请机构、需求、原 activationId 和同通道私有 gate 哈希；最长 5 分钟，当前状态每需求每机构只留最新一份，历史仍在区块中。旧确认不能被改内容、覆盖更新记录或在恢复时延长期限。Server 消费必须再核对原双签私有委派、本地当前授权和绝对期限，取最短执行租约；Peer 查询和 committed 布尔值均不够。协议、时钟和存储边界见[执行确认](../../../deploy/federation/fabric-execution-gate.md#有期限的链上执行确认)。

链码、生产 Adapter 与 Server 专用确认服务已接通。迁移 0124 扩展现有市场待办约束与预留/确认查询索引；人工 confirm API 只接受空请求体，要求当前组织 agreement.approve。内部 refresh 在网络查询前后重新校验精确双签委派和本地当前授权，以预留为单位去重，正常市场 worker 完成背书/提交/恢复。最终 authorize 只消费匹配的持久 VALID 交易，期限取链确认与当前私有委派、协议、签名信任的最短值。续期使用新 ID，不改变旧交易或原截止时间；撤销本地同意或执行身份立即拒绝。

源站提交/重发/材料披露、提供方接单/准备/绑定和派发已接入该服务。网络续期在事务外，最终操作事务内调用 authorize；返回期限约束到源站下载凭据与现有 Agent 派发/运行租约。提供方回执固定使用商业预留 ID，并发恢复不生成第二份预留；协调模式跳过本地可用余额扣减，但保留私有条款和接单数量检查。短暂链故障可继续使用尚未到期的原 VALID，过期必须等待；不因断线或到期释放 ACTIVE 锁额。

Web 仍不开放协调运行模式。人工预批准合同后的真实联合执行已通过：独立 Server/数据库经生产 Adapter 完成真实 Fabric 发布、认领、私有预留、激活和执行确认；mTLS 委派触发 Kubernetes 双 Script 文件计算，源站 Agent 实读校验并回传结果。两个平台都没有生成本地预算。自动商业握手、ACTIVE 停止/结算/重开、完整 Web 和 PR 预览仍待完成；该测试使用直接委派 API，不代替普通 Workflow 动态调用或科学软件安装验收。可复现入口及前提见[真实执行验收](../../../deploy/federation/execution-lab.md)。


真实 Orderer 中断的运行中到期检查已通过：Agent 与独立看守按原确认期限触发停止，Kubernetes 在自身终止宽限后确认原 Job/Pod 停止，下游没有派发；链恢复不重启终态作业。到期与停止均不自动改变 ACTIVE 或释放私有锁额。该检查使用真实墙钟与轻量 sleep，不修改签名期限；停止请求与实际停止分别记录，不能把删除请求成功解释为进程已退出。

### 链级停止意图与续期冲突

Market 新增 RequestExecutionStop、STOPPING 和原始 stopRequest；公开字段绑定请求机构、原需求/activation 与原 ACTIVE 版本。源/目标机构都能提出停止，最多各保留一份不可变请求。同机构原文重放恢复原回执，换 ID 或内容拒绝；双方请求收敛到第一份 STOPPING，不通过同意方数量生成停止或资金证明。原生交易读取并写公共需求；旧 ACTIVE 上背书的执行确认在停止先提交时必须 MVCC INVALID。STOPPING 之后的新确认、普通撤回或认领均拒绝，私有释放仍只允许未激活的 CLAIMED。

生产 Market Adapter 与 Unix 客户端支持这个固定操作及原交易恢复；通用市场意图 schema 不开放它。Server 专用停止入口验证原组织/预留归属，在审批记录上原子保存本地停止与审计；旧 VALID 不能绕过本地停止。后台查询精确 activation 后复用市场待办，原源站取消同步保存链停止意图，独立执行监控复用 Workflow 取消。迁移 0125 和接口边界见[平台停止接口](../../../deploy/federation/fabric-execution-gate.md#平台停止接口与本地约束)；终态证明和结算继续待办。不能只发一个链上停止请求就把界面或私有额度改为已停止/已释放，亦不能将旧 VALID 的期限改短来伪造远端已停。


### 双方终态确认与关闭执行许可

新增独立 commercial-terminal 签署用途。双方签署同一原预留/activation/gate 版本及带盐终态材料摘要，RecordExecutionTerminal 验证当前 ACTIVE/STOPPING 后在双方 PDC 保存不可变正文并升版为 TERMINAL gate。预算不变，既有待提交续期通过私有哈希原生读集被否决。原两方任一方提交固定 terminalId 的 CloseDemand，公共链仅校验 gate 哈希与原激活并进入 CLOSED，不披露终态明细。重复终态/关闭不增版或退款，重开和资金结算须另行批准。Server 已提供基于本机构真实记录的空正文终态审批：原预留写锁保护证据、签名和本地执行防线，缺失停止/清理回执不得签署，成功任务按合同要求关联源方结果接收回执。源方复核已接入，按本机构原委派/接单/终态报告以及结果导入或取消停止回执检查后，保存双签和专用私有上链待办；私有 VALID 确认与固定 terminalId 的公共关闭待办已原子接通，重启补办历史遗漏，公共 worker 重核私有回执并恢复原交易；终态材料分块接收、重启续传、源方批准后的自动对签回传及签名 ACK 已接通；终态无人值守批准已按下节接入，完整 Web/CLI 仍待完成。完整字段、签署用途与升级边界见[终态协议](../../../deploy/federation/fabric-execution-gate.md#双方终态确认与公共关闭)。


### 机构终态预授权与后台批准

提供方和源方均已加入按商业协议不可变 revision 的本地终态预授权（迁移 0131），限定结果集合、有效期、组织和合同摘要。复用原终态归集/源方复核服务，自动传输不携带签署权限；实际签署必须持有本机构授权锁，并在链查询后、落库前复核。两边各自独立授权，原角色变化不替代机构撤销；授权撤销不抹除历史签名。后台持久退避及异常人工复核沿用原商业 worker，数据和权限检查不降级。原终态已存在时不再签署，最终账单及资金释放仍未实现。接口、授权语义与恢复步骤见[按协议版本预授权终态批准](../../../deploy/federation/fabric-execution-gate.md#按协议版本预授权终态批准)。Web/CLI 配置界面尚待接入。


### 已批准商业记录的自动签名交换

迁移 0132 接入商业合同、预留及释放的私有 mTLS 查询与双端持久待办。原商业审批保持独立；双方有同文批准后，后台取得原业务 JWS，复用既有导入校验，同事务补齐对签、审计、同步状态及可选链待办。未批准只返回受签名保护的等待状态。直接模式不创建任何链工作；签名交换完成与链 VALID 分开判断，未知/INVALID 交易仍按原记录恢复或复核。固定路径、独立密钥用途、短时查询、证书/用途/端点复查和迟到租约隔离均已接通，管理 API 只显示进度并允许授权人工重试。详见[自动交换边界](../../../deploy/federation/fabric-commercial.md#已批准商业签名的自动交换)。长期授权下的新任务批准、执行同意与市场/准入自动编排仍待完成。


### 初始激活和执行确认自动推进

迁移 0135 在原预留策略增加默认关闭的源方激活/本地执行确认开关，原提案保存独立执行进度、动作引用和租约；不另建一套业务队列。自动动作必须关联原策略实际批准的预留，复用原商业激活及执行确认服务，保留合同/基础同意/身份/停止防线和有效链回执检查。新市场待办保存政策归属，机器审计与原人工意图区分；撤销阻止新动作，不能借重试替换 INVALID。仅初始化执行许可，原各操作权限和续期机制保持，尚未自动发布/认领市场需求或创建普通 Workflow 的协调委派。接口与状态语义见[自动激活与首次执行确认](../../../deploy/federation/fabric-execution-gate.md#自动激活与首次执行确认)。


### 基础执行协议自动对签

迁移 0136 新增独立执行同意交换队列，避免把直接/异步存证合作绑到商业合同或 Fabric。固定 mTLS 查询返回原已批准 agreement JWS 或专用等待回执；通过原安装事务完成对签、机构执行身份、仅双边模式所需预算、审计和进度提交。原人工导入与自动路径共用校验，并在事务内重核签名用途。角色变化不撤销已签机构同意，暂停/撤销/执行身份停用仍阻止新安装；原合同/任务授权与链 VALID 边界保持。生产后台与组织状态/人工复核 API 已接入，详细配置见[执行协议自动交换](../../../deploy/federation/README.md#已批准执行协议的自动签名交换)。普通 Workflow 协调编排、市场自动发布/认领和完整 Web/CLI 仍待接续。


### 已批准账单自动对签交换

迁移 0139 在现有商业签名交换待办中加入 bill，不另建传输通道。双方独立批准完全相同的账单后，后台通过原 mTLS 查询取得原签名；一方未批准保留等待，金额或正文不同进入复核。原批准人的离职/停用不取消机构历史同意，当前机构与签名密钥失信仍阻止传输和附加。执行合同过期不阻止历史账单对签；传输权限不授予新账单审批。

补齐对签、完成交换、机器审计和提供方可选账单存证待办同事务提交，失败回滚；重启、丢失响应、手工附签后补办均复用原记录。保存响应时重验租约、当前信任和原正文；迟到 worker 不能覆盖新租约。bill 人工重试独立要求 billing.approve，协议审批权不自动扩权。直接模式无链调用，异步存证故障不阻塞业务对签，complete 不表示链 VALID、付款或对端已接收。

本次接通的是已有批准的签名传递。草稿及独立减免仍需先传递并复核，自动账单审批、Web/CLI、对端存证状态同步和实际结算仍待实现；真实双平台账单流程未作联合验收。升级及 API 见[账单审批说明](../../../deploy/federation/fabric-commercial.md#server-账单审批)。


### Kubernetes 计量与协调账单的终态依赖

Kubernetes Agent 从当前 Job UID 所属单个工作容器的终止时间采集 job.elapsed，Server 在原终态事件内保存，汇总校验调度器来源和不可变摘要。缺数据、重启或多 Pod 保留未知，不推算 CPU 计量；现有 Slurm/PBS 补采范围不扩大。无需新迁移，升级双方 Server 后再升级 Agent；详情见[Kubernetes 运行时长](../../../deploy/federation/fabric-commercial.md#kubernetes-作业运行时长)。

协调账单不再等待不存在的“提供方本地终态提交”。队列要求本机构保存原双签终态，在背书前向真实商业 Adapter 查询原终态的私有回执，精确匹配 terminalId/摘要；缺失继续等待，错误进入复核，查询后再查当前信任。查询在数据库事务外完成，已有交易继续按原 checkpoint 恢复；链码仍独立核对账单的原预留和终态，不因应用查询成功放宽规则。


真实 success 场景已验证上述路径：独立 Kubernetes 容器观测合计 1,000 毫秒，生产报告经 mTLS 到达需求方；双方明确批准账单后，Orderer 停止期间自动交换原签名，恢复后原提供方待办取得唯一 VALID。该流程不自动批准账单、不扣款或释放预留；完整范围与记录见[真实计量验收](progress.md#真实-kubernetes-用量与账单联调)。


账单 Web 入口已接商业合同详情：读取本组织分页原记录，从最新报告生成草稿，导入/导出双方同文，显式批准、手动对签及原链待办重试；权限独立于合同审批。金额不转浮点，缺失对端存证状态不推断成功。机构/登录切换清理草稿，手机只读。独立减免及交换复核管理、CLI、自动审批和资金结算未在此页面中实现。操作与验证范围见[Web 账单核对](../../../deploy/federation/fabric-commercial.md#web-账单核对)。


## 独立额度结算与预算唯一权威

账单确认后另签 commercial-settlement，绑定原账单/合同/机构/单位及守恒的预留、消耗、归还金额；协调任务另绑原终态回执。链码/Adapter 已接 SettleBill：协调私有事务扣减 locked、增加 spent 并保留 settled 记录，终态 gate 不变；幂等原记录及按账单唯一索引阻止重复花费。异步存证仅记录原链下事实，直接模式不提交链。业务签署用途必须显式新增，原账单批准不扩权。Server 独立批准、双边 spent 记账和原签名自动交换已接通（迁移 0140），专用结算 Web 入口见下文；CLI、自动批准及退款/支付/争议仍待完成。直接/异步模式本地处理不等待链，协调模式仅在本站持久化 VALID 后释放本地任务名额，不复制链预算。详见[额度结算协议](../../../deploy/federation/fabric-commercial.md#独立额度结算协议)。


Server 的实际 API、权限与升级边界见[额度结算](../../../deploy/federation/fabric-commercial.md#server-额度结算)。源方保留已消费额度，提供方只退回未用部分；原接单金额、回执与执行状态不被结算改写。

协调结算已在真实双 Server/独立数据库、mTLS、Agent/Kubernetes 与 Fabric 上联调：实际非零计量及账单产生后分别批准结算，停 Orderer 时只交换原签名，恢复后原待办 VALID 才释放各自名额。一次竞争提交产生原生 MVCC INVALID，后台保留原交易并核对同文回执后自动恢复；独立 PDC 区块证明预算只扣一次，终态 gate/公共关闭不变、C 无私有写入。详细证据与未覆盖范围见[真实结算联调](progress.md#真实双平台结算与断链恢复)。


## 结算 Web 入口

合同详情新增独立结算页签，账单详情在已双签时提供原 billId 的生成入口。共用读取 schema 验证本组织/站点/合同与原账单标识，保留精确整数金额；手工导入同文、显式批准、原签名导出/附签和本站链待办重试复用既有接口。签署状态、appliedAt 与链状态分别显示，不把账单确认或对签当作协调结算完成。独立 settlement.approve、手机只读与组织/登录草稿隔离生效。完整操作见[Web 额度结算](../../../deploy/federation/fabric-commercial.md#web-额度结算)；CLI、自动授权和银行付款仍待完成。


## 商务收尾的机构预授权

新增 bill/settlement 两种 closing policy（迁移 0141），按本站、本组织、合同 revision/digest 绑定有效期、允许终态、单笔/累计金额和次数；各自需要独立批准能力。Server 内部自动批准入口锁定政策、重验原材料和当前信任，复用原人工批准的事务逻辑；批准记录关联 authorizationPolicyId，额度计数与机器审计同事务提交，失败全部回滚。已批准原文重放不重新计数或替换政策来源。

这是独立审批授权，不是计算接单授权、资金账户或自动认可对方签名。实际额度应用仍使用现有双签与链 VALID 规则。人工管理 API 与生产 worker 已接主 Server；提供方持久待办原子生成原文，经私有 mTLS 传递原业务签名，由需求方独立政策批准。断线与材料等待重试，授权拒绝进入人工复核；原签名完成与链 VALID 分开。专用 Web 政策管理已接合同详情自动审批页签，CLI 已接政策和待办管理。字段、撤销与历史收尾边界见[账单与结算预授权](../../../deploy/federation/fabric-commercial.md#账单与结算预授权)。


自动编排的任务键、租约、恢复与减免边界见[自动商务收尾](../../../deploy/federation/fabric-commercial.md#自动商务收尾)。迁移 0142 需随双方 Server/Gateway 升级；不能仅升级一端后假定对方支持新路由。协调模式现已补真实双平台、mTLS、Agent/Kubernetes 与 Fabric 自动收尾验收，停链自动签署、恢复后 VALID 才记账；政策在作业结束后启用以验证历史发现，仍不替代长期无人值守运行或直接/异步模式真实联合验收。


Web 自动审批沿用商业合同的本组织作用域与现有账单/结算详情。创建响应未知先读取核对，撤销及重试固定原 ID；共享 schema 同时供 Server 输入验证和浏览器读取核对。原账单/结算列表增加 recordId 筛选而非在浏览器扫描所有分页，组织与合同隔离继续由数据库查询执行。交互边界见[Web 自动审批](../../../deploy/federation/fabric-commercial.md#web-自动审批)。


## 联邦财务 CLI 与会话机构断言

CLI 复用生产商业 API，新增合同读取、账单/结算原文操作、政策和待办命令；不增加签名权或直连 Fabric。每项私有操作要求明确机构，主 Server 在 principal 绑定后比较可选 X-KQ-Active-Organization，失配或无当前机构拒绝请求，不变更身份。无头旧客户端兼容，mTLS 和平台管理入口不受此会话机制影响。CLI 显式 use 调用现有登录会话切换接口；输入有界、文件不覆盖、金额精确、业务编号与正文一致，写入未知不自动重放。无迁移或新依赖，Server 与 CLI 应同时升级。实际操作与未覆盖范围见[CLI](../../federation-cli.md)。


## 结算后的不可变调整记录

共享 commercial-adjustment 与纯核对函数绑定原合同/账单/结算和当前上一笔调整，签署变更前后净扣用额、原因及可选依据摘要；双方业务签名和指定机构原生背书分别验证。链码 AdjustSettlement 将新记录和当前索引同事务追加，协调模式仅改变原预算 spent，保留 limit、locked、原结算、预留与终态 gate。新扣用不得超过原任务限额或可用预算，慈善不能变为收费；同文重放不重新应用余额，私有数据缺失不能重置索引。

Adapter 新增 adjust-settlement，只有成员机构 transient 携带正文。新 commercial-adjustment 用途需显式配置；共享 trust schema 和中英文用途名称已更新，不自动授权旧密钥。Server 已接独立 adjustment.approve、人工批准/附签及原待办，按三模式应用本地账目，见下文。

Server 的双方持久批准与三模式账目应用已接通，原签名自动交换已沿用 commercial-approvals 接入；direct/attested 不等链，coordinated 仅本站 VALID 后应用投影。Web/CLI 应显示原值、调整历史及当前净额，付款与争议另建记录，不能覆盖本协议。当前实现、部署与已验范围见[账务调整](../../../deploy/federation/fabric-commercial.md#结算后的独立账务调整)。


## Server 调整占额与记账

新增持久调整表，按本站/原结算的序号和前驱唯一性防分叉；原结算行锁串行化审批与应用。直接/异步模式的增额在批准时先锁正差额：提供方用原预算 available/reserved，源方用原 outbound.adjustmentHeldAmount 并纳入接单聚合。双签时原子转为净扣用，调减不提前退款；原业务正文及接单金额保持不变。协调模式不复制链余额，仅在本地持久 VALID 后投影净额。事务内审计与签名/占额/应用共同回滚，旧原文重放不改当前头或再次记账。

主 Server 挂载独立人类管理 API，链 worker 在披露前核对本地双签原文、当前机构/密钥用途和原结算/前驱私有回执，重试需 adjustment.approve。迁移 0143/0144 必须与接单代码同步升级，旧代码不能忽略增额占额；已签待办不因超时或员工撤权自动释放。详细接口、未完成的解除占额/争议与联合验收范围见[Server 调整](../../../deploy/federation/fabric-commercial.md#server-账务调整)。


已批准调整沿用原签名查询协议，recordKind 新增 adjustment（迁移 0145）。发现器每轮每种记录最多 8 条；网络调用在数据库事务外，附签前重核当前信任、端点、同文摘要、分钟查询窗口及任务租约。附签、账目应用、存证待办、交换完成和审计同事务；迟到响应不能覆盖新租约。员工撤权阻止新的批准，不抹除已有机构签署；已签原文继续交换，主动重试仍需 adjustment.approve。未批准的一方只返回等待，不自动生成新批准；直接/异步本地处理不依赖链。CLI 和页面均已接通调整专用入口；真实双平台协调调整及两边 Server/商业 Adapter 强制重启恢复已通过，原检查点保留并分别取得 VALID，详见[真实调整恢复](../../../deploy/federation/fabric-commercial.md#真实调整恢复验收)。直接/异步完整生命周期和正式登录/预览仍待验收。


CLI 的 adjustments 沿用合同作用域、精确整数字符串、有限文件读取、0600 独占导出和未知写入处理；草稿需要原 settlementId、新净额和原因，返回原文须与输入金额/原因/佐证一致。批准与附签核对外层调整/结算编号、原文与机构归属。共享 AdjustmentApproval/List schema 与实际 Server 响应已通过 HTTP/数据库联调，批准时占额作为历史数值展示，不冒充当前冻结余额。


Web 调整沿用现有商业面板，新增独立权限控制的调整标签和从已应用结算进入的筛选历史。Server list 的 settlementId 筛选同时返回当前净额汇总：锁住原结算，核对本站/机构/合同归属，读取最新调整；未应用取其 previousChargedAmount，已应用取 chargedAmount，原结算未应用返回 null。所有分页和历史编号都保留同一汇总，按结算历史按 number 降序，避免时间戳/UUID 顺序误代表前驱关系。页面草稿、确认与附签均核对作用域；单位与金额不转浮点数，差额通过 BigInt 展示。


## 异步存证的准入积压保护

共享执行协议新增可选 `attestationLimits`（次数、原预留额、最长等待秒数），无默认值注入旧签名，仅允许 `bilateral_attested`。提供方在现有协议锁内、重放处理之后用同一 SQL 快照汇总 reservation 的未结算和待存证义务，每次尝试只计一次。原预留额使用 PostgreSQL numeric 和 BigInt；本地退款不提前释放存证容量。用量、减免、账单、结算和调整经各自原记录关联任务，合同待办覆盖其 revision；`needs_review` 不视为完成。已结算旧任务新建调整按新义务时间计龄。

超限为 `ATTESTATION_BACKLOG` / 503，源方既有交付队列保留原请求重试。原签名恢复、旧请求回放及原任务收尾不受该准入检查阻断。提供方人工查询复用 `agreement.read`、本机构审批记录和 `no-store`；Web 协议核对/详情显示签署上限，提供方独有汇总显示实时观测时间。配置见[部署说明](../../../deploy/federation/fabric-commercial.md#异步存证的接单积压上限)。本次无需数据库迁移。

该功能只补充 O01 的业务积压边界。它不替代下文的实际磁盘水位检查；物理预留见后文，跨 revision 容量、按任务分配结束/取消/恢复预算和 Peer 历史恢复仍按原范围待完成。


## 存储侧签名观测与接单压力检查

新增只读 filesystem observer、Ed25519 签名报告和 `FEDERATION_STORAGE_GUARD_FILE` 本站策略。存储侧从带管理员卷绑定标识的实际目录采样容量，报告使用独立控制目录原子发布；Server 不挂载业务数据库文件，只读取并验证报告。按模式选择必需卷，绝对空间/比例/收尾阈值余量与 inode 共同判断；未启用明确返回 disabled，启用后缺报告、错卷、签名错误、过期或压力状态均阻止新预留。容量 I/O 后仍重新检查授权和有效期，旧请求重放和原回执恢复不受新接单检查阻断。

运维查询复用平台联邦基础设施管理权限与 no-store，不公开路径和密钥；镜像定义及 Compose overlay 已提供。文件交付保留独立部署空间，远程自动同步、Kubernetes 接线及运维 Web 尚未接通。真实独立 16 MiB tmpfs 验证 ENOSPC/恢复/报告停止后的过期，独立 PG/HTTP 覆盖交易与权限边界。[配置和限制](../../../deploy/federation/storage-capacity.md)说明采样窗口内并发/外部写入仍可能消耗空间，阈值余量不等于物理预留；可选实际缓冲见后文，容量增长预测和完整 O01 联合验收仍待完成。


## 新意图容量检查与已接任务恢复

Server 启动时把同一容量策略传入源方出站、任务市场、自动市场请求、预留提案、人工商业批准及私有接收入口。直接/异步模式在双方各自首次接受委派时检查；协调模式提前到首次接受市场意图/提案/商业预留，不在已批准的执行发送和接收阶段重新拦截。`reservation-capacity.ts` 通过本站、机构、协议、reservationId 和完整提案摘要核对已接受意图，不能使用未核验的旧 ID 或调用方布尔值取得豁免。

工作流在文件捕获与参数派生前预检，在持久绑定前复检；恢复绑定仍验证所有者和完整意图。容量不足抛出可重试的 `STORAGE_WAITING`。源方出站对相同请求先重放，再检查容量，取得机构锁后再次查重，避免并发等待期间的误冲突。容量报告读取后继续检查有效期；人工商业批准还在市场网络查询后的最终事务内复检。自动流程保留原记录重试容量错误，收尾/撤回入口保持可用。此项不提供物理保留空间或跨副本占用预算。


## 可选物理收尾预留

`storage-reserve.ts` 与独立 CLI 在实际数据文件系统的专用目录分配预留文件，使用 fallocate、块数核验及 fsync，独立文件系统保存状态。OS flock 串行化操作，不使用自定义过期锁。低水位先保存 released 阻断标记，再释放日志中登记的自有文件；后续 tick/重启只续完释放，必须显式 restore 才能重新申请。observer 始终只读，将物理预留状态放入原签名报告，Server 的 requiredCompletionReserve 按 reserveId/字节核验；报告已声明非 armed 也不能因缺少新策略字段被当成健康。

报告与控制状态复用受限读取和原子发布工具。Compose 独立 overlay 只给预留子目录及控制目录写权限，数据库主体仍只读。真实 ext4/SQL 满盘、释放、数据库重启、原接单回执完成、拒绝新任务和显式恢复已联合验证。配置、Linux 工具依赖、不同文件系统的控制卷、采样窗口及外部写入边界见[物理预留](../../../deploy/federation/storage-capacity.md#可选物理收尾预留)；不等于跨副本容量预算或完整工作流收尾证明。


## 跨副本数据库收尾预算（部分完成）

新增 [completion-capacity](../../../packages/server/src/federation/completion-capacity.ts) 与 Drizzle 生成的 [0146](../../../packages/db/migrations/0146_worried_swarm.sql)。同站点各 Server 副本、各协议 revision 共用持久策略与完整请求绑定的占额；工作流绑定、市场请求、提案、批准与正式接单沿用一笔任务占额，手工公开发布/认领另计。策略启用补计历史记录，拒绝漏算既有任务；策略修改保留每笔原分配字节。原任务不受新分配锁竞争影响，容量分配失败与业务落库一起回滚，物理报告读取后重验授权期限。

平台管理 API 可读写本地容量策略并记录审计。预算必须有健康的数据库物理预留报告支持，缺报告/配置的副本无法新接任务；副本争用可沿原 ID 重试。自动回收已接入满足完整收尾条件的结算任务与关闭的公开市场意图；未满足判据的历史记录继续保留，不提供按超时或作业状态强制清空的入口。早期意图回收、增长预测、结果/取消完整满盘恢复和 O01 总验收仍待完成。此项保持可选，尚未应用到部署环境。


## 占额恢复与释放互斥

`renewTaskCompletion` 由已有任务的后续写入入口调用，锁定原占额行后判断是否需要恢复；未释放任务不再争全站新接收锁。恢复时同时取得全站预算事务锁，按原 `allocatedBytes` 检查物理预留和共享余量，恢复标记、审计、后续业务记录以及资金预留一起提交或回滚。普通初始准入不能复用已释放的 taskId/attempt 新建意图；业务层的原记录重放仍先返回原签名和原编号。

已接入调整、用量更正与同步、新账单/减免、输入/结果新导入和取消双方；Server/Ingress 构造器传递原 storage guard。用量同步新增容量错误保留 pending 和原游标，其他真实性/授权错误继续复核。恢复占额 I/O 后继续检查网络响应期限、当前签名身份和同步租约。释放扫描按同一占额行 `FOR UPDATE SKIP LOCKED` 协调，不等待业务行。自动结算发现与执行停止的首次写入同样恢复占额，主 Server 与私有 Ingress 传递 guard。详见[自动回收条件](../../../deploy/federation/storage-capacity.md#自动回收条件与边界)。


## 执行前释放与市场关闭

已提交的双签私有释放由源站按原 releaseId 自动生成公共 `close-demand`，生成与提交前重验本地最新 VALID、签名原文及完整预留关联。`CloseDemand` 在 CLAIMED 上核对 REVOKED gate 的同通道 PDC 哈希后变为 CLOSED，不产生 activation；ACTIVE/STOPPING 仍须 TERMINAL。停止 worker 校验原任务绑定后结束无须激活的停止待办，错误关闭不会清除原意图。迁移 0149 扩展既有提交约束，无新增对外写接口或私有字段公开。部署顺序与未完成回收范围见[执行前公共关闭](../../../deploy/federation/fabric-execution-gate.md#执行前释放后的公共关闭)。


### 双边执行前取消的独立退款

新增独立 `commercial-refund`，不扩展取消回执的财务含义。源方从持久出站与已验证的停止回执生成原文，双方以 `settlement.approve` 和独立密钥用途分别签署；正文绑定原委派、原摘要、商业合同、提供方取消回执、全额归还金额与随机盐。双方本地原记录分别校验，提供方持原协议锁封住迟到接单/准备，并要求未创建过执行工作流、无用量/账单且清理已完成。退款记账只在同文双签后发生，与审计同事务；固定 operation 唯一性防止换编号重复退款。

直接/异步模式的批准、附签、分页 API、本地记账和批准后的自动签名交换已接通，原接单/取消/签名不删除，未知接单不得猜测为空。异步提供方在退款同事务保存 record-refund 待办，链故障不阻塞退款，恢复只补私有凭证。链码显式验证退款及嵌套取消回执用途，双方组织背书；退款与首次用量/账单通过原生 MVCC 互斥，不创建链上余额。迁移 0154 扩展原交换与提交约束，列表提供本地存证状态和重试所需编号。原容量扫描已支持双签退款完成后的回收，复用文件/交换/父工作流和租约收尾判据，异步提供方另核对原退款最新 VALID。源方退款事务清除后台状态轮询所有权及下一次时间，阻止迟到写回。Web 与 CLI 已接入原文草稿、批准、附签和分页查询，页面另支持原存证复核；原编号过滤保持机构/合同范围。同机独立双 Server/数据库已通过真实 mTLS 的等待材料、永久取消、独立双签退款和断链进程恢复验收；退款预授权见下节，跨主机独立机构验收继续保留，详见[退款边界](../../../deploy/federation/fabric-commercial.md#执行前取消的独立额度退款)。


### 签名查询的时间窗口

执行协议与终态签名交换从同一次取时构造 `issuedAt` 和 `expiresAt`，保持精确的 60 秒窗口，避免两次取时跨毫秒后误生成超限请求并进入 `needs_review / INVALID_MESSAGE`。验签、有效期与租约约束不变。既有待复核记录仍须由有权人员按原记录重试，升级不会批量清除错误或代替业务批准。


### 机构自动退款

复用 `FederationClosingPolicyService` 与 `FederationClosingAutomation`，新增 refund 种类，不另建一套政策或交换队列。政策固定 cancelled 结果，只有 `FederationRefundService.originals` 在同一事务锁内证明永久取消、从未执行及金额/原件一致后才消费权限；金额与次数、批准原件、审计和源方任务关联原子提交。退款发现方向是源方 outbound → 提供方，与提供方发起账单/结算的方向相反；接收方必须具备自己的有效退款政策。

签名保留授权策略编号；已有人工或机构签名不改写、不重复计数。策略撤销/到期在新批准前生效，已有原件仍可交付；重试在没有原件时可明确选择新授予政策，已有原件始终使用原身份。自动处理复用 mTLS 对端与签名用途验证、租约防迟到响应和原预算幂等规则，source completion 检查额外包含 operationId 对应的退款收尾任务。迁移 0155 扩展原表约束及可空策略引用，不修改签署退款正文，也不改变链码或合约。

Web 自动批准与 CLI 原 closing 命令共用 schema；退款条件不可改成已完成/失败，链协调不提供退款策略，原始批准响应包含 authorizationPolicyId。双方升级与操作边界见[机构预授权](../../../deploy/federation/fabric-commercial.md#执行前退款的机构预授权)。


### 接收方数据集发布与来源授权执行

迁移 0162/0163 保存外来资产的结构化来源关系、接收副本、来源签名凭证和续期令牌。`FederationDatasetPublicationService` 接在现有介质管理 API；网络前后复查已验证导入及本地批准，资产/版本/清单/位置/副本和审计原子提交。按来源机构及资产复用本地资产，相同版本核对摘要及完整清单后复用。独立后台通过既有 mTLS 出站续期，持久令牌防止迟到网络回复覆盖撤销或接管后的新状态。

Data Market、数据前置条件、批量候选和实际派发共同检查结构化来源，阻断所有者/机构/public/open 隐式使用；本地明确授权与来源凭证必须同时有效。派发按实际位置限期，不能超过来源、协议及密钥期限。普通内容写入、来源披露/再导出/再次对外授权拒绝外来资产。接口及有效期语义见[数据集使用许可](dataset-use.md#接收方发布与续期)。导入回执已接通，见后文；任务介质、运行中撤权与跨主机恢复仍需完整实现和验收。

普通 CP 扫描也拒绝 `.federation-media` 保留目录：Server 拦截直接路径，Agent 拒绝扫描该目录、包含它的父目录或指向其内部的受管根别名，避免把外来数据重新登记为本地自有资产。正常的独立数据目录扫描和已授权只读派发仍可使用。


### 介质接收签名回执与恢复

迁移 0164 在原 verified 导入操作保存不可变接收事实和持久补报令牌，来源独立保存原回执及签名确认。media-import-receipt / media-import-receipt-ack 为独立密钥用途，专用 mTLS 路径、双语选择器和生产后台已接通。使用许可和回执互不替代：过期/撤销后仍可补报有效窗口内已发生的事实，不重新授予使用权。领取令牌限制迟到回复，双方审计回滚、未知提交结果、密钥轮换及旧 verified 数据恢复保持同一事实；回执队列与 Agent 导入扫描独立。协议、API 和验收边界见[介质导入回执](media-receipts.md)。


## 私有任务介质的生产链路验收

`task-media` 实验复用原两平台框架：普通 Workflow 的 File 输入、双向真实 age 介质、自动上传/版本校验/原子发布、两项 Kubernetes 作业与来源下游恢复均已通过。输入/结果网络复制源为空，未通过共享数据集或数据库状态注入绕过交付。入口及边界见[任务介质验收](task-media.md#私有任务介质双平台验收)与[执行实验](../../../deploy/federation/execution-lab.md#私有任务文件的双向介质交付)；完整 Web/CLI、其他蓝图项及 PR 预览仍待完成。


任务介质 CLI 已复用同一生产 API，覆盖导出批准/运行/清单保存、接收登记/批准/运行、状态/双方回执及撤销；共享响应 schema 保持私有字段隔离和原编号核对。实际 CLI 子进程已驱动双平台任务介质完整闭环。Web 和其他蓝图入口仍待补齐，见[操作入口](task-media.md#cli-操作入口)。

Web 独立介质交付页已接入上述生产 API，支持分页包列表、原签名清单下载／登记、独立批准和运行、状态与回执、包／批准撤销。新增机构内只读选项接口，复用原权限和归属关系，不披露路径或合同内容。原工作流入口、绑定任务选择及历史筛选已接通，共享数据集可按授权选择配对的版本与来源副本，完整蓝图与 PR 预览仍待完成，见 [Web 操作入口](task-media.md#web-介质交付入口)。

### 外部付款凭证

付款记录与合作额度结算独立，已增加双签的 `commercial-payment` 格式、同一付款的追加更正规则和 PDC `RecordPayment` 入口。绑定原有偿合同／账单，保留整数金额、时间、证明摘要及原签名，不改资金余额或执行状态。具体契约及尚未接通的 Adapter／Server／Web／CLI 与真实网络验证见[付款凭证](payment.md)。


### 原生争议冻结的平台接线

迁移 0182 为原冻结表增加 ledger_pending 与匹配收据约束，原商业队列接受 freeze-disputed-task。Server/私有 Ingress 共用本站商业 Unix Adapter 配置；原件核对与双签交换之后，开案方同事务排队，两端独立读回私有收据才确认。网络 I/O 不持有数据库事务，租约与审计原子性沿用原机制，直接／异步业务不增加链依赖。状态和恢复边界见[原生平台确认](disputes.md#原生冻结的平台确认与恢复)。隔离 PG 检查通过，实际两 Server/Fabric 联合验收仍待完成。


### 披露原签名交换

政策和逐条材料已复用商业签名交换队列、worker 及私有 Ingress；双方先独立批准，后台只收集已有同文签名。迁移 0184／0185 扩展原队列类型及长度，发送／响应／保存均重新核对当前信任、本站撤销与原件，租约及审计与附签原子完成。接线和读取边界见[政策与材料原签名自动交换](disputes.md#政策与材料原签名自动交换)。R 材料传输已接下述交付入口；主动撤权传播与 A/B/R PDC 仍待实现。


### 当前材料读取许可

新增独立签名用途、持久原响应及 mTLS 读取许可端点，接收方内部客户端同时核对 A/B 两个当前响应，拒绝单边同意和缓存回退。迁移 0186 保存原查询／许可及原子审计；实际材料值下载与 R 案件入口见下文，A/B/R PDC 仍待实现。时效／撤销边界见[双边当前许可](disputes.md#每次读取的双边当前许可)。


### 获批材料的实际交付

R 真人 API 使用独立 disclosure.receive，登记本机构案件后，复用当前许可客户端并读取 A/B 政策／材料的四份原签名。生产下载入口在返回前再次核对本站授权，完整接收才保存，缓存读取也必须重新询问双方。迁移 0187 保存下载记录、接收方案件及原件；未增加链操作或改变原争议。契约与未完成的 PDC／撤权传播边界见[实际字段交付](disputes.md#获批字段交付与接收方记录)。


同机三 Server／三独立数据库已完成实际作业账单字段的 mTLS 交付、R 进程恢复及 A/B 分别撤权；不是正式跨主机身份或案件 PDC 验收。复现与清理见[三站交付实验](../../../deploy/federation/execution-lab.md#三站证据字段交付验收)。


### 案件独立账本

`kq-cases` 复用现有 Fabric shim 构建依赖，独立链码入口／信任配置／集合；case Adapter 复用现有私有 Unix runtime 与加密交易恢复，不新增 SDK 或钱包。读取、存证、仲裁权限分开：入链需要双方独立存证签名，撤回为 A/B 任一方的独立签名。现有 Server 材料接收不会自动上链；同机四 Peer 的原生权限／背书／MVCC／进程恢复已通过；人员审批见下文；持久队列见下文，远端撤回通知已接通，Server/Fabric 联合验收及裁决仍待完成。接口、集合及限制见[案件链配置](../../../deploy/federation/fabric-cases.md)。

迁移 0188 与 Server `case.publish` 真人 API 已接通独立存证草稿、批准、同文附签、历史和签名撤回。复用材料／政策／源原件核对与数据库锁；同时检查平台信任和配置的案件链公钥／用途。旧材料失效不阻止当前合法密钥撤回旧批准，审计和原签名原子保存。批准原签名已复用商业队列和 worker 自动交换（迁移 0189），没有自动代签；持久投递和本站私有链收据已接通，远端撤回通知已接通，完整联合验收仍待完成；实现和迁移顺序见[平台存证审批](../../../deploy/federation/fabric-cases.md#平台独立存证审批)。


迁移 0190 保存独立案件队列和完整交易尝试历史；可选 FEDERATION_CASE_SOCKET_PATH 接通生产 Unix 客户端及原后台 worker。批准、交换与链确认分离，未发送前失效关闭，已持久授权的未知发送继续恢复原交易，撤回另行优先投递；VALID 和私有收据共同确认。状态／重试入口复用 case.publish，本轮不新增财务或执行权限。细节见[案件持久投递](../../../deploy/federation/fabric-cases.md#server-持久投递与私有收据)。


迁移 0191 接通独立 mTLS 撤回通知与持久回执，A/B 分别通知对端和 R，不等待链。接收方提前保存撤回编号，阻止后续批准／附签／未授权发送的待办；已授权未知交易仍按原编号恢复。通知不带材料值，不撤销独立读取权、不删除历史，R 无权代撤回。人员状态／重试复用 case.publish，配置和验证边界见[跨机构撤回通知](../../../deploy/federation/fabric-cases.md#跨机构撤回通知)。三 Server/Fabric 联合验收及剩余完整蓝图仍待完成。
