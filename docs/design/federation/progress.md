# 算力联邦 V2：实现进展

完整目标仍以 [蓝图](blueprint.md) 和 [验收契约](acceptance.md) 为准。本文只记录分支实际完成的内容，不把内部模块等同于完整功能。

## 已实现的内部接单基础

| 代码 | 当前能力 |
| --- | --- |
| [shared/federation](../../../packages/shared/src/federation/index.ts) | 独立纯协议入口；三模式、不可变资产引用、协议/委派/预留回执 schema；38 位定点整数字符串；模板、资源、租期、单位与预算域校验 |
| [signatures](../../../packages/server/src/federation/signatures.ts) | JWS/RS256、固定 protected header、注册公钥及用途检查、撤销/有效期、消息体积限制、精确字节摘要；不接受请求携带的 JWK/公钥 URL |
| [admission](../../../packages/server/src/federation/admission.ts) | 验证双方协议签名，绑定本地受限机器身份；机构请求验签；数据库事务内去重、额度预留、保存签名意图与证据；签名失败后可用原预留恢复 |
| [schema-federation](../../../packages/db/src/pg/schema-federation.ts) | 协议、独立预算、预留/inbox、独立证据与待存证表；唯一请求/attempt、额度守恒、非负有限金额、签名与状态一致性约束 |
| [0073](../../../packages/db/migrations/0073_true_sister_grimm.sql)、[0074](../../../packages/db/migrations/0074_flaky_quasar.sql) | 由 Drizzle 生成，已在隔离 PostgreSQL 从空库迁移验证；没有应用到部署库 |

`receive()` 返回的是 `RESERVED` 额度预留回执，不是已经创建或运行 Job。验签失败、协议范围不符、机器身份失效、超额或事务证据落库失败时，不创建可执行任务。签名失败留下 `pending_signature`，恢复补签不重新占额。

直接模式保存双方签名证据，不创建存证待办，也没有 Fabric 依赖或连接。异步模式将证据与 pending outbox 在同一个数据库事务写入；该基础提交尚无发送 worker，后续已接通，见下文 Server 存证批次一节。链上协调模式的 schema 已定义，但本接单模块明确返回 `LEDGER_REQUIRED`，不能借该接口降级执行。

本地预算当前只有可用与预留两部分，尚无结算/退款/释放接口。每个协议 revision 使用独立 budgetDomain/epoch；重复登记原 revision 不重置余额，复用已存在 epoch 创建新 revision 会拒绝。后续续约/结转必须实现受控迁移，不能直接复制余额。

## 协议编码与身份边界

协议 v1 使用紧凑 JSON，要求收到的正文与 `JSON.stringify(JSON.parse(text))` 完全一致，并保留属性顺序；不排序、不重新编码后验签。这是显式的编码限制，不是接受任意 JSON 排版的通用规范。重复键（包括转义别名）、非紧凑排版、有损数字表示及未知字段均拒绝。

签名按原始字节验证与留存，旧生态包 canonical JSON/签名不改动。Node/Bun 互验测试编译独立入口，不加载 shared 根模块；生产 Node Adapter 的包构建、镜像与版本锁定仍未交付。

公钥、允许签署的消息类型、撤销状态和机构 ID 必须由接收方信任登记提供。`authenticatedPeerSiteId` 必须来自实际 mTLS 认证。现已加入独立 Node mTLS Gateway 与 Bun Unix listener。指纹仅由实际 TLS 证书生成；Server 普通 HTTP 不注册机构接单路由。接单事务中再次锁定、核查机构、公钥和证书状态。浏览器仅可通过有权限的管理 API 登记信任，不能携带公钥直接接单。

## 已覆盖的验证

2026-11-06：协议 5 项、签名及 Node/Bun 互验 5 项、PostgreSQL 事务与故障恢复 12 项，共 22 项通过。全仓 lint 无错误（存在原有警告）；全仓 typecheck 中两处新增测试类型错误已修正，Server 重跑通过，其余包均通过。文档链接与差异格式检查通过。隔离数据库及临时 PostgreSQL 二进制在验证后已清理。

- 协议测试：金额精度、字段与资源限制、模板摘要、单位/epoch、过期边界、链模式拒绝降级。
- 签名测试：篡改、错误 keyId、撤销、用途不符、未知 header、重复键、超长输入；Node 22 与 Bun 双向签名/验签一致。
- 真实 PostgreSQL：8 个并发相同请求只预留一次；不同请求争抢预算不超额；相同 ID 换正文和相同 attempt 换 ID 均拒绝。
- 故障恢复：签名失败保留原预留，替换 service 实例后补签；证据写入故障注入使预留和预算一起回滚；数据库拒绝 NaN、负数、不守恒余额和无签名 ready 状态。
- 权限和时间：错误机构、暂停协议、停用机器身份、签名用途不符被拒；获取锁后再次检查授权有效期。

PG 测试必须指定 `kuintessence_unit_*` 隔离数据库，拒绝默认连接部署库；仓库 `test:unit` 的隔离库命名与之兼容。测试使用最多 8 个连接、小型数据，不运行科学计算或任何集群作业。测试凭据均临时生成，不写入仓库。

## 新接通的机构信任与认证入口

- [trust-registry](../../../packages/server/src/federation/trust-registry.ts)：独立机构、公钥、TLS 证书登记；用途、有效期、暂停和不可恢复撤销；不可覆盖已有 keyId、不可把同一指纹重新分配给别的机构；变更和审计同事务。
- [admin-federation](../../../packages/server/src/routes/admin-federation.ts)：已挂到现有登录 API，统一使用平台 manage 权限。该入口只管理基础设施信任，不代替双方商业审批。
- [gateway](../../../packages/server/src/federation/gateway.ts) 与 [runtime](../../../packages/server/src/federation/runtime.ts)：Node TLS 1.3 双向认证、身份头白名单；Bun 只开私有 Unix socket，启动检查目录/私钥所有者与权限。默认关闭，可显式启用，direct 无 Fabric 依赖。
- [ingress](../../../packages/server/src/federation/ingress.ts)：真实证书登记与 JWS 绑定；调用额度预留事务返回原始签名回执；处理失败不向外泄露数据库错误或请求正文。
- [0075](../../../packages/db/migrations/0075_panoramic_justice.sql)：Drizzle 生成的机构/公钥/证书迁移，已在隔离 PostgreSQL 从空库迁移。
- [部署说明与 Compose 叠加配置](../../../deploy/federation/README.md)：Gateway 构建、私有 socket、凭据挂载与登记接口。Docker 镜像/Compose/Helm/PR 预览仍待实际验证。

新增验证：TLS 2 项、Unix runtime 2 项、PostgreSQL 信任/入口 5 项通过。包括真实 Node mTLS → Bun 私有 listener → PostgreSQL 预留及签名回执；不是只 mock TLS。另重跑受影响的原接单 12 项和签名 5 项，均通过。入口只证明到 RESERVED，不能据此宣称已经派发 Job 或完成链存证。新增回执用途检查在预留之前拒绝配置错误。全仓 lint 无错误，原有 47 个 warning 和 1 个 info 不变；全仓 typecheck 已通过，新增测试后的 Server 检查也通过。临时 PostgreSQL 已停止，数据与下载的二进制已清理。

## 协议审批与可复用的 Job 事务

- [permissions](../../../packages/server/src/federation/permissions.ts) 与[授权管理 API](../../../packages/server/src/routes/admin-federation-permissions.ts)：`agreement.read` / `agreement.approve` 按本地组织显式授予，仍要求当前成员、未暂停的真人账号。平台角色不会自动获得商业审批权；服务账号不能审批。权限变更与审计同事务。
- [agreements](../../../packages/server/src/federation/agreements.ts) 与[审批 API](../../../packages/server/src/routes/federation-agreements.ts)：审批人只能使用会话中的活动组织；双方对同一不可变条款签名。接收方绑定本地受限服务账号后，导入另一方签名与建立协议/预算同事务；源方只保留签名，不复制接收方预算。
- 同 revision 的条款和服务账号不可更换；并发重试保持原签名和预算。可以本地暂停/恢复、永久撤销；接收方状态同步到接单协议。**源方暂停不代表远端任务已停止**，跨站撤销及回执机制仍待接通。旧签名不会因审批人权限撤销而被删除。
- [JobService.submitInTransaction](../../../packages/server/src/services/job-service.ts)：普通 submit 和联邦后续调用复用同一事务核心，保留原数据权限、不可变数据绑定、可信生态软件及受限输出检查。数据授权过期处理也参加调用方事务，避免使用另一条连接或并发嵌套 savepoint。
- [0076](../../../packages/db/migrations/0076_curvy_senator_kelly.sql)：Drizzle 生成审批权限和双签记录表，隔离 PostgreSQL 从空库迁移通过。

本轮 PostgreSQL 验证：审批 7 项、原接单 12 项、JobService 33 项，共 52 项通过；签名密钥加载改造后的 Unix runtime 2 项通过。新增覆盖组织隔离、平台角色不能替代审批权、失效权限、不可替换条款、重复激活、审计失败回滚，以及外层事务失败时 Job/数据绑定/工作流映射一起回滚。全仓 typecheck 通过，新增测试后再检查 Server；lint 沿用原有告警，无新增错误。

**尚未把预留自动转换成 Job**：事务方法已可复用，但跨站资产映射、材料/环境锁解析、完整入口级软件许可检查与持久 dispatch intent 尚未连接。没有绕过这些检查直接执行请求中的脚本，也没有把这组测试当成跨机构作业验收。

## 跨站资源引用与持久准备状态

- [纯协议材料 schema](../../../packages/shared/src/federation/assets.ts)：输入参数、数据集清单、来源版本绑定、目标平台/架构及环境锁引用；禁止目录穿越、重复描述符和未声明字段。材料摘要使用独立的确定性 JSON 编码，限制一 MiB/32 层，JWS 原字节签名规则不变。新增 usecase 资源引用，用于工作流中的用例版本。
- [assets](../../../packages/server/src/federation/assets.ts)：按本地组织登记来源机构/资源/版本到本地不可变版本的映射，摘要或类型不符拒绝，不覆盖旧映射。映射不授予使用权，执行身份解析时仍调用现有软件访问服务及数据授权服务；使用前可在事务内复查映射、版本摘要、生命周期与数据位置。
- [资产管理 API](../../../packages/server/src/routes/federation-assets.ts)：`asset.read` / `asset.map` 独立授权；会话决定本地组织；登记/撤销与审计同事务。输入清单与环境锁保留规范字节，读取时重算摘要；不能按任意 URL 下载材料。
- [preparation](../../../packages/server/src/federation/preparation.ts) 与[恢复 worker](../../../packages/server/src/federation/preparation-worker.ts)：已挂到启用联邦的 Server；签名预留完成后自动解析引用，缺材料/数据位置持久等待，协议失效或权限拒绝记录阻断，恢复后从数据库继续。每轮最多 8 项，无链连接和 Job 提交。协议 API 可分页查询预留及准备状态/更新时间。
- [0077](../../../packages/db/migrations/0077_slippery_karnak.sql)、[0078](../../../packages/db/migrations/0078_nosy_masked_marvel.sql)：Drizzle 生成映射、材料和准备状态表，隔离 PostgreSQL 从空库迁移通过。

本轮新增纯协议 4 项、数据库资产/准备 7 项通过；受影响的原协议 5 项、签名及 Node/Bun 互验 5 项、审批/查询 7 项通过。覆盖摘要/类型替换、修改/撤销版本、映射不越过使用授权、缺位置等待、重启后继续解析、审计回滚与机构隔离。准备测试确认没有创建占位 Job。lint 无错误（原有 47 个 warning、1 个 info）；全仓其余包 typecheck 通过，Server 两处材料返回类型及一处测试类型推导问题修正后重跑通过。465 个本地文档链接目标检查通过。隔离 PostgreSQL 已停止并清理。

**resolved 仅表示引用快照已解析**：尚未校验真实目标 Agent 的环境、native lock 内容和安装材料是否完整，也未进行实际文件交付、安装或 Job 派发。该状态不可作为执行许可；后续提交前必须重新检查权限、签名租期与版本。已有数据版本采用 Data Market 的 manifestDigest，实际文件字节校验仍属于数据交付路径，不把数据库元数据当成文件校验结果。

## 动态 Workflow 检查点与原子 Job 绑定

- [shared journal](../../../packages/shared/src/workflow/journal.ts) 和[现有引擎](../../../packages/shared/src/workflow/engine.ts)：可选的按运行隔离检查点；每次执行携带包含循环迭代、子工作流层级的稳定路径。保存根定义、首次解析的子工作流定义、分支选择及节点结果；恢复保留 Reduce 所需的收集值，不重复调用已有完成检查点的节点。
- [execution-journal](../../../packages/server/src/workflow/execution-journal.ts)：PostgreSQL 租约，使用数据库时间和随机所有权 token；读写均检查当前运行状态、锁和租约。事务超时回滚，过期持有者不能续租、写入或释放新持有者的租约。检查点只允许相同内容重放；拒绝恢复时修改定义。
- [execution-jobs](../../../packages/server/src/workflow/execution-jobs.ts)：用例执行意图、动态调用路径与 Job 在同一个受租约保护的事务中保存。通过现有 `JobService.submitInTransaction` 创建 Job；相同调用重试复用 Job，不同循环迭代分别记录，改变原调用输入拒绝。完整意图保留 Spack 参数、输入输出及软件要求，创建时派发状态为 `pending`；后续传输回执接入见下一节。
- [0079](../../../packages/db/migrations/0079_nasty_korg.sql) 和 [0080](../../../packages/db/migrations/0080_material_randall.sql)：Drizzle 生成检查点、租约与作业意图表，已在隔离 PostgreSQL 从空库迁移。

恢复接口沿用现有引擎，普通调用不传 journal 时保持原行为。数据库故障和执行权丢失以 `WorkflowExecutionInterrupted` 向上返回，不记成计算失败；并行循环等待已启动的分支退出后才返回中断，并停止推进新节点。用例和 Script 回调均能接收动态路径，但生产 Sandbox 执行器尚未使用该路径建立持久绑定。

验证：引擎、恢复、用例物化、JobSubmitter 和 runner 的 129 项测试通过；隔离 PostgreSQL 的 9 项通过。覆盖 8 个并发请求只创建一个 Job、Job 已提交但节点检查点未保存时恢复复用同一 Job、绑定写入失败同时回滚 Job/旧工作流映射，以及失效租约、取消和实例替换。测试仅写隔离数据库和运行内存执行器，未派发真实集群作业。全仓 lint 无错误（原有 47 个 warning、1 个 info）；全仓 typecheck 通过，后续新增内容涉及的 Shared/DB/Server 也已复查通过。

**这组内部能力尚未启用生产自动续跑**：旧 async runner 的中断取消行为未改变。普通 `stepJobs` 仍是旧节点映射；新表才保存完整动态调用清单，查询/取消/UI 尚待接入。只有完成联邦准备门禁、Script 原子绑定、准备期间崩溃后的恢复和生产恢复调度，才可以让 durable run 自动恢复。单独保存检查点不能保证外部作业恰好执行一次；超过 8 MiB 的单条检查点会中断，后续需将大型日志/循环行转为 artifact 引用。

## 已接入现有执行路径的派发待办与结果恢复

- [JobDispatchOutbox](../../../packages/server/src/grpc/job-dispatch-outbox.ts)：placement 完成软件、数据、队列等原有检查后，先将完整 protobuf 指令写入 PostgreSQL，再交给 Agent 连接。Server 定期扫描和 Agent 重连时重发；保留原 Agent、Job、dispatchEpoch、Spack 参数、签名及数据材料，不在重试时换资源或重签授权。真实 Agent 状态成功落库后才记录收件，并同步动态 invocation 的 `acknowledged` 状态。
- [placement](../../../packages/server/src/services/placement-orchestrator.ts) 和 [Sandbox](../../../packages/server/src/services/sandbox-node-executor.ts)：连接在准备后断开时返回 `pendingDelivery`，工作流继续等结果，不把已持久接受的派发误判为计算失败。带有 runId 的普通工作流与 durable 工作流都将父 run 记录在待办中；父 run 失败/取消后停止新重发，已发出的取消仍由原取消 outbox 和 revokedEpoch 处理。
- [JobCompletionRegistry](../../../packages/server/src/workflow/job-completion-registry.ts)：生产配置使用数据库终态与输出为依据，内存通知仅触发加速读取；支持通知丢失、完成早于订阅、重启后读取、多个等待者及独立取消/超时。读取暂时失败保留等待；受限输出仍被清空。普通作业与 Script 使用同一结果投影，不接受通知中的未落库结果。
- [0081](../../../packages/db/migrations/0081_sweet_sentinel.sql)、[0082](../../../packages/db/migrations/0082_volatile_smiling_tiger.sql)：Drizzle 生成传输待办及父工作流关联；隔离 PostgreSQL 从空库迁移通过。后台扫描有批量上限和重试间隔，停止时等待当前扫描结束。此能力没有 Fabric 依赖。

验证覆盖：消息编码/身份/结果等待 54 项，Sandbox 7 项，原 placement 与断线回归 21 项，跨 PostgreSQL/Agent SQLite 的[派发恢复测试](../../../scripts/workflow-dispatch.pg.test.ts) 9 项，测试入口 9 项通过。包括保存失败不得发出指令、接收回执丢失后按原代次重发、真实 Agent inbox 只接纳一次、双 worker 争抢、错误 Agent/代次、撤销、父工作流超时结束后不得启动滞留 Job，以及重启后读取原终态。跨组件测试已加入 `test:unit`，不把 inbox 去重当成真实调度器端到端验收。全仓 lint 无错误（原有 47 个 warning、1 个 info），全仓 typecheck 通过；后续 Server/DB 和跨包脚本检查也通过。隔离 PostgreSQL 已停止，临时数据及二进制已清理。

**剩余边界**：目前解决的是完整指令已持久化之后的传输恢复；在 placement 已分配 Agent、但尚未保存完整指令时崩溃，仍需要后续恢复 worker 核对并继续准备。恢复过程中不自动延长过期的签名/数据租约，Agent 仍执行原有效期检查。联邦协议、native lock 和目标环境准备尚未接入实际派发，Script 尚无原子调用绑定，不能因此宣称联邦工作流已可运行。旧运行中工作流在 Server 重启时仍按旧规则进入中断取消。

## 工作流模板转换与只读诊断

- [materialize](../../../packages/server/src/federation/materialize.ts)：只遍历 DSL 的类型化引用，将显式 UUID/命名绑定转换为接收方不可变版本。支持循环、内联/ByVersion 子工作流、脚本、参数与 Dataset 槽；保留原材料摘要，不全局替换字符串或查询 latest。子工作流保留独立版本快照，递归引用交给现有引擎 maxDepth，不无限展开。
- 输入清单的 bindings 可带 `sourceSelector`；环境锁可带 `runtimeBindings`，将原站 runtimeProfileId 转为接收方运行环境契约。保留原 UUID 清单兼容性，拒绝重复命名绑定、重复软件锁及 runtime profile 映射。
- [只读 plan API](../../../packages/server/src/routes/federation-assets.ts)：要求协议/材料读取授权、同组织预留，以及执行账号的使用权和操作者自己的查看权。返回原 template/清单摘要、本地工作流及子版本，固定 `executionReady:false`，不创建 Job、运行或准备记录。
- 错误带明确 path/reason。来源队列、映射账号、集群/输出存储 ID、静态文件/文本记录 ID、未知/错类型参数、不支持的 Milestone/Command Reduce 均拒绝。原模板的 skipStaticValidation 无法绕过接收方静态检查。脚本按真实 I/O 类型检查文件参数，不能靠 Text 槽绕过。

验证：转换/清单/原协议/签名互验 26 项通过；真实隔离 PostgreSQL 的资产、准备和新增 plan/权限/API 验证 9 项通过。覆盖模板不变、参数里的 UUID 不改写、固定子版本、递归有界、错误 runtime/hash、文件引用注入、跨组织查询、查看权不足、过期签名和只读操作没有派发副作用。隔离数据库已停止并自动清理；没有运行真实集群任务。全仓 lint 无错误（原有 47 个 warning、1 个 info）；全仓 typecheck 中新增测试的一处参数推导错误已修正，Server 重跑通过，其他包均通过。更新文档的本地链接和差异格式检查通过。

**仍是输入转换，不是可执行授权**：缺失的受管文件交付、用例内部本地 package/provider 标识映射、现有用例命名空间/许可证/可信生态入口检查、native lock 内容与实际 Agent 环境检查仍需接通。返回的 ByVersion ID 只能从本次固定快照解析。普通 prepare 的 resolved 语义仍只代表引用快照，未改成自动执行。

## 工作流执行时固定受管 Spack 安装

- [内部 Spack intent](../../../packages/shared/src/workflow/spack-execution.ts) 增加可选 pin：完整 32 位 DAG hash、材料发布摘要、原始锁文件摘要、Spack 1.0.0 和目标平台三元组。共享用例执行器保留该 pin，拒绝退回普通 shell 包装；仍不能从公开 JobSubmit 接口任意注入内部执行意图。
- [Agent 受管安装](../../../packages/agent/src/spack/managed-installation.ts) 按精确 spec、DAG 与 manifest 选择唯一安装，核对经验证的站点 target 和缓存中原始材料发布的 lockfile/Spack/target。要求带许可证/provenance 的材料 v2，然后复用原隔离校验/加载 worker。指纹不符不会执行或替换现有软件，也不会把一份健康安装误标为损坏；真正的校验/加载失败仍撤回该安装的可用状态。
- [SpackManager](../../../packages/agent/src/spack/index.ts) 的 pinned 路径只调用受管后端，不回退到普通宿主 CLI 或同名安装。[Agent stream](../../../packages/agent/src/stream.ts) 将完整 pin 写入 SQLite 收件记录，保持取消、超时和 dispatchEpoch 检查。
- protobuf 注册增加 `spack_pinned_execution_v1`。placement 要求真实 mTLS 身份与该能力；dispatcher 每次发送（包括 outbox 重放）都重新检查当前连接。带 pin 的 Job 使用 `exit 126` 占位，普通受管任务仍为 `exit 125`；旧 Spack Agent 即使忽略新 protobuf pin 字段，也因占位不符而拒绝执行，不能降级加载。

验证：共享物化、消息、mTLS 身份、Agent 受管安装/加载 147 项通过；AgentStream 受影响的 24 项通过；隔离 PostgreSQL placement 23 项和跨 PostgreSQL/Agent SQLite 派发恢复 10 项通过。包括错误 DAG/manifest/锁/平台、本地策略拒绝、材料缺少 v2 证据、旧连接替换、protobuf 字节重放、pin 丢失和取消阻止调度器提交。安装测试使用受控 worker 替身，未执行 Spack 编译或真实 Slurm/PBS 作业，不能视为完整离线验收。隔离 PostgreSQL 已停止并清理。

全仓 lint 无错误（原有 47 个 warning、1 个 info）。全仓 typecheck 中新增测试的两处类型推导问题已修正，Shared/Agent/Server 与跨包派发测试脚本复查通过，其他包均通过；protobuf 通过工具重新生成，未手改生成文件。

**尚需连接来源锁与安装准备**：pin 是执行器内部的强制约束，普通包 resolver 尚不从联邦 environment-lock 构造 pin；材料绑定/自动安装必须使用同一授权发布，不能把“同名软件已安装”当作锁定环境已满足。nativeLockDigest 的完整材料解析、软件/数据授权和联邦预留到运行的事务连接仍待完成，不因该约束上线就自动执行联邦请求。

## Fabric 私有证据链码与可恢复 Gateway 接口

- [证据批次协议](../../../packages/shared/src/federation/ledger.ts) 限定同一域/协议/epoch/机构对，连续序号、原记录 ID/摘要、随机盐和单方/双方确认语义。原有 JWS 实现移至独立的 [shared 签名子路径](../../../packages/shared/src/federation/signatures.ts)，Server 复用原实现，不把 Node 密码依赖放进浏览器协议入口；信任登记增加 evidence-batch 用途，JSON 用途字段无需新迁移。
- [Fabric 证据链码](../../../contracts/fabric/evidence/src/contract.ts) 通过 CCAAS 运行，校验 Fabric MSP/站点/角色与业务签名。初始化固定共同批准的公开信任配置；批次正文、记录索引和带盐序号只写入对应 PDC。交易参数只有两个随机 ID，响应只有 ID/摘要，无私有事件。配置生成 memberOnlyRead/Write 与 AND(双方) 集合背书；链码默认 ALL 管理初始化，所属机构可永久撤销自己的业务密钥。原生策略必须按[部署说明](../../../deploy/federation/fabric-evidence.md)配置。
- [Node Adapter](../../../packages/fabric-adapter/src/evidence.ts) 使用官方 Gateway 1.13.0，精确指定集合两个成员 MSP，不扩大 transient 接收范围。创建签名 proposal、取得背书、提交之间分别返回加密检查点。恢复保存原交易和预先签署的状态查询，提交超时继续查询/重发同一 txId，只有 VALID 返回 anchored；invalid 与 pending 明确区分。
- [本地 Unix API](../../../packages/fabric-adapter/src/runtime.ts) 无任意 invoke 代理，Peer/channel/chaincode/身份由本地配置固定，使用 TLS 和 0700/0600 本地边界。AES-256-GCM 检查点绑定策略与身份；进程不另建数据库，也不在 Server direct 启动路径引入 SDK。

验证：链码与 Adapter/Unix 接口 14 项、测试入口 9 项通过，原签名/Node-Bun 互验 5 项通过。真实 SDK 编码与恢复配合受控 RPC 返回验证丢失提交回执、重启不重复提交、未知状态保留原交易、MVCC INVALID 不误报成功以及恢复记录篡改拒绝；PDC 缺字节但仍有账本 hash 时拒绝重建批次或重置序号。两个包构建成功，Node 实际加载构建产物并按预期拒绝缺失配置。测试没有连接真实 Fabric Peer，不能证明 PDC 分发、背书策略执行或共识竞态已经验收。

全仓 lint 无错误（原有 47 个 warning、1 个 info），全仓 typecheck 通过；最后补充的 PDC 恢复检查再核对两个新增包。生成的 protobuf 无额外变更，依赖锁由 Bun 生成。

**当轮边界**：该次提交尚无 Server 自动消费；后续连接见下一节。A/B/C 真实网络验收尚待完成。配置与公钥代次迁移、双端撤销同步、长期归档、商业/市场链码仍未实现。Adapter 的恢复密钥、旧身份与策略须保留到相关待办处理完，不能直接轮换覆盖。链码只有签名证据承诺，不管理余额或认领，也不把 Peer 背书当成双方业务确认。

## Server 存证批次、持久补交与人工重试

- [attestation](../../../packages/server/src/federation/attestation.ts) 只组装 bilateral_attested 原证据；按合作域/本机构串行分配连续序号，批次限定同协议版本/epoch，最多 100 项。manifest、随机盐、成员映射及 nextSequence 同事务保存；独立批次签名需要 evidence-batch 用途。只签单方承诺，不改变原证据或任务预算。
- [数据库 schema](../../../packages/db/src/pg/schema-federation.ts) 保存批次、序列、每次交易与加密恢复检查点。签名、proposal、transaction 分别落库后才能推进下一步；VALID 时原子完成批次、交易和 outbox。数据库时间/随机租约 token 隔离晚到 worker；INVALID 与未提交的 abandoned 保留历史。NULL 不能绕过签名配对、成员、manifest 或提交结果 SQL 约束。[0083](../../../packages/db/migrations/0083_spotty_wolfpack.sql)、[0084](../../../packages/db/migrations/0084_foamy_dazzler.sql) 均由 Drizzle 生成。
- [Unix client](../../../packages/server/src/federation/attestation-client.ts) 检查同 UID、0700/0600 文件边界、响应 schema 和大小/超时；Server 不导入 SDK。[worker](../../../packages/server/src/federation/attestation-worker.ts) 每十秒最多推进八步，错误至少间隔三十秒；可选 FEDERATION_ATTESTATION_SOCKET_PATH 决定是否启用，链不可用不阻塞接单。只有原 txId 的 VALID 才完成；不明结果保留原交易，不自动退款或重新执行任务。
- [协议 API](../../../packages/server/src/routes/federation-agreements.ts) 新增 attestation 查询与 needs_review 人工重试。查询按本地组织/协议隔离；重试需人类 agreement.approve，和审计同事务。明确 INVALID 后才创建新交易；仅 proposal 状态可安全标记 abandoned 后换交易，已提交或不确定的 transaction 保留原检查点。
- 新增工作区的 package.json 已补入九处 Docker 构建依赖层，避免 frozen-lock 安装遗漏 Fabric 包。十一份工作区清单的隔离 frozen-lock 检查通过；没有据此声称 Docker 镜像已运行。

验证：新增 PostgreSQL 9 项通过，受影响的接单/审批原测试 19 项通过；SDK/链码/Unix client 共 15 项通过。PG 覆盖八路并发只生成一个批次、后续连续编号、链故障仍可继续接单、保存 transaction 后才允许 submit、进程替换保持原交易、过期租约拒绝晚到成功、INVALID 人工重试保留历史、跨权限/自动化会话拒绝及查询不泄露恢复 token。初次组合 PG 测试达到临时服务的连接数上限，改为单文件验证；SQL 断言改用实际 Promise 后通过。隔离数据库已停止并清理，未启动真实 Fabric 或科学计算任务。

全仓 lint 无错误（原有 47 个 warning、1 个 info）。全仓 typecheck 其余包通过，Server 新增测试的类型推导和审计字段问题修正后复查通过；protobuf 无额外差异。新增 Docker 依赖层的 frozen-lock 检查使用 npm 官方 registry，避免本机镜像站缺少 @bufbuild 包导致的无关失败。

**完整存证验收仍未通过**：下一步必须部署 A/B/C 独立 Fabric Peer，验证实际 PDC 私密性、组织背书、并发/MVCC 和真实网络故障恢复。源站证据同步、双方批次确认、用量/结算证据、密码材料代次迁移、归档、Web UI 仍待实现。签名证据补交不等于联邦 Workflow 已能运行。

## Fabric 三机构真实网络与断点恢复验证

- [隔离网络脚本](../../../scripts/fabric-evidence-network.ts)使用官方 Fabric 3.1.5、三个独立 Peer/LevelDB、三份 TLS CCAAS 实例和一个测试 Raft Orderer。生命周期和初始化由 A/B/C 批准，AB 数据使用原生集合策略；全部凭据随机生成，不接触部署环境。成功后停止本次进程并删除临时账本；失败保留私有目录。
- [断言](../../../scripts/fabric-evidence-assertions.ts)与 [Node probe](../../../scripts/fabric-evidence-probe.ts)调用生产证据链码、Adapter 和 Server Unix client。每次推进使用新进程/原加密检查点；检查原生区块私有数据交付，不能被应用层过滤伪装成通过。
- 12 项真实网络断言通过：缺 B 背书 INVALID(10)、正常双方 VALID、同批次重放仍受双方背书约束、A/A 和 B/B 有正文而 C/A、A/C、C/C 无私有写入、公共块无正文、原 txId 恢复、同序号并发 INVALID(11)、真实 Orderer 停机 pending/重启后原交易 VALID、机构撤销权限，以及撤销与旧交易提交产生原生 MVCC 冲突。
- [Adapter](../../../packages/fabric-adapter/src/evidence.ts)修复明确链码拒绝被当作临时不可用的问题：只提取统一格式/白名单的拒绝码，交由 worker 人工复核；混合、未知和传输错误保持重试，详情不跨 Unix 边界。7 项相关单元测试通过，真实网络的冲突/撤销也验证此错误传递。
- [CI](../../../.github/workflows/fabric-evidence-network.yml)固定 Fabric 发布包校验值，对相关 PR 改动运行同一测试；仅保存断言摘要。新增脚本纳入严格类型检查。全仓 lint 无错误（原有 47 warnings、1 info），全仓 typecheck 及脚本独立检查通过。

初轮测试修正了两个就绪条件：Peer 启动不表示已完成跨机构发现；Orderer 重启监听不表示 Raft 已选主。现在使用明确的只读就绪检查，并在限定时长内继续核对同一交易，不更换 txId。最终测试完整通过，临时进程已停止。

**边界**：真实链证据模块验证已通过，但本次没有将 PostgreSQL worker 接入真实链，也没有运行联邦作业。一个本地 Orderer 不验证生产多节点共识/容灾；本地三机构不构成真实独立信任。价格/用量/合同链码、全通道日志/备份隐私、密钥代次迁移、归档和完整 L01–L09 验收仍待完成。

## PostgreSQL、Node Adapter 与真实链的自动补交

- [联合检查](../../../scripts/fabric-evidence-database.ts)复用现有迁移器和隔离数据库命名规则，从空库创建随机 `kuintessence_unit_*` 数据库。启动生产 Node Adapter 的实际入口与 mTLS 配置，使用 [Bun worker](../../../scripts/fabric-evidence-worker.ts)调用真实接单、存证服务和后台扫描。测试结束只删除自己创建的数据库。
- Orderer/Adapter 均离线时直接接单成功、outbox 为零；随后启用 Adapter，存证请求在 Orderer 离线时完成签名/proposal/transaction 落库，保持原 txId 和 `LEDGER_PENDING`，另一请求仍可接单并留下待补交证据。
- 强制结束 Adapter 后保留身份/恢复密钥重启；取得真实 VALID 后，在数据库确认事务之前强制结束 worker。新后台 worker 等待真实 90 秒租约自然到期，自动确认原 txId，再补交后续批次。未手改租约、成功状态或 Gateway 返回。
- 最终两批各两条证据，序号从 1、3 开始，四条 outbox anchored；只有两次交易尝试，原交易 ID 未改变，额度未被存证流程修改，也未创建 Job。正常退出/终止信号均清理本次测试进程、数据库及临时凭据。

新增 4 组联合检查与原真实链 12 项合计 **16 项通过**。隔离数据库帮助函数的 9 项测试通过；该函数补充显式环境类型，避免被新的严格脚本类型检查引入时失去索引签名。全仓 lint 无错误（原有 47 warnings、1 info），全仓 typecheck 和最终脚本检查通过。首次联合运行发现独立测试 worker 没有保持事件循环，修正为有期限的常驻测试进程后通过；没有修改生产后台间隔或租约。

`test:fabric:integration` 强制要求 `KQ_FABRIC_DATABASE_URL`，不会因缺库退回较窄的纯链检查。CI 已加入隔离 PostgreSQL 服务和对应入口；远端尚未运行。具体运行方式见[部署验证说明](../../../deploy/federation/fabric-evidence.md)。

**仍不等于 A02 或完整 L02 已验收**：本次接单只达到 RESERVED，没有实际联邦 Workflow/Job，也没有覆盖用量/结算、事件全序、商业隐私、归档或三套完整 KQ。下一步连接受授权的联邦预留与真实执行，并补齐 Script 持久绑定和恢复，不能用“接单不阻塞”代替“真实作业不阻塞”。

## Script 调用的原子 Job 绑定与独立产物

- [SandboxNodeExecutor](../../../packages/server/src/services/sandbox-node-executor.ts)接收既有引擎传递的动态 invocation path。传入内部 `executionLease` 时，复用[原子绑定方法](../../../packages/server/src/workflow/execution-jobs.ts)，在同一受租约保护的事务内创建 Job、保存完整意图和关联。意图包含脚本/运行环境、输入挂载与摘要、请求资源、输出定义、身份和限制；同路径改代码、runtime 或身份拒绝，循环/子工作流路径不同则分别创建。
- 恢复已有终态 Job 时只读取原结果；已有同 Agent/epoch 的派发 outbox 时交给原待办重放，不重新选择 Agent 或签署指令。Job 尚未分配时可以继续原准备路径；初次实现中已分配但缺少完整派发检查点会等待准备恢复；下文已接通这一恢复路径，始终复用原 Job。授权检查保留，派发前与完成后重新核验租约；取消后的晚到结果不发布新产物。
- 修复普通 Script 循环输出覆盖问题：[产物表](../../../packages/db/src/pg/schema.ts)增加可空 `producerJobId`，新产物按 Job＋输出名唯一；原节点 ID 保留用于展示。旧产物沿用 NULL 分组，不推断不存在的历史 Job 归属。[0085](../../../packages/db/migrations/0085_quick_psynapse.sql)由 Drizzle 生成，未手改迁移或快照。
- [产物服务](../../../packages/server/src/services/workflow-artifact.ts)对同 Job 的既有内容、类型、大小和归属做不可变校验，并发注册返回同一 artifactId。不同 Job 的同名输出分别保存；重放不清空已持久化标记，也不重复复制已经持久化的文件。共享产物 schema 同步包含可选 Job ID。

验证：新增 [Script/PostgreSQL](../../../packages/server/src/services/sandbox-recovery.pg.test.ts) 6 项、原 journal/原子 Job 绑定 9 项通过；Sandbox、共享执行器、产物服务共 47 项相关单元测试通过。覆盖完成后中断恢复、循环输出分离、准备前中断、已有派发待办、代码/runtime/身份改变、租约跨运行误用、取消、八路产物并发注册、旧 NULL 产物兼容及持久化标记保留。初轮仅测试清理顺序遇到已有 outbox 外键，调整清理顺序后通过。隔离数据库从空库应用迁移；调度和文件传输为受控测试边界，没有运行真实科学计算任务。

全仓 lint 无错误（原有 47 warnings、1 info）；全仓 typecheck 通过，最后的执行器调整按 Server 范围复查。当时生产 `makeRunner` 尚未传入 `executionLease`；后续内部持久模式接入见下文。只有普通 Script 的按 Job 分离产物行为已接入现有调用路径。

**自动恢复仍有明确依赖**：生产 lease 心跳已在下文接通，原子运行创建/联邦预留映射仍待接通；下文已补齐已分配 Job 的准备恢复与派发终点校验，分配前的软件安装等待恢复已在后文接通，安装指令可靠补投仍待完成；执行统计已改为按 Job 幂等贡献（见下），但其他恢复依赖尚未完成。当时 Script 的 File 输出返回 `artifactId`，下游只接受 `fileMetadataId`；下文已接通受管文件解析，实际文件传输端到端仍待验收。

## Script 执行统计按 Job 去重

- [统计服务](../../../packages/server/src/services/sandbox-execution-stats.ts)锁定终态 Job，在同一事务内写入统计标记与聚合值；重复完成回调和恢复重放只贡献一次。执行器传递实际 Job ID，普通生产调用同样生效；不引入独立记账队列。缺失/运行中的 Job 或与终态不一致的成功标记拒绝计数。
- [0086](../../../packages/db/migrations/0086_gorgeous_pestilence.sql)由 Drizzle 生成，新增可空统计时间戳；不追溯归因旧聚合值。此统计用于输出量预测，不是联邦计费或结算账本。
- 新增 [PostgreSQL 测试](../../../packages/server/src/services/sandbox-execution-stats.pg.test.ts) 3 项通过：24 路回调对成功、失败、取消的 3 个 Job 只累计 3 个样本；聚合写入外键失败回滚 Job 标记，重试成功；不存在/非终态 Job 拒绝。统计和执行器的 9 项相关单元测试通过。全仓 lint 无错误（原有 47 warnings、1 info）；全仓类型检查发现测试数组索引可能为空，改用明确的成功 Job 参数后 Server 范围复查通过，其余包与 Fabric 脚本检查均通过。

## 派发取消检查覆盖最终投递

- [派发 outbox](../../../packages/server/src/grpc/job-dispatch-outbox.ts)的授权落库与补投统一按 Workflow → Job → outbox 顺序加锁，与现有执行 journal 一致。补投重新核验运行状态、提交者、Agent 和 epoch；同步写入 Agent 通道队列完成后才释放锁，消除“查完未取消、释放锁、此时取消成功、仍然发出指令”的窗口。
- 不在数据库事务内等待网络回执。若已入通道但事务提交失败，仍按原始指令/epoch 重投，由 Agent 持久 inbox 去重；取消只能阻止尚未投递的指令，已投递任务仍须走原有取消协议。
- [真实 PostgreSQL/Agent SQLite 测试](../../../scripts/workflow-dispatch.pg.test.ts) 13 项通过，包括原有断线重放、重复回执、并发补投、停止运行和固定 Spack 意图保护。新增三项验证：在实际入队边界用独立进程探测 Workflow 和 Job 行锁，均返回 `55P03`；取消事务先取得锁时，首次授权落库和已有 outbox 补投都实际等待该事务，取消提交后均不发出指令。检查使用数据库阻塞关系确认先后顺序，不靠固定等待时间碰运气。全仓 lint 无错误（原有 47 warnings、1 info）；全仓类型检查和新增测试脚本的独立严格类型检查通过，524 个本地文档链接通过。临时 PostgreSQL 已停止，其自建数据目录已清理。

**仍待接通**：这次修复运行/Job 取消与投递的竞争；下文已补齐执行租约代次在最终授权提交处的检查，以及已分配 Job 没有完整 envelope 时的准备恢复。当时尚未实现的 Script 文件转换、FileBatch 成员保留和逐文件映射已在下文接通；目录按成员传输，不作为单个云盘文件。

## 已分配 Job 的准备恢复与最终租约检查

- [提交桥接](../../../packages/server/src/workflow/job-submitter.ts)直接传递完整的 `JobSubmission`，保留准备后的 Spack pin、软件/用例修订、输入、资源及候选队列；不再通过手写字段投影丢掉恢复所需信息。生产 Job 行仍使用不可直接执行的 Spack 占位命令，手动队列的提取保留在 JobService 调用处。
- [Placement](../../../packages/server/src/services/placement-orchestrator.ts)接收内部执行租约，核对持久 invocation、运行、用户与组织。已有完整 outbox 或终态 Job 不重做准备；已有分配但尚无 outbox 的 Job，只允许原 Agent、provider、队列目标和原 epoch 继续准备。原 Agent 不在线时抛出可恢复中断，不改派，也不标成计算失败。恢复重新检查目标的软件与授权条件；不会为已经分配的 Job 另起软件安装。
- [JobService](../../../packages/server/src/services/job-service.ts)为调度记录、分配、Sandbox manifest、epoch 检查及准备失败状态增加可选事务边界，使用现有租约事务的前后检查。旧 token 不能通过晚到失败把新执行器的 Job 终结。普通调用保留原写入方式，状态通知与计量仍在事务提交后执行。
- [Outbox](../../../packages/server/src/grpc/job-dispatch-outbox.ts)对持久 invocation 强制要求匹配的当前租约，完整指令落库与租约检查在同一事务内完成。即使 epoch 检查刚成功后旧执行器失去租约，也不能提交或发送新指令。已经获准并落库的指令仍可由 outbox 独立补投，不因运行器换代重新签名或重新安装。
- Script 已将内部租约传入 placement。没有完整指令时交由上述恢复路径处理，已有指令时继续等待原结果。

验证：新增[准备恢复 PostgreSQL 测试](../../../packages/server/src/services/placement-recovery.pg.test.ts) 4 项通过，实际使用 JobService、placement、租约事务和 outbox；在文件准备、epoch 检查后主动释放租约模拟执行权丢失。验证原 Job/Agent/epoch、固定 Spack pin 保留、原 Agent 离线等待、已有 outbox 不重做准备、旧 token 无法再写失败或提交指令，以及不同运行/身份与缺少 outbox 的拒绝。Script 恢复 6 项、派发 13 项、原有调度 23 项、JobService 33 项均通过，共 79 项数据库相关检查；提交桥接与 Script 的 17 项单元测试通过。测试使用受控通道和下载 URL，没有运行真实调度器、安装科学软件或传输实际文件。全仓 lint 无错误（原有 47 warnings、1 info）；全仓类型检查发现测试 Spack 版本字面量需显式类型，修正后 Server 复查通过，其余包、Fabric 脚本和派发测试脚本的严格检查均通过。529 个本地文档链接通过；本轮临时 PostgreSQL 已停止并清理。

**本节当时的剩余项**：下文接通 `makeRunner`/异步运行器的内部持久模式、心跳与重启扫描、用例原子绑定和动态调用取消清单；Script 文件产物转换已在后续章节接通。此次恢复覆盖已分配 Agent 后的准备中断；分配前的软件安装等待已在后文接回，可靠补投和跨实例联邦预留到 Workflow 的原子映射仍待完成，不能据此认定联邦作业已经可用。

## 内部持久执行接入生产运行器

- [异步运行器](../../../packages/server/src/workflow/async-runner.ts)支持内部 `executionModel: durable-v2`，保存显式组织范围，启动与每 5 秒扫描可恢复运行；执行期间续租，失去租约终止结果等待。生产工厂把同一租约传给引擎、用例和 Script。普通 API 提交仍沿用原行为，联邦 RESERVED 尚未映射到该入口。
- [提交方法](../../../packages/server/src/workflow/submit-job.ts)原子绑定动态 invocation 与 Job，保留完整准备意图、授权材料、执行身份和工作目录。完成与错误写入受租约保护；暂时中断标记 `WORKFLOW_RECOVERY_PENDING`，不可变定义/意图冲突标记 `WORKFLOW_RECONCILING`，后者停止自动重试、仍可取消。
- 取消读取全部动态 invocation Job，覆盖循环和并行节点，不再只依赖静态节点映射。正常关闭停止恢复扫描、心跳并释放本进程租约；旧 token 无权完成或中断新持有者的运行。
- 用例文件清单在释放 Agent 工作目录前保存到不可变 Job 绑定；重放先读清单再补清理，发布失败保留源目录。缺少批次元数据不作为空输出成功处理。[0087](../../../packages/db/migrations/0087_famous_nekra.sql)由 Drizzle 生成，增加 `published_files`，隔离空库迁移通过。

验证：[持久运行器 PostgreSQL 测试](../../../packages/server/src/workflow/durable-runner.pg.test.ts) 7 项、journal 9 项、运行登记 6 项，共 **22 项数据库检查**，另 **38 项相关单元测试**通过。覆盖循环中断后复用原 Job、全部动态调用取消、定义漂移停止重试、真实 5 秒扫描不影响 legacy 运行、500ms 租约实际续期、文件清单跨租约恢复和旧 token 写入拒绝。使用真实 PostgreSQL 与受控 Job 完成，不等同于完整 Server 进程重启、文件传输或 Slurm/PBS 验收。全仓 lint 无错误（原有 47 warnings、1 info）；类型检查中新增导出类型的可移植性问题已修正，DB、Server、shared 和脚本复查通过，其余包此前已通过。

Script 的 File/FileBatch 到下游受管文件转换、Checkpoint 文件持久化恢复已在下文补齐；分配 Agent 前的安装等待已在后文接回，安装指令可靠补投、联邦预留到运行的事务映射仍待完成。

## Checkpoint 上传从数据库恢复

- [产物服务](../../../packages/server/src/services/workflow-artifact.ts)在工作流完成前读取数据库中尚未持久化的 Checkpoint/Persistent 产物，使用原工作流归属与经校验、未过期的 Agent 本地副本补传。没有内存任务的新服务实例也能恢复 `persisting`/`failed` 上传；已持久化及其他运行的产物不重复处理。
- 缺少所属用户、本地副本失效或上传失败时拒绝完成检查。内部持久模式保留 `WORKFLOW_RECOVERY_PENDING`，下一次恢复只补文件，已完成的计算节点仍从检查点读取；普通模式保留原失败处理。复用既有产物及副本表，无新增迁移。
- 新增 2 项产物单元测试、2 项真实 PostgreSQL 产物恢复测试及 1 项持久运行器恢复测试。连同受影响的原测试共 **25 项单元测试、16 项 PostgreSQL 测试通过**，覆盖不同服务实例、失败重试、缺失/未验证/已过期副本、运行隔离和恢复不重复运行 Job。首次联合运行发现前一测试留下的运行也被扫描，已将运行器测试改为逐项清理，避免跨测试累计作业数。

全仓类型检查（含 protobuf 生成和 Fabric 脚本检查）通过；lint 无错误，原有 47 warnings、1 info 未增加；534 个本地文档链接通过。自建 PostgreSQL 已停止、临时数据已清理。

测试使用受控文件上传器，并非真实 Agent/NetDrive 传输或完整 Server 进程重启验收。Script FileBatch 成员保留、逐文件发布及 File 输出转换的后续实现见下文。

## Script 受管文件桥接与批次成员恢复

- [受管文件桥接](../../../packages/server/src/services/workflow-artifact-files.ts)将 Script 的 File/FileBatch 引用按当前 Workflow 和用户解析成下游输入。生产工厂同时传给软件节点和 Script；循环产生的引用数组逐项校验后解析。普通文件 ID 继续走原 Job 授权；不能用其他运行、其他用户的 artifactId 获取文件。
- 发布前验证原 Job 已完成、归属一致且没有 `restrictedNoEgress`，生产传输携带原 Job/Workflow ID。Ephemeral 在被下游读取时才经既有 Agent → NetDrive 通道发布；Checkpoint/Persistent 仍按原持久化策略执行。暂时上传失败使持久运行等待恢复，不标成计算失败。
- [成员校验](../../../packages/server/src/services/artifact-members.ts)保留 Agent 返回的每个相对路径、SHA-256 和大小，验证总大小/总摘要，拒绝越界、重复、文件/目录冲突；成员上限沿用 Sandbox 输入契约的 256 项。Script 与用例均保留批次目录结构，重复目标路径拒绝覆盖。
- [0088](../../../packages/db/migrations/0088_quick_loki.sql)由 Drizzle 生成，增加批次不可变清单和逐文件发布映射，云盘文件删除会清空对应外键。完整发布前再校验归属、摘要和大小；失败后保留已发布成员，恢复只补缺失部分，空批次与缺少清单分开处理。旧批次没有清单或原 Job 归属时拒绝推断和导出。
- 同进程并发读取共享上传任务；不同实例的上传使用独立目标，数据库保留首个有效文件映射，避免后到上传覆盖下游已引用的文件。宕机留下的未绑定云盘副本和 Ephemeral 云盘字节回收仍需连接完整清理流程；当前没有宣称上传恰好一次或自动回收这些字节。同 Agent 的本地直读优化也尚未实现，当前均复用云盘传输路径。

验证：**83 项相关单元测试**通过（包含 Agent 实际临时文件校验），另 **15 项 PostgreSQL 测试**覆盖完整迁移、Script 保存 Agent 批次事实、Script → Script 输入、Script → 软件输入、部分发布后的服务替换恢复、并发引用稳定、跨用户/运行拒绝、禁止导出、文件删除后补传及旧清单拒绝。初轮发现新测试 Job 缺少 CPU/内存必填字段、UUID schema 引用错误及数组解析未接入，均已修复；没有修改生产数据来使测试通过。

全仓 lint 无错误（原有 47 warnings、1 info）；全仓类型检查首轮定位到 Server 的 schema 引用与测试字段问题，修正后 Server、shared 及 Fabric 脚本复查通过，其余包此前已通过。537 个本地文档链接与差异格式检查通过，自建 PostgreSQL 已停止并清理。

本轮上传器受控，没有实际连接 Slurm/PBS、NetDrive 网络后端，也未进行完整 Server 进程重启；不能据此认为跨集群工作流或 A01–A10 已通过。仍需完成安装指令可靠补投、联邦预留 → Workflow，并运行真实传输和调度联合验收。

## 安装等待恢复固定原操作与原 Agent

- [Placement](../../../packages/server/src/services/placement-orchestrator.ts)读取 Job 已保存的安装操作关联。恢复尚未分配的 Job 时，使用原安装 Agent；目标离线或暂时不符合调度条件时保留等待。不同 Agent 的混杂关联、操作丢失或 spec 不符进入核对，失败/拒绝操作不触发新安装。已有完整派发 envelope 或终态 Job 不依赖历史安装操作继续保留。
- [安装服务](../../../packages/server/src/software-governance/operation-service.ts)优先复用 Job 的关联，即使这项共享安装由另一个 Job 创建且现已失败。修复原查询只认创建者幂等键、导致其他等待者可能重建失败安装的问题。操作与 Job 关联在事务中加锁；持久工作流的关联写入受当前执行租约保护，最终投递再次校验租约和 Job 未取消。
- [等待器](../../../packages/server/src/software-governance/wait-for-installation.ts)接收租约 AbortSignal；停止执行器或失去租约立即结束轮询等待。超时/基础设施中断在持久模式下等待恢复；明确安装失败仍按失败处理。取消某个 Job 不取消被其他 Job 共享的安装。

验证：准备恢复 7 项、安装共享 4 项、原调度 23 项，共 **34 项 PostgreSQL 检查**通过；等待器 **8 项单元测试**通过。新增覆盖安装过程中换执行器、原 Agent 离线时不改派、安装完成后按原目标派发、失败共享操作不重建、旧租约不能新增关联、材料准备后失去租约不能晚发指令，以及已派发 Job 不依赖被清理的安装历史。使用受控 Agent 通道与库存状态，不进行 Spack 编译或真实调度器作业。

全仓 lint 无错误（原有 47 warnings、1 info）；全仓类型检查发现闭包中的 requester 可空类型，捕获已验证值后 Server 复查通过，其余包和 Fabric 脚本检查通过。540 个本地文档链接与差异格式检查通过。测试使用的自建 PostgreSQL 已停止并清理。

**本节当时的缺口**：安装操作写入后、发给 Agent 前的中断只保留原 `queued` 操作。下文已补齐持久模式的安装补投和 Agent 能力协商；真实软件安装、跨进程及联邦执行联合验收仍待完成。

## 安装指令补投与 Agent 不可变收据

- [安装服务](../../../packages/server/src/software-governance/operation-service.ts)复用操作行和 Job 关联作为持久投递意图。内部持久 Workflow 等待器按原操作、Agent 和 spec 补投；`nextDispatchAt` 将并发补投间隔限制为至少 5 秒。通道关闭或材料服务暂时不可用保留 queued/running，恢复不会生成替代操作。投递前在同一执行租约事务中锁定 Job 与操作，检查取消和原关联；旧租约不能晚发。
- 每次补投重新授权并取得短期下载凭据，凭据不写数据库。材料 manifest 摘要首次发送时保存，后续不得替换。安装恰好完成导致凭据续期失败时，读取已有终态；不将这一竞争误报为准备失败。Server 的结果更新同时匹配 Agent、操作、动作和 spec。
- [协议](../../../packages/proto/proto/kuintessence/v1/agent_service.proto)新增 `software_operation_replay_v1` 和请求的 `durable_replay`。只有启用受管材料且有 SQLite 安装账本的 Agent 才声明能力，Server 还要求当前连接经 mTLS 验证。旧 Agent、不具备账本的 Agent 和旧操作不自动获得可重放资格；普通非持久工作流仍沿用既有投递路径。
- [Agent 收据](../../../packages/agent/src/queue/software-operations.ts)保存动作、spec、请求人和 manifest 摘要的请求指纹，排除可续期凭据。重复请求只恢复/返回原收据；改变意图的请求拒绝执行，也不覆盖原结果。同一操作实际执行中断时仍按既有进程身份和写锁规则报告失败或待人工恢复，不自动重新编译。
- [0089](../../../packages/db/migrations/0089_simple_gamma_corps.sql)由 Drizzle 生成，增加 Server 投递标记、下次投递时间与 manifest 摘要；SQLite 升级为旧收据增加可空指纹，不推断历史身份。必须保留 Agent 的持久数据库；丢失账本不在此重放保证范围内。

验证：**253 项相关检查通过**：安装收据、通道和等待器 44 项，完整 Agent 消息处理 143 项，准备恢复 12 项、安装共享 4 项及安装服务 36 项，另有[派发与安装跨包联合测试](../../../scripts/workflow-dispatch.pg.test.ts) 14 项。使用隔离 PostgreSQL 完整迁移与真实 SQLite，覆盖材料准备前中断、服务/租约替换、8 路并发补投、丢失终态后只执行一次、票据更换、意图冲突、旧数据库升级、旧能力拒绝、取消、发送异常及完成/续期竞争。一个恢复用例等待数据库中真实 5 秒投递期限自然到期；其他并发/重发用例主动推进投递期限，未冒充实际耗时验证。临时 PostgreSQL 已停止并清理。

全仓 lint 无错误（原有 47 warnings、1 info）；全仓类型检查发现联合测试跨越 Server 的 rootDir，已将跨包部分移入既有派发测试脚本。修正后 Server、Agent 和联合脚本的严格类型检查通过，其余包此前通过；546 个本地文档目标及差异格式检查通过。

联合用例中的安装执行、材料授权和消息通道为受控边界；另有 AgentStream 自身的重建/重复请求测试。没有执行真实 Spack 编译、启动完整 Server/Agent 进程做故障注入或运行 Slurm/PBS 作业，不能据此声称联邦无人值守端到端已验收。下一步仍为联邦预留到持久 Workflow 的原子映射及真实派发、传输联合验证。

## 联邦预留与待准备 Workflow 原子绑定

- [绑定服务](../../../packages/server/src/federation/execution-binding.ts)在同一个 PostgreSQL 事务中创建 `submitted` 的内部持久 Workflow，并写入预留 → 运行的唯一映射。参数、完整本地工作流/子工作流定义、原委派、受限身份、环境锁和材料映射一起保存摘要快照。并发准备、服务替换或响应丢失均返回原运行；已取消的运行不被重新创建或重新激活。
- [准备服务](../../../packages/server/src/federation/preparation.ts)复用只读计划的物化逻辑，并重新验证接单回执签名与原请求、金额和预留身份一致。外部软件授权检查后，在绑定事务中锁定并复核协议、身份、机构密钥、原请求/回执、材料和映射；撤销、过期或改变意图不留下游离运行。快照恢复按解析后的内容摘要核对 YAML，避免 JSONB 字段重排被误认为定义变更。
- [后台扫描](../../../packages/server/src/federation/preparation-worker.ts)已接入生产初始化，按既有每批 8 项的限制处理缺少绑定的预留。模板无法转换时记录 `WORKFLOW_INCOMPATIBLE`，缺少材料继续等待，其余授权冲突进入 blocked。它不调用链、不再扣预留额度，也不提交调度器作业。
- [运行登记](../../../packages/server/src/workflow/run-registry.ts)支持调用方事务。普通排队方法拒绝带联邦标记的运行；[异步执行器](../../../packages/server/src/workflow/async-runner.ts)也拒绝未经联邦派发授权的运行，防止把“已经映射”当作“可执行”。本轮运行保持 `submitted`；**仍需将环境/资源约束、本地授权及每次派发检查接到这一运行，才能自动执行**。
- [0090](../../../packages/db/migrations/0090_abandoned_impossible_man.sql)由 Drizzle 生成，新增绑定表、预留唯一键、运行唯一键及禁止级联删除的外键。迁移保留已有预留和运行，不推断旧关联。

验证：联邦资产/绑定 **18 项**、持久运行器 **8 项**、运行登记 **6 项** PostgreSQL 测试，以及物化与异步执行器 **30 项**单元测试通过。覆盖 8 路并发唯一绑定、运行插入后抛错的事务回滚、取消后重复准备、协议/身份/映射撤销和授权过期、错配的有效签名回执、运行身份/快照被篡改、扫描批次推进，以及误排队仍不能执行。隔离数据库从空库完整迁移；测试结束已停止临时 PostgreSQL 并清理数据。

初次验证修正了测试签名参数、JSONB 排序比较和扫描测试只等待一批的问题；类型检查发现默认 placement 配置需要 schema 解析，以及导出快照需要显式类型，已修正。全仓 lint 无错误（原有 47 warnings、1 info）；Server 修正后的类型检查、Fabric 脚本检查通过，其余包在本轮全仓检查中已通过。552 个本地文档目标与差异格式检查通过。没有执行真实调度器作业；这不是 A06 的完整进程故障注入验收，也不是跨机构工作流已可用的证明。

## 固定软件环境与资源约束接入

- [环境锁](../../../packages/shared/src/federation/assets.ts)可携带完整 Spack execution pin，绑定完整 DAG、材料 manifest、native lock、Spack 版本与平台架构。旧格式仍可读取，但缺少完整 pin 不获得执行资格。
- [联邦包解析器](../../../packages/server/src/federation/package-resolver.ts)按快照里的本地固定修订重新检查软件和用例授权，只接受输入清单明确批准的软件别名，继续使用本地受管 usecasePackageId 和安装策略。最终 spec（含用例软件参数）必须与锁一致；完整 pin 经既有用例执行器进入 JobSubmission。
- [运行器](../../../packages/server/src/index.ts)恢复时核对绑定快照和受限身份，子工作流使用保存的定义。用例和 Script 的 CPU、内存、GPU 与时限受委派限制；显式超限拒绝，不暗中缩减。Script 调度使用固定镜像摘要，实际目标运行时不符时在签名之前拒绝。
- [安装服务](../../../packages/server/src/software-governance/operation-service.ts)创建操作时保存要求的材料摘要，复用或补投不能换包；placement 首次安装和持久等待补投都携带 pin。[材料投递](../../../packages/server/src/software-governance/spack-material-delivery.ts)在签发凭据前核对 v2 manifest、native lock、Spack 版本和 target。普通固定安装同样拒绝材料服务缺失或错误摘要，不退回无材料约束的安装。
- [绑定读取](../../../packages/server/src/federation/execution-binding.ts)共用于准备和运行恢复；标记存在但绑定丢失、身份变化或快照摘要不符时拒绝普通执行回退。

验证：**49 项单元测试与 73 项 PostgreSQL 测试通过**（联邦资产/绑定 19、安装恢复 13、共享安装 5、安装服务 36）。覆盖固定 pin 经过真实用例执行器、软件别名/授权失败、超限资源、错误脚本镜像、材料摘要/锁/目标不符、旧材料拒绝、安装操作换包拒绝及绑定丢失。数据库测试使用隔离空库迁移，结束后已停止并清理；最初尝试按名称单跑绑定测试时发现其夹具依赖同文件前序准备，改为运行完整文件后通过，没有将过滤运行失败计为通过。

本轮修复了新增参数误入严格下载凭据 schema 的错误，以及测试字面量和资源类型声明问题。全仓 lint 无错误（已有 47 warnings、1 info）；全仓类型检查发现的测试类型问题已修正并复查相关包，其余包及 Fabric 脚本通过。

**联邦运行仍保持 submitted，异步执行器的拒绝保护仍在。** 上述代码不代表无人值守联邦已可执行。尚须接通逐次派发/补投授权、协议撤销和过期、Agent 目标、完整数据预检与许可，以及联合运行验收；没有运行真实 Spack 安装或 Slurm/PBS 作业。

## 派发待办的联邦授权复查

- [联邦派发授权](../../../packages/server/src/federation/dispatch-authorization.ts)复用既有签名、材料和本地授权准备，核对当前投影仍与原快照一致；外部软件授权调用位于最终发送事务之外。在发送事务内锁定并复核绑定、协议、预留、受限身份、机构密钥、材料和映射，撤销/过期不能被旧准备结果绕过。
- [派发待办](../../../packages/server/src/grpc/job-dispatch-outbox.ts)首次投递、Agent 重连和定时补投都重新获取授权，不保存可无限复用的通过标记。授权服务缺失、授权失效或准备期间运行关联改变时不发送；联邦标记被删但绑定仍在时也不退回普通路径。原 Workflow/Job 取消锁与新的本地授权锁一直保持到同步通道入队；拒绝不会删除原待办或伪造 Agent 回执。
- 生产初始化已接入授权服务，并在依赖就绪后启动派发扫描。该服务不调用 Ledger Adapter，直接合作与异步存证均不依赖链可用性；链上协调模式仍按现有策略拒绝，不能借此绕过链许可。

验证：**40 项 PostgreSQL 检查通过**（联邦资产/绑定/派发授权 25、派发跨包联合 15）。新增覆盖准备后暂停协议、停用执行身份、撤销映射、授权过期、绑定丢失、授权组件缺失、补投重新授权和准备期间更换预留。真实授权服务与真实 outbox 联合测试使用受控 Agent 通道；通道入队时由独立 PostgreSQL 连接探测协议行，`FOR UPDATE NOWAIT` 返回 `55P03`，验证撤销锁持续到发送边界。其后暂停协议或删除运行标记均不再发送。临时数据库已停止并清理。

全仓 lint 无错误（已有 47 warnings、1 info）；全仓类型检查发现新增测试缺少内部 Job ID 和可空 stdout，修正后复查 Server 与 Fabric 脚本，其余包通过。没有运行真实调度器、重新验收 Fabric 或部署预览。

本节只补齐 **Server 通道入队前的联邦协议与引用授权**；不能将入队等同于调度器已提交或已停止。安装补投仍需接入同一协议复查，目标 Agent/队列及软件许可和数据租约的最终检查、Agent 端过期拒绝与回执、预留激活和完整数据预检仍未完成，因此异步执行器的联邦拒绝保护保持开启。

## 安装补投复用联邦授权保护

[安装服务](../../../packages/server/src/software-governance/operation-service.ts)现在从持久 Job 调用反查运行和联邦绑定。联邦安装必须提供对应的当前执行租约、授权服务和原 invocation 内的完整软件 pin；更换 DAG/spec、遗漏 pin 或试图走普通安装路径均拒绝。创建/关联操作前执行协议复查，准备材料后、同步发给 Agent 前再次持锁复核。每次等待器补投重新准备授权，不能复用上次已通过的授权结果；运行关联变化也会中止投递。

生产初始化复用上节的联邦授权服务。拒绝不删除共享安装、不重新创建操作，也不把已发送任务宣称为已取消；是否已执行仍依据 Agent 收据。普通工作流维持既有受管安装和共享操作行为。

验证：安装恢复 **16 项**、共享安装 **5 项**、安装服务 **36 项**检查通过。新增覆盖授权组件/租约/pin 缺失、DAG 换锁、材料准备后撤销和后续补投撤销；撤销后无新消息、原操作仍是同一 queued 记录。新增安装边界测试的授权回调为受控注入；真实 PostgreSQL 联邦授权服务及其撤销锁已由上一节单独验证，未将这些测试称为真实 Spack 安装。隔离数据库已停止并清理。

全仓 lint 无错误（已有 47 warnings、1 info），类型检查通过。实际联邦运行仍保持待准备；下一步为目标 Agent/队列、软件许可与数据租约最终校验、Agent 端过期处理，以及预留激活和数据预检的完整连接。

## 联邦数据预检使用固定的接收方定义

[数据预检](../../../packages/server/src/federation/dataset-preflight.ts)已复用既有递归校验，ByVersion 子工作流从绑定快照读取，用例从已批准的本地映射修订读取并重新授权；不再用普通可变模板表解释联邦子工作流 ID。仍执行本地用例访问、数据集使用授权和输入结构检查，绑定身份或主工作流不一致时拒绝。异步执行器恢复校验时传递 runId，生产入口据此选择普通或联邦预检。

验证：联邦包/预检 **13 项**、普通数据预检及异步运行器 **25 项**，共 **38 项单元检查**通过。新增覆盖 ByVersion 内嵌 Loop 的数据输入、禁止回退到普通模板/用例查询、缺少固定子工作流、执行身份不符、主定义变化和数据/用例撤权。全仓 lint 无错误（已有 47 warnings、1 info），全仓类型检查通过。

异步执行器的联邦自动启动保护仍在，尚待目标范围、Agent 端授权时效及实际激活接通；本节验证的是固定定义的预检路径，不是已执行跨机构任务。

## 双签目标范围与队列派发约束

- [协议 schema](../../../packages/shared/src/federation/index.ts)新增 `executionTargets`，每项绑定提供方组织、集群、Agent 和队列；队列不得重复。该范围保存在[运行快照](../../../packages/server/src/federation/execution-binding.ts)，不从当前资源列表推断。旧协议和旧快照缺少目标时没有运行许可，必须明确批准新的协议修订；不改写旧签名或自动迁移旧运行。仅扩展现有 JSONB 内容类型，不新增数据库列。
- [目标解析](../../../packages/server/src/federation/execution-targets.ts)复用本地队列授权与库存查询，并检查签署的集群/提供方归属；授权前后的队列内容必须一致，防止外部检查期间权限变化被当作新通过结果。[placement](../../../packages/server/src/services/placement-orchestrator.ts)将有效目标作为候选硬限制，旧安装恢复仍固定原 Agent；没有批准目标时等待，不退回其他集群。Script 和用例均传入同一快照范围。
- 所选队列随 Job 指派保存，并在同一事务写入队列权限同步待办。已有硬队列不能换成另一队列；待办写入失败回滚指派，不发送指令。联邦指令强制 `queueValidationMode=enforce`，要求 Agent 按真实调度器状态检查队列。
- [派发授权](../../../packages/server/src/federation/dispatch-authorization.ts)现在从实际 Job 与 invocation 核对运行、受限身份和资源上限。安装补投与计算补投都会重新解析当前批准目标；计算还核对保存的队列、目标模式、队列名称和信封 QoS。最终持有 Agent/队列行锁并校验配置版本，目标被停用、迁移、改权或改变执行参数时拒绝旧投递。

验证：目标/指派 **8 项**、联邦资产/真实授权待办 **25 项**、既有 placement **23 项**、安装恢复 **16 项**、派发跨包联合 **15 项**，共 **87 项 PostgreSQL 检查**通过；协议与 Script **16 项单元测试**通过。覆盖缺目标、跨提供方/集群/Agent、队列撤权、外部授权竞争、队列停用时不改派、批准的命名队列不受无关默认队列故障影响、持锁直到发送、所选队列保存、权限待办失败回滚和重连补投。真实授权待办用例现包含真实持久调用/租约及批准队列；初次夹具因未先建立执行租约触发外键拒绝，调整为正常建立顺序并补齐清理后通过。数据库已停止并清理。

全仓 lint 无错误（已有 47 warnings、1 info），全仓类型检查及最后修改的 Server 复查通过。测试使用受控 Agent 通道和声明为 Slurm/PBS 的目标，没有向真实调度器提交作业，也没有完成硬件平台/软件许可/数据租约的全部最终检查。Agent 端授权过期、预留激活、真实安装/运行联合验收仍未完成，联邦自动启动保护保持开启。

## 软件补投重新授权与许可事务边界

- [软件派发授权](../../../packages/server/src/federation/software-authorization.ts)从不可变 invocation 读取具体软件需求，每次首次发送、重连和补投都以受限执行身份重新调用现有软件可用性服务，检查选定 Agent 的访问、安装、提供方策略和软件许可。必须返回原资产、原 spec 和目标 Agent；缺少资产、授权组件或对应安装需求时拒绝，不能退回无资产的 raw spec。计算仅接受已安装库存，不能把“可以安装”当作“可以运行”。
- 安装授权明确要求安装能力，节点已有软件也不会跳过安装权限和安装许可。安装目标现在携带原 spec，只检查这次原安装操作对应的需求，避免其他尚未安装的需求阻塞独立安装。
- 最终派发事务重新核对完整 invocation，防止外部授权期间任务内容被换掉；随后通过同一许可治理服务读取当前 canonical 许可及凭证，对读取到的发布、修订与许可凭证持有共享锁直到通道入队。准备后许可过期、凭证撤销或发布停用均拒绝发送，安装和计算复用该边界。外部权限调用仍在事务外，不将网络调用放进发送锁范围。

验证：新增软件授权 **9 项**、联邦资产/真实待办 **25 项**、既有许可来源 **2 项**、共享安装 **5 项**、安装恢复 **16 项**、安装操作 **36 项**，共 **93 项数据库相关检查通过**；软件可用性及许可治理 **26 项单元检查通过**。新增覆盖许可到期/撤销、发布停用、已安装软件不能绕过安装权限、目标策略补投复查、缺资产/组件/目标、错误安装 spec，以及授权后篡改 invocation。独立 PostgreSQL 连接使用 `FOR UPDATE NOWAIT` 验证许可凭证和发布行在最终事务中不能被同时撤销。

测试夹具先因缺少发布物化字段、使用错误的停用状态而失败，按真实数据库契约修正后通过。安装操作测试文件包含数据库用例，首次直接运行因未启动默认本地数据库失败，随后纳入隔离 PostgreSQL 验证并通过；未连接部署数据库。隔离数据库均已停止并清理。全仓 lint 无错误（已有 47 warnings、1 info），全仓类型检查及新增测试后的 Server 复查通过。

该边界证明 Server 发送前的软件许可检查，不证明实际 Spack 安装、软件执行或调度器已提交。软件访问/提供方策略在外部检查与最终发送之间的完整并发封锁、受限材料挂载、数据凭据过期恢复，以及 Agent 端授权时效仍待补齐；本轮不解除联邦自动启动保护，也没有部署 PR 预览。

## 派发待办的数据凭据续期与最终数据授权

- [数据派发准备](../../../packages/server/src/federation/data-dispatch.ts)已接入联邦待办首次发送和每次重连/补投：复用原受管数据解析器重新校验访问权限、生成短期租约与固定对象版本的下载链接。原待办字节不改写，不换 Job、Agent 或 epoch；数据资产/版本、摘要、路径、交付方式和普通数据绑定的副本位置必须与原消息一致，数据库返回顺序变化也保留原文件顺序。受限 Sandbox 输入按原签名清单核对逐文件路径/摘要/大小，只更新外部下载凭据，不修改签名内容。
- 最终发送事务核对 Job 与不可变数据绑定，锁定数据资产、版本、位置、授权/拒绝策略、副本及文件清单，再检查授权时效、版本可用性、敏感级别和交付策略；签发 URL 在事务外完成。父记录锁也阻止并发插入新的授权/拒绝记录，避免只锁旧行的遗漏。数据撤权与 Job 锁顺序相反时采用 `NOWAIT` 拒绝本次发送，保留原待办供后续重试。元数据关联到其他版本的文件不能被当成本版本的下载材料。
- 无对象存储配置时，无对象下载的路径不因此增加 MinIO 依赖。数据授权组件缺失时，带数据凭据的联邦投递不能退回旧消息直接发送。权限拒绝后的退避单独保存，避免失败事务回滚退避后反复占用扫描队首；退避写入也失败时，已落库的派发仍返回 pending，不伪造任务失败或新建派发。

验证：新增数据续期/并发 **13 项 PostgreSQL 检查**、既有真实联邦授权待办 **25 项**、派发跨包联合 **15 项**，共 **53 项数据库相关检查通过**；新凭据投影 **12 项**、原数据交付 **12 项**、派发器 **24 项**，共 **48 项单元检查通过**。覆盖过期租约的断线补投、原待办保持不变、撤权/到期/新增 deny、版本/敏感级别/对象版本/位置变化、授权和新拒绝策略插入的并发锁、锁冲突、缺授权服务，以及退避写入故障。隔离数据库已停止清理。全仓 lint 无错误（已有 47 warnings、1 info），全仓类型检查及最后新增测试后的 Server 检查通过。

数据续期测试使用真实 PostgreSQL 和真实 outbox，URL 签发与机构协议授权使用受控注入；机构协议检查另由原真实授权待办用例验证。本轮没有连接真实对象存储或提交调度器作业，不能作为完整联邦作业验收。**只完成 Server 补投前续期**：Agent 收到后长准备/长传输中的续租、Sandbox 签名重新授权续签、安装/运行授权时效及真实激活仍未完成；签名过期时保留待办，不擅自重签或放宽期限。联邦自动启动保护保持开启。

## Agent 执行许可与传输续期

- [协议](../../../packages/proto/proto/kuintessence/v1/agent_service.proto)新增 `federationExecutionV1` 能力协商、联邦派发标记和执行许可请求/响应。Agent 具备持久收件记录、撤销记录、清理日志才声明支持；Server 仅向支持续期且通过证书验证的通道发送带标记作业。旧 Agent、未验证通道和缺少标记的历史联邦待办不能自动降级执行。
- [派发待办](../../../packages/server/src/grpc/job-dispatch-outbox.ts)复用现有协议、资源、软件、数据授权和最终事务锁，为原 Job/Agent/epoch 发放最多 10 秒的许可，期限同时受原请求、协议、数据租约和 Sandbox 信封限制。Agent 已确认收件后仍可申请；错误 Agent、epoch、取消、协议停用和到期均不能获得新许可。许可仅允许开始提交调度器，不是已提交、已执行或持续运行授权的证明；此路径不调用 Fabric。
- [Agent](../../../packages/agent/src/stream.ts)在开始准备和调度器提交前分别申请，不缓存许可；Server 暂时不可达时等待重试，取消打断等待，拒绝授权停止执行。最终申请在队列检查后、`adapter.submit` 前完成。gRPC 请求异步处理并限制每通道并发数量，授权检查等待不阻塞心跳，错误回复不暴露内部错误详情。
- [数据交付](../../../packages/agent/src/data-market/data-delivery.ts)在普通数据绑定的逐文件传输/复制/挂载前后重新授权，过期的旧下载凭据可被同一固定内容的新凭据替换。传输后拒绝、过期或取消会清理本次文件/挂载，避免继续提交；下载接收取消信号。Server 与 Agent 共用[不可变意图比较](../../../packages/proto/src/dispatch-intent.ts)，只允许原有数据凭据变化，禁止改变命令、数据版本、摘要、路径、普通文件 URL 或新增数据租约来源。

验证：**84 项数据库相关检查**通过，覆盖真实联邦授权/待办、数据派发、目标约束、gRPC handler 和跨包派发；修改后的授权到期、已收件续期及异步心跳等 **48 项数据库检查**单独复查通过。**236 项单元/Agent 集成检查**通过，覆盖真实 AgentStream 与 SQLite 的准备/提交双重授权、提交前拒绝/取消、旧能力拒绝、断线/超时重试、原意图保护及传输失败清理；调度器和对象下载使用受控替身。隔离 PostgreSQL 已停止清理，没有启动远端任务或连接业务数据库。全仓 lint 无错误（已有 47 warnings、1 info），全仓类型检查通过。

仍需完成：安装 Worker 的执行许可、完整软件/提供方策略并发封锁、Sandbox 逐文件续租与重新签名、独立于一小时接单窗口的签署执行期限、Agent 真实进程重启后的完整恢复、联邦自动激活和真实 Slurm/PBS/Fabric 联合验收。当前只恢复同进程重连时的许可等待，不宣称跨进程恢复完成，也不以许可响应代替运行中撤权或调度器停止确认。联邦自动启动保护继续开启，尚未发布 PR 预览。

## 联邦安装操作的固定授权归属

- [安装服务](../../../packages/server/src/software-governance/operation-service.ts)原先按 Agent/spec 合并所有活动安装操作。现在联邦安装记录保存原 `federationJobId`，只允许原 Job 和请求人复用；联邦与普通作业、不同联邦作业之间都不合并控制操作。普通作业之间原有的共享安装行为保留。
- 补投先核对 Job 关联的操作归属，再在领取和发送事务中核对归属未变。外部材料票据准备期间替换或移除归属会拒绝发送；历史无归属安装不会被自动提升为联邦安装。普通派发入口拒绝带联邦归属的操作。
- 新字段及约束由 Drizzle 生成[迁移 0091](../../../packages/db/migrations/0091_mean_darkstar.sql)。带联邦归属的记录必须为持久 install 操作，并已有请求人和材料摘要；不回填历史记录，也不随 Job 删除清空归属。

验证：安装恢复、普通共享安装、操作服务与跨包派发共 **78 项检查**通过，其中新增 6 项覆盖不同联邦任务/普通任务隔离、原操作重试、错误/历史关联、票据准备期间归属变化及数据库约束。约束测试最初使用 Drizzle 惰性查询而非 Promise，修正为 `.execute()` 后单独通过；其余 77 项无须重复运行。隔离 PostgreSQL 已停止清理。全仓 lint 无错误（已有 47 warnings、1 info），全仓类型检查通过。

这一步完成 Server 安装操作的授权归属，不代表 Agent 已获得安装续期能力。安装 Worker 启动前续期、下载和预检后再次授权、进程恢复与真实安装仍待完成；联邦自动启动保护保持开启，未部署预览环境。

## 联邦安装的 Agent 在线许可

- [安装服务](../../../packages/server/src/software-governance/operation-service.ts)新增原 operationId 的续期入口，复用当前协议/目标/软件授权、Agent 操作权限和材料票据准备；最终事务锁定 Workflow、待安装 Job 和安装操作，复核原请求人、归属、spec、材料摘要及关联需求，再签发最多 10 秒且不超过请求/协议期限的许可。已取消作业、错误 Agent、错误阶段、归属变化或材料版本变化不能获得许可；不调用 Fabric。
- [gRPC](../../../packages/proto/proto/kuintessence/v1/agent_service.proto)沿用执行许可消息，安装请求额外携带 operationId，要求原 Job 和零 dispatch epoch。独立的 `federationInstallationV1` 能力协商防止仅支持计算续期的旧 Agent 接收安装；派发携带固定 `federationJobId`，Agent 持久收据将其纳入不可变指纹，不能换归属或降级为普通安装重放。
- [AgentStream](../../../packages/agent/src/stream.ts)从安装队列取出操作后，先获得当前许可和新材料票据再准备材料；沿用计算许可客户端的超时、断线重试与取消处理。[安装 runner](../../../packages/agent/src/spack/install-runner.ts)在预检、文件准备和内存准入后再次请求许可，才允许启动安装/验证 worker，并在持久 worker 启动记录写入后复查许可尚未到期。失败时不发布成功安装记录，也不创建替代 operationId。
- 准备前断线可等待；持有安装存储锁期间的在线许可检查限时 15 秒，超时走现有操作失败和清理流程，避免无限持锁。**该超时尚未实现自动恢复为等待并重试**，失败的原操作仍按现有终态规则保留，不能称为完整的无人值守故障恢复。许可只控制 worker 启动，不自动证明运行中 worker 已撤销或停止。

验证：**104 项数据库相关检查**通过，覆盖真实协议/待办、安装恢复、计算与安装 gRPC 分流及异步心跳；其中安装许可用例使用真实协议和事务，软件/目标授权与票据签发受控注入，已有软件/目标边界由各自回归覆盖。新增夹具最初缺少持久执行租约导致外键失败，补齐真实租约后该文件 **26 项**复查通过。**289 项单元/Agent 集成检查**通过，包括收据防降级、材料票据续期、提交意图不可变、实际 AgentStream 双边界、安装 runner 拒绝/过期许可不启动 worker，以及旧 Agent 能力拒绝；Spack 进程仍为受控替身。隔离 PostgreSQL 已清理，全仓 lint 无错误（已有 47 warnings、1 info）；类型检查的测试类型问题已修复并复查。

尚需完成独立签署的执行期限、安装锁内网络故障后的持久等待恢复、长材料下载凭据续期、编译中撤权及停止确认、Agent 完整进程恢复、Sandbox 续租/续签、完整软件策略并发封锁、实际激活和真实 Slurm/PBS/Fabric 联合验收。联邦自动启动保护继续开启，未发布 PR 预览。

## 独立签署的接单窗口与执行期限

- [委派 schema](../../../packages/shared/src/federation/index.ts)新增可选 `executionExpiresAt`。首次接单仍检查原 `expiresAt`（最长一小时），执行期限必须覆盖接单窗口且不能超过协议有效期；历史请求缺少字段时保留原截止时间。
- [准备服务](../../../packages/server/src/federation/preparation.ts)仅在验证原请求签名、接单回执及其 requestDigest 后使用执行期限，接单回执的 acceptedAt 仍必须落在原接单窗口内。准备及最终事务检查使用相同口径，已准备对象跨过执行期限也会被拒绝。
- 计算与安装续期继续限定最多 10 秒，但现在截断到独立执行期限、协议期限及更早的数据/Sandbox 期限。长准备不再仅因一小时接单窗口结束而失败；既有权限撤销和固定执行意图仍生效。同一操作不能通过换签一个更晚期限来改写已接单记录。

验证：**42 项 PostgreSQL 检查**及 **14 项协议/签名单元检查**通过，覆盖过窗首次接单拒绝、原回执幂等返回、签名期限篡改、重新签名改期冲突、旧请求不延长、执行期限内准备/绑定，以及计算和安装在接单一小时后继续申请原许可、到期拒绝。接单超时夹具最初先触及额度不足，降低该请求额度后单独复查期限判断通过；其余检查未重复运行。隔离 PostgreSQL 已停止清理。全仓 lint 无错误（已有 47 warnings、1 info），全仓类型检查通过。

期限只控制新准备/worker 启动/作业提交许可，不代表已经具备运行中撤权停止确认。安装超时后的持久等待、Agent 进程恢复、Sandbox 续签、真实自动激活和联合验收仍未完成，联邦自动启动保护保留，PR 预览仍未部署。

## Agent 未提交准备的持久恢复

- [收件记录](../../../packages/agent/src/queue/inbound-acks.ts)沿用原 SQLite 表，联邦收件新增不可变派发指纹与原可续期输入位置；不新增持久下载凭据、环境变量或缓存许可。共享[派发意图](../../../packages/proto/src/dispatch-intent.ts)规范化规则继续只允许原有数据凭据变化，环境变量键顺序不影响恢复指纹。
- [AgentStream](../../../packages/agent/src/stream.ts)在重新连接后为未提交准备重新申请 Server 原 Job/epoch 的派发，核对指纹后进入正常准备/提交双重许可。断线或 Server 返回 RETRY 时沿用原客户端重试，取消中断等待；授权拒绝、任务替换和已有撤销记录阻止恢复。恢复期间的重复投递不启动第二份任务。
- 最终许可后、调用调度器前，将提交标记写入原持久收据，并再次检查期限/取消。该标记独立于清理日志；没有本地活动记录的模糊提交、未清理材料或缺指纹的历史收据保留 pending，不能因为调度器一次未找到或清理日志已删除而重新提交。已有活动作业仍沿用原监控路径。

验证：收据/指纹/执行许可/共享意图 **41 项**及 AgentStream **157 项**检查通过。新增恢复用例关闭并重新打开磁盘 SQLite、创建新的 AgentStream，覆盖恢复、拒绝、篡改、撤销、提交标记、清理未决与历史收据；提交标记移动到最终许可后，相关 **14 项**单独复查通过。测试未启动真实独立 Agent 进程或真实调度器，不能当作完整主机重启验收。全仓类型检查通过，最终调整后的 Agent 类型检查通过；全仓 lint 无错误（已有 47 warnings、1 info）。

本轮只补齐未提交准备的恢复。模糊提交自动核对、完整活动作业/Sandbox 元数据恢复、清理重试和运行中撤权停止确认仍待完成，联邦自动启动保护保留，未发布 PR 预览。

## 提交响应丢失、进程退出与活动作业恢复

- [持久收据](../../../packages/agent/src/queue/inbound-acks.ts)在调度器调用前同时保存完整准备快照和提交标记，禁止二次覆盖；[活动作业](../../../packages/agent/src/queue/active-remote-jobs.ts)保留原 dispatchId、队列约束及完整 Sandbox 运行身份、命名空间、挂载和输出校验信息。联邦能力声明现在也要求活动作业存储。
- [Agent](../../../packages/agent/src/stream.ts)启动与心跳期间单实例核对未确认提交。调度器接受后响应丢失、活动记录写入失败，不再直接报失败并清理输入；已知 ID 或原 Job UUID 查到的作业接回原监控器，不再 submit。找到前保留原收据与清理日志，断链不影响这一核对过程，也不调用 Fabric。恢复后只回报实际观测状态，queued 不伪装为 running，状态回报确认原派发收据。
- Slurm 支持活动队列与保留的 sacct 历史 UUID 查询，活动匹配不依赖 accounting 可用；PBS 支持 qstat 历史。精确匹配、重复匹配拒绝及查询超时继续生效。历史已清理、UUID comment/变量未保存或权限不足时保留待核对，不因一次 not_found 重跑。Torque 当前仍只查询可见作业，不能宣称已覆盖其全部历史恢复。
- 调度器状态查询失败/返回错误格式/对象不匹配不再被当作计算失败，沿用 runner 的重试路径，CLI 已有查询错误处理保持兼容。未确认提交已有撤销记录时，先取消并要求正向停止确认，确认前不清理输入；Slurm/PBS/Torque 支持此确认。Kubernetes/自定义适配器没有该能力时保留记录，其他已确认运行作业的取消与清理路径仍需统一。

验证：相关 **425 项检查**通过，覆盖 9 个 Agent/适配器测试文件；最终生命周期调整后的 **255 项**及 Slurm 停止确认的 **66 项**单独通过，未重复执行不受影响文件。新增子进程夹具在调度器替身接受任务后直接 `process.exit(73)`，父进程重新打开同一磁盘 SQLite，覆盖接回原作业、查询故障后心跳重试、撤销与等待停止确认，均没有第二次 submit。另覆盖 Sandbox 完整元数据、原收据确认、PBS 精确 ID、历史查询与终态确认。PBS 新夹具最初引用 describe 内局部 helper，改为独立 JSON 夹具后通过。全仓类型检查通过，全仓 lint 无错误（已有 47 warnings、1 info）。

这些测试确实跨了 Agent 进程退出边界，但调度器、授权 Server 和数据内容仍是受控替身，不是实际 Slurm/PBS/Fabric 联合验收。完整活动任务撤权/停止确认、Kubernetes 停止证明、长下载/Sandbox 授权续期、安装持久等待和真实激活仍需完成；联邦自动启动保护保留，未发布 PR 预览。

## Agent 运行中取消、数据撤权与停止确认

- 提取共享 `cancelAndConfirmStopped`，普通任务取消、数据撤权、提交回执异常与重启清理都要求正向停止证据。取消响应丢失但已证明停止可以继续；停止查询失败、不支持或仍运行都不清理、不确认成功。Runner 不再吞掉取消失败后提前清理；并发停止请求共享当前检查，失败可以重试，真正退出本地轮询后再释放输入。
- 数据撤权改为先等作业停止、再清理，去掉原先取消与删除并行的路径。启动/心跳重试撤销与清理失败，同一 Job 的并发取消共享收尾；只落下 tombstone 就退出的窗口也能恢复。已知新 epoch 的任务不受旧轮次撤销影响，恢复监控采用相同 epoch 判断。
- 原始/Spack/Sandbox 准备任务统一登记收尾 Promise，取消先阻止后续提交，再等待其完成清理，不能在文件准备仍执行时回成功。可取消的既有联邦/Spack 等待继续通过原信号终止，暂不支持中断的准备会等待，不伪造已经停止。
- [Kubernetes 适配器](../../../packages/agent/src/adapters/k8s.ts)保留原命名空间，foreground 删除后检查 Job 终态/消失和相关 Pod 的实际阶段；owner reference 或 Job 标签仍指向原任务的运行中 Pod 都会阻止清理。查询异常、错误对象、无效列表和单纯失败 Pod 计数不能证明停止。清理日志中的命名空间可直接用于已知调度器 ID，无须先恢复完整 JobSpec。

验证：共享停止检查、Kubernetes 适配器、Runner、ExecutorPool 和 AgentStream 共 **272 项检查通过**；最终新增准备等待与 Pod 标签用例后，相应 **229 项**单独通过。覆盖取消回应成功但仍运行、取消响应丢失后正向确认、查询不可用、清理失败后心跳重试、tombstone-only 恢复、旧 epoch、原始/数据准备撤销等待及不同命名空间。最初两个旧测试替身缺少停止确认已补齐，新增 Runner 夹具改为等待实际进入轮询后注入取消，避免把不同提交窗口混为一个场景。全仓类型检查和最终 Agent 类型复查通过，lint 无错误（已有 47 warnings、1 info）。

测试使用真实 AgentStream/SQLite 与调度器命令/进程状态替身，没有执行真实 Kubernetes、Slurm 或 PBS 作业；不把这些检查当作真实集群撤权验收。Server 主动撤销传播、运行期限到期处置、安装 worker 撤权、长下载与 Sandbox 续签等仍未完成，联邦自动启动保护继续保留，PR 预览未发布。

## Server 主动撤权与执行到期取消

- 新增[执行监视器](../../../packages/server/src/federation/execution-monitor.ts)，复用派发授权准备和最终事务检查，不连接 Fabric。启动即扫描，之后每 10 秒按 ID 轮转最多 25 个联邦运行；单个失败不会阻塞后续记录，停止 Server 时等待扫描收尾。普通任务和终态排除，绑定丢失但保留联邦标记的任务仍接受检查；禁用联邦后继续取消遗留任务。
- 协议停用、源/接收签名密钥撤销、机构或执行身份停用、材料映射/软件/数据明确撤销、软件 use 权限拒绝、绑定冲突和签署执行期限到期触发原 Workflow 取消。取消原因和状态一次写入，重试及终态不覆盖原原因；原 Workflow 恢复与 Job 取消 outbox 继续负责实际停止，未确认前保持 cancelling。重新获得授权不能恢复已取消的执行。
- 明确撤销的材料返回 POLICY_DENIED，和缺副本/未就绪的 DATA_WAITING、ASSET_UNAVAILABLE 分开；数据库或外部授权服务异常按下一轮重试处理，不冒充明确撤权。每轮数量和检查耗时决定扫描延迟，不承诺任务规模无关的 10 秒停止时限。

验证：隔离 PostgreSQL 下，材料/联邦授权、Workflow 运行注册表和异步运行器共 **72 项检查通过**；包含真实 JWS 与授权记录变更、独立执行期限/历史期限、准备后的最终事务撤销、原取消原因、未收到停止确认、运行器重新创建后恢复、关闭联邦、分页和瞬时故障。最终补充的数据集生命周期撤销检查单独通过。全仓类型检查及 Server 最终类型复查通过，lint 无错误（原有 47 warnings、1 info）。隔离 PostgreSQL 均已停止清理。

测试中的停止边界是受控回调，不代表已执行真实 Slurm/PBS 停止验收或真实 Server 进程崩溃。资源目标/队列、完整运行许可和数据租约主动监控、安装 worker 运行中停止、锁内超时的持久等待、长下载与 Sandbox 续签等仍待完成；自动激活保护继续开启，PR 预览尚未发布。

## Agent 安装操作的撤销归属与停止门槛

- [软件执行收据](../../../packages/agent/src/queue/software-operations.ts)新增持久 `jobScope` 与 `stoppedAt`。SQLite 沿用项目自有的幂等迁移，旧记录保留未知归属，只有匹配原请求指纹的重放可补齐，不为旧记录猜测 Job；不同 Job/普通安装的归属不能互换。
- [AgentStream](../../../packages/agent/src/stream.ts)将 Job 取消和数据撤权传给原安装的信号。未执行操作直接保存失败并封锁队首，取消不等待无关安装；已执行操作等处理收尾，再由原 store writer fence 证明无活动/未知 worker。终态失败不视为停止，无证明不发取消确认；启动/心跳根据原收据和撤销记录重试，已确认的收据不会重复创建 store 锁代次。
- [安装 runner](../../../packages/agent/src/spack/install-runner.ts)和[源码审计器](../../../packages/agent/src/spack/source-auditor.ts)不再在 transport 异常时直接删除输入。明确未启动或正常返回可以清理；未知 worker 保留私有目录，源码审计器在当前进程中不再复用执行槽。未引入不经停止证明的目录清理或强行解锁。

验证：AgentStream **173 项**、软件收据 **18 项**、SQLite 集成/编译迁移 **14 项**、安装 runner/源码审计/安装事务 **176 项**，共 **381 项不同检查**通过。最初 3 个 runner 测试仍要求异常时删除目录，已改为验证保留，最终 runner 的 54 项单独通过。覆盖运行中取消、排队/续期中取消、先撤销后到达、数据撤权、其他操作隔离、SQLite 重开后的 writer fence 与历史归属。全仓类型检查与最终 Agent 类型复查通过；lint 无错误（原有 47 warnings、1 info）。

这里的 worker/transport 是测试替身，不能作为真实编译停止验收。仍需完成 Server 按安装操作找到全部 Agent 并持久投递取消/等待证明（安装 Agent 不一定等于 compute Job.agentId，待安装 Job 也可能还没有 Agent）、进程监督和原宿主机重启后的停止恢复。当前原生 transport 异常没有完整子进程停止证明，会保守保留恢复状态；源码审计输入保留后的自动回收也未实现。自动激活保护保留，未发布 PR 预览。

## Server 跨安装 Agent 的持久取消与 Workflow 结束门槛

- Job 取消在同一事务中查出该 Job 的全部安装操作，覆盖尚未分配计算 Agent、安装与计算不在同一 Agent，以及已失败但尚未证明停止的安装。取消收件记录改为 `(jobId, agentId)` 唯一，保留原计算取消，并按接收方保存撤销代次。新增 PostgreSQL 迁移 0092，由项目生成命令生成。
- 普通取消、Workflow 取消、数据资产撤销和数据使用授权撤销共用安装取消记录。启动与每 10 秒重投未确认消息，离线 Agent 重连后可继续接收；加强停止要求会使旧的普通确认失效，不会被后续普通重投降级。新协议 `installations_stopped` 只在 Agent 完成持久安装停止检查后发送，旧 Agent 的普通确认不能满足此要求。
- Workflow 取消等待所有安装/计算接收方，跨 Server 回执通过数据库收敛；单轮等待最多 15 秒，未确认保留 cancelling，交给现有恢复逻辑继续。已完成或失败的 Job 保留结果，同时仍撤销其遗留安装。数据撤销后的正常运行器返回也在结束事务中检查待确认记录，沿用 Workflow → Job 加锁顺序；先保存节点结果并进入 cancelling，全部停止后才结束，失败节点与原因不会被改成成功或丢失。

验证：本轮 AgentStream/Agent handler **191 项**、Dispatcher/WorkflowAsyncRunner **45 项**、新取消 PostgreSQL **10 项**、运行注册表/持久运行器 PostgreSQL **15 项**通过；此前 JobService 与安装授权等隔离检查已通过，不重复运行未受最终改动影响的部分。新用例覆盖多个安装 Agent、部分确认、错误 Agent/代次、旧回执拒绝、实例替换与跨 Server 确认、事务回滚，以及数据撤销后真实 WorkflowAsyncRunner 等待安装确认、失败结果保留。全仓类型检查通过，最终 Server 类型检查通过；lint 无错误（已有 47 warnings、1 info）。隔离 PostgreSQL 已停止清理。

这些测试使用受控 Agent 回执，尚未完成真实安装进程停止及 Slurm/PBS/Fabric 联合验收。Server 已具备跨安装 Agent 的取消传递和等待，真实进程监督、同宿主机进程退出后的停止恢复、源码审计保留输入回收仍待完成。新协议需配套升级 Agent；旧 Agent 会保持待确认，不会伪造停止成功。联邦自动激活保护继续保留，PR 预览尚未发布。

## 安装与源码审计的真实进程监督及同宿主机恢复

- 新增[systemd 进程监督](../../../packages/agent/src/spack/supervised-process.ts)。启动前持久保存随机单元名、执行身份、输入目录及资源预算；安装/验证与源码审计默认使用用户级 systemd 254+。资源上限与所有后代使用同一 cgroup，Apptainer 保留原 namespace/只读挂载，去掉自行创建资源 scope 的参数；worker 继续检查实际限制。没有可用的管理器或 cgroup 视图时拒绝执行，不退回无监督安装。
- 正常结束、取消、超时和异常均先持久封锁晚到启动，再停止原单元并核对完整 cgroup 为空或已消失。只有确认停止才能清理输入/释放 writer；单纯进程组 kill 或父进程退出不作为证明。单元可自动收集，但禁止启动与停止记录继续保存，不能在线随意删除。精确环境、字面量参数与输出预算保持原约束。
- 软件操作 SQLite 新增监督引用，沿用手维护的幂等迁移；只有已开始、未终结的原操作可以追加。它覆盖尚未绑定 storeRoot 的源码审计，防止其失败后一直缺少停止证据。store 锁代次也保存每个 worker 的监督引用，可信同宿主机上原 Agent 已退出或当前控制调用已收尾时，先核对停止再恢复；旧未监督记录、未知身份和活着的其他 Agent 保持保守拒绝。
- 输入回收复用同一停止证明。新审计前检查旧审计记录；安装/软件账本恢复及取消沿原引用清理私有目录，保留部分安装目录与失败结果，不自动重新编译。PR managed runtime 探针也改为使用相同监督入口，不能再绕过资源管理路径。

验证：安装/源码审计/存储恢复/软件账本 **246 项**回归通过；最终账本、AgentStream 和 SQLite 两类迁移 **205 项**通过（两组有重叠，不相加作为不同测试数）。新增生命周期的 **4 项**定向检查通过。显式 systemd 集成 **13 项**通过，其中 **6 项**创建真实轻量进程，覆盖真实限额、字面量参数、setsid 后关闭输出管道的后代、晚到启动、SQLite 重开，以及两个 Agent SIGKILL 场景。SIGKILL 后先确认原 worker 仍活着，再由新进程恢复 store/审计并确认停止、清理输入；没有再次执行编译。其余 7 项验证非法预算在访问 systemd 前拒绝。初次夹具出现 PID 文件尚未写完、服务主进程不能再次 setsid 的问题，改为等待有效 PID 并由 fork 子进程 setsid 后通过。最终源码审计 **89 项**及收尾调整后的 **8 项**生命周期检查通过，runtime 探针构建通过。全仓类型检查与最终 Agent 类型检查、lint 通过（原有 47 warnings、1 info）。

本地使用 systemd 255 的 root 用户管理器与轻量 Python，未启动实际 Apptainer/Spack 编译，也不代表 Slurm/PBS/Fabric 联合验收。systemd/cgroup 视图要求和持久元数据维护见[安装恢复说明](../../spack-install-recovery.md)；未知容器身份的跨进程恢复、没有监督引用的历史/启动前失败收据仍沿用保守规则。长下载授权续期、安装锁内网络超时后的持久等待、完整主动授权监控、实际联邦激活及完整蓝图交付仍待完成。自动激活保护保留，PR 预览尚未发布。

## 联邦安装临时授权故障的持久等待

- 队首与安装/验证 worker 启动前的在线授权统一限制为 15 秒。网络不可用、响应超时、RETRY 和短期许可过期返回内部等待信号；明确拒绝、非法许可及调用方取消仍结束操作。复用 Server 已有的原 operationId 补投，不创建新的安装操作，不连接 Fabric。
- store 新增 `waiting_install`、`waiting_verify`。等待释放写锁；编译成功立即持久保存不可变 `buildReport`，等待后的重投沿用原 release UUID/路径，只继续验证。原材料摘要、站点、spec 和 root hash 必须一致，并要求新在线授权；编译未完成或 worker 停止不确定时不能冒充可恢复检查点。已发布 release 复验等待会撤销库存并保持 unavailable。
- SQLite 幂等添加 `authorization_waiting`，原请求指纹和 Job 归属不变，不落盘票据。匹配重投通过条件更新领取；记录、原 Agent 身份及 store 检查点支持重开后的恢复。新尝试已领取时，旧恢复不能再标为等待或写入失败，延迟队列收尾也不能删除新尝试的跟踪。等待期间无关软件操作继续执行，同一 spec/root 的另一安装等待原检查点，避免重复编译和发布。
- 取消持久等待先核对原监督引用和写锁，再原子保存终态及停止证明，并立即通过原持久 outbound 路径回报 Server。新尝试尚未启动时不沿用旧尝试的 started 标记，避免授权被拒绝后无法证明停止；旧 store 检查点仍须经过锁检查。

验证：最终 AgentStream/软件账本 **198 项**通过，覆盖原 ID 重投、活动去重、取消/拒绝后的停止确认、无关操作进度、SQLite 重开、并发领取、旧身份回调及 store 已写入而 SQLite 尚未更新的恢复窗口。安装事务/store/授权 client、Manager、runner、SQLite 初始化与单文件编译迁移相关检查通过；最终取消结果即时上报 **3 项**、过期/非法许可 **4 项**及旧库迁移定向检查通过。全仓类型检查中两个新测试的类型问题已修正，Agent 最终复查与其余包/Fabric 脚本检查通过；lint 无错误，仍有原有 47 warnings、1 info。测试集合有重叠，不汇总为独立检查数量。

这一轮使用临时 store/SQLite 与 worker、调度器和传输替身，没有重新执行真实 systemd/Apptainer 编译或远端作业。等待状态目前只在 Agent 内部保存，Server 仍显示 queued/running；新 store 字段要求共享写入者一致升级，不支持直接降级。完整资源/运行许可/数据租约的主动监控、长下载续租、Sandbox 续签、实际联邦激活和全部蓝图功能仍待完成。自动激活保护保留，PR 预览未发布。

## 运行中的资源、软件许可和数据授权监视

- 新增[实际执行策略检查](../../../packages/server/src/federation/execution-policy.ts)，接入现有启动/周期监视器。沿持久 invocation 找到 pending/queued/running Job，以及仍在安装的原操作；计算目标核对签署的提供方、集群、Agent、队列和当前队列目标，安装目标独立检查，不能因为计算 Job 尚未分配 Agent 而漏检。终态计算 Job 不新增执行义务。
- 复用队列 submit 权限与软件策略、资产 use/install 权限、canonical license 和 entitlement 规则。运行检查不依赖 Agent 在线、调度器库存或软件库存重新上报，不创建下载凭据，也不连接 Fabric。明确权限拒绝、队列停用、资源归属变化、软件策略撤销及许可证到期进入原 Workflow 持久取消链路；仍须实际停止确认，不能直接发布 cancelled。
- 对实际 `job_data_bindings` 检查数据版本/摘要、敏感度、交付政策以及当前 use 授权。版本撤销、授权到期/撤销和绑定变化会取消；不要求已交付输入的源副本仍在线，也不通过持续生成下载链接假装续期。
- 权限后端原先用普通 403 同时表示明确拒绝和服务不可用。新增内部 `AuthorizationUnavailableError`，保留 Web 调用原有的拒绝响应；联邦准备、队列发现、安装补投及 Agent 许可 RPC 将它保留为可重试故障，监视器不据此误取消。Agent 许可 RPC 对 DATA_WAITING / ASSET_UNAVAILABLE 同样返回 RETRY，避免暂缺材料被误作永久拒绝。协议检查与实际执行检查独立进行；材料暂不可用不会遮蔽队列撤权，队列权限服务故障也不会遮蔽已确认的软件许可到期或数据撤权。

验证使用隔离 PostgreSQL、真实授权/协议记录及 Workflow 注册表，调度器停止由受控回调模拟。覆盖资源/队列变更、未放置 Job 的安装 Agent、实际软件许可证到期、软件策略/使用权限撤销、数据使用授权到期与版本/政策变化、离线仍获授权、后端失败重试及交叉故障。最终材料/监视器 PostgreSQL 全套 **63 项**、Agent 许可 RPC **34 项**以及执行目标/队列/Job 路由回归 **35 项**通过；先前软件授权等组合回归 **169 项**通过，与上述检查重叠，不累计为独立检查数。全仓类型检查及最终 Server/Fabric 脚本类型复查通过；lint 无错误（原有 47 warnings、1 info）。隔离数据库已停止并清理。

这仍不是完整运行许可交付：Sandbox 运行契约/映像、执行账户及受限材料的持续授权检查、Agent 与 Server 断联期间的本地许可到期停止、长下载和 Sandbox 逐文件续签尚待接通。当前轮询不能承诺固定的最大撤权延迟，真实 Slurm/PBS/Fabric 联合运行未验收。自动激活保护保留，PR 预览未发布。

## 受管安装运行中的本地续期与独立到期停止

- [运行许可](../../../packages/agent/src/execution-authorization.ts)复用原安装授权 RPC，在源码审计、安装和验证期间持续续期；墙钟与单调时钟共同限制期限。暂时故障可以等待到原许可到期，明确拒绝立即中断；迟到响应不能复活旧许可。worker 启动前仍可持久等待，启动后的许可丢失按失败停止，不把不完整编译当作检查点重跑。
- [进程监督](../../../packages/agent/src/spack/supervised-process.ts)对联邦 worker 使用宿主 Python 守护和 systemd notify 服务。守护仅读取原 unit 的私有原子租约，按墙钟与 CLOCK_BOOTTIME 过期；隔离 worker 不接收租约或通知 socket。Agent 被 SIGKILL 后仍会停止，守护冻结时由 systemd 运行时限兜底，续期不会突破安装总超时。先确认 cgroup 停止再释放 writer，过期事件本身不是停止回执。
- 普通非联邦 worker 沿原监督路径；未证明停止的传输异常仍保留输入、锁和未知状态。联邦路径增加宿主 `/usr/bin/python3` 要求，监督记录新增可选字段，共享写入者需要一致升级。注册新增 `federation_installation_lease_v1`，Server 在派发及续期入口拒绝仅有旧启动检查能力的 Agent；历史正在执行的旧进程须先停止，不能通过升级自动补装守护。具体限制和维护规则见[安装恢复说明](../../spack-install-recovery.md)。

验证：最终源码审计/安装 worker **152 项**、许可计时器 **8 项**、Agent 注册与授权边界 **3 项**通过。真实 systemd 集成累计覆盖 **18 个不同用例**（包含原有回归和分次新增检查），其中新用例验证迟到启动、准备中到期、持续续期后 Agent SIGKILL、守护冻结、以及续期不能突破总超时；未启动真实编译。受管安装/Manager/源码审计/授权 client 组合回归 **173 项**通过，与上述测试有重叠，不相加。隔离 PostgreSQL 中 Agent RPC、Dispatcher、联邦材料/监视器与 placement 恢复 **146 项**通过，数据库已停止清理。全仓类型检查通过，最终 Agent/Server 类型复查及 lint 通过（原有 47 warnings、1 info）；protobuf 使用生成命令更新，Python 语法与新增文档链接静态检查通过。

验证仅使用受控 worker/网络替身和本机真实轻量 Python 进程；未执行真实 Apptainer/Spack 编译或远端集群作业。调度器计算作业的本地续期/到期停止、长材料下载续租、Sandbox 契约与文件授权仍待完成；系统管理器或内核故障时仍需保守核对，不声称绝对即时停止。自动激活保护保留，PR 预览未发布。

## 计算作业的独立运行期续期接口

- 扩展原执行许可 RPC 的 `runtime_renewal` 标记，并在响应中回显。运行续期只返回原 Job/epoch 的有效期，不返回 DispatchJob、安装操作或下载凭据；Agent client 严格拒绝用途不匹配、旧 Server 未回显以及混入指令的响应。安装请求不能借此切换用途。
- [派发 outbox](../../../packages/server/src/grpc/job-dispatch-outbox.ts)从原不可变消息恢复归属，允许原 queued/running 作业续期；原 Workflow、Job、Agent、epoch、撤销代次、双方签署期限及当前授权仍须有效，终态或竞争取消不给许可。确认收件后仍可续期，但不重发 Job，也不修改原派发待办的重试时间。
- 运行期授权复用协议、软件策略和 canonical license 的最终事务检查，资源检查不再要求新库存或在线状态。默认队列保留原已解析目标，不因暂无库存重新选择队列。已交付数据仍需原映射/版本、摘要、选定文件及使用授权；此路径不要求源副本持续在线，也不续发已过期的下载地址。实际 Job 数据和授权记录在最终事务中加锁，修改或撤销不能在响应发送边界穿过。
- Sandbox 与受限材料挂载尚缺完整运行契约复查，此接口保留可重试的拒绝门槛，不能给未完成检查的受保护执行签发运行许可。启动/材料派发仍沿原准备与副本就绪检查；运行期许可不能代替新的提交权。

验证：Agent 执行许可 client **33 项**通过；隔离 PostgreSQL 中最终运行续期/Agent RPC **29 项**、默认队列定向 **1 项**通过，包含已确认原 outbox、运行态/离线库存、取消竞争、原 epoch、过期下载地址与有效 use 授权、数据撤权/绑定篡改、跨连接 UPDATE NOWAIT 证明发送边界仍持有数据授权锁，以及运行/安装用途隔离。初次五文件组合回归 **139 项通过、1 项 protobuf 可选字段断言失败**，断言已修正并通过上述定向复查；软件许可、派发数据与执行目标的未受后续改动影响的检查未重复执行。隔离数据库均已停止清理；上述集合有重叠，不累计为独立检查总数。全仓类型检查通过，最后一处默认队列调整后的 Server 复查通过；lint 在调整期间发现一处格式错误，格式化后全仓错误级别检查通过，原有 warnings/info 保留。

这轮完成的是 Server 运行续期及 Agent client，尚未由 Agent 的作业生命周期自动调用。调度器计算任务的持久本地到期、取消和重启恢复，以及独立进程/调度器侧的失联停止仍待接通；不能据此声称运行中的 Slurm/PBS 作业已具备完整本地到期控制。Sandbox 持续授权、长下载、全部已知授权截止时间对许可上限的收敛、实际联合运行及 PR 预览仍待完成，自动激活保护保留。

## 计算作业在 Agent 内的持久续期、到期停止与重启恢复

- [AgentStream](../../../packages/agent/src/stream.ts)在提交边界保存初始许可，随后调用已有的独立运行续期 RPC。复用安装路径的[许可计时器](../../../packages/agent/src/execution-authorization.ts)，同时检查墙钟和单调时间；续期不重派 Job、不重复下载输入，也不连接 Fabric。普通非联邦任务保持原行为。
- [SQLite 收件记录](../../../packages/agent/src/queue/inbound-acks.ts)沿用原 JSON payload，保存原 dispatch epoch 对应的许可截止时间、恢复 owner 和 active/stopping/finished 状态，不新增表、不落盘可复用票据。已确认收件的任务也读取原记录；新进程接管不延长旧期限，过期、已停止续期或历史缺少许可的记录进入停止流程。旧 owner 的续期、取消计时器及终态写入不能覆盖新 owner；旧进程失去归属后停止自身轮询，不取消新进程接管的作业或清理其输入。
- 明确拒绝、无有效续期直至到期、运行中取消和数据撤权均关闭续期，复用原 epoch 的持久撤销、调度器停止确认及清理链路。停止失败保留记录，额外的本地重试不依赖 Server 心跳；仅到期不能冒充已经停止。恢复材料期间若许可已失效或收到撤销，不再接回运行监控。

验证：AgentStream、SQLite 收件记录及共用计时器共 **206 项检查通过**，涵盖续期、无响应到期、明确拒绝、停止失败重试、停止未确认时保留输入、迟到响应与 owner 接管，以及 SQLite 文件关闭重开后的 active/expired/stopping/历史记录。专项重试关闭了短周期心跳，确认由本地计时器继续处理。安装 worker 的 4 项启动许可检查通过；重用计时器期间误改的一处安装专用错误断言已还原并定向复查。全仓类型检查及最终 Agent 类型复查通过，lint 无错误（原有 47 warnings、1 info）。调度器及 Server 使用受控替身，没有启动实际集群任务。

边界：这轮只有 Agent 进程内的运行监督与重启恢复。Agent 被 SIGKILL、宿主机掉电或长时间不恢复时，调度器计算作业仍缺独立守护/调度器侧到期停止，不能声称完整失联控制。跨进程持久截止时间依赖宿主时钟，进程内单调时钟保护不能代替宿主时间管理。旧版 Agent 不识别新收据，不支持在活动联邦作业期间直接降级。完整运行许可能力协商、Sandbox 持续授权、长下载、真实 Slurm/PBS/Fabric 联合验收及实际联邦激活仍待完成；自动激活保护保留，未发布或部署。

## 独立调度器看守与 Agent 进程退出后的计算停止

- 新增[独立可执行入口](../../../packages/agent/src/federation-watchdog.ts)和[看守扫描器](../../../packages/agent/src/queue/federation-runtime-watchdog.ts)，由[独立 systemd unit](../../../deploy/systemd/kq-federation-watchdog.service)监督，与 Agent 服务的进程和停止关系分离。它只读取现有 SQLite、封锁许可和请求停止，不访问 Server/Fabric、不派发任务、不迁移数据库、不清理输入。复用 Slurm/PBS Pro/Torque 的作业查找及正向停止确认，CLI 调用设置上限；未知提交、调度器故障和未停止均保留重试。
- 过期封锁使用原收据的条件更新，与 Agent 续期竞争只有一个获胜。活跃许可按已持久期限监视，未变化的许可不能因墙钟回拨获得更多时间；已及时持久续期不会因为某次调度器查询较慢被当作迟到响应。确认停止后单独保存原调度器 ID 的证明，重启后的 Agent 可以接回取消与清理，避免对已确认停止、可能被调度器回收的 ID 再次发送取消。
- 新提交的调度名称包含 dispatch epoch，并与完整 Job UUID 一起匹配。PBS Pro/Torque 恢复查找补齐名称和账户条件；出现另一代次或不同调度器 ID 时不猜测取消。历史缺少代次名称的记录保持待维护。
- 看守沿用 `agent_config` 保存扫描心跳，提交与运行续期检查其时效与调度器类型。新增 `federation_compute_lease_v1` 注册能力，Server 最终派发和许可 RPC 均拒绝只支持启动检查的旧 Agent；安装继续使用已有的独立安装租约能力。配置与升级方法见[systemd 部署说明](../../../deploy/systemd/README.md#联邦计算的独立看守)。

验证：AgentStream、收件记录、看守、PBS/Torque 和 Dispatcher 的 **338 项检查通过**；隔离 PostgreSQL 中 RPC、数据派发和执行目标 **60 项通过**，包含旧能力拒绝，数据库已停止清理。最终 **2 项编译入口进程测试通过**：实际 AgentStream 进程在独立看守存活时多次续期，随后被 SIGKILL；看守经 Slurm/PBS CLI 替身停止真实轻量 `sleep` 进程，并保留输入清理记录。这些不是实际 Slurm/PBS 集群验收，Server 协议端也是受控替身。首次编译缺少本机可选 `cpu-features` 插件，改用项目发布脚本已有的 external 参数完成；强化进程夹具时一处参数传递错误已修复。全仓类型检查通过，lint 无错误（原有 47 warnings、1 info）；protobuf 通过生成命令更新。

剩余边界：Kubernetes 独立看守、看守自身冻结/宿主故障的停止保障、同宿主不同任务身份的完整隔离、真实调度器与 Fabric 联合验收、Compose/Helm 联邦部署和预览环境尚未完成。不承诺固定停止时限；控制面与调度器均不可用时仍保留待核对。自动激活保护继续保留，没有将此轮结果当作完整联邦交付。

## Kubernetes 独立看守与不可变作业身份

- 联邦 Kubernetes 作业名称和标签包含执行代次，提交使用 `create` 防止覆盖同名任务。API 返回的 UID、命名空间和调度器 ID 先写入收件记录，再保存活动记录；绑定不可更换。Runner、恢复、取消及停止证明均携带原 UID，记录冲突和缺失身份不猜测取消。
- 独立看守已支持 Kubernetes。删除使用 API 的 UID precondition，确认停止同时检查原 UID 的 Pod；Job 已删除或被同名替代时，仍用持久 UID 核对残留 Pod，不重新认领替代对象。停止失败保留重试和输入。
- 修复 Sandbox 多资源 `kubectl create` 输出不能当作单个 JSON 解析的问题，改用只输出资源身份字段的 JSONPath。修复执行器先清理活动记录、取消重试随后误报提交未知的竞态：清理前持久保存已确认的停止证明。

真实验证：本机 k3s 独立临时命名空间中运行受限轻量 `sleep`，独立看守入口在持久许可到期后停止实际 Job；再制造 Job 被删除、原 Pod 被保留、同名新 Job 已创建的情形，验证 UID 条件删除拒绝误删新 Job，原 Pod 未停时拒绝停止证明，原 Pod 清理后确认停止且新 Job 保留。多资源提交也通过真实 API 验证。测试结束后已删除临时命名空间和 SQLite。未运行计算密集型软件。

验证结果：AgentStream、Runner、活动记录、收件记录、独立看守和 Kubernetes/Sandbox 适配器共 **341 项测试通过**，另有 **1 项真实 k3s 集成测试通过**。全仓类型检查及最终 Agent 类型复查通过，lint 无错误（已有 47 warnings、1 info），Agent 独立可执行文件编译通过。

初次实际检查触及 Kubernetes 默认终止宽限期，测试脚本改为显式处理 TERM；回归检查发现的取消记录竞态已修复，未通过增加业务超时掩盖。检查记录见本地 `temp/k8s-watchdog-*.log`，不纳入版本控制。

边界：这是 Kubernetes 作业身份与独立停止机制的实际验证，不是完整联邦任务、Sandbox 隔离或 Fabric 联合验收。看守自身冻结、宿主机掉电、控制面不可达仍无固定停止时限；Compose/Helm 独立监督接线及 PR 预览仍待完成。自动激活保护继续保留。部署前需按 [systemd 说明](../../../deploy/systemd/README.md#联邦计算的独立看守)配置受控 Kubernetes 凭据和权限。

## 容器部署的独立监督与真实 Slurm 停止验证

- [共用启动脚本](../../../deploy/schedulers/common/start-agent.sh)在加载已有注册环境后启动[独立监督脚本](../../../deploy/schedulers/common/supervise-agent.py)。Agent 和看守分别运行在自己的进程组，退出后单独重启；Agent 反复启动失败时，看守保持原进程继续工作。容器退出时发送 TERM，限时回收后清理残留子进程。复用镜像已有 Python 标准库，没有新增运行依赖。
- Slurm/PBS/K3s 入口补齐信号转发；PBS 保留 CI 外层的 EXIT 诊断。scheduler-base 打包监督脚本，因此 Compose 和 Helm 使用同一条启动路径；Helm 准备容器检查镜像是否具备新脚本。启动收紧现有 SQLite/WAL/SHM 到 `0600`，拒绝符号链接、硬链接或其他账号文件，保留数据；K3s kubeconfig 改为 `0600`。
- 实际旧版 Slurm 暴露 `squeue --me` 不兼容，现改为通过同一个 Spawner 查询调度器端 UID，再用 `--user`，容器内外账号不同也不扩大查询范围。任务退出队列后，未启用 accounting 的集群补查 `scontrol` 保留记录，仍同时核对 UUID、代次名称和用户/账户；其他任务不能充当停止证明。记录已被调度器清除且无会计历史时继续保留待核对。

实际验证：在本机 k3s 的独立临时命名空间复用已缓存 Slurm 镜像，挂载本分支启动脚本和代码，启动真实 slurmctld/slurmd、Agent 和看守。提交受限 `sleep` 作业并 SIGKILL Agent，独立看守在持久许可到期后取消作业；原生记录为 CANCELLED，具有实际运行时间，SQLite 保存停止证明。测试未连接 Server/Fabric；收据由测试写入，因此不是完整联邦派发验收。测试结束已删除命名空间。

编译入口进程测试同时覆盖 Slurm/PBS CLI 替身：实际 AgentStream 多次续期后 SIGKILL，监督脚本模拟 Agent 持续重启失败，看守 PID 保持不变并停止真实轻量进程。该结果不等于真实 PBS 验收。独立生命周期测试覆盖单独重启、注册环境继承、私有状态权限、链接拒绝和终止回收；Helm 渲染覆盖实际模板，未部署完整 Chart。

验证结果：相关单元/部署检查 **121 项通过**，Helm 实际渲染 **38 项通过**，编译入口进程检查 **2 项通过**，另完成上述真实 Slurm 验证。全仓类型检查、最终 Agent 类型复查、Python/Shell 语法检查和 Agent 编译通过；lint 无错误（已有 47 warnings、1 info）。本地证据保存在 `temp/scheduler-*.log`。

边界：容器内的两组进程仍共享容器和宿主机；看守本身冻结、容器被移除或宿主机故障没有固定停止时限。本轮仅接通独立监督部署，完整多机构 Compose/Helm 配置、授权/实际激活、Fabric 联合验收与 PR 预览仍待完成，未解除自动激活保护。部署操作见[部署说明](../../deployment.md#初始化与持久化)。

## Sandbox 运行中的原身份与撤权观察

- [Sandbox 授权检查](../../../packages/server/src/federation/sandbox-authorization.ts)已接入现有联邦运行监视器，复查保存的 Script 来源、原派发的运行时镜像、执行账号及有效策略。脚本撤销/归档、使用授权撤回、账号禁用/变更、映射到期/撤销、运行时撤销/镜像变化、契约绑定撤销、SharedService 证明到期/撤销或有效策略收紧会触发原有持久取消流程。保持待停止状态，不能把发出取消等同于调度器已停止。
- 复用 [Sandbox resolver](../../../packages/server/src/services/sandbox-execution-resolver.ts)，增加明确授权失败类型；数据库或后端暂时故障继续重试，不转成永久撤权。脚本授权限于原绑定机构，不能借用用户在其他机构的授权；撤销/归档也不能被所有者身份绕过。执行账号同时核对 Agent 和提供方。
- 已运行任务按原派发账号检查，修改默认账号不会切换任务身份，也不能用新账号绕过原映射撤销；Unix UID/GID/账户以及 Kubernetes namespace/serviceAccount 等事实与原消息比较。复用派发端的身份编码，避免两套字段转换。Job 和 outbox 在同一查询快照读取，避免放置过程的旧代次与新 outbox 混读。
- 队列或材料准备暂时失败不遮蔽独立的脚本撤权检查。隔离 PostgreSQL 中已验证明确撤权进入 `FEDERATION_AUTHORIZATION_REVOKED` 持久取消，并继续等待停止回执；此处没有调用 Fabric。

验证：新增授权检查 **20 项通过**；同轮 Dispatcher、Sandbox 执行/恢复和联邦监视器等相关回归 **120 项通过**。最初运行契约用例同时填写互斥的 profile/contract 字段，夹具已修正并通过定向重测。全仓类型检查及最终 Server 类型复查通过，lint 无错误（原有 47 warnings、1 info），新增文档链接静态检查通过。隔离数据库已停止清理；本地日志为 `temp/sandbox-monitor-*.log`，不纳入版本控制。仅使用隔离数据库和受控派发消息，没有运行科研计算、真实 Sandbox 或远端集群任务。

边界：本轮是运行监视与撤权观察，不是完整的受保护许可签发。Sandbox/受限材料的最终事务并发封锁、全部已知授权期限对许可上限的收敛、SelfAccount 执行证明、受限材料挂载、逐文件授权与签名续签仍待补齐；原运行续期拒绝门槛及自动激活保护均保留，PR 预览尚未发布。

## 受限材料的原映射续期与许可证期限

- [材料授权检查](../../../packages/server/src/federation/licensed-material-authorization.ts)连接到计算派发/续期的最终事务及独立运行监视器。复查原 Job、代次、提供方/Agent、声明的 selector/挂载位置/元素、材料状态和指纹，并复用现有 canonical license 规则检查提供方及使用方权限。明确撤销进入原有持久取消；队列授权暂时失败不会遮蔽材料撤权。
- 派发材料补充 `mapping_id`、`asset_id` 和 `license_subject`，绑定原授权身份。相同文件指纹不能通过换绑到另一资产或宽松许可证续期。字段属于内部授权元数据，不是凭据；旧联邦 outbox 缺失这些字段时拒绝续期，须按当前策略重新准备任务，不能现场给旧执行补认授权。protobuf 已通过生成命令更新；普通非联邦任务仍兼容原字段。
- 材料映射、关联资产、canonical license 来源及 entitlement 在签发事务中加锁，发送许可后才释放。映射写入者已持锁时立即重试，不等对方反向获取 Job 锁。材料 `revokedAt` 和关联资产撤销/归档也参与拒绝；运行续期不重新挂载、不重发计算指令。
- [许可证治理](../../../packages/server/src/services/license-runtime-governance.ts)同时返回拒绝原因与授权期限：同一权限范围内取有效替代授权的最晚截止时间，必须同时满足的提供方/使用方范围取最早截止时间。被撤销、已过期或其他主体的记录不能延长期限。计算许可及安装许可取该期限、10 秒窗口、签署执行期限和协议有效期的最小值；已到期不发许可。

验证：服务端/隔离 PostgreSQL 相关检查 **182 项通过**，Agent 材料解析与 Stream 回归 **193 项通过**；同指纹换绑到另一份有效宽松许可证的用例另经定向复查通过，不重复累计。实际续期响应验证 5 秒许可证上限、已到期不签发、安装许可上限、撤权/改指纹拒绝、映射写锁竞争及原材料撤权持久取消。首次检查的异步断言夹具已修正；安装续期用例补齐独立素材映射，支持单独运行。全仓类型检查和 lint 通过（原有 47 warnings、1 info）。隔离数据库已停止清理，日志保存在本地 `temp/material-permit-*.log`。这些检查使用实际 Server 授权/续期代码、跨连接数据库锁探针与 Agent 测试替身；没有运行真实受限科学软件或远端集群任务。

边界：已解除仅因本地受限材料挂载而拒绝续期的门槛；Sandbox 仍保持拒绝门槛，其最终签发并发封锁、执行证明、逐文件授权和签名续签待补齐。数据 use grant 等其他已知授权期限尚需统一收敛；跨机构材料物化、真实受限挂载/停止联合验收、完整联邦自动激活及 PR 预览仍未完成。

## Sandbox 运行许可的最终授权事务

- Sandbox 计算派发及运行续期复用同一授权检查，在发送许可的最终事务中核对并锁定原脚本/版本、机构使用授权、原账号映射、运行时/契约绑定、SharedService 证明、Agent 执行能力和有效策略。Job 保存的签名 manifest 与原 outbox 完整比较，并核对双签环境锁中的镜像类型和摘要；续期不切换身份、替换运行时或重发计算指令。
- 许可截止时间进一步受账号映射、SharedService 证明和 SelfAccount 原运行时证明期限约束。SelfAccount 必须继续匹配原 Slurm Unix 账号及已验证证明；其他镜像的无关缓存条目不影响当前证明。受限 Unix 作业核对原可信执行 profile，包括 wrapper 和 SIF 指纹。
- 对可新增的策略 overlay 和更具体运行时绑定，最终事务使用短期表读锁，避免仅锁已有行漏掉并发插入；使用 NOWAIT 将写锁竞争转为稍后重试。没有在事务内等待网络服务，也未改变数据库结构。
- NetDrive 输入按原签名挂载清单逐文件核对归属、删除状态、摘要和大小，并保留文件行锁。运行中的 DataMarket 输入核对原绑定及不可变版本的路径/摘要/大小；已完成下载无需源位置继续在线，也不因原下载租约过期而重新下载。使用授权仍由现有数据授权检查负责，撤回后不能续期。
- 已解除 Sandbox 运行续期的总拒绝门槛。启动签名期限仍约束首次执行许可；已运行任务按原派发身份重验当前授权后续期，不因旧启动签名过期而被误停。尚未实现启动签名续签和长下载续租，不能据此解除整体自动激活保护。
- 修正放置过程的误撤权竞态：Job 已排队但 outbox 尚未保存时，Sandbox/受限材料检查等待重试；原脚本或材料明确撤权仍被识别，已运行 Job 缺失原派发记录仍拒绝。

验证：服务端、隔离 PostgreSQL 与 Dispatcher 组合 **183 项通过**；补充竞态和无关缓存修复后，Sandbox/软件授权定向回归 **64 项通过**（包含前一组合的重复用例，不相加计数）。Agent Stream 与签名验证 **192 项通过**。包含真实 Server 续期响应、已过期启动签名、5 秒映射期限、账号/策略撤权、manifest 不一致和环境锁替换拒绝，以及跨连接数据库锁探针。全仓类型检查通过，lint 无错误（原有 47 warnings、1 info），文档本地链接静态检查通过。隔离数据库均已停止清理；本地日志为 `temp/sandbox-fence-pg.log`、`temp/sandbox-final-*.log`，不纳入版本控制。

边界：上述使用隔离数据库、真实授权/续期代码和 Agent 测试替身，未运行真实 Sandbox/Fabric 联合任务或科研计算，未推送或部署 PR 预览。数据 use grant 等其他已知授权期限仍需统一约束许可上限；启动签名续签、长材料下载续租、跨机构材料物化、完整自动激活和联合验收继续待完成。

## 数据使用授权期限约束运行许可

- [数据权限决策](../../../packages/server/src/services/data-access-decision.ts)在原布尔判断之上返回当前授权的有效截止时间，旧调用仍复用同一判断。只统计当前主体/机构、版本及 use 能力匹配、已生效且未撤销的 grant/allow policy；显式有效 deny 优先，多份可替代授权取最晚截止，无期限授权保持无限上限。未来生效、无关主体/版本及仅 view 的授权不能延长运行许可。
- [数据前置仓库](../../../packages/server/src/services/data-prerequisite-repository-drizzle.ts)保留公开开放数据、用户/机构所有者的原访问规则；私有非所有者仍拒绝，licensed-material entitlement 仍要求实际有效授权，不能借所有者身份绕过。对外的 boolean API 保持不变，授权过期状态与权限投影仍使用调用方事务。
- 联邦计算的最终派发和续期事务均从原 Job 数据绑定取得截止时间，多份必要数据取最早截止，再与已有协议、软件许可证、Sandbox 身份/证明和 10 秒许可窗口取最小值；过期不发许可。复用既有数据行锁及父行锁，不能在发送前插入或修改更严格授权后仍使用旧判断。运行中的检查不续发下载链接，不要求源端在线，不依赖 Fabric。

验证：相关 Server/隔离 PostgreSQL 组合首次 **116 项通过、3 项失败**；失败均为新增夹具遗漏 ready 版本的不可变字段或所有者类型，补齐后 **3 项定向复查通过**。另有 **1 项**原有授权过期/投影事务回滚测试通过，共 **120 个不同用例通过**。验证了真实 Server 续期响应的 5 秒数据授权上限和到期拒绝，首次计算的最终事务上限、多个数据集取最早到期、替代授权与 deny 优先，以及锁竞争。全仓类型检查、夹具修正后的 Server 类型复查及文档链接静态检查通过；lint 无错误（原有 47 warnings、1 info）。隔离数据库均已停止清理，本地证据为 `temp/data-permit-*.log`，不纳入版本控制。

边界：这是数据使用权对许可上限的约束，不是长时间下载中途刷新传输凭据的实现；未改动 Agent 协议，没有重复执行上一轮 Agent 测试。真实跨机构任务、Sandbox 启动签名续签、长材料下载续租、自动激活和 PR 预览仍待完成。

## Sandbox 启动签名续签与恢复指纹

- 联邦 Sandbox 初始派发、补投和启动许可现在在最终授权事务通过后，用现有 Server 签名器为原 manifest 签发新 nonce/期限；随后重新核对派发意图并检查签名新鲜度，才允许入队或响应。原 Job manifest、outbox 和代次保持不变，实际脚本/账号/镜像/挂载/资源限制不能被续签替换。运行中续期仍不生成签名、不重发计算指令。
- 修正 Agent 准备路径使用旧签名的问题，现将授权响应中的 manifest 交给既有 Sandbox 验证器。共享意图比较仅允许原有联邦 Sandbox envelope 的凭据字段更新，manifest 摘要及完整执行内容仍参与比较；普通任务仍保持原规则。
- 原持久收据增加可选 `renewableSandboxSignature` 标记，保持 version 1，避免独立看守旧进程因版本变化拒绝读取停止记录。新收据固定签名内容，恢复时允许更换凭据；旧收据缺失标记仍按原完整指纹核对，不能现场放宽。旧 Sandbox 准备记录遇到续签不自动接管，需按原停止/清理流程核对后重新准备；普通旧任务和已开始执行的停止监督保持原路径。
- 注册能力增加 `federation_sandbox_signature_renewal_v1`，Server 拒绝向未声明能力或无已验证传输身份的 Agent 初始派发联邦 Sandbox。暂时不具备能力时保留待办并退避，避免反复占据补投队首；运行中旧任务仍按原运行许可规则处理。新 Agent 仅在持久联邦能力和 Sandbox processor 均具备时声明该能力，protobuf 通过生成命令更新。
- 数据传输凭据检查不再提前拒绝旧 Sandbox 签名，签名刷新及最终期限检查集中在派发边界；当前有效账号、数据和许可证等仍约束短期启动许可，续签不授予额外执行时间，也不依赖 Fabric。

验证：Server/隔离 PostgreSQL 与 Dispatcher **141 项通过**，其中启动过期签名、重复请求的新 nonce、原记录不变、Ed25519 签名真实性、撤权不签名、缺少签名器、旧能力及内容替换拒绝均已检查；退避调整后 Sandbox 授权 **11 项定向复查通过**（不重复累计）。协议/恢复指纹/许可客户端/数据凭据 **56 项通过**。Agent Stream 首轮 **193 项通过、1 项新夹具失败**，修正 protobuf 嵌套消息构造后新增 **2 项定向复查通过**；兼容看守的最终 Agent Stream/恢复指纹/独立看守回归 **204 项通过**。全仓类型检查首次仅因同一夹具报错，修正后 Agent/Server 复查及 Fabric 测试类型检查通过，其余组件已通过；最终 lint 无错误（原有 47 warnings、1 info），文档本地链接检查通过。隔离数据库已停止清理，本地证据在 `temp/sandbox-signature-*.log`。

边界：使用真实签名器和 Server 授权/续期代码、隔离 PostgreSQL、Agent 测试替身；未启动真实 Sandbox/科研任务，也未验证真实跨机构完整运行。长期下载中的凭据续租、整体自动激活、真实多机构/Fabric 联合验收与 PR 预览仍未完成。旧 Sandbox 准备收据的安全重准备仍需运维核对，不能用新签名直接绕过旧指纹。

## Sandbox 下载准备的持续授权与中断恢复

- Sandbox 准备复用现有短期执行许可守护，在下载期间持续续租。Server 暂时不可达时允许当前许可用完；到期立即取消 HTTP 读取并清理未完成文件，重新获得有效许可后从头准备。明确拒绝、任务取消和内容校验失败不按断线恢复重试；中断原因穿过异步 AbortError 后仍保留。
- 每个外部输入下载前后读取最近授权响应中的传输凭据，保留原 stagePath、签署摘要和大小校验。续租不得变更任务内容、将有租约输入降级为无租约输入，或替换普通固定 URL。正在进行的 HTTP 连接通过持续有效的执行许可控制；新文件或重试使用最新凭据，不在连接中途替换 URL。
- 重新准备先验签，再清理原准备目录；首次运行目录尚不存在时清理为空操作。中断后清理整份准备目录，避免残留输入、脚本及独占输出文件影响恢复。既有派发收据、活动作业检查和提交边界继续负责防止重复执行，不能把重新准备当成接管已运行作业。
- 新增 Agent 注册能力 `federation_sandbox_input_lease_v1`。Server 初始派发、补投及启动授权均要求有外部 Sandbox 输入的联邦任务具备该能力；旧 Agent 暂时保留待办并退避，不把不能中止下载的 Agent 当成兼容。已运行作业和非联邦派发沿用原路径，protobuf 使用生成命令更新。

验证：Agent Stream、Sandbox、许可守护和 Dispatcher 组合首轮 **285 项通过、2 项失败**；两项失败是原 SelfAccount 证明测试在 root 主机上使用了 UID 0，改为普通账号及相应测试目录归属后 **2 项定向复查通过**，共 **287 个不同用例通过**。补强最新输入凭据路由后的 **3 项 Stream 定向复查通过**，不重复累计；隔离 PostgreSQL 中旧 Agent 启动授权门槛 **1 项通过**，未签发许可或签名。包含本机慢速 HTTP 流、中途到期/撤权/取消、文件残留清理、真实 Ed25519 验签先于目录清理，以及断线恢复后重新准备。全仓类型检查首次发现新增 Server 夹具缺少 fileMetadataId，补齐后 Server 类型复查通过；其余组件、最终 Agent 类型复查及 Fabric 测试类型检查均通过。最终 lint 无错误（原有 47 warnings、1 info），本地文档链接检查通过。检查未启动真实 Sandbox、科研计算或远端集群任务。隔离数据库已停止清理，日志保存在本地 `temp/sandbox-input-*.log`。

边界：本轮仅覆盖 Sandbox 输入准备。普通 DataMarket 下载和 Spack 材料下载尚未接通完整的持续传输授权/票据续租；NetDrive 普通 URL 不自动重签。中断文件从头下载，未实现 Range 断点续传。真实跨机构执行、整体自动激活、多机构/Fabric 联合验收及 PR 预览仍未完成。

## DataMarket 下载与本地材料准备的持续授权

- 普通联邦作业的 DataMarket 准备与 Sandbox 共用短期许可守护：准备期间持续续租，逐文件从最近授权响应读取原绑定的新凭据；保持资产/版本、选中文件、摘要、大小、目标位置等不可变意图。Server 原有许可上限已包含数据传输租约到期时间，不能用计算许可延长过期传输凭据。
- HTTP 读取、本地文件复制及摘要校验接受同一取消信号。许可到期中止读取、关闭流并删除未完成文件；取得新授权后重新准备。明确拒绝、任务撤销或内容不匹配不按断线重试。本地复制使用可取消的标准流；原入口已逐项限定普通文件，移除了无法通过该入口调用的目录递归复制分支。
- 已成功准备但在返回边界失去授权的结果也会清理，清理完成后才重新等待许可；清理失败不继续准备或提交。准备中途失败的残留进入原清理列表，只有清理成功才删除记录；卸载失败、权限错误或无法确认挂载消失时保留待清理状态。Linux umount 报错后仅接受 util-linux mountpoint 明确返回未挂载，不把其他错误当成功；调度器基础镜像显式安装 util-linux，独立宿主部署也需要该命令。既有持久清理意图和运行中撤权流程保留。只读挂载在调用前复查取消，若调用期间中断则在有界命令返回后清理，不把挂载命令本身描述为可瞬时中断。
- 新能力 `federation_data_preparation_lease_v1` 接入 Agent 注册、Server 初始派发/补投及启动授权。缺少能力的 Agent 保留待办并退避；已有运行许可不要求新增准备能力，非联邦任务保持原兼容行为。

验证：Agent Stream、DataDelivery、Sandbox processor 与 Dispatcher **246 项通过**；隔离 PostgreSQL 的运行续期/数据授权/旧 Agent 准备门槛 **16 项通过**。包含本机慢速 HTTP 下载、断线恢复、撤权停止、最新下载凭据路由、刚完成即失去授权的清理，以及原已运行任务继续续期而不重新下载。补充清理重试后 DataDelivery **20 项通过**，其中 **4 项为新增用例**，其余不重复累计；验证挂载清理连续失败后仍可继续重试，以及卸载后只有明确未挂载才算成功。首轮新增 Stream 测试缺少枚举 import，已修复并包含在最终组合中。全仓类型检查、清理修复后的最终 Agent 类型复查通过；lint 无错误（原有 47 warnings、1 info），文档本地链接及 diff 检查通过。隔离数据库已停止清理；本地证据为 `temp/data-preparation-*.log`。

边界：本轮覆盖 Sandbox 与 DataMarket 准备，不包含 Spack 材料票据刷新、普通 Workflow 的 NetDrive inputStaging 持续授权或 URL 重签；中断文件仍从头下载。没有重建调度器镜像，也没有运行真实科研软件、跨机构完整作业或 Fabric 联合任务，整体自动激活与 PR 预览仍待完成。

## 尚未接通，不能宣称支持

协议审批与机构信任管理 UI、源站发送与状态查询、额度结算/退款、联邦目标/数据最终授权与实际激活连接、完整生产持久 Workflow 端到端验收、完整的数据/软件物化与介质交付、双方证据确认与完整用量/结算记录、商业/市场链码及真实联邦作业与 Fabric 联合运行、归档恢复、Web/CLI 和部署配置均未完成。

接下来为已原子绑定的联邦 Workflow 接通环境/资源授权和实际 Job 派发，复用已有 Script 原子绑定、准备恢复与原操作补投，完成真实执行不被链故障阻塞的联合验证。同时仍须补全用例内部标识与受管文件转换、native lock/Agent 检查，将本地输入连接到既有授权执行路径，并接通联邦任务/工作流映射与派发待办消费；只有本地资源、数据和软件授权及 Job 映射完整后，预留才能进入执行。完整交付仍须通过所有端到端验收，不将本轮基础模块单独宣传成可用联邦平台。
