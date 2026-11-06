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

直接模式保存双方签名证据，不创建存证待办，也没有 Fabric 依赖或连接。异步模式将证据与 pending outbox 在同一个数据库事务写入；目前尚无存证发送 worker。链上协调模式的 schema 已定义，但本接单模块明确返回 `LEDGER_REQUIRED`，不能借该接口降级执行。

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

## 尚未接通，不能宣称支持

协议审批与机构信任管理 UI、源站发送与状态查询、额度结算/退款、联邦准备到实际派发的连接、生产持久 Workflow 恢复、完整的数据/软件物化与介质交付、完整证据序列与批次、Fabric Adapter/链码及上链 worker、归档恢复、Web/CLI 和部署配置均未完成。

下一项依赖是补全用例内部标识与受管文件转换、native lock/Agent 检查，再将本地输入连接到既有授权执行路径，并接通联邦任务/工作流映射与派发待办消费；只有本地资源、数据和软件授权及 Job 映射完整后，预留才能进入执行。完整交付仍须通过所有端到端验收，不将本轮基础模块单独宣传成可用联邦平台。
