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

接收方一个事务内完成：去重 → 锁协议/预算行并核验 revision → 预留额度 → 建 task/attempt → 保存接单回执待签材料与发送待办。机器签名失败时不得发出“已完成接单”的虚假签名回执；恢复 worker 仍只能处理这个原有 attempt。

生成最终签名可采用事务前构造稳定材料并签名、事务内 CAS 验证版本后写入，冲突则重做；或事务内保存不可变材料，由恢复 worker 签名并标记可发送。选后者时，B 只有在必要签名证据已可靠保存后才允许启动，避免“运行了但没有可验证接单凭证”。

数据/软件未就绪时只建联邦 attempt，不创建空的调度器作业。就绪后锁定 attempt，在同一事务创建本地 Job、绑定唯一 Job ID 和 dispatch intent。为此将 JobService 的创建事务核心提取为接受事务上下文的内部方法，保留全部数据/许可校验；不得先调用 `submit()` 再另写绑定，留下崩溃窗口。

本地 dispatchEpoch/revokedEpoch 和取消 outbox 继续使用。远端 operation/attempt epoch 是另一层标识，不能以重试网络请求为由递增调度器作业代次。租约到期仅允许 worker 恢复处理，不能证明旧集群作业已停止。

## 5. API 与签名格式

### 管理 API

`/api/federation/agreements`、`members`、`tasks`、`evidence-batches`、`deliveries`、`settlements`：由本机构登录用户调用，使用对应 capability 和机构范围；不通过现有 operator 角色自动继承所有商业审批权限。

### 机构协议 API

`/federation/v1/delegations`、`operations/:id`、`receipts`、`revocations`、`data-authorizations`：独立 mTLS listener，验证机构签名和协议能力，不接受浏览器 session 代替机构授权。

写请求返回持久操作 ID 与可核对状态，不能用 HTTP 202 代表任务已运行。查询返回签名回执或明确的未知/待核对结果；重复委派返回原结果，相同 ID 换正文为 409。403 表示授权拒绝，版本冲突和需要人工处理各有机器可识别错误码。

信封字段：`protocolVersion, operationId, senderSiteId, recipientSiteId, agreementRevisionId, mode, budgetDomainId, epoch, taskId, attempt, issuedAt, expiresAt, executionExpiresAt?, payload`。JWS protected header 限定 `alg=RS256`、`kid`、类型和版本；对实际 UTF-8 payload 字节签名并保存原始 JWS，使用原字节摘要，不在接收端重排 JSON 验签。

委派的 `expiresAt` 只限定首次接单窗口，仍须在 `issuedAt` 后一小时内；可选 `executionExpiresAt` 限定已经接单后允许准备材料、启动安装/验证 worker、提交调度器的最终期限。它必须覆盖接单窗口且不超过协议 `validUntil`，由原请求签名和接单回执的 `requestDigest` 共同绑定。缺少该字段的历史请求继续使用原 `expiresAt`，不自动延长；同一 operationId 不能用重新签名的不同期限覆盖原接单记录。接单超时后的同请求重放只返回原回执，不重新预留或授予新执行权。

执行期限不代替逐次许可：当前协议、机构密钥、资源、软件及数据授权仍须有效，计算/安装的短期许可不得超出执行期限，数据/Sandbox 的更早期限继续生效。到期后禁止新许可，不把它描述为运行中调度器作业或编译进程已停止；运行中撤权、停止确认和恢复另行实现，单个计算作业继续受已声明 wall time 约束。


不要直接复用现有通用 `canonicalJson()` 作为跨机构密码协议：它用 `localeCompare` 排序，且忽略 undefined；也不要更改旧生态包签名算法以适配联邦。批次签署精确编码的 manifest 字节，严格 schema、重复字段/非法值处理、固定定点金额和跨运行时测试向量一起交付。

接收状态检查时钟容差与过期，记录 source time、received time、anchored time；历史补交只能表示“现在记录了过去声明的事件”，不能凭源方自报时间证明事发时即上链。

## 6. Workflow 等待与恢复的具体改造

Agent 收件时保存原 Job/epoch 的不可变派发指纹及原有可续期输入的位置，不额外保存完整环境变量、下载凭据或执行许可。重启后的未提交准备，从 Server 原 outbox 重新获取当前授权的派发，按同一规则验证指纹，再经过正常准备与提交许可；不会删除收据来绕过去重。旧收据缺少指纹时保留待核对，不自动补造授权。

在最终提交许可后、调度器调用前，将“已进入提交”标记写入原收据，写入后再次检查许可期限和取消信号。该标记不随清理日志删除而消失：已有活动作业沿用原 schedulerJobId 监控；没有活动记录但已经进入提交时，当前保留 pending，禁止根据一次“未找到”自动重跑。提交结果不明的自动核对、运行中撤权停止确认和完整进程恢复仍需接通。

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

安装派发和执行许可使用独立 `federationInstallationV1` 能力协商。Agent 收到原操作并排到队首后申请当前许可和材料票据；安装/验证 worker 启动前再次申请最多 10 秒的许可，Server 事务复核原作业、操作、协议、软件与目标授权。许可不改变原 operationId 或材料版本。安装存储锁内的网络授权等待最多 15 秒，当前超时按失败收尾；自动恢复为持久等待、编译中撤权与停止确认仍需接通，不能将短期启动许可视作已完成整段安装生命周期控制。

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
