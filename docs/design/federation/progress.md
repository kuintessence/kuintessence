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

## Spack 材料下载票据刷新与原操作恢复

- 安装续租响应中的新 operation ticket 已传到材料下载器。下载器在同一 operationId、spec、Spack 版本及 manifest 摘要下持续持有短期许可；每个新请求使用最近的有效票据，原请求/安装操作不改写。原 FederationExecutionClient 继续核对完整安装意图，票据刷新不能替换安装内容。
- 材料传输与缓存校验复用现有 ExecutionAuthorization。许可到期取消传输、移除未完成文件并抛出已有 SpackInstallationPending；SpackManager 保留该状态，Stream 使用原持久账本记录授权等待，释放队列后按原操作重投。明确拒绝、非法新票据、取消及内容失败不按断线重试；缓存复用仍须获得当前授权并重新校验，不因有缓存跳过 manifest 请求。
- 修正长传输被固定单请求时限误截断的问题：60 秒改为请求/响应无进度超时，非空 chunk 才刷新时限；原 10 分钟准备总上限继续生效。每个未完成 blob 重下，已验证缓存可复用，没有引入 Range 或无限时下载。
- 新能力 federation_installation_material_lease_v1 接入 Agent 注册、Server 能力响应、安装投递与授权 RPC/服务。旧 Agent 不能接收或续期联邦安装；已有旧联邦 worker 失去许可后由原守护停止，需升级 Agent 后遵守原操作恢复规则。非联邦安装继续使用原模式。详情见[材料下载说明](../../spack-material-delivery.md)。

验证：材料客户端/Manager/Dispatcher **99 项通过**；Agent Stream、授权客户端及材料 preflight **248 项通过**；隔离 PostgreSQL 的安装授权、RPC 能力、原操作恢复与准备重投 **43 项通过**。无进度超时调整后材料客户端 **54 项通过**，其中 **1 项为新增用例**，其余不重复累计。包含本机慢速 HTTP、下载中持续续租、后续请求的新票据、授权失联后的清理和原操作恢复、明确拒绝/非法票据不重试、缓存授权检查、缺少新能力拒绝签发，以及迟到授权/取消/协议截止边界。全仓类型检查、最终 Agent 类型复查通过；lint 无错误（原有 47 warnings、1 info），本地文档链接与 diff 检查通过。隔离数据库已停止清理，本地日志为 `temp/spack-transfer-*.log`。

边界：没有运行真实 Spack 编译或新调度器/Fabric 联合任务。普通 Workflow NetDrive 输入的持续授权、跨机构材料物化与物理介质交付、整体自动激活和完整联合验收继续待完成；PR 预览尚未发布。单次准备仍有 10 分钟上限，超出时限与普通网络故障不自动当作授权等待。

## NetDrive 输入持续授权与链接续签

- 普通联邦 Workflow 输入首次派发固定文件 ID、SHA-256、大小及规范相对路径，下载 URL 与租约可以刷新，原 outbox、代次和派发意图不改写。恢复指纹继续保留新增快照字段；旧无快照派发不能现场补字段后自动接管，需按原停止/清理规则重新准备。
- Server 初次放置对联邦输入生成链接，不再先用普通文件传输器写入用户工作目录。补投和准备期续租从原文件行重新签发 60 秒 URL，不重复记下载额度；最终事务重新核对所属用户、删除状态、摘要和大小并锁定文件。签名期间文件存储位置变化则重试，避免发送旧对象位置的链接。运行中仅检查原文件授权和内容，不要求下载 URL 继续有效，也不重新下载文件。
- Agent 复用现有 DataDeliveryExecutor 与持续许可守护，普通 NetDrive 输入落入 Agent 受管 Job 根目录，即使原任务填写了其他 workingDir 也使用该目录执行。根目录和子目录文件均按摘要/大小校验并登记原有持久清理意图。许可失联至到期后取消、清理并等待新授权；明确拒绝、内容错误不按失联恢复。Sandbox 仍使用原签名挂载准备流程，并识别新 NetDrive 租约标记。
- 新增能力 federation_netdrive_input_lease_v1；首次派发、补投与启动许可要求该能力，旧 Agent 保留待办并退避。已运行作业沿用运行许可，不要求新增下载准备能力。非联邦输入沿用原流程；protobuf 通过生成命令更新，无数据库结构变更。

验证：Agent Stream、DataDelivery、协议意图与 Dispatcher 原组合 **264 项通过**；NetDrive 转换/路径检查 **15 项通过**，随后新增的成功提交与受管工作目录 **1 项通过**（同次复查的旧用例不重复计数）。隔离 PostgreSQL 的 NetDrive、DataDispatch、Sandbox 授权 **72 个不同用例通过**；Placement **23 项通过**。覆盖本机实际字节下载及校验、长下载续租、断线恢复、明确拒绝、完成边界清理、原 outbox 不变、旧 Agent 暂缓派发、运行中删除/换内容/换所有者拒绝和跨连接行锁。首轮测试配置与夹具问题已修正并定向复查：Placement 起初未注入临时库而连接被拒；新增用例名称序列化 BigInt 报错；旧 DataMarket 夹具缺少准备能力；Placement 参数断言遗漏 federation 标记。未使用部署数据库。补投测试使用真实 outbox/刷新服务，执行授权回调为定向测试替身；没有据此声称完成真实跨机构授权端到端验收。全仓类型检查及后续 Agent/Server 类型复查通过；最终 lint 无错误（原有 47 warnings、1 info），本地文档链接与 diff 检查通过。临时 PostgreSQL 均已停止并清理。

边界：联邦 NetDrive 仅接受本地执行身份拥有的文件，共享文件 ACL 与跨机构文件副本/授权映射仍待接通；普通非联邦共享文件行为不变。中断从头下载，没有 Range。未启动真实科研软件、远端任务或 Fabric 联合作业，未推送或部署 PR 预览。整体自动激活、跨机构材料物化及完整联合验收继续待完成。本地验证日志为 `temp/netdrive-*.log`，不纳入版本控制。

## 联邦工作流自动入队与授权恢复

- 准备 worker 现在可以把已经解析并绑定的双边请求交给专用入队路径；已存在的 submitted 运行也会被恢复扫描拾取。先复用平台的 Workflow owner/机构权限登记，再在事务内重新核对原协议、签名、受限身份、材料映射和不可变快照，将原运行从 submitted 改为 queued。并发扫描只允许一次状态变化，终态和取消中的运行不复活，不新增额度预留或运行记录。
- 运行器原先对所有联邦运行的总拒绝改为必需的授权回调；仍要求 durable-v2 执行租约。首次执行和 Server 恢复都复用 FederationDispatchAuthorization，在租约事务内复查；缺少回调不能启动，授权组件暂未就绪和服务失联保留原运行待恢复，明确拒绝进入既有停止/失败收尾流程。每个具体计算/安装 Job 下发及续期仍执行原来的目标、软件、数据、期限和 Agent 能力检查，工作流入队不替代这些检查。
- 直接和异步存证模式的这条执行路径不访问 Fabric。ledger_coordinated 继续在现有协议策略检查中拒绝无账本许可的执行，没有通过删除总保护绕过链上模式。生产初始化将授权对象声明提前，恢复扫描遇到尚未完成初始化的对象会等待，不触发暂时性引用错误。
- 已绑定运行的临时激活失败遵循原 30 秒准备重试间隔，避免固定占用扫描队首；不直接调用调度器。Workflow 原恢复扫描继续消费 queued 运行，完成节点使用同一持久 journal，不另建工作流引擎。

验证：异步运行器 **19 项通过**；隔离 PostgreSQL 的入队/授权事务/准备 worker/恢复 **14 个不同用例通过**。包含五次并发入队仅一次成功、授权检查后到入队前撤权、旧总保护仍拒绝缺失授权回调的运行、重建运行器后等待原授权恢复，以及节点已完成但结果发布中断后的 journal 恢复（节点只执行一次）。使用真实准备/授权/入队服务、WorkflowAsyncRunner、共享工作流引擎及 PostgreSQL，Script 执行回调为测试替身；没有运行真实 Agent 或调度器任务。修正了依赖其他测试先登记映射的夹具，使定向 fixture 自己登记原映射；撤权断言对齐既有中断收尾的 failed 状态。已通过的用例未整体重复执行。全仓类型检查及最终 Server 类型复查通过；lint 无错误（原有 47 warnings、1 info），文档本地链接与 diff 检查通过。临时 PostgreSQL 已停止并清理。

边界：本轮接通现有接收端本地映射路径，源站发送与状态、跨机构字节物化/物理介质、商业/市场账本、归档恢复、UI/CLI 和完整多机构验收仍未完成。没有推送、合并或部署 PR 预览。日志为本地 `temp/federation-activation-*.log`，不纳入版本控制。

## 真实接单联调与运行状态查询

在本机独立 k3s namespace 中复用 Slurm 镜像并挂载本分支源码，启动完整 Server、临时 PostgreSQL、生产 Agent 与 Node 机构 mTLS 网关。证书、机构签名密钥和测试用户独立生成；调度器 Pod 限制 1 CPU/768 MiB。没有连接部署数据库或改动腾讯云、main、现有预览环境。

- **真实传输与调度基线**：通过生产注册服务和 CLI 注册 Agent，以直接 mTLS 连接完整 Server；HTTP 提交轻量 `printf` 原生任务，Slurm 实际返回 schedulerJobId `2`，平台状态 completed。它是原生任务基线，不是联邦 Workflow 或科学软件验收。
- **真实接单与自动启动**：接收方登记本地脚本映射、签署协议并附加源机构签名；源端探针经真实 Node TLS 网关发送 JWS，完整 Server 接单。重复发送返回完全相同的原回执，只生成一个预留、一个绑定和一个 Workflow。后台自动入队、恢复扫描及共享引擎均实际运行，没有手工将 Workflow 改成 queued。未配置 Fabric。
- **缺少执行环境的拒绝**：实验未启用 Sandbox，也没有伪造已验证的 SIF/运行时能力。Script 以 WORKFLOW_NODE_FAILED 结束，执行身份没有产生任何 Job。此结果只证明未配置时没有绕过执行保护；尚未验证启用 Sandbox 后的真实联邦脚本、原生依赖锁或软件安装。
- **修复状态查询缺口**：[接单查询](../../../packages/server/src/federation/agreements.ts)现在连接原有 Workflow 绑定，返回 `workflow.runId/status/errorCode/updatedAt`，未绑定时为 null。材料 resolved 与 Workflow failed 可以同时正确显示，避免把材料就绪当作运行成功。保持协议读取能力、当前机构范围、分页；不返回 YAML、输入、结果或原始错误文本。它仍是接收方本地接口，不是源站状态回传。

验证：新增隔离 PostgreSQL 用例 **1 项通过**，覆盖未绑定、已绑定、真实 registry 写入失败、分页、跨机构拒绝和撤权拒绝，并检查返回字段不包含执行内容。完整 Server HTTP 联调验证状态查询确实返回 resolved + failed，且重复签名交付没有新增预留/运行。初次实验中的只读 Agent 数据库路径、首次队列上报等待、未登记队列和登录时尚无机构成员关系均已修正为正式配置/会话流程；未因此放宽产品权限。新增测试首轮格式问题修正后 lint 无错误（原有 47 warnings、1 info）；全仓 typecheck 及 Fabric 测试类型检查通过。临时 Server、数据库、网关、namespace 与凭据已清理。

本机记录位于 `temp/federation-live/`、`temp/federation-reservation-status.log`、`temp/federation-status-{lint,typecheck}.log`，均不纳入版本控制。尚未推送、合并或部署 PR 预览；下一项需要配置真实受信任运行时后，验证联邦 Script 的实际派发、执行与结果，而不是重复原生任务基线。

## 真实 Kubernetes 联邦脚本与接线修复

沿上一轮完整 Server 联调继续测试，修复两个真实路径中暴露的接线缺口：

- CLI `agent register --scheduler` 原来只影响登记请求，生成的 env 不含调度器选择，Agent 启动又自动探测。混合客户端环境会注册 Kubernetes 却运行 Slurm。现在 CLI 保存类型/版本，Agent 与独立联邦看守均使用同一配置；旧未设置配置保持自动探测。复用现有 detectScheduler 的强制类型入口，没有替换调度器 CLI 或测试伪装。
- 自动联邦入队原来遗漏普通提交时的资源规划，已启用 Sandbox 的 Script 仍因缺少 planned Agent 失败。现在准备 worker 入队回调先调用原 PlacementPlanService；规划器读取原联邦绑定，只允许双签目标的机构/集群/Agent 和环境锁中的镜像类型/摘要。原具体派发、执行身份与运行续期检查保持有效。

完整联调使用独立 namespace、临时 PostgreSQL、完整 Server、真实 Node mTLS 网关、生产 Agent 与独立 Python supervisor/watchdog。Agent 只有该测试 namespace 的作业管理、执行账号读取和集群节点只读权限，业务 Pod 不挂载 API token。运行镜像使用本机缓存的固定 OCI digest，由实验管理员对核实的 manifest digest 签名并验签；它不是对第三方发布者签名的认证。原脚本、机构协议和委派固定摘要，重复请求保持同一回执、预留与运行。

**实际成功记录**：Job `b0cb8bb3-05c9-45a0-b617-5261460479f3`，Kubernetes Job `kq-b0cb8bb3-05c9-45a0-b617-5261460479f3-1`，Workflow `451acb46-60a6-4363-a782-dbb44f4b9527`。Pod 退出码 0，平台 Job/Workflow 和接单查询均为 completed。真实 stdout 为 `federation-sandbox-ok:42`；脚本实际检查非 root UID、NoNewPrivs=1、Seccomp=2、外网 TCP 建连失败及 `6 * 7 = 42`。保存的 Pod 规格显示只读根目录、丢弃全部 capabilities、Localhost seccomp、1 CPU/128 MiB 限制。全程未配置 Fabric，没有跳过短期许可或独立看守门槛。

初始实验缺少执行账号读取 RBAC、未启动看守，以及测试 Agent 预留 100m CPU 导致总预留超出节点 10m，均在独立实验配置中修正；最终 Agent 仅预留 10m CPU，作业仍为 1 CPU，现有预览服务未调整。一次首次节点健康上报尚未就绪也触发了原拒绝路径；这不被计为成功执行。

验证：Agent 配置、调度器选择和 CLI 注册组合 **70 项通过**；新增隔离 PostgreSQL 规划用例 **1 项通过**，覆盖协议外 Agent、归属变化和本地合法绑定但摘要与签署锁不一致时的排除。新增夹具最初缺少 securityRequirements，补齐后定向复查通过。全仓 typecheck 及 Fabric 测试类型检查通过，后续修改的 Server/Agent 类型复查通过；最终 lint 无错误（原有 47 warnings、1 info）。真实联邦 Script 成功不是 mock 回调。临时数据库、Server、网关、namespace、RBAC、seccomp 文件和凭据均已清理；本机证据保存在 `temp/federation-k8s/` 及 `temp/federation-{scheduler,runtime,placement}*`，不纳入版本控制。

Slurm 方向已取得并核对仓库既有 Apptainer 1.4.3 包 SHA-256，构建约 1.9 MiB 的本机 Bash SIF，并真实运行成功。现有缓存 Slurm 19.05 镜像配置 task/none，没有作业 cgroup；本轮没有把安全能力布尔值伪造成已验证能力，也没有将这份 SIF 宣称为完整 Slurm 联邦验收。仍须完成 Slurm/PBS 受限运行环境、跨机构文件产物、真实软件与依赖锁安装，以及其他完整蓝图功能和 PR 预览。

## Kubernetes 联邦文件流水线

接收端真实运行两个串联的 Script：生产者读取签署参数 `6` 的只读输入，计算并写入 `42\n`；平台将 Checkpoint 文件上传到独立 RustFS，消费者通过原受管文件解析、短期签名 URL、Agent 下载及摘要校验读取该文件，再写出 Persistent 结果 `verified:42\n`。两个脚本均使用受信任的固定 OCI digest、原协议的 1 CPU/128 MiB 上限和生产 Agent/watchdog，没有配置 Fabric。重复 JWS 仍只有一个预留和一个 Workflow；HTTP 接单查询返回 completed。

本轮修复：

- Kubernetes PVC 原来直接使用 `inputs/...`、`outputs/...` 公共路径，且输出-only 作业不准备目录。现在每次准备使用独立的 `jobs/<jobId>/<随机准备ID>/`，保存到原 JobSpec 供恢复读取。业务 Pod 只挂载自己的输出目录，允许脚本真正创建文件，不再依赖 kubelet 将未存在的文件 subPath 当目录。输入与输出采集保持同一持久路径。
- 未生成的可选输出不再让 `kubectl cp` 失败，也不预造空文件；远端检查失败仍拒绝。准备器与收集器沿用原隔离要求，辅助 Pod 退出宽限设为 5 秒，避免每个节点多等两次默认 30 秒。
- 原文本收集把 PVC 路径拼到容器内 `/kq`，但收集发生在 Agent。Kubernetes 的 Agent 工作目录现在是本地受管目录，Text/JSON 按已准备的 hostPath 读取；File/FileBatch 只走产物链，不作为普通文本日志读取。禁止导出的任务仍检查所有输出挂载。

真实成功记录：Workflow `9f21d05d-b5b9-4286-910a-a58b723d2cd6`，生产者 Job `04adcbe9-076e-4e82-9220-4543c78d8cdf`、消费者 Job `39b8f078-2e11-443e-a937-44e5efa2af8c`，两个对应 Kubernetes Job 均实际完成。生产者未创建声明的可选文件，平台最终仅登记两个产物/云盘文件：

| 产物 | 字节数 | SHA-256 |
| --- | --- | --- |
| `42\n` | 3 | `084c799cd551dd1d8d5c5f9a5d593b2e931f5e36122ee5c793c1d08a19839cc0` |
| `verified:42\n` | 12 | `87730d8e29a90b06728319cb30fcf8dbae523f785f3043c82ea4df6386c83f7f` |

首轮发现本机全仓类型检查占用 CPU，消费者被现有 95% 负载门槛拒绝。没有降低门槛；静态检查完成后单独重跑文件流程通过。测试 PVC 使用 local-path 的 WaitForFirstConsumer 存储类，需要部署侧选定已证明节点并完成绑定；实验已按该条件配置，未改平台的固定节点隔离规则。RustFS 使用生产 Object Lock bootstrap 和独立非 root committer，未使用现有环境的存储或凭据。

验证：初始 Kubernetes adapter/stager 组合 **96 项通过**；增加可选输出和输出-only 覆盖后，相关 Stream/stager/adapter/执行器组合 **271 项通过**，包含上述重叠用例，不累加。后续补强原 Stream 用例的持久输出路径断言，首轮仅因夹具未列 schema 默认字段失败，改为保留核心字段断言后 **1 项定向通过**；准备路径补充拒绝 `.`/`..` 输出描述符后，原 Kubernetes stager 用例 **1 项定向通过**。全仓 typecheck（含 Fabric 测试）通过，最终 Agent 类型复查通过；最终 lint 无错误，维持原有 47 warnings、1 info。此次实际执行无需 Spack 编译，未更换现有科学软件。临时 Server、数据库、对象存储、凭据、namespace、RBAC 和 seccomp 文件已清理。本机证据在 `temp/federation-k8s-artifacts/`，首轮诊断在 `temp/federation-k8s-artifacts-first/`，均不纳入版本控制。

边界：这是**一个接收站点内**的真实双节点文件链路，源端仍为机构签名发送探针；不是两个完整平台或 Slurm/PBS 跨站验收。没有独立重新下载最终云盘文件，已验证下游实际读取首个文件、Agent 最终产物摘要及云盘发布记录。共享 PVC 目录的自动回收尚未接通，需按[部署说明](../../software.md#sandbox)管理容量和保留；Agent 本地副本释放不代表 PVC 字节已删除。完整跨机构结果交付、源站出站功能、其他蓝图功能与 PR 预览仍待完成。

## 源站持久发送与真实双平台验收

源站已接通组织隔离的出站提交、列表和人工重试 API，以及持久后台发送 worker。原 operationId、task attempt、签名 JWS 和额度预留随重试保持不变；响应丢失后只重放原请求取回既有接单回执。签署和网络发送不持有数据库事务，租约过期的旧 worker 不能覆盖新处理结果。同操作换正文拒绝；同正文重复提交仅返回原事实，仍检查当前提交权限及原提交者/组织。首次提交与实际发送核对双签协议、材料映射、当前权限和信任登记；同预算域/epoch 跨协议复制及并发超额拒绝。端点变化要求明确重试并审计；mTLS 使用独立配置的证书/私钥/CA，不跟随重定向。

`accepted` 仅表示取得匹配原请求的可信接单回执，不代表执行、结果交付或结算。未知交付、失败和 accepted 均保留额度，结算释放尚未实现。网络发送期间本地撤权不抹掉已经观察到的可信接单事实；远端停止仍须专用取消协议，不能把本地撤权描述为已停机。

真实验收使用两个生产 Server、同一临时 PostgreSQL 进程内的两个独立数据库，以及实际机构 mTLS 网关、生产 Agent/watchdog、Kubernetes 和 RustFS。A 通过自己的 HTTP API 两次提交同一请求，后台 worker 自动送达 B；B 保持一个预留和一个 Workflow，两个 Script Job 实际完成，文件从 `42\n` 经对象存储上传/下载后被下游读取，输出 `verified:42\n`。未配置 Fabric，资源为 1 CPU/128 MiB，不涉及 Spack 编译或替换科研软件。

本机证据：`temp/federation-platforms/` 与 `temp/federation-platforms-run.log`。A 操作 `3286e646-29d7-46bd-8cb1-5fbdaa812029`，B 预留 `9798765a-1e68-473b-8f8c-d957883993a8`，Workflow `a5b31a92-d3af-4680-8eca-0936269d5c30`。两份产物摘要与上一节一致。临时服务、namespace、PVC、存储、凭据和 seccomp 文件已清理，未改现有部署。

验证：隔离 PostgreSQL **9 个不同用例通过**，覆盖并发/幂等、未知交付恢复、签名回执内容校验、撤权、材料缺失、端点变更、预算与租约竞态；最后幂等早返回变更定向复查 **1 项通过**，不重复累计。TLS/config **8 项通过**，包含真实 HTTPS mTLS、CA/hostname、不完整/超限响应、重定向和超时。全仓类型检查及后续 Server 类型复查通过；lint 无错误（原有 47 warnings、1 info）。首次 TLS 超限错误分类竞态已修复，最终组合通过。迁移通过生成命令产生并在隔离数据库执行。日志为本地 `temp/federation-outbound-*.log`。

边界：两个平台仍在同一主机，非多主机独立信任验收；材料分别预先登记，尚未跨站自动物化。B 的完成状态来自 B 管理查询，A 当前仅保存接单回执，跨站运行状态/结果回传、取消、普通 Workflow 自动委派、结算和 Slurm/PBS 联合验收仍待完成。共享 PVC 自动回收仍未接通。PR 预览尚未发布。

## 源站签名运行状态查询

源站新增 `GET /api/federation/outbound/:operationId/remote-status`，经原 mTLS 发送器和接收站固定 `/federation/v1/status` 通道查询。每次使用独立随机 queryId、最长 60 秒的签名查询；接收站按原预留的机构、operation/task/attempt、协议修订、reservationId 和请求摘要限制读取，签名报告绑定查询摘要。只返回材料准备/Workflow 状态及更新时间，缺少绑定为 null，不传内部运行 ID、用户、脚本、日志或结果。新密钥用途须显式登记；协议/接单期限过后仍可在当前身份信任和源站读取授权有效时核对历史状态，不授予任何执行权。

源站收到响应后再次复查当前读取权限与对端签名信任，拒绝旧查询响应、错误任务、伪造签名、过期或异常观测时间。网络和签名不持数据库事务；状态查询不改接单记录、不释放预算、不重跑作业。响应带 reportJws、observedAt 和 verifiedAt，禁止 HTTP 缓存。此接口为按需读取，后台持续同步、普通 Workflow 消费、结果传输与远端取消确认仍待实现；已接单端点迁移也仍需维护流程。数据库仅扩展 JSON 列的 TS 用途类型，没有新增迁移。

验证：隔离 PostgreSQL **4 项**、真实 Node TLS 网关/发送器 **7 项**、协议期限/报告绑定 **2 项**通过。包含组织隔离、协议过期后的历史查询、错误 TLS 机构、身份/摘要不匹配、旧报告重放、查询中撤权，以及只读权限可查询但不恢复提交权限。全仓 typecheck（含 Fabric 测试）与新协议测试的最终 shared 类型复查通过；lint 无错误，仍为原有 47 warnings、1 info。没有重复运行无改动的 Agent 全套测试。

真实双平台验收再次通过：A 的生产 API/后台发送器自动委派，B 的生产 Agent/watchdog 运行实际 Kubernetes 双 Script 文件链；随后 A 的上述 HTTP API 经真实机构网关取得签名报告，返回 `preparation=resolved`、`workflow=completed`，摘要与接单预留一致。A 操作 `40c670db-fb8d-49ee-9061-b5b18b50e23b`，B 预留 `f86c7825-4352-43e5-9029-92813fa96e12`，Workflow `a514f476-0f38-4d24-a827-59c722ec96b1`。产物仍为 `42\n` 和 `verified:42\n`，摘要与前述一致。两个平台共用一台主机、使用独立数据库，无 Fabric、无 Spack 编译，作业限制 1 CPU/128 MiB。

本地证据为 `temp/federation-status-platforms/source-remote-status.json`、同目录运行/产物记录及 `temp/federation-status-*.log`，不纳入版本控制。临时 Server、数据库、凭据、namespace/PVC 和 seccomp 文件已清理，未改变现有部署。状态由接收机构签名声明，不能据此证明科学结果正确、文件已交付源站或已结算；完整联盟链交付与 PR 预览仍未完成。

## 源站远端取消与停止确认

源站新增持久取消与人工重试 API，经独立 mTLS 通道发送绑定原 operation/task/attempt、协议与请求摘要的机构签名。接单结果未知时也能请求停止；接收端在原接单/派发共用协议锁下保存永久撤回记录，阻止迟到首次接单、准备、入队、计算/安装派发和续期。已有接单回执保留为历史事实，原额度不释放。已授权落库的停止意图不因发起人随后失权而丢弃；机构信任/端点变化仍要求核对，明确重试可用当前可信密钥重签同一停止正文。

接收端后台复用现有 Workflow/Job 取消、安装停止和数据清理确认。终态 Workflow 仍检查遗留安装；未知 Job、未收到停止或清理确认均保持 pending。仅在后台收尾成功且回执生成时状态仍已收敛，才签署 stopped。源站按原意图重试直到获得可信确认，独立租约防止旧 worker 覆盖；不依赖 Fabric，不把 202、failed、断联或超时视为停止成功，也不代表退款、结算或结果交付。部署文档已列出新增密钥用途与权限。

实际联调发现 Agent 与独立看守并发写 SQLite 时，Agent 未设置锁等待导致短暂争用直接报 SQLITE_BUSY。现将 Agent 连接的 busy_timeout 设为 5 秒；真实 Python 独立 writer 持锁测试在修复前失败，修复后两份写入均保留。没有关闭看守或增加无限重试。

验证：隔离 PostgreSQL 共 **45 个不同用例通过**，含取消的身份/摘要校验、接单前停止、未知交付、迟到回执、失权后继续停止、坏签名、租约竞态、最终准备封锁与原安装停止链；组合首轮旧恢复测试受同库其他夹具影响，已限定为当前运行的统计并定向通过。真实 Node TLS 网关/发送器 **7 项通过**；SQLite 真实争用及原集成/看守组合 **26 项通过**。全仓类型检查发现的新测试 nullable 类型错误已修复，最终 Server/DB/Fabric 类型复查通过，其余包此前通过；lint 无错误（原有 47 warnings、1 info）。迁移 0094、0095 经生成命令产生并在隔离 PostgreSQL 实际执行，未手改生成文件。

真实双平台取消验收通过：两个生产 Server、独立数据库、机构 mTLS 网关、生产 Agent/独立看守和 Kubernetes/RustFS，在真实生产者进入 `sleep 120` 后由 A 的 HTTP API 发出取消。A 于 **66.4 秒**后获得并验签 B 的 stopped 回执；原 accepted 回执仍保留，B 的 Workflow/Job 均为 cancelled，实际 Kubernetes Job 和工作 Pod 已消失，下游未启动，产物与云盘文件记录均为空，A 的签名状态查询也返回 cancelled。操作 `e6ead828-acdc-4adf-b311-02a49380b26f`，Workflow `ea240528-1a91-4433-8ea6-8493f2ced757`，Job `03fb81ff-7056-463b-907c-fc7062cf5b91`。作业仍为 1 CPU/128 MiB，无 Fabric、无 Spack 编译，未修改现有部署。

首次尝试暴露上述 SQLite 故障；修复后第二次作业已运行，但测试等待的短 stdout 被现有 `head -c` 缓冲，未发出取消，不能算作通过。最终改用可写 `/tmp` 内的标记文件与平台 running 状态确认进入脚本，再发取消；未改变生产日志或停止判定。取消期间 Kubernetes 默认退出宽限和后台重试曾使确认保持 pending，直到真实停止/清理完成，没有提前报成功。本地证据保留在 `temp/federation-cancellation-platforms/` 及对应 run 日志，前两次分别保留于 `*-first/`、`*-buffered-log-attempt/`，均不入库。临时服务、数据库和凭据已清理。

边界：这是同一主机内两个独立平台的 Kubernetes 轻量任务验收，未覆盖真实编译取消、Slurm/PBS、多主机或 Fabric 联合作业。远端停止不等于结果交付或结算；源站后台状态同步、普通 Workflow 自动委派、其他蓝图功能及 PR 预览仍待完成。

## 双方授权的签名结果清单

已新增源站 `GET /api/federation/outbound/:operationId/results` 和接收方固定 mTLS `/federation/v1/results`。采用独立 result-query/result-report 密钥用途、随机一分钟 challenge、原任务/预留/请求摘要绑定与源站返回前重新授权。源站必须具有独立 `result.read` 权限，原 submit/read/cancel 不隐含结果读取权；双方须在新协议修订显式签署 resultPolicy，包含持久文件范围、总文件数/字节上限及披露截止时间。旧协议无该字段时拒绝导出，不能直接改已签署条款扩权。结果期限可晚于计算窗口，协议暂停/撤销、签名信任失效或结果期限结束仍拒绝。

接收端检查原签署委派、执行身份、不可变运行绑定与 completed 状态，筛选 Persistent File/FileBatch。每项产物核对本运行的生产 Job、完成状态和导出限制，并检查全部已发布云盘文件的归属、大小和 SHA-256。丢失产物元数据不能变成空清单；文件删除、批次缺项、摘要变化、超限等均拒绝整个请求。签署后重新读取检查，不能返回授权或产物已改变的旧快照。清单只含稳定输出摘要 ID、节点/输出、相对文件路径、大小/摘要及原模板/输入清单/环境锁引用，不包含内部用户/Job/Workflow/云盘 ID、存储路径或下载凭据。

验证：新增隔离 PostgreSQL **5 项通过**，覆盖旧协议、权限隔离、计算期限过后读取、结果期限、待完成、禁止导出、文件所有权/删除/摘要变化、缺失产物、FileBatch 全成员核对、限额、响应重放、错误 provenance、网络返回前撤权、错误 TLS 机构、请求串单、执行身份停用及修改已签条款。协议与真实 Node TLS 组合 **11 个不同用例通过**；网关初次只因新增第四条合法路径后计数断言仍为 3 失败，更新后定向复查通过。新增测试生成时误插入 schema 参数的问题已修正，最终上述五项通过。共享 schema 初次使用 safeExtend 更换 literal 类型被 TypeScript 正确拒绝，已改为复用查询字段及共同期限校验；最终其他包全仓类型检查通过，Server 与 Fabric 测试类型复查通过。lint 无错误，保留原有 47 warnings、1 info。0096 迁移经生成命令产生并在隔离数据库实际执行。

真实双平台联调通过：两个生产 Server/独立数据库、机构 mTLS 网关、生产 Agent/独立看守、Kubernetes 和 RustFS 完成 `42\n` → `verified:42\n` 文件链。源站随后经生产 HTTP API 得到签名运行完成报告和签名结果清单，仅含消费者的一个 Persistent 文件，12 字节，SHA-256 为 `87730d8e29a90b06728319cb30fcf8dbae523f785f3043c82ea4df6386c83f7f`；生产者的 3 字节 Checkpoint 文件不被披露，清单不含两个内部 Job ID。操作 `15ecb312-4de3-4c91-b33f-967167626d23`，Workflow `4b0abe27-3887-4ac6-87f7-5719bec62188`。清单摘要为 `sha256:9042c07b0b14b2b4487ced016e1521de20a067243cf72451a21dcfe30269fb1f`。未使用 Fabric 或 Spack 编译；轻量作业限制为 1 CPU/128 MiB。两个平台在同一主机，不是多主机/Slurm/PBS 联合验收。

本机证据为 `temp/federation-results-platforms/source-result-manifest.json`、同目录运行记录及 `temp/federation-results-*.log`，不入库。临时数据库、服务、凭据与 Kubernetes namespace/PVC 已按实验清理流程回收，未修改现有部署。

本轮仍是结果交付的清单与授权接线，**没有传输文件字节、登记源站副本或签署接收完成回执**；不得据此显示已交付/已验收/已结算。大文件数据通道、后台恢复、普通 Workflow 的结果消费，以及其他完整蓝图功能和 PR 预览继续推进。

## Agent 结果字节搬运基础

新增 Agent 内部结果文件搬运函数，按原清单、操作、文件成员及 transferId/generation 绑定下载和分片授权；短期授权上限 60 秒，必须落在结果可用期限内。源/目的 HTTPS origin 由运维独立配置，不接受任意地址或重定向。真实字节经 Agent 在存储端间搬运，完整下载 SHA-256 校验通过后才上传，返回未完成 multipart parts；不会登记可用副本或提前签收。

同时修复共用下载器接受忽略 Range 的 HTTP 200、全量读取响应及全量重读恢复前缀的问题。原实现已用真实 HTTP 服务复现：4 字节 Range 请求会接受全对象响应。新实现严格核对 206 与范围，流式限制窗口；恢复重哈希使用 64 KiB 内存。共用上传器改为逐分片/重试领取新 URL，使用文件支持的 Blob，避免整个分片分配内存，并拒绝上传期间文件变化。

验证：Agent 搬运、恢复下载、multipart、stage-in 组合 **22 项通过**，另有现有 AgentStream multipart 地址映射/取消 **2 项定向通过**。搬运测试使用两个真实 HTTPS 服务，传输 5 MiB + 123 字节（6 次 Range、2 次 PUT），重新拼接目的字节核对 SHA-256；授权回调仍是测试替身，不是生产平台授权联调。错误 origin/generation/过期授权/重定向/损坏内容/上传撤权/磁盘上限/挂起取消/空文件授权均覆盖。测试最初因 Bun 自动设置 Content-Length 未走到期望的超长流分支而失败，改为真实异步流后通过。全仓类型检查发现 Bun 类型名兼容错误，改用 RequestInit 类型后定向复查；lint 无错误，保留原有 47 warnings、1 info。本机证据位于 `temp/federation-result-copy-*.log`，不入库。

边界：当前只是内部函数，尚未接入生产 grant 接口、AgentStream 和持久任务；需要整个文件大小的本地磁盘，没有跨进程保留暂存及并发容量预留。没有 TB/RSS 实测、真实 S3 CompleteMultipart、源站副本发布或双平台完整结果回传。未完成 multipart 的持久跟踪和中止清理需由后续平台接线负责。

## 结果下载的机构授权协议

接收机构已新增固定 mTLS `/federation/v1/result-downloads`，源站增加对应内部签名请求/验签方法。使用独立密钥用途，绑定原任务/协议/预留、随机查询、transferId/generation、清单和文件成员；原清单授权与完整性检查复用，签发前后分别复核，源站返回前再次检查当前用户权限。存储只执行 Head 和预签名，字节不经 Server；支持时指定 versionId。接收机构的 HTTPS origin 白名单默认关闭，已接 Server 启动与 Compose 变量。

有效期最多 30 秒且不能越过结果披露期限。双方同时检查真实 S3 SigV4 地址有效期，拒绝正文写短期但 URL 仍长效的凭据；地址与签名响应只交给内部搬运组件，不持久化/记录。已发地址不可即时撤回，受管 Agent 在到期时取消连接；S3 不保证到期瞬间停止已开始的响应，这一撤权窗口已写入部署说明。

验证：隔离 PostgreSQL **10 个不同用例通过**，包括原清单的 5 项和新增下载授权 5 项。首次测试发现编辑时误把导入标识插入函数实参，修正后复查；另两项拒绝行为符合预期，但测试期望错误码与既有信任/策略分类不一致，调整断言后定向通过。新用例覆盖对象版本、最后披露窗口、错误清单/成员、错误 TLS 机构、存储缺失、禁止导出、签发期间换文件/停协议、网络返回前撤权、重放/错误尝试、未登记 origin、长效实际凭据与独立签名用途。TLS 网关/发送器、运行配置、原清单协议和 Agent HTTPS 搬运组合 **52 项通过**，含新增固定路由及伪造 query 路径拒绝。lint 无错误（原有 47 warnings、1 info）。全仓检查中其他包通过，Server 的编辑/测试类型错误修正后，Server 与 Fabric 测试类型定向复查通过。无数据库迁移，仅扩展 JSON 密钥用途类型。

数据库测试使用真实 PostgreSQL、生产权限/签名服务和替身存储签发；TLS 测试用真实 Node mTLS，字节测试用真实 HTTPS。不能合并描述成一次真实 S3 或完整双平台回传。尚无持久传输状态、目的端上传授权、AgentStream 桥接、CompleteMultipart/副本发布及接收回执。未改 main、现有部署或发布预览。证据在本机 `temp/federation-result-grant-*.log`，不入库。

## 源站持久结果导入意图与尝试隔离

已接通结果导入的提交/查询/取消 API，以及 PostgreSQL 的导入、文件成员、历史尝试三类记录。接收意图前验签远端清单，写入时重查当前授权；同 ID 重放和相同所有者/操作/清单去重。取消后旧 ID 保持取消，新 ID 可重新授权导入。所有者/组织/operation 路由范围均检查；普通返回只含状态、成员、大小和摘要，不泄漏签名正文或存储凭据。

尝试先落库随机 generation 与独立 storageKey，再允许存储副作用。当前授权、Agent 归属、租约和精确文件绑定分别检查；元数据保存在数据库，服务对象重建后可重新读取。过期/撤权/取消保持清理责任，迟到的旧上传 ID 不会被遗失或覆盖新尝试。数据库限制重复活动尝试，旧取消租约尚有效时 Agent 名额不提前释放。完整 parts 与大小/摘要匹配的 Agent 上传报告只推进到 assembling；相同回报可重放，不写云盘文件、不标记已交付。

验证：隔离 PostgreSQL **6 个不同用例通过**，其中生产 Hono 路由覆盖并发首次提交、无缓存详情、跨组织/操作拒绝、失去读取权后仍可取消自己的导入、取消旧 ID 重放与新 ID 重新授权。其他用例覆盖并发领取、错误 Agent/绑定、服务实例重建、非法 parts、上传报告不能发布文件、租约过期、旧上传创建响应在清理/新尝试后到达、撤权与清理保留。补充“取消但租约未到期仍占用 Agent 名额”后对应 **1 项定向复查通过**，与上述六项重叠，不累加。迁移 0097、0098、0099 均经生成工具产生并在隔离数据库实际执行；后两项调整索引，分别允许迟到的旧清理记录与新活动尝试共存、取消后新 ID 再导入。未手改生成文件。全仓类型检查（含 Fabric 测试）通过，API 接线后 Server 定向类型复查通过；lint 无错误，保留原有 47 warnings、1 info。本机日志为 `temp/federation-result-import-*.log`，临时数据库已关闭并清理。

边界：这是持久控制状态和 API，尚无后台传输 worker、AgentStream 派发或实际 S3 分配/组装/清理。测试重建服务对象，没有用实际进程崩溃冒充恢复验证；内部清理确认在测试中直接调用，不能证明对象已删除。当前提交保持 pending，已有内部状态入口不能当作可运行的完整结果回传；配额、目的字节复验、整单原子副本发布与接收完成回执继续推进。没有发布预览或修改现有部署。

## 结果存储协调与真实残留清理

新增存储协调器，先持久保存尝试与独立 key，再检查整份清单配额并创建 multipart；创建超时后仍记录迟到的 uploadId。双端短期授权核对当前尝试、原授权、HTTPS origin、实际 S3 期限及上传 part/uploadId，返回前再检查撤权或取消。错误、过期或取消均保留清理责任；已清理 key 每 24 小时可复扫，处理旧进程退出后才创建成功的孤儿，不能把一次观察为空当成永无迟到副作用。

清理只接受联邦尝试的精确 key，扫描全部 multipart（含丢失响应的 ID）并显式删除全部版本和 delete markers，再次扫描为空后才登记清理。SDK 错误脱敏，失败保留待清理。生产 RustFS/Helm bootstrap 同步补充固定版本读取，以及仅限 federation-results 前缀的残留枚举和版本删除权限。

验证：4 个不同隔离 PostgreSQL 协调用例通过，覆盖授权期间取消、错误分片、配额拒绝、分配超时/迟到响应、旧 key 复扫和清理失败。2 项清理单元测试、20 项部署脚本/Helm 测试通过。真实临时 RustFS 使用生产初始化脚本创建的非 root committer：清除两个 multipart、对象版本及删除标记，旧上传 URL 失效、相邻对象保留；独立权限用例确认可读固定版本，但不能枚举普通 netdrive 的版本/上传或删除其历史版本。临时 namespace、凭据及数据均已删除。上述为存储组件验收，不是完整跨平台结果回传。

协调器尚未连接生产后台和 AgentStream，导入 API 仍只排队。尚无 CompleteMultipart、目的字节独立复验、整单原子发布或接收完成回执。配额回调是检查入口，尚不构成并发配额预留。

## 结果搬运通道与能力协商

已将搬运函数接入生产 AgentStream：新增 protobuf 消息、独立能力协商、短期 grant 请求/响应及元数据回报。Agent 的配置默认关闭，限制单文件磁盘容量和双方 HTTPS origins，单 Agent 只搬一个文件；断线/退出/租约到期停止，迟到地址不再复用。Server 只接受当前 mTLS 连接和已协商能力，授权期间保持心跳可处理，连接替换后不释放旧响应。生产启动已接传输服务及独立源存储 origin 配置；没有启动自动搬运 worker，避免在发布链路未完成时反复搬运后过期清理。

验证：Agent 配置与真实 HTTPS 搬运组合 55 项通过，其中新增两项覆盖 protobuf 客户端的真实字节、重复/并发派发、断线、租约到期和迟到/错误 grant；另新增生产 AgentStream 的协商/授权拒绝/失败回报 1 项通过（传输为内存测试连接）。隔离 PostgreSQL 与生产 Server handler 共 7 项通过，覆盖身份/能力、心跳不阻塞、拒绝脱敏、旧连接响应隔离、分配时重连和 copied 仅到 assembling；Server 源存储 origin 配置新增 1 项通过。存储/机构授权在这组 DB 测试中使用既有生产服务及存储替身，不冒充完整双平台字节回传。protobuf 通过生成命令更新且 lint 通过。全仓类型检查通过，新增测试后 Agent/Server 定向类型检查通过；最终 lint 无错误，保留原有 47 warnings、1 info，新增的隐式类型问题已修复。文档本地链接检查通过。

下一项是 CompleteMultipart、固定目的版本的实际字节复验、配额与整份清单原子发布、接收完成回执；随后才启动后台与重做双平台真实回传。本轮不发布预览，不变更 main 或现有部署。

## 分片完成与独立目的读取

已接 CompleteMultipart 与 Agent 目的校验通道，持久保存目的 ETag/versionId 和验证时间。完成响应丢失时可以找到对象并重新读取；完成超时或取消保留独立 key 的清理责任。目的授权限制当前 generation、对象、HTTPS origin 和短期期限，签发前后重查权限。Agent 按精确 1 MiB 范围流式重读并计算 SHA-256，校验 ETag/版本，空对象也真实 GET；Server 不转发文件正文。相同 copied/verified 回报重放不重复组装或回退状态。

验证：Agent 搬运/校验与共用 Range 下载 **17 项通过**，含真实 HTTPS 大于 1 MiB、空文件和无版本对象，损坏同大小内容、错误版本、忽略 Range 和读取到期均拒绝。隔离 PostgreSQL **6 个不同用例通过**，覆盖传输到 verified、失去完成响应、取消竞态、错误对象/摘要、完成晚于清理和并发完成。并发失败不再将另一个已成功完成的尝试标为待清理，由原租约到期机制保留失败尝试的清理责任；首轮两个失败暴露严格 task schema 不接受回报额外字段，已显式提取任务字段并定向通过。补充重放后传输用例单独通过，不重复累加。另有 6 项 Server 通道能力/身份测试通过，新增的 copy-only 用例确认旧版只会上传、不会复验的 Agent 不领取新任务。迁移 0100 由 drizzle 生成并在隔离数据库执行。

真实 RustFS 新增 **1 项通过**：生产 bootstrap 创建的非 root committer 实际上传并 CompleteMultipart；随后同 key 写入另一版本，Agent 通过限定路径的本机 HTTPS 代理仍按原 versionId/ETag 读取旧版本，实读 1 MiB + 37 字节、两次 Range，SHA-256 一致。此用例使用真实生产存储 backend 和 Agent 校验函数，授权回调为测试替身，不冒充完整 Server/Agent 双平台验收。专用 namespace、数据、临时 CA 与凭据均清理，证据在 `temp/federation-result-verification-real.log`，不入库。

静态检查发现跨包真实存储测试不应放入 Server 的 src/rootDir，已迁至 `scripts/federation-result-storage.integration.test.ts`，复用现有跨包测试类型检查配置；没有用类型忽略绕过。其余包全仓类型检查通过，Agent/Server 与跨包测试最终定向类型检查通过；lint 无错误，保留原有 47 warnings、1 info；protobuf lint 和本地文档链接检查通过。

当前只推进到内部 verified；API 仍只排队，后台自动派发尚未启动。下一项补齐配额、整份清单原子发布和签名接收回执，再做双平台完整结果交付验收与其他蓝图工作。没有发布预览或修改 main 部署。

## 事务配额预留与云盘版本固定

导入清单在持久化时原子预留全部成员字节；普通云盘提交与联邦预留共享按用户的事务锁。重复导入不重复占用，迁移前意图在首次领取时补预留，失败重试继续保留，取消只有在所有尝试完成真实清理后才释放。批量配额检查区分实际文件写入与额外预留，预留不能通过虚构覆盖路径抵扣已有用量。普通上传的旧记录替换与新记录写入也已改为同一事务。

云盘单次上传与 multipart 提交保存 storageVersionId，下载与联邦结果授权使用该版本，并核对大小、ETag 与签发前后数据库映射。旧无版本记录仍兼容；固定版本不代替目的字节验证。0101、0102 均由生成工具生成，在隔离 PostgreSQL 实际执行。

验证：配额/云盘组合 38 项通过，覆盖两个导入及普通预签名上传竞争最后 3 字节、取消等待清理及失败清理不释放。版本固定/结果下载组合 34 项通过，包含普通云盘回归、单次/multipart 固定版本和授权期间版本改变拒绝；与前组重叠，不累加。首次 multipart 用例错误地把测试 backend 的 {etag} 对象当字符串，已修复并定向复查。测试使用真实隔离 PostgreSQL 和存储替身，不是双平台真实字节回传。证据见本机 temp/federation-result-quota-pg.log 与 temp/federation-result-version-final-pg.log，数据库均已停止清理。

整单发布、签名接收回执与自动搬运尚未接通，没有修改 main 或现有部署。

## 整份结果清单原子发布

存储协调器新增内部发布入口：所有成员 verified、目的固定版本 HEAD 一致，并重新向对端请求/验签同摘要清单后，事务内重查本地授权、签名信任与尝试快照，一次登记全部云盘文件并将预留转为实际用量。路径冲突不覆盖用户文件；复用成员 UUID 作为 fileId，保留原始签名清单及尝试的可追溯关系。重复发布、空清单均可完成，已发布对象不被过期尝试清理误删。

长期云盘副本要求真实存储版本号；无版本对象即使已完成实读验证也不能发布。远端查询完成后最多 30 秒提交，并复查披露截止时间，数据库锁等待不能延长授权。该机制使用短期签署快照，不承诺跨平台同时撤权。

验证：新增 6 个不同隔离 PostgreSQL 用例通过（首组 5 项、时效补充 1 项）。覆盖两文件整单并发提交、配额转换不重复计数、未完成成员/目的变化/路径冲突均不出现半批文件、取消/远端撤权、跨所有者拒绝、源文件丢失、无版本拒绝、配额缩减回滚、空清单、目的快照改变与过期授权。首轮撤权用例误更新源端审批表而不是接收方实际协议表，纠正测试目标后通过。测试使用生产签名/权限/数据库服务与存储替身，没有模拟字节校验冒充真实双平台传输。前轮真实 RustFS/Agent 字节证据仍独立有效。

全仓类型检查（含 protobuf 生成及 Fabric 测试）通过，最后时效补充后 Server 定向类型复查通过；lint 无错误，保留原有 47 warnings、1 info，本地 637 个文档目标检查通过。

后台自动派发和接收回执仍未接通，API 仍只排队；尚未发布预览或变更 main 部署。证据在本机 temp/federation-result-publication-pg.log、temp/federation-result-publication-fresh-pg.log，临时数据库已清理。

## 自动结果回传与签名接收回执

结果后台已在满足联邦、NetDrive、双方 origins 配置时自动启动：先清理过期尝试，再发布全部 verified/空清单，最后按本组织、当前 mTLS 与 copy/verify 能力派发。每个 Agent 一次一文件，数据库排除忙碌 Agent，并发 worker 仍由尝试锁/唯一约束隔离。未完成尝试到期后清理再重传；已验证成员可在服务重建后重新授权发布。lastError 和 30 秒退避已持久保存，不隐藏处理失败，也不把进程退出当作成功。

发布事务同时保存接收回执正文。独立后台签署并经固定 mTLS 路由发送；对端核对原预留/任务完成/披露范围并保存签名声明后，签署已登记确认。双方身份与原正文摘要绑定，同 ID 换正文拒绝，响应丢失重试返回原确认，不重复搬运。回执是收到声明与对端登记事实，不代表科研正确性、商务验收或预算结算。新密钥用途 result-receipt/result-receipt-ack 须显式登记；源站所有者可通过 receipt-retry 在轮换后重签原正文，对端也可用当前密钥重签原 recordedAt 的确认。历史事实补送不依赖原用户继续拥有数据读取权限，但当前机构/密钥信任必须有效。迁移 0103、0104 由工具生成并在隔离 PostgreSQL 执行。

验证：7 个不同隔离 PostgreSQL 用例通过（初组 5 项、双方密钥轮换分别 1 项），覆盖生产权限/签名与数据库持久状态、响应丢失、重放冲突、错误 TLS 机构/任务绑定/确认摘要、返回时撤销信任、缺独立密钥用途、披露过期及文件删除后补送事实、旧 Agent 拒绝、并发 worker 与过期尝试恢复、原子发布后的回执排队、双方轮换及重签入口权限。Agent/存储部分在这组用例中是受控替身；worker 重建不是实际进程崩溃验收。另有真实 Node mTLS 网关/发送器 7 项、部署脚本/Helm 20 项通过。

完整双平台真实回传通过：两个生产 Server/独立 PostgreSQL、两个经实际注册 API/CLI 登记的 Agent、两个独立非 root RustFS 与受限 HTTPS 存储入口，完成 Kubernetes 工作流 42\n → verified:42\n。源站 HTTP API 排队导入，后台通过 AgentStream 实际下载/上传/组装并独立读取校验目的对象，然后原子发布云盘文件，经机构 mTLS 取得对端签名确认。再次调用普通云盘下载 API，实际得到 12 字节 verified:42\n，SHA-256 为 87730d8e29a90b06728319cb30fcf8dbae523f785f3043c82ea4df6386c83f7f；Checkpoint 未披露，重复同清单提交仍返回原 importId/fileId。操作 e1b9ba59-284a-47ec-8adc-018216670d42，Workflow 81b106f8-a578-45d0-b2ce-f5bacb1fef9e，导入 1626bede-b262-4589-a915-607a87974e66；目的版本 89e6e207-1dcf-419f-9ea3-87e4b078c2dd，回执状态 recorded。

联调暴露并修复部署缺口：原 bootstrap 只对不可变材料桶启用版本管理，云盘桶未启用，目的对象虽通过 SHA-256 验证仍因无 versionId 被正确拒绝发布。已同步 Docker/Helm 的云盘版本启用，修复后上述完整回传通过。前两次启动分别受测试 origin 误写 JSON（应为逗号分隔）以及共享 RustFS 中两套初始化覆盖同名 IAM 策略影响；修正参数并改为两套独立存储后继续，未将失败算作通过。无版本实测在问题已确认后中止并走 finally 清理，再按修复配置重跑。云盘版本留存会增加后端物理占用，当前用户逻辑配额不等同物理容量；历史版本回收不可误删仍被引用的版本，仍需运维策略。

最终其他包全仓类型检查通过，Server 定向复查和 Fabric 测试类型检查通过；lint 无错误，保留原有 47 warnings、1 info，文档本地链接检查通过。修复了新增密钥用途遗漏数据库 JSON 类型以及测试可空值断言问题，未用类型忽略规避。证据在本机 temp/federation-result-return-platforms/result-delivery-evidence.json 及相应日志，临时服务、数据库、凭据、namespace/PVC 已清理，不入库。实验在同一主机，计算限 1 CPU/128 MiB，无 Spack 编译、无 Fabric；不宣称多主机、Slurm/PBS、TB 级搬运、真实科学软件或完整三模式联合验收。未修改 main 部署或发布预览。

## 源站持久状态同步

复用现有签名状态协议，委派后台每 10 秒扫描，每轮最多 8 项查询，已接受操作在接单后进入待查。迁移 0105 由工具生成，保存签名报告、本地验证时间、错误、领取标识与下次查询时间，并为待查操作建部分索引；已有已接受操作也自动纳入。每次查询以原提交人的当前组织读取权限授权，保存前复核信任和有效期。公开列表只增加 preparation/workflow 与更新时间、脱敏错误，不返回 JWS 或执行身份；原实时 GET 保持只读兼容。

30 秒领取和退避持久保存，并发 Server 使用 SKIP LOCKED；迟到成功/失败都不能覆盖后来领取的结果。断线保留上次可信报告，未知状态不当作计算失败，accepted 和预算不变。completed/failed/cancelled 停止后台轮询；未绑定、waiting/blocked/resolved、排队和 cancelling 继续。服务重建可接替过期领取，不声称已验证真实进程崩溃。签名终态只是对端声明，不能代表文件已到、结果正确或结算完成；普通 Workflow 尚未消费这些快照。

验证：5 个新增隔离 PostgreSQL 用例与 4 个原实时状态查询回归用例通过，覆盖真实数据库/签名/权限、后台 worker 调用、未知状态、断线保留与服务重建、过期领取和迟到成功/失败、全部终态及非终态、权限/密钥撤销、伪造及过期响应、组织隔离。首次终态用例夹具遗漏 preparation 必填 blocker，修正后定向通过；不把失败计为通过，不重复累计用例。网络为服务内发送替身，本轮没有重跑已通过的双平台结果搬运，也不是普通 Workflow 自动委派验收。证据在本机 temp/federation-status-sync-pg.log、temp/federation-status-sync-terminal-pg.log、temp/federation-status-sync-trust-pg.log，临时 PostgreSQL 均已停止删除。

全仓类型检查（含 protobuf 生成和 Fabric 测试）通过，最后新增信任测试后 Server 定向复查通过；lint 无错误，保留原有 47 warnings、1 info；637 个本地文档目标检查通过。未修改 main 或现有部署，尚未发布 PR 预览。下一项需补齐受授权的动态输入清单交换，再将持久状态及回传文件接入普通 Workflow；仅发送摘要并预置两端材料不能替代自动委派。

## 动态输入清单与环境锁交换

接收方准备后台在 DATA_WAITING 时自动按原委派的两个摘要拉取 inputs/environment-lock。新增固定机构路由 /federation/v1/materials 与独立 material-query/material-chunk 密钥用途；旧信任记录不自动扩权。源站限制已接受操作、原接收机构与原任务摘要，逐次复查原提交者权限、双签协议、原委派签名、材料映射、取消和执行期限。目标复用原准备/执行事务检查，传输前后及最终登记时核对原身份、协议、取消、信任和端点。

保留单清单 1 MiB 上限，每个签名响应携带最多 64 KiB 原始字节的 base64，仍在原 256 KiB 签名正文限制内。拒绝查询重放、偏移/长度变化、损坏内容、无效 UTF-8 和摘要/schema 不符。本次缺失清单全部完成后一次登记及审计，最终不得超过最后一次查询截止；没有部分清单或断点续传表，中断后重新获取小清单，并发导入按内容地址去重。软件/模板及数据本地映射、许可、使用授权不由接收清单自动授予，大文件内容不走此通道。

隔离 PostgreSQL 新增 6 个不同用例通过：大于单消息上限的 Unicode 清单、精确 1 MiB 边界、生产准备 worker 调用与真实私有 ingress handler、专用密钥用途、双清单原子登记、并发去重、中断重拉、无映射仍等待、错误机构/任务/摘要、源端取消、签名损坏/错序/重放、授权撤销和截止拒绝。准备/绑定回归共 7 个不同用例通过；其中两项最初因定向筛选遗漏前置映射夹具失败，补入依赖后通过，不将失败计为通过。新密钥用途一度超过旧列表 max(14)，已同步为 16。真实 Node mTLS 网关/发送器 7 项通过，新增路由固定路径及证书检查；网关断言计数随新增路由由 6 改为 7 后定向通过。

全仓其余包类型检查通过，Server 测试可选 path 缺少类型收窄已修正，最终 Server 与 Fabric 测试类型检查通过；lint 无错误，保留原有 47 warnings、1 info，637 个本地文档目标检查通过。数据库仅扩展密钥用途 JSON 的 TS 类型，没有新增物理 schema 或迁移。单元证据在本机 temp/federation-material-*.log，临时 PostgreSQL 均已清理。

真实双平台新增验收通过：接收方初始 federationMaterials 为 0，仅源站保存本次输入/环境锁；两个生产 Server、独立数据库、机构双向 mTLS 网关和两个真实 Agent 自动完成清单获取，接收方登记 2 份材料后启动 Kubernetes 两节点工作流。实际产物 42\n → verified:42\n，原子回传到源站独立 RustFS 云盘并通过普通下载 API 取得 12 字节，SHA-256 为 87730d8e29a90b06728319cb30fcf8dbae523f785f3043c82ea4df6386c83f7f，回执 recorded。源站自动状态同步也实际保存 completed、verifiedAt 与 nextAttemptAt=null；重复提交/导入仍只有原运行和原文件。

操作 58dabb4b-c146-44ec-84fe-b4f8cc3905fc，Workflow 13795a01-2b07-4ddb-b277-7c55cc20539a，导入 0c890084-553d-4d58-ba78-eb2d7f0f9394。证据在本机 temp/federation-material-live-platforms/material-exchange-evidence.json、result-delivery-evidence.json 与相应运行日志。临时进程、数据库、凭据均清理，并确认异步删除的 namespace 最终消失。本次在同一主机，计算限 1 CPU/128 MiB，模板与运行时映射预先批准；没有 Spack 编译、Fabric 或普通源站 Workflow 自动委派，不据此声称全部蓝图完成。未修改 main 或发布预览。

下一项接入普通 Workflow 的联邦节点/执行位置、动态 invocation 持久绑定、取消及恢复，并将已回传文件转换为下游可用的受管产物。输入清单交换已经接通，但本地云盘 File/FileBatch 到跨站受管输入的自动授权交付仍需完成。

## Workflow 的可恢复外部等待

接入源站 Workflow 前发现现有引擎只能终态或整体中断，无法让一个远端等待节点让出本地执行而继续无关分支。已增加 WorkflowNodeWaiting 与聚合的 WorkflowExecutionWaiting：执行者须先持久化外部意图，引擎记录动态路径及受限原因，在完成可运行分支后让出。等待节点及其下游不写成功/失败/跳过 checkpoint，恢复时仅重新进入未完成节点；已完成节点及选定分支复用原 journal。ForEach 等待迭代仍占 maxParallel 名额，避免把等待释放误当成可无限提交新远端作业；While 顺序及 SubWorkflow 路径不变。真正的基础设施中断仍停止其他副作用。

迁移 0106 由 drizzle 生成，在运行表保存 waitingInvocations 快照，受原执行 lease 保护；状态继续为 running，完成时间/result 不提前填写，错误码区分 WORKFLOW_WAITING 与恢复故障。最终完成/失败/取消时清除；取消仍等待已有停止回调确认。快照不是 invocation→远端操作的唯一绑定，这项持久绑定及源站联邦节点/取消转发尚未实现。

引擎/检查点组合 81 个不同测试通过（新增 4 项），覆盖独立分支、等待下游、循环并发槽位、恢复不重跑、嵌套 While/SubWorkflow/Switch、直接输入引用与基础设施故障。嵌套夹具最初错误使用不存在的 Last 聚合值，改用 While 原输出语义后定向通过。隔离 PostgreSQL 的新等待用例已验证持久路径/原因、服务重建、恢复不重放以及未确认停止时保持 cancelling；新增关系夹具补齐必填 slotRelations 后通过。原有后台恢复测试暴露 5 秒扫描周期与 Bun 默认 5 秒超时冲突，已将该测试上限设为 10 秒，未调整生产周期。

隔离 PostgreSQL 的 execution-journal/durable-runner 共 18 个不同用例最终通过（新增 1 项），修正夹具与扫描超时后只复查失败项。全仓类型检查通过（含 protobuf 生成和 Fabric 测试）；最终 lint 无错误，保留原有 47 warnings、1 info，637 个本地文档目标检查通过。证据为本机 temp/federation-workflow-wait-*.log；临时数据库已清理。等待用例使用生产 runner/engine 与数据库，执行者和停止确认回调为替身，尚不构成普通 Workflow 真实跨站验收。

## Workflow 持久委派绑定与取消

源站内部 enqueueForWorkflow 已按 runId/动态 invocation 固定远端操作、任务与第 1 次尝试，保存原请求和配置摘要；重复调用、服务重建及同名循环节点恢复均复用原身份，其他迭代独立绑定。绑定与签名出站分两次持久化，出站最终提交仍在原执行 lease 内完成并复查当前运行、提交者、组织、权限、协议和材料。绑定后未入队的窗口不会丢失意图，也不会在取消后派单；过期入队失败保留原截止时间，不自动续期。普通委派入口拒绝绕过 Workflow lease 重放绑定请求，接收方运行不得隐式再委派。

取消已接入生产 Workflow 回调，与本地 Job 停止共同推进。内部取消权限来自父运行已持久进入 cancelling，并核对原所有者、组织与完整绑定；原提交者撤权不阻断系统停止。已入队任务必须取得对端签名 stopped 回执；未知任务仍走接收方永久撤回机制。完成/失败/取消/中断收尾增加远端检查，防止遗留任务仍在运行时本地提前终态；签名与机构信任失效会保留待处理状态，不宣称停止。迁移 0107 由 drizzle 生成并在隔离 PostgreSQL 执行。

新增 6 个不同隔离 PostgreSQL 用例、9 个既有出站/取消用例及 9 个 durable runner 回归最终通过。覆盖并发幂等、恢复保留期限、动态迭代、意图冲突、组织/用户隔离、旧租约、禁止隐式再委派、绑定后取消、无出站记录恢复、到期拒绝、撤权后停止、无回执不终态、失败清理及取消后的派发阻止。首轮夹具遗留的待发任务干扰后续 worker，已在测试结束时推迟这些测试任务的发送；另修复查询缺少 FROM，以及 Drizzle 在 UPDATE 表达式中移除列限定后导致同名列歧义的问题。最后仅复查受影响用例及实际改动的 runner 回归，不把失败计为通过。

全仓类型检查通过（含 protobuf 生成和 Fabric 测试）；lint 无错误，保留原有 47 warnings、1 info；638 个本地文档目标检查通过。

测试使用真实数据库、生产签名/权限/协议服务，跨站发送为服务内替身；服务重建不是实际进程崩溃验收，本轮没有运行真实集群或 Fabric，也没有重跑已通过的结果文件搬运。本机证据为 temp/federation-workflow-binding-*.log，临时 PostgreSQL 已停止清理。普通 Workflow 联邦节点、结果导入到下游输出以及本地动态文件输入的授权交付仍须继续接入；本轮是可恢复副作用边界，不是完整自动委派交付。未推送、发布预览或修改 main 部署。

## 普通 Workflow 联邦节点与回传文件消费

新增显式 Federation DSL 节点和生产执行者，以已批准模板、输入清单、环境锁、资源和金额上限提交。普通异步提交递归检查 Loop、Inline/ByVersion 子工作流并自动固定 durable-v2；无当前组织/规范用户时拒绝提交。运行恢复调用原持久 binding，消费后台签名状态；未知状态保持等待，completed 不代表文件已到。声明的 File/FileBatch 输出在自动导入、整单发布、所有者/成员/大小/摘要/本地版本检查后才变为源站受管文件引用，供普通下游使用。Web 已同步节点渲染、中英文名称和文件端口；配置暂通过 YAML，未添加无效占位节点或假装已完成协议选择表单。

结果入队复用原导入服务和稳定操作 ID，在网络查询返回后的最终事务复查 Workflow lease，取消不能留下迟到副本任务。取消同时停止原提交者的未完成导入，保留已发布文件及其他用户副本；远端已 stopped 但本地短期搬运授权仍有效或清理未确认时，父运行继续 cancelling。远端 failed/cancelled 也不能替代停止回执。接收方物化明确拒绝 Federation 再委派节点，防止模板未经批准跳往第三站。

新增 6 项不同隔离 PostgreSQL 联邦节点测试、1 项普通提交自动 durable 测试，以及既有 durable runner 9 项通过；新增 DSL/嵌套模式选择 3 项与原 async runner 19 项通过。生产 shared engine/runner + 数据库验证远端等待、结果等待、恢复不重跑无关分支、下游 Script 获得本地 FileBatch、自动排队去重、网络返回与取消竞争、错节点输出/覆盖版本/删除/撤权拒绝、远端失败及本地副本清理。首次清理夹具未等短期授权过期，改为推进测试时钟后通过；增加其他用户副本隔离时，预期状态应保持原 transferring 而非 pending，修正断言后定向通过。类型检查发现 executor 只接受成功/失败结果，已将远端独立撤回映射为节点失败并走父运行清理，未扩宽公共节点终态类型。

上述 PG 测试中的远端网络、存储和下游 Script 执行仍为替身，不能代替真实双平台作业验收。静态输入清单的自动委派/回传已实现，动态参数、源站 File/FileBatch 输入授权交付、真实多调度器与 Fabric 联合、完整管理 UI/CLI 及 PR 预览仍须完成，不缩小总交付目标。

真实普通 Workflow 双平台验收通过：使用源站正常 POST /api/workflows 提交 Federation + NoAction 文件接收节点，没有调用委派 POST 或结果导入 POST 发起任务。两个独立生产 Server/数据库、双向真实 mTLS 网关、两个注册 Agent 和独立 RustFS，接收站从零清单自动取得输入与环境锁，运行两个实际 Kubernetes Script 得到 42\n → verified:42\n。源站节点消费后台签名 completed 后自动排队回传并恢复，remote/consume 均 Succeeded，waitingInvocations 清空；源站普通云盘下载取得 12 字节，SHA-256 87730d8e29a90b06728319cb30fcf8dbae523f785f3043c82ea4df6386c83f7f，对端接收回执 recorded。后续重复导入请求只验证去重，未用于发起本次搬运。

源站运行 1ea538a7-f707-428e-8b76-b0cc628b1947，委派/导入 ad7e4953-9950-4e93-8acc-4c423fa85792，源站文件 033dba6d-4597-41c6-9830-e6a20cce8c53。本机证据为 temp/federation-workflow-live-platforms/source-workflow-evidence.json、result-delivery-evidence.json、source-workflow-result.json 与 temp/federation-workflow-live-run.log。源站下游为 NoAction 文件就绪检查，远端两个 Script 才是真实计算；普通下游 Script 接收本地文件的数据库用例仍使用执行替身，不混作源站真实脚本验收。两站位于同一主机，远端计算限 1 CPU/128 MiB，无 Spack 编译或 Fabric，不声称 Slurm/PBS、多主机或全部蓝图完成。

全仓其余包类型检查通过；Server 两个新增终态类型问题修正后，最终 Server 定向类型检查通过，Fabric 测试类型检查通过；lint 无错误、保留原有 47 warnings/1 info，639 个本地文档目标检查通过。临时服务、数据库、凭据已清理，并确认 namespace 已删除；未推送、发布预览或修改 main 部署。

## Workflow 动态标量输入

Federation 节点新增可选 Text inputSlots，复用普通工作流的参数、上游输出、sources/select 和循环 CEL 绑定，保留字符串、有限数值与布尔类型。optional 缺失时保留基础清单参数；文件句柄、对象/数组、null、非有限数值以及 File/Dataset/contents 输入拒绝。参数描述符与联邦清单使用同一校验，静态检查覆盖重复输入和关系目标，不能靠本机文件 ID 绕过跨机构交付。

源站在原运行租约和所有者检查下，以 delegation.submit 权限派生不可变输入清单，无需额外 asset.map 权限。只覆盖 parameters，数据/软件绑定和环境锁不变，合并后仍限制为 1 MiB。审计仅记录摘要和 derivedFrom，不包含参数正文；原清单不修改。不同循环调用分别绑定，恢复重用相同规范化摘要和原操作；同一 invocation 输入变化明确拒绝。源清单缺失保持 DATA_WAITING，不再误标为 RESULT_WAITING。

本轮数据库验证沿用已完成的 5 个隔离 PostgreSQL 用例结果，未重复运行：参数类型和基础清单保留、审计不含正文、无 asset.map 仍可提交、恢复及不同循环调用、意图冲突、文件/超限/跨组织/环境锁修改/取消拒绝与等待原因；另含既有并发幂等回归。共享执行器两项动态输入用例已通过，涵盖实际循环执行、来源选择、可选值和提交前拒绝；新增一项 DSL 用例验证输入约束、关系目标和重复描述符。初次来源选择夹具缺少节点成功状态，修正后定向通过；新增 DSL 夹具初次使用错误的参数类型和传输策略格式，按现有契约修正后通过。原单元运行中的其他 39 项已通过，不重复累计。

全仓各包类型检查最终通过（含 protobuf 生成和 Fabric 测试）：首次 Server 检查发现测试缺少 inputs/environment-lock 类型收窄，补显式检查后仅复查 Server 通过。Lint 无错误，保留原有 47 warnings/1 info；640 个本地文档目标及文档内动态参数 YAML 静态校验通过。本机日志为 temp/federation-workflow-parameters-*.log，未推送、合并或部署。

本轮未启动真实双平台、集群作业或 Fabric，数据库跨站发送仍为服务内替身；这些结果不等于动态参数的真实跨平台验收。源站动态 File/FileBatch 输入的授权交付仍待完成。实现和用法见 [普通 Workflow 联邦节点](implementation.md)，当前以 YAML 配置，无新增管理表单。

## 动态参数真实双平台与进程恢复

普通源站 Workflow API 提交 Generate → Federation → NoAction，源站生成 8，覆盖基础输入清单的整数 6；目标站从零清单自动取得派生清单与环境锁，两个真实 Kubernetes Script 计算 56 并生成 verified:56\n。源站在已接受委派且 invocation 持久等待后被 SIGKILL，原数据库启动新的生产 Server 后恢复，三个节点均 Succeeded，waitingInvocations 清空。委派 UUID、预留和目标 Workflow 均保持唯一，实际回传 12 字节，经普通云盘下载核对 SHA-256 eef7fb5680468789fb1baa5c3478620cd7bfe6ae579385380f7c2dfb152fe4c6，对端签名接收回执 recorded。

源站运行 4b5fdcc9-28db-4860-aa2d-5136ddeff405，委派 208c5a73-0933-4ae8-b598-573704973d56。本机证据 temp/federation-parameters-live-platforms/dynamic-parameters-evidence.json、source-workflow-evidence.json、result-delivery-evidence.json 及 temp/federation-parameters-live-run.log。两个独立 Server/数据库、真实 mTLS 网关、Agent 与 RustFS 位于同一主机，计算限 1 CPU/128 MiB；源站下游为文件就绪检查，无 Fabric/Spack/Slurm/PBS，不作为全套联邦交付或所有崩溃窗口的证明。临时进程、数据库、凭据均清理，已确认 namespace 消失。

第一次验收在源站重启失败：SIGKILL 遗留 ingress.sock 导致 EADDRINUSE，已保留失败日志 temp/federation-parameters-live-run-before-socket-fix.log。修复后上述用例通过。最终 Server/Adapter 共用私有 Unix socket 启动工具：Linux 上持有稳定 .lock 文件的内核 flock，探测 ECONNREFUSED 后才清理本 UID socket，再完成绑定及权限设置；活跃监听、探测不确定、普通文件/符号链接、锁不安全或缺 flock 均拒绝。锁文件保留但文件描述符关闭/进程死亡即释放，不使用网络命名空间内的锁代替共享卷锁；非 Linux 保持原路径占用拒绝行为。

最终公共工具已通过 3 项真实 Node 进程测试，包含 SIGKILL 的启动锁释放、活跃监听保护、缺 flock 拒绝以及实际 unshare 独立网络命名空间竞争；Server/Adapter 相关 5 项测试通过，Bun ingress 用真实子进程留下 socket、并发恢复、活跃监听和非 socket 路径保护。双平台测试完成后，仅对改用共享文件锁的最终实现定向验证，未重复跑整套远端计算。Fabric 数据库验收脚本去掉手工删除 socket，并改为实际 /health 就绪探测；该修改后的真实 Fabric 联合脚本尚未重跑。镜像增加 util-linux，尚未构建新镜像。源站动态文件输入授权交付及其后续完整目标仍待完成。全仓各包类型检查通过；Fabric 验收脚本健康响应的 unknown 类型收窄修正后，Fabric 测试定向类型检查通过。Lint 无错误，仍为原有 47 warnings/1 info；641 个文档目标检查通过。检查证据在本机 temp/federation-unix-startup-*.log。

## 动态文件源站快照与签名清单

增加不可变源站输入快照（工具生成迁移 0108），按原运行和动态 invocation 保存当前用户的版本化云盘文件。相同调用恢复复用原 exportId，不同循环调用独立；固定对象版本、key、SHA-256 和大小，任何替换、删除、转移所有权或撤权均拒绝。File/FileBatch 的相对别名、重复/重叠路径、描述符、总数及安全整数总量都在保存前验证；没有对象版本保持 DATA_WAITING。内部重查持有源文件共享行锁，防止事务内并发删除，并核验私有映射与两个摘要一致。审计只记摘要、数量和总量，不写源文件位置。

双签协议新增可选 inputPolicy，明确 workflow-input-files 范围、最大文件数和总字节数；旧协议不自动取得披露权。内部 Workflow 委派先捕获选择，再签署 inputFilesDigest；授权时按同一运行/动态路径/节点定位快照，普通 API 或其他 invocation 不能仅凭摘要借用快照。复用现有机构 materials 路由披露第三份清单，仅限已接受任务的接收机构；签署前后复查协议、信任、原请求、权限、取消、执行期限和固定版本。可传输清单不含源文件 UUID、用户、存储 key/versionId 或下载地址。

接收端在实际文件导入未接通时保持 DATA_WAITING，executionSnapshot 拒绝产出执行定义，防止只取得清单便开始计算。当前不开放普通 Federation DSL 文件输入；目标配额、字节下载授权、实际搬运/校验、原子发布与执行身份映射仍须完成。没有把输入伪装成结果回传，也没有启动真实集群作业或 Fabric。

验证：源站快照 6 个不同隔离 PostgreSQL 用例通过。第一组 5 项通过；第六项最初只因断言未读取 Drizzle 包装异常的 cause 失败，按 PostgreSQL 锁错误码修正后定向通过。新增签名清单 4 个不同数据库用例通过，覆盖同调用重放、拒绝借用快照、普通 API 绕过、双签缺失和限额、原任务/机构绑定、版本变化、删除/所有权/撤权/取消、隐私及接收方等待。首项测试先修正缺失 material 验签用途的夹具，后移除与该用例无关且超过测试预算的第二个委派；循环快照独立性已由快照用例覆盖，仅复查失败项，不重复累计成功项。网络为进程内发送替身，使用真实数据库与签名，不能代表文件字节端到端交付。临时 PostgreSQL 均按 finally 停止并删除；证据在本机 temp/federation-input-exports-*.log 与 temp/federation-input-inventory-*.log，不入库。

修改了共用出站授权与材料披露路径，因此定向回归既有并发委派恢复及材料交换 7 项，全部通过，包括 1 MiB 边界、Unicode 分块、专用密钥用途、网络返回后的撤权复查和损坏/重放拒绝。未重跑先前已经通过且未改动的真实双平台计算。

全仓类型检查中其余包通过，Server 发现新增测试对 optional 摘要缺少类型收窄，改为断言已验证查询的必填摘要后，Server 定向复查及 Fabric 测试类型检查通过。Lint 无错误，保留原有 47 warnings/1 info；最终修改文件格式检查通过，642 个本地文档目标检查通过。未推送、发布 PR 预览或修改 main 部署，完整目标继续保留。

## 输入文件短期下载授权与对象身份隔离

源站新增独立 input-download-query/input-download-grant 协议和私有 `/federation/v1/input-downloads` 入口，已接 Node mTLS 网关、发送器 allowlist、Server 生产构造及独立 FEDERATION_INPUT_DOWNLOAD_ORIGINS 配置，默认关闭。信任用途列表扩展到 18 项，旧记录不自动扩权。查询绑定原任务/接单、请求与文件清单摘要、输入描述符/相对路径/大小/SHA-256，以及接收方 transferId/generation；不能借用普通材料或结果权限。授权复用源站材料披露的原任务与当前双签检查，存储 HEAD/presign 前后均复核双方信任/用途、权限、取消和固定文件版本。新增目的/来源相互独立的配置未引入数据库物理迁移。

只签发固定 versionId 的 HTTPS 地址；存储必须返回同一版本与大小，URL 的实际 S3 凭据期限须与响应相符。最长 30 秒且不得晚于查询、原执行授权、协议或签名密钥期限；不把超长 bearer URL 包在短期信封里。Server 不中转文件正文，不存储下载 URL/响应 JWS。已发地址仍可能有效至短期截止，撤权保证拒绝续发，不宣称已发凭据即时失效。

检查真实对象路径发现普通云盘把 owner UUID 编入 storageKey，直接分享会暴露源平台账号标识。新单次/分片上传现统一使用 netdrive/objects/随机 UUID；所有权、commit token、配额与原用户路径仍由原服务校验。旧路径没有重写，本平台操作继续兼容，但联邦输入下载明确拒绝；匿名导出副本转换仍待补齐，不能通过改写源文件版本或活动快照绕过。随机 federation-results/导入UUID/尝试UUID 的已回传文件也可作为输入来源。

验证：4 个新输入下载数据库用例通过，覆盖实际 ingress 的 no-store/默认关闭、签名任务及尝试绑定、固定版本、账号/路径不泄露、无凭据审计落库、错误文件/任务/机构、过期查询、旧身份 key 拒绝、缺失/替换存储、来源白名单、实际凭据 TTL、网络 I/O 后的双方专用用途撤销、用户撤权、文件版本变化和取消。存储为元数据/签名地址替身，无真实字节搬运；仍未接收端持久尝试校验与副本发布，不作为文件交付完成证明。

云盘单次/分片上传、commit token、配额、所有权隔离、旧文件读取和版本下载等 53 项数据库回归通过。因共用材料授权和下载 URL 校验提取，另验证既有结果下载 6 项、材料交换 6 项、输入清单 4 项。组合运行暴露旧 worker 测试会处理同站点的其他夹具：初次材料数从 2 变成 3，改为按当前摘要计数后又发现共享环境锁已被其他任务导入，当前任务新增审计数只有 1。最终把该测试的传输回调限定到本夹具，保留两个新材料/两条审计的原断言，并带上触发污染的前置用例复查通过；不改变生产去重/worker 逻辑，不重复累计成功用例。新增 I/O 中版本变化断言随定向回归通过。

配置与真实 Node mTLS 网关/发送器 44 项检查通过，包含新路由和带 query 的伪造路径拒绝。全仓类型检查通过（含 protobuf 生成及 Fabric 测试类型），lint 无错误，仍有原有 47 warnings/1 info；最终测试夹具格式检查通过，643 个本地文档目标检查通过。临时 PostgreSQL 和 TLS 进程均已清理，证据在本机 temp/federation-input-download-*.log，不入库。未启动新的真实集群/Fabric 作业，未发布 PR 预览或修改 main。

后续仍需接收端的持久输入导入、源站匿名旧对象导出、实际 Agent 搬运与独立目的校验、整单发布/执行身份映射及真实工作流验收；文件型委派继续 DATA_WAITING。完整目标不因本轮下载授权完成而缩减。

## 接收端输入清单持久化与配额收尾

准备后台已接收 workflow-input-files 第三份清单，复用分块拉取/验签与原任务授权，规范 JSON、schema 和内容摘要均通过后才登记。材料交换共用接收实现，增加网络返回后与最终登记时的双方签名用途复查。输入清单单独保存到 federation_input_imports（工具生成迁移 0109），按已接受 reservationId 唯一绑定接收机构和原执行服务账号，不进入组织材料目录；仅保存任务声明的文件别名/类型/大小/SHA-256，不保存源文件 ID、存储位置或下载 URL。

按全部成员的逻辑大小一次预留空间，独立检查双方 inputPolicy、单文件 5 TiB 上限及本地云盘配额。新预留与普通上传提交、结果导入共用 cloud-storage 用户锁，统一统计 reservedBytes；并发不同任务不能合计超过剩余空间，同任务重试或服务重建不重复预留。登记后仍重查查询有效期和授权，失败整单回滚。恢复还核对保存的身份、摘要、清单、预留字节与原执行截止，拒绝损坏记录。空 FileBatch 保存为显式空选择。

目前 pending 没有对象存储副作用。准备 worker 每轮先复查至多 8 项待导入，SKIP LOCKED 和持久 nextCheckAt 限制并发领取，至少间隔 30 秒；明确取消、到期、撤权或记录冲突会将未开始意图设为 cancelled 并释放预留。临时后端故障只记脱敏错误、保留空间，后续成功复查清错；不将暂时不可用当撤权。取消监视器在没有远端 Workflow 时也可收尾输入意图；停止状态检查把未收尾输入算在内，原接单/计算预算不删除。已经取消的输入在账号恢复后继续使准备状态 blocked，不重新抓取或重开原意图。

新增 8 个不同隔离 PostgreSQL 用例通过，覆盖实际准备 worker 的接线、私有清单与身份、重试/服务重建/并发幂等、不同任务和普通上传的共享配额、未绑定 Workflow 的签名取消与停止门槛、损坏清单/预留拒绝、网络返回时撤销执行身份与双方签名用途、到期、临时后端故障保留及恢复、空批次与取消后禁止自动重开。补充取消后 blocked 的断言后只复查对应用例，不重复累计。

因修改共用配额、取消和材料交换路径，执行存储配额 8 项、云盘 53 项及原取消/结果配额清理/材料交换 15 项回归，全部通过。没有重复运行上轮未改动的真实 TLS 或集群作业。测试中的签名与数据库为真实实现，网络和存储为受控替身；没有字节搬运、远端文件发布或计算，不能作为文件输入端到端验收。临时数据库均由 finally 清理，证据为本机 temp/federation-input-imports-*.log。

全仓类型检查通过（含 protobuf 生成及 Fabric 测试类型）；最后补充接收用途撤销测试和取消后的准备阻断后，Server 定向类型检查再次通过。最终 lint 无错误，仍为原有 47 warnings/1 info；643 个本地文档目标检查通过。

下一项须增加传输成员和尝试持久状态、接收端下载授权验证、Agent 搬运/独立目的校验，以及带清理确认的取消/发布。在引入上传副作用时必须原子离开当前 pending 状态，不能沿用未开始意图的直接释放规则。文件委派继续 DATA_WAITING，源站旧对象匿名转换、DSL 文件接入、真实工作流验收和完整蓝图仍待完成；未发布 PR 预览或修改 main。

## 尚未接通，不能宣称支持

协议审批与机构信任管理 UI、额度结算/退款、完整的数据/软件物化与介质交付、双方证据确认与完整用量/结算记录、商业/市场链码及真实联邦作业与 Fabric 联合运行、归档恢复、完整 Web/CLI 和部署交付仍未完成。接收输入的未知存储请求现有受信任管理员核对入口，见后文；Web 表单和更广的归档/维护交付仍待完成。

普通 Workflow 自动委派、动态标量和文件输入、原身份映射及结果回传已接通，小文件真实双平台 Kubernetes 验收见后文。仍须验证 Slurm/PBS、受管科学软件安装/环境锁、真实运行恢复和撤权的完整组合；不能用 Bash 沙箱测试替代。完整交付须通过全部验收，当前尚无 PR 预览。


## Agent 输入文件复制与独立目的校验

增加输入任务/逐次授权/复制回报/目的校验协议及 Agent 内部入口。输入成员保留独立 descriptor/path 与清单/委派/尝试身份，不伪造 result-report/outputId。源站原 input-download-query/grant 协议未变。结果搬运与输入复用底层私有 staging、Range 下载、SHA-256 校验、multipart 上传及目的重新读取；原结果调用接口与错误类兼容，结果对无版本存储的支持保留。

输入目标要求真实固定 versionId，使用 If-Match 和响应 ETag/version 校验后逐段重新计算摘要，不能用上传回报或 HEAD 代替内容证据。空文件也需要下载授权与目标读取；跨尝试/成员/清单授权、非允许 origin、重定向、长效或过期授权均拒绝。取消中止网络 I/O 并清理本地临时目录；Server 端对象/分片清理与配额释放仍须单独确认。

验证：现有结果传输/AgentStream 与新增输入真实 HTTPS 测试共 17 项通过，新增 6 项覆盖 5 MiB + 123 字节的 6 次 Range/2 次 PUT、目标 6 次独立 Range、空文件、各身份字段串单、错误上传分片、源/目的损坏、对象版本变化、缺少版本、超限/过期任务、授权撤销、取消/到期挂起读取与临时文件清理。授权回调与存储完成仍为测试替身，不是生产输入搬运或完整联邦验收。首次提取遗漏下载 SHA-256 的变量引用，已修复并通过全部受影响测试；拒绝用例收紧为具体错误码后，新增 6 项定向复查通过，不重复计数。全仓类型检查中测试夹具的 Buffer 泛型不匹配已修正，Agent 定向检查通过，其他包及 Fabric 测试类型检查通过。lint 无错误，保留原有 47 warnings、1 info；文档 643 个本地目标检查通过。证据保存在忽略目录 temp/federation-input-agent-*.log。未改数据库/生产协议能力。

Server 的成员/尝试持久状态、源站授权响应验签与活动尝试绑定、Agent 传输能力及输入/结果共享并发限额、取消后存储清理、整单发布和执行身份映射仍待接入。普通文件委派继续 DATA_WAITING；原 pending 意图尚无对象副作用，其取消规则未放宽。完整蓝图目标保持，尚未发布 PR 预览或部署 main。


## 接收端输入传输代次与存储清理

清单准备事务现同步登记输入成员，按 descriptor/path 固定大小、SHA-256、partSize；老的未开始清单可以初始化成员，部分/变更成员拒绝自动修复。独立 federation_input_transfers / federation_input_attempts 保存每代 Agent、对象 key、一次性分配许可、uploadId、截止和清理 token；[迁移 0110](../../../packages/db/migrations/0110_luxuriant_smasher.sql) 由 Drizzle 生成并已从空库执行。输入和结果开始传输共用 Agent advisory lock 与活动租约检查，防止两个方向或多个 Server 同时占用搬运资源。

input-storage 的分配在数据库锁外进行，前后复查原协议、执行身份、清单、Agent 归属和活动代次；不凭保存在内存的旧授权派发。未知分配结果保留配额和原 key，迟到响应写入原代次，重试同一成员前必须清理旧尝试；新代次使用新的 key。分配许可未发出时可以证明没有存储副作用；已发出但没有 uploadId 的情况不能凭一次空列表释放配额，自动发现与核对这类未知分配仍待完成。

取消监视与授权扫描现封锁 active 输入并进入 cancelling，旧租约到期和全部尝试清理确认后才变为 cancelled、释放配额及允许 stopped 回执；取消不会因重新启用身份而重开。准备后台已接入到期与清理；MinIO 独立输入清理入口仅接受精确 federation-inputs key，删除全部上传/版本/删除标记并复查为空。失败不确认，旧清理 token 不能覆盖当前 worker；不改原结果存储命名空间和普通云盘。

验证：新增 10 个隔离 PostgreSQL 用例通过，覆盖成员幂等、服务重建、并发领取、输入/结果共享 Agent 槽、撤权/归属、串单/成员损坏、取消停止确认、到期与迟到分配、旧清理确认、清理失败保留额度、分配 I/O 不持数据库锁及无副作用失败后的重试。首轮 3 项失败由测试使用 60 秒执行截止却试图在租约后重试引起，已为传输夹具签署独立长期执行截止，原短期接单/到期用例不变。原输入导入 8 项、结果导入/存储/配额及工作流取消回归 13 项通过，独立清理命名空间及既有结果清理 3 项通过。复查发现旧租约续期可能与新领取交错，输入与结果的续租/进入验证已改为共用同一 Agent 锁；新增真实 PG 锁等待用例通过，过期旧尝试不能被续活。超时分配错误分类的定向复查也通过，不重复计数。续租改动后的结果组装/目的验证 4 项回归通过。全仓类型检查通过，最后的 Server 改动已定向复查通过；最终 lint 无错误，保留原有 47 warnings、1 info；644 个文档本地目标检查通过。证据位于忽略目录 temp/federation-input-transfers-*.log。存储驱动测试使用受控存储替身，不冒充双平台真实字节传输。

实际输入授权读取与活动尝试绑定、Agent 消息/能力、上传完成与目的验证、整单发布/执行映射、未知分配恢复、DSL File/FileBatch 及完整蓝图仍待完成。输入自动派发未启用，文件委派继续 DATA_WAITING；尚未发布 PR 预览或部署 main。


## 接收端输入凭据验证与发放

新增 input-reader：以接收方专用 input-download-query 密钥请求源站固定路由，验证 input-download-grant 签名、完整请求身份与成员绑定；最终事务同时复查当前输入代次/Agent、原执行身份、协议、双方信任/用途及源站地址。不能凭有效源站签名借用其他本地尝试。URL 仅接受允许的源站 origin 和唯一真实 versionId；实际 S3 凭据与信封期限必须一致，最多 30 秒，并受当前租约/查询/密钥期限限制。密钥在响应期间被撤用途或缩短有效期会拒绝披露。

input-storage 新增下载/上传 grant 路径，先按原尝试授权、在共用 Agent 锁内续租，再签发当前 multipart 分片地址。上传 partNumber 受实际成员分片数限制，URL 精确匹配 uploadId/partNumber、目标 origin 和有效期；存储 I/O 后再次检查授权/代次。签名 URL 和 JWS 不持久化，异常消息不携带原始 SDK 票据。

新增 FEDERATION_INPUT_IMPORT_SOURCE_ORIGINS，独立于本地输入存储与结果传输设置，默认空；目标使用本地 FEDERATION_INPUT_DOWNLOAD_ORIGINS。Server/Compose 已接配置与内部服务，未配置凭据功能时仍可准备清单和清理遗留尝试。没有新增数据库迁移或输入 Agent 能力，自动派发保持关闭。

验证：新增 6 个隔离 PostgreSQL 用例通过，覆盖有效双方签名、独立 multipart 地址、签名响应重放/身份替换、版本参数、实际凭据超期、用途/身份/Agent/协议/地址中途变化、密钥缩短、默认关闭、错误分片与 SDK 错误脱敏。检查夹具时发现协议停用误写了不合法状态，会因数据库错误而假通过；已改为 suspended，并将相关负向断言收紧为具体错误码，3 项定向复查通过，不重复计数。源站下载授权、接收端传输/存储与续租的 15 项回归通过，Server 配置 39 项通过。全仓类型检查通过，lint 无错误并保留原有 47 warnings、1 info；644 个文档本地目标检查通过。证据保存在忽略目录 temp/federation-input-grants-*.log。传输与存储使用替身，不冒充真实跨平台文件交付。

后续继续接 Agent 输入消息与共享并发控制、上传完成/独立验证、整单发布、未知分配恢复、原身份文件映射和普通 Workflow 文件输入；完整蓝图与 PR 预览目标保持，尚未部署 main。


## 接收端输入合并与目的验证收尾

输入复制回报现持久固定分片列表，合并前保存一次性请求许可，重试只查原对象；完成响应丢失可按原 key 找回，迟到成功响应也登记到原代次。对象大小/真实版本通过后进入 verifying，按原版本发短期校验凭据，Agent 的独立目的读取回报通过成员/摘要/大小/版本核对后保存 verified。上传或 HEAD 成功不产生云盘文件；取消后回报不能重新启用输入。迁移 [0111](../../../packages/db/migrations/0111_charming_stone_men.sql) 由 Drizzle 生成，并已通过隔离空库迁移。

未知合并结果不释放配额；后台查询取得正向完成证据后，才允许清理原对象及分片并确认。已 verified 的对象不会被普通传输租约过期清理；授权失效/取消仍需存储清理成功才能释放空间。清理失败保留原额度，恢复继续清理。若保存请求许可后尚未发出请求即崩溃，或请求未成功且没有对象，当前保守保留待核对；人工确认停止与安全释放入口仍待补齐，不能直接删除记录。

新增 9 个独立 PostgreSQL 场景通过，覆盖分片/回报幂等与串单拒绝、并发只发一次合并、取消后迟到完成、响应丢失后的服务重建、HEAD 缺失保留、错误大小/无版本隔离、短期凭据和 I/O 中撤权、verified 后取消及清理失败。首次运行有一个包含两组夹具的测试超过默认 5 秒，按仓库 15 秒限时复查通过，随后拆成两个独立场景并再次通过。输入清单、传输、存储、下载/上传凭据及共用 Agent 续租 25 项相关回归通过；不重复累加复查结果。临时 PostgreSQL 已关闭并清理；测试使用真实签名和数据库、受控对象存储替身，不代表真实跨站字节传输。日志位于忽略目录 temp/federation-input-verification-*.log。

全仓类型检查通过（含 protobuf 生成及 Fabric 测试类型）；lint 无错误，保留既有 47 warnings/1 info。最后新增取消场景后的 Server 定向类型检查通过，645 个本地文档目标检查通过。

下一步接输入 Agent 消息/能力协商、后台派发、整单发布与执行身份文件映射；未知存储请求的恢复也要在自动派发前补齐。文件型 Workflow 继续 DATA_WAITING，完整蓝图与真实 Slurm/PBS/Fabric 联合验收目标保持。本项改动在实现分支持续收尾，未推送或部署 main。


## 创建上传响应丢失恢复与输入存储权限

清理 worker 新增原站点、已封锁且租约到期的未知分配扫描。仅接受原尝试专属 key 下唯一 uploadId 的完整列表结果，写回原代次再实际清理；服务重建不重新创建上传，不恢复失效执行身份。空列表、歧义、超限及异常不释放额度，后续可继续查询；与迟到原响应幂等，相异 ID 拒绝。整个存储查询仍在数据库锁外。

真实 RustFS 验收发现部署策略此前只有 federation-results 权限，输入目录的发现/清理与固定版本读取会被拒绝。Docker 和 Helm 共用初始化脚本已补精确 federation-inputs 权限，外部 S3 和已有部署的更新步骤见部署说明；不扩大 netdrive 历史删除或不可变数据删除权限。

新增恢复与原清理共 5 项存储单测、1 项隔离 PostgreSQL 恢复场景及 3 项原分配回归、14 项初始化策略测试通过。使用隔离 namespace、临时凭据和实际非 root RustFS，3 项真实存储测试通过：未知上传发现、空结果与多上传歧义、固定旧版本读取、全部分片/版本/删除标记清理及邻居保留、普通云盘历史枚举/删除拒绝。初次权限失败已定位到初始化策略，修复后上述三项共同通过；临时 namespace/凭据和 PostgreSQL 均已清理。全仓类型检查通过（含 protobuf 生成及 Fabric 测试类型），lint 无错误并保留既有 47 warnings/1 info，645 个本地文档目标检查通过。日志为 temp/federation-input-allocation-recovery-*.log，不入库。

仍有已记录许可但始终没有对象/上传记录的未知请求，需要补明确停止证据下的维护收尾；不能凭空列表自动释放。接下来继续 Agent 输入消息/能力与共享资源限制、生产派发、整单发布和原身份文件映射，普通文件委派仍 DATA_WAITING。尚无 PR 预览，完整蓝图及真实跨站作业/Fabric 联合验收仍未完成。

## Agent 输入协议与后台派发

新增独立输入 Copy/Verify、短期凭据请求/响应及复制/校验回报 protobuf 消息，生成代码由 buf 生成。Server 只有启用联邦、双方输入存储 origins 配置齐全时装配输入 transport/worker；Agent 通过独立默认关闭的 AGENT_FEDERATION_INPUT_COPY 配置 opt in。双方协商复制和目的校验能力，必须核验 mTLS。旧 Agent、仅复制能力和未核验连接不派发。停用新派发不影响原准备 worker 的取消与存储清理。

输入/结果 Agent 客户端共用传输槽与租约/请求关联会话，保持原结果接口；断线/到期中断网络及暂存，迟到凭据不恢复活动。Server RPC 在存储等待期间继续心跳，输入/结果共用两个在途请求上限；旧连接的迟到响应不发给新连接，分配期间被替换的连接留下待清理代次。回报须匹配原 Agent/代次/成员；重复复制与验证回报幂等，仍不产生云盘记录。

输入后台每 10 秒扫描，单轮最多 20 个候选、4 个不同 Agent；新成员及失败后至少等待 30 秒。输入和结果候选都排除另一方向的活动/待清理租约，数据库共享锁继续防止多 Server 竞态。租约过期后实际清理、重新分配新代次；取消或撤权后不重开原清单，未知存储结果仍保留额度。没有跨进程暂存续传；正向存储证据仍缺失的尝试进入保守等待，明确停止证明下的维护入口继续待补。

验证：Agent 配置、真实 HTTPS 复制/目的读取、原结果客户端与 AgentStream 共 69 项通过；会话请求构造简化后相关 7 项定向复查通过，不重复计数。隔离 PostgreSQL 的输入/结果派发、worker、多进程竞争、跨方向候选排除、重连封锁及撤权退避共 8 项不同场景通过；RPC 的输入/结果各 6 种信任/心跳/连接替换场景共 12 项通过。组合运行暴露旧结果 worker 夹具会领取其他测试保留的导入，已限定该存储夹具领取自己的候选、核对自身 key 的清理；新增输入用例比较执行账号文件前后不变，不假设其他夹具没有文件。初次 Agent 类型检查发现新断言的 Buffer 泛型不匹配，已改为字节比较。全仓类型检查在主实现后通过，新增测试后的 Agent/Server 定向检查通过；645 个本地文档目标检查通过；proto lint 与全仓 lint 无错误，lint 保留既有 47 warnings/1 info。数据库测试使用真实签名/事务及受控对象存储，Agent 组件使用真实 HTTPS 字节；两者不是完整双平台输入端到端验收。证据位于忽略目录 temp/federation-input-transport-*.log。

下一步接整单发布、预留转用量、原执行身份下的 File/FileBatch 映射与 Workflow 消费，并完成真实跨站小文件验收。当前 verified 不解除 DATA_WAITING，尚无完整 PR 预览，UI/商业市场链码/结算/介质交付等完整蓝图目标继续保留。

## 接收输入整单发布与撤销配额

新增 input-publication 并接输入后台：全清单 verified 或空 FileBatch 才领取发布，先检查固定对象版本，再获取源站新签名清单；最终事务锁住原执行身份/协议、输入成员与尝试，匹配检查前快照，并在锁等待后复查材料交换的 60 秒披露截止。原成员 UUID 成为本地 fileId，保留原执行账号、descriptor/path、SHA-256 与固定版本；活动路径冲突整单拒绝。共用云盘事务锁完成预留转用量、全部文件登记、available 状态及审计，重试/并发/服务重建不重复发布。每轮最多 4 份发布，失败至少退避 30 秒；迟到 Agent 回报在原租约和权限内幂等，不让 available 回退。

取消已发布输入时仅隐藏原 owner/fileId/key/version，恢复原清单清理预留；重复取消不重复占用，后来替换的文件不被误删。修复检查中发现的 available 状态约束冲突，恢复预留与切换 cancelling 在同次更新完成。存储清理还要求绑定执行和全部作业已终止、取消/撤权确认完成，之后仍须等待原搬运租约到期；存储失败或停止证据缺失不释放额度。运行停止检查从取消回执检查中分离，避免“等待输入清理才能判断停止”的循环依赖。

生成迁移 0112，新增发布时间、后台领取索引及 available 约束；从空库迁移通过。新增/扩展 8 个发布场景覆盖单文件并发重建、空批次、多文件齐全门禁、固定版本/源站或本地撤权/取消/成员变化、路径冲突退避、授权提交前过期、配额下降与替换文件、运行/存储未停止时保留清理额度。连同相关输入验证、Agent 传输、配额与原取消流程，39 个不同隔离 PostgreSQL 场景最终通过；定向复查不重复计数。首轮冲突夹具漏填摘要、重复回报的父状态限制、披露测试误用了下载的 30 秒窗口均已修正。测试清理按当前输入成员 ID 删除本地发布文件，避免污染后续用例。数据库与签名真实、存储为受控替身，不能作为双平台字节/作业验收。证据在忽略目录 temp/federation-input-publication-*.log。

文件型 Workflow 仍 DATA_WAITING。下一步把 published 输入以原身份映射为 File/FileBatch，加入执行快照及启动/恢复时输入状态锁，并验证数据暂存的固定版本读取；之后进行真实双平台小文件作业。未知存储请求维护收尾、UI/治理/市场链码/结算/介质交付及真实 Slurm/PBS/Fabric 联合验收仍属完整蓝图待办，尚未发布 PR 预览或部署 main。

验证收尾：全仓类型检查仅新测试夹具漏填 Workflow input 的 yaml/role，已补齐；其他包通过，最终 Server 定向检查及 Fabric 测试类型检查通过。全仓 lint 无错误（既有 47 warnings/1 info），最终测试文件 Biome 检查通过；645 个文档本地目标及 diff 空白检查通过。


## 联邦派发下载续期保留对象版本

接通输入文件前检查执行路径，发现 FederationDataDispatch 续期只向存储传 storageKey，遗漏云盘记录的 storageVersionId；相同 key 的新对象可能代替原固定版本。现将版本一路传至生产 presignDownload，最终发送锁内同时比较 key 与版本。签出地址后版本改变则本次发送拒绝，重新准备才可取得对应的新地址；原普通无版本记录兼容行为保持。

新增固定版本续期与签名期间版本变化的 PostgreSQL 回归，并运行直接受影响的 NetDrive/data-dispatch 数据库与消息处理用例，共 50 项通过。使用隔离数据库、凭据签发替身，不表示对象存储和完整工作流实际执行。后续除了接收端 File/FileBatch 映射与执行快照锁，还需把源端 Federation 节点的文件槽接入已有签名输入导出；当前普通节点仅接标量参数，不能仅放开接收端 DATA_WAITING。证据位于忽略目录 temp/federation-input-version-*.log。

本项 Server 类型检查通过；全仓 lint 无错误，保留既有 47 warnings/1 info；645 个文档本地目标与 diff 空白检查通过。仍在实现分支，无 PR 预览或 main 部署。

## 普通工作流 File/FileBatch 输入与原身份执行映射

源端 Federation 节点现接 File 槽、批次、空批次和可选输入，继续保留 Text 的标量约束。复用受管产物解析器及已有 input-exports，校验原提交人、动态调用路径、云盘版本和双边 inputPolicy，再把摘要绑定到原委派。源站文件 ID 不进入远端清单，YAML 的大小/摘要不会覆盖本地可信记录。普通生产执行器已转发文件选择；重复执行沿用原快照，文件换版拒绝继续。

接收端新增 published-inputs，在原身份/协议锁内核对 available 清单、成员、已验证尝试和原账号的活动云盘记录；文件路径、大小、摘要、key、版本和 ETag 必须完整一致。receivedInputs 写入内部运行快照，创建/启动/恢复/派发复用并最终持锁复查，取消或文件变更不能沿用旧快照。移除“有输入摘要就永久 DATA_WAITING”的临时门禁，未发布输入仍等待；本地模板映射与其他运行授权仍须齐全。

模板转换支持批准的同名 File/FileBatch 槽、JSON 文件参数及独立 Script 的输入声明；保留上游绑定，拒绝源端静态文件 ID、表达式注入、类型混用、同名标量覆盖和未消费交付项。空批次与缺少可选输入分别保留。检查执行路径时发现静态文件槽未保留批次目录，已增加可选安全 relativePath 并贯穿接收投影、软件用例暂存与原有脚本批次挂载。存储位置留在内部快照，不进入模板投影。

验证：16 个不同隔离 PostgreSQL 场景及 105 项共享执行器/DSL/模板转换/材料暂存组件用例最终通过；定向复查不重复计数。覆盖真实签名与隔离 PostgreSQL 的普通源端执行器、重复快照/换版拒绝、整单发布、空/多文件映射、原身份 held 运行绑定、版本/所有者/删除/验证事实变更拒绝，以及执行快照锁阻止取消穿越。存储仍为受控替身，没有实际启动远端计算作业。初轮测试修正了可选参数上下文、接单回执字段及脚本夹具 entrypoint；对应定向复查通过。最终类型检查与 lint 无错误，lint 保留既有 47 warnings/1 info；文档 645 个本地目标和 diff 空白检查通过。Drizzle 确认只有 JSON 类型扩充，没有新增 SQL 迁移。日志位于忽略目录 temp/federation-workflow-files-*.log。

下一步使用真实双平台与独立存储，把源端云盘小文件经 Agent 搬运到接收端脚本，核对输出回传和原版本，并覆盖中断/撤权。UI、市场链码/结算/介质交付、未知存储请求维护收尾及 Slurm/PBS/Fabric 完整联合验收仍需继续；本轮不等于完整蓝图完成，尚无 PR 预览或 main 部署。


## 真实双平台输入、作业与回传验收

通过普通云盘 API 上传 2 字节 `8\n`，普通 Workflow 的 Federation File 槽自动导出签名清单。接收方初始无清单，后台拉取输入/环境锁，真实 Agent 复制并独立读取校验，发布为原执行身份的本地文件；源端与接收端文件 ID/所有者不同，SHA-256/大小相同，接收版本与原验证尝试一致，发布后预留为零。

接收端两个真实 Kubernetes Script 先读取传入值并生成 `56\n`，再消费该产物生成 `verified:56\n`。源端 Agent 自动搬回持久输出，独立版本读取核对 12 字节与 SHA-256，签名回执为 recorded；Checkpoint 不对外发布，重复导入保持同一副本。源端普通工作流 remote/consume 均完成。源 Server 在接单后持久等待期间 SIGKILL，重启同库后保持原 operation/reservation/run，没有重复执行。

这是两个 Server、两个独立 PostgreSQL 数据库、两个独立版本化 RustFS、机构 mTLS 和两端真实 Agent 的一次完整往返；共用同一宿主机 Kubernetes，使用非 root Bash 沙箱及短脚本，不包含科学软件/Spack、Slurm/PBS 或 Fabric。测试返回零；临时进程、数据库、凭据、RBAC 和 namespace 已清理。脱敏验收证据与运行日志保存在忽略目录 `temp/federation-input-live-platforms/`、`temp/federation-input-live-run.log`。

另一次独立双平台测试在接收端读取真实输入、进入 180 秒 sleep 后，通过源站 API 请求取消。84.5 秒内收到签名 stopped：真实 Job/Pod 已停止并移除，下游从未启动；接收文件留下删除标记，导入 cancelled、预留为零、尝试 cleaned。额外直接枚举真实对象存储确认原 key 无版本/删除标记及 multipart 上传；源站仍可下载原始 8\n，重复取消返回原 stopped。执行停止回执等待期间保持 pending，未凭超时提前释放。日志与证据位于 `temp/federation-input-cancel-platforms/`、`temp/federation-input-cancel-run.log`；测试返回零并清理隔离环境。

两次真实测试均一次通过，本轮没有新增产品代码或迁移，仅更新验收状态和过时文档。未重复运行已通过且未受改动影响的单元测试/类型检查；645 个本地文档目标及 diff 空白检查通过。接下来推进未知存储请求维护、UI/治理、市场链码/结算、介质交付和完整联合验收。完整目标保持，尚无 PR 预览或 main 部署。


## 输入未知存储请求的运维核对与安全清理

新增平台管理查询/登记接口，按原站点、输入清单/成员/代次、对象 key、上传/完成事实及租约生成 snapshotDigest。导入必须已取消且尝试等待清理，租约到期、绑定 Workflow/全部 Job 及取消/撤权回执均停止，才能登记受信任管理员的外部写入停止/存储排空声明；记录停止时间、工单号与证据摘要，审计同事务提交。正常鉴权及 platform manage 权限，不接受机构对端或普通组织角色。列表/详情 no-store，正文严格 schema/4 KiB。

记录是运维信任边界，不能自动验证外部存储排空或管理员证据内容；无可信停止依据时仍须保留配额。后台取得明确核对记录后仍执行原 key 全量对象/版本/分片清理并确认，成功才释放。重复决定幂等，冲突正文拒绝；迟到存储事实清除原决定和清理 token，防止旧 worker 提交。原 key 不复用，运维须持续隔离旧写入者。没有伪造 uploadId、合并成功或目的版本，也不重新开放输入执行。

迁移 0113 由 Drizzle 生成；接收输入的未知分配和未知合并均可收尾。Web 表单、结果导入等更广维护入口仍未完成，不改变完整蓝图/PR 预览目标。

验证：新增 4 个隔离 PostgreSQL 场景覆盖未知分配/合并、原请求事实保留、并发幂等与审计、旧快照/未到期/未来停止时间、活跃运行、机器身份、平台角色、迟到事实使旧清理 token 失效，以及清理失败时保持额度。连同传输、存储、验证及整单发布，共 30 个不同场景最终通过，定向复查不重复计数。首轮新路由测试的简化错误处理器把 schema 400 改成 403，已改用生产错误处理器；组合回归暴露旧文件验证测试错误假定账号无文件，已改为比较前后文件集合并通过相同前置用例的定向复查。存储使用受控替身，证明的是授权/事务/恢复控制；本轮未重复跑无改动的真实 Kubernetes 或对象存储测试，也不声称实际外部运维排空已自动验证。空库执行全部迁移通过，临时数据库已清理。证据保存在忽略目录 `temp/federation-input-reconciliation-*.log`。

全仓类型检查通过（含 protobuf 生成、Fabric 测试）；最后清理检查复用与测试调整后另做 Server 定向类型检查。最终 lint 无错误，保留既有 47 warnings/1 info；648 个文档本地目标和 diff 空白检查通过。仍在实现分支，尚无 PR 预览或 main 部署。


## 联邦信任管理页面

平台安全增加联邦信任页签，沿用机构列表 → 详情 → 公钥/客户端证书布局，不新增独立管理体系。支持分页、登记机构、编辑名称/HTTPS origin、暂停/恢复、永久撤销、公钥用途与期限、证书登记/撤销及 PEM 查看。机构 ID 固定，轮换须新增凭据；用途默认不勾选，客户端拒绝私钥 PEM，最终信任/权限检查仍由现有 Server API 执行。共享输入 schema 从 Server 移至 shared，兼容原导出，未改变数据库或 API 契约。基础设施信任权与组织业务审批权保持分离。

失败保留表单和明确错误，迟到请求不替换当前机构；编辑期间禁用会丢失草稿的导航，刷新失败不允许基于旧详情写入。永久操作先确认具体对象。手机只读，公钥和指纹可换行，中英文、深色主题沿用平台样式。浏览器截图发现确认框缺少内容边距和按钮间距，已改为现有 DialogBody 和 footer 布局。

验证：11 项新组件交互与翻译测试、7 项设置入口测试、5 项真实 PostgreSQL 信任回归通过；包括角色/移动端限制、输入校验、用途选择、保存失败保留、撤销确认、刷新失败和乱序响应。浏览器使用真实组件/主题与显式 API 夹具，检查桌面列表/详情/添加公钥/撤销、390 px 手机及英文深色界面，无浏览器异常或手机横向溢出；这是 UI 渲染验证，不是部署预览或真实登录验收。最初整页夹具缺少无关设置 API，改为目标组件渲染，未以夹具错误修改产品逻辑。测试和截图日志在忽略目录 temp/federation-trust-ui*。

完整目标保持：业务协议/授权、维护入口、市场与商业结算、介质交付、归档恢复及真实 Slurm/PBS/Fabric 联合验收仍待推进。尚未推送、部署 main 或提供 PR 预览。

本项全仓类型检查中 Web 测试类型曾因不支持的查询选项失败，已删除该选项并通过最终 Web 类型检查；其他包类型、protobuf 生成及独立 Fabric 测试类型检查通过。最终 lint 无错误（既有 47 warnings/1 info），648 个文档目标和 diff 空白检查通过。


## 输入存储核对管理页面

已将上一项维护 API 接到平台安全的“输入存储核对”页签：待核对列表（最多 100 条）、任意代次 UUID 查询、原请求快照、执行/租约/清理状态、登记停写与存储排空声明、历史声明和实际清理结果。独立的业务/组织角色没有该管理入口，移动端只读；最终权限与状态复查继续由 Server 执行。表单不预填核查事实，明确要求工单、证据摘要、停止时间与两个确认，并在提交前显示具体代次和后果。没有凭空列表自动释放额度，也未改变数据库或清理策略。

使用共享响应 schema 解析列表/详情。请求失败保留原提交内容供同正文重试；刷新遇到新快照则重置声明，详情错误时不使用旧数据写入。已登记只表示后台获准继续清理，单次 cleaned 不代表全部导入均已释放空间。清理后可按原代次继续查看，避免列表消失被误解为操作丢失。

新增 9 项存储页面交互场景，与 9 项设置入口、11 项信任页面回归合计 29 项通过，包括未确认停止禁止登记、停止时间上下界、同正文重试、快照变化重新确认、历史查询及手机只读。前一项已验证的后端事务/数据库清理未改动，本轮不重复运行数据库与真实集群测试。浏览器使用真实组件和样式、显式 API 夹具完成中英/深色/390 px 手机检查，无页面异常和横向溢出；自动化日期输入初次因零秒格式被浏览器规范化而拒绝，脚本改为分钟格式后完成，产品输入仍支持秒。截图与日志保存在忽略目录 temp/federation-storage-ui*。此结果不替代真实登录、部署预览或外部存储排空验收。

下一项仍为业务协议/授权管理及其余完整蓝图，包括市场/结算、物理介质、归档恢复和 Slurm/PBS/Fabric 联合验收。实现分支目标保持，尚未推送或部署 main。

截图同时发现原生日期图标在深色下仍使用浅色控件配色，已在现有全局主题根节点补 color-scheme light/dark；浏览器实际样式检查和深色截图通过。全仓各包类型检查及 protobuf 生成均返回零；包装命令在 Fabric 测试类型阶段收到 SIGTERM（143），仅单独补跑该检查并通过，未重复已通过的包检查。最终 lint 无错误（既有 47 warnings/1 info），648 个文档目标和 diff 空白检查通过。


## 联邦组织授权管理与成员离会撤权

平台安全增加“联邦权限”页签，按名称选择组织、按姓名或邮箱搜索当前真人成员，逐项授予八种业务权限；列表显示原授权时间和成员有效性，允许撤销历史无效授权。新建授权不默认选择成员或能力，显示该能力的包含范围；移除只影响指定直接授权，不误称已停止运行任务。编辑失败保留选择，修改期间避免导航丢失，组织切换隔离缓存与迟到响应，同名组织显示 ID，移动端只读。浏览器发现 select 嵌套标签会把全部选项并入可访问名称，已改为独立关联 label。

共享 schema 保留原 Server 导出，权限包含关系只有一个实现。新增活动组织内当前用户的权限查询（禁止指定其他用户/组织和自动化身份）、平台管理员专用的限定组织成员搜索；授权列表返回成员名称和有效性。均为 no-store；当前权限视图不代替具体业务的事务授权和联邦部署就绪检查。

检查调用链发现原成员删除未清联邦授权，重新加入可能恢复旧批准权。已在唯一生产删除入口将成员、该组织联邦授权、权限投影待办和审计原子提交；审计包含实际撤销能力，失败全回滚、其他组织不受影响。成员删除确认文案及相关缓存失效同步更新。没有数据库迁移或自动清扫历史无效授权。

验证：联邦协议/权限的 11 个不同真实 PostgreSQL 场景通过，新增范围包含显式权限继承、当前组织隔离、自动化/服务身份拒绝、成员搜索排除、离会后重新入会、审计失败回滚和其他组织授权保留；28 项原平台授权路由回归通过。8 项新页面交互、11 项设置入口测试通过，覆盖明确选择、保存失败保留、撤权确认、失效成员、刷新错误、手机只读、乱序响应与同名组织。首轮乱序测试点到重新获取目录时暂禁用的按钮，修正测试等待后通过；定向复查不重复计数。浏览器检查桌面组织/授权/成员/表单/撤销、390 px 手机及英文深色界面，无页面异常或横向溢出。截图使用真实组件和主题、显式 API 夹具；数据库测试使用隔离 PostgreSQL，不代表真实登录/PR 预览或完整联邦链验收。证据位于忽略目录 temp/federation-permissions-*，临时数据库已清理。

完整蓝图目标保持；下一项是组织范围内合作协议签署与签名交换页面，其后仍有市场/结算、介质、归档恢复及 Slurm/PBS/Fabric 联合验收。尚未推送或部署 main。

成员删除相关 6 个 Web 场景最终通过；原确认文案断言随新的明确撤权效果更新后定向复查通过。完整工作区类型检查的其他包及 protobuf 生成通过，初次 Server 因测试读取未知 JSON 的类型错误失败，改用已知响应 schema/整体断言后 Server 定向类型检查通过；Fabric 测试类型独立检查通过。最终 Web 类型及 lint、文档检查见收尾记录。

收尾：最终 Server/Web 类型检查及独立 Fabric 测试类型通过；lint 无错误（既有 47 warnings/1 info），648 个文档本地目标与 diff 空白检查通过。Vite 和临时 PostgreSQL 已关闭。共 25 个不同前端场景（含成员管理 6 项）、28 个平台授权单测及 11 个隔离 PostgreSQL 场景通过；定向复查不叠加计数。实现分支继续推进，未推送或部署 main。


## 机构合作协议签署与签名交换页面

资源区增加机构合作入口，普通成员可在所属机构间切换，实际操作取决于当前组织显式联邦权限。页面支持严格条款 JSON 文件/文本导入、结构化核对、明确确认后签署、签名查看/复制、对方 JWS 验证导入、本地启用/暂停与永久撤销。精确额度使用字符串/BigInt，不经浮点数；合同材料摘要和已签条款摘要分开。接收方必须选择当前机构合格的受限执行账户；后台新增 context 与执行账户搜索，复用签署资格条件和实时权限检查。未改协议/数据库，不将目录结果视为资源授权。

界面把本地状态和双方签名分开，明确直接合作无链依赖、异步存证不阻塞，未支持的链上协调拒绝签署。手机只读，协议批准不套用普通审批的移动端豁免；永久撤销提示不可恢复且不证明远端任务停止。错误保留原输入供核查和幂等重试。文件大小按 UTF-8 字节检查，迟到文件读取不覆盖后来粘贴的内容。

签署与查询显式绑定当前组织和登录版本，认证续期重试前再次核对。机构目录和选择接口也拒绝迟到响应覆盖新组织；切换机构/登录后卸载原草稿与确认框。抽取原算力提供方已有的组织缓存清理函数，两个入口共用，避免离开协议页后残留其他机构资源。原提供方选择器的角色范围未扩大。

验证：12 个隔离 PostgreSQL 场景通过，包括新增读取/批准权限区分、受限执行账户资格与组织隔离、自动化拒绝、目录 HTTP 参数及 no-store。前端最终通过 76 个不同场景（15 个协议交互、3 个机构切换、4 个组织请求竞态、原 API/移动端/导航与组织相关回归 54 个），重跑不重复计数。初次组件测试用了项目未安装的 DOM matcher，改为本项目断言；数据库测试首次因编辑误把 schema 导入插入签名调用而失败，已修正并完整定向复查，未修改产品签名逻辑。

浏览器用真实页面、主题和显式 API 夹具检查了桌面列表/详情/条款核对/签署确认/撤销确认、390 px 手机和英文深色界面，7 张截图，无页面异常或手机横向溢出；截图是界面渲染检查，不是真实登录或 PR 预览验收。记录位于忽略目录 temp/federation-agreement-*。全仓类型检查（含 protobuf/Fabric）通过，新增最终代码另做 Server/Web 定向检查；lint 无错误（既有 47 warnings/1 info），648 个文档本地目标通过。

当前完成既定条款的签署交换入口，完整可视化合同编辑器、私有商业条款/组织背书策略、其他业务页面、市场/结算、介质交付、归档恢复和 Slurm/PBS/Fabric 联合验收仍待继续。仍在实现分支，尚未推送或部署 main，完整目标未完成。


## 私有商业合同、价格与用量的 Fabric 约束

新增独立 kq-commercial 链码工作区及 shared commercial 子入口。合同封装原执行协议、价格版本、整数单价/计量数量、慈善/置换/收费方式、私有条款与随机盐；先验证双方不同机构对同文的业务签名，再写对应 PDC，原版本不可改写。信任配置为每把公钥声明合同/用量用途，链码默认/生命周期治理与集合双方原生背书分开。记录、签名和价格不写公共 args/response/event；连 Get 接口也只返回带盐摘要，避免客户端把返回私有正文的查询提交成公开交易。

用量只接受原执行机构当前有效签名，绑定登记合同摘要、原任务/attempt、有效执行期间和计量单位。每个尝试的初始报告唯一，更正使用新记录并引用当前私有头；原证据不覆盖，旧请求重放不回退头。头记录的私有读集参与 MVCC，并发报告不能双成功。历史已批准合同不因原批准密钥自然到期而失去历史效力；新操作的签名仍检查用途与撤销。已提交 hash 存在但 PDC 字节缺失或不符时继续 DATA_WAITING，不把它当新建空状态。

13 个商业链码单测通过，包括大整数原值、机构/用途/签名拒绝、不可变版本、原始报告与更正、重放不回退、缺失/损坏私有数据、历史报告及期间越界；既有证据链码和 Adapter 的 15 个回归通过。真实 Fabric 3.1.5 的最终商业网络检查通过九组断言：业务双签、缺 B 原生背书 INVALID、合法合同/用量 VALID、双初始用量并发 MVCC 冲突、第三方及信任管理员接口拒绝、A/B 私有块可见而 C 从 A/C Peer 均不可见、公开块无价格/合同/用量/JWS 探针、同文重放及所属进程日志无探针。实际网络先通过基础版本，随后补报告唯一性与线性更正后重新验证最终链码；没有把旧构建结果当成最终证据。临时三个 Peer、单 Raft Orderer、TLS 链码进程及私有账本均按测试框架清理。

共用真实网络 runner 新增 --commercial，默认存证路径保持不变；CI 增加商业网络检查，只上传脱敏断言，不上传私有 fixture、证书或账本。bun install 正常生成新工作区锁项，无新第三方版本。全仓其他包类型及 protobuf 生成通过；商业测试中可能未找到原记录的类型断言已修正，商业包定向类型通过。扩大签名用途联合类型导致既有存证数据库夹具的数组类型过宽，改为 satisfies 保留其原来四种实际用途，Fabric 测试类型最终通过，未扩大 Server 信任或旧公钥权限。lint 无错误（既有 47 warnings/1 info），655 个文档目标及 workflow uses 静态检查通过。

此项完成私有商业记录的链级基础，不是完整结算或链上执行闭环。Server 商业审批、独立 Adapter 恢复检查点、公共市场与商业 gate、锁额/账单/争议/结算、合同编辑器、介质交付、归档恢复、真实 Slurm/PBS/Fabric 联合验收和 PR 预览仍须继续；不放宽当前 ledger_coordinated 执行拒绝。实现分支保持，未推送或部署 main。证据日志在忽略目录 temp/federation-commercial-*。


## 商业 Adapter、私有客户端与提交恢复

商业链码现有独立 Node Adapter：验证双方同文合同/执行方用量签名、专用公钥用途与固定合作域后创建 proposal，敏感内容仅进入 transient，背书目标固定为两家机构。启动以 KQ_FABRIC_ADAPTER_KIND=commercial 选择商业通道，默认 evidence 行为不变；Server 类型化客户端仅访问本 UID 的私有 Unix socket，不引入 Fabric SDK。商业审批路由、数据库待办和后台 worker 尚未接入。

两通道复用原有有界 HTTP/证书启动与加密检查点提交实现，保留旧证据版本 1 token 的字段和 AAD，并保留 anchored 对外状态。商业 token 额外绑定用途与商业配置，不能跨通道、机构、证书或恢复密钥重放。每步先返回可持久化检查点；未确认提交结果时保持原签名交易与 txID，不重新生成交易。只有 VALID 返回商业 committed，不能将其视为账单确认或执行授权。

14 个 Adapter/客户端测试通过，覆盖固定端点、私有 socket、脱敏错误、跨通道响应拒绝、精确 transient/指定背书机构、签名/用途/摘要拒绝、恢复隔离及独立构造的旧版本证据检查点兼容。真实 Fabric 3.1.5 商业网络通过 11 组断言，包括生产 Unix 客户端每步新进程、已提交未保存响应时退出、重启原交易恢复，以及 Orderer 停机 pending 后恢复同一交易。原商业隐私/背书/MVCC 检查保持通过；原证据真实网络 12 组断言也通过。测试中发现并修正夹具误将 state 字段写入严格检查点 schema 的问题；生产提交逻辑无此问题。

全仓类型检查及新增 Adapter/Fabric 脚本定向类型检查通过；lint 无错误，保留既有 47 warnings/1 info；657 个本地文档目标与 workflow uses 静态检查通过。真实网络全部在隔离临时目录运行，所属进程与成功材料已清理。本轮没有重跑 PostgreSQL worker 联合测试，没有执行平台作业或部署 PR 预览；不改变完整蓝图待完成状态。日志保存在忽略目录 temp/federation-commercial-*。


## 商业合同审批、持久待办与真实数据库恢复

新增组织范围的商业合同管理 API、独立商业审批/待办/提交尝试表和后台 worker。签署须有显式 agreement.approve 与 commercial-agreement 公钥用途；双方对同一精确条款签名后，事务保存对签与待办。条款不可覆盖，大整数价格保留字符串；列表、状态及审计不复制合同正文、价格或恢复 token。平台信任登记及中英用途选项支持 commercial-agreement/commercial-usage，旧公钥不自动获得新用途。迁移 0114 由 bun run db:generate 生成，未手改迁移或快照。

直接模式不创建链待办；bilateral_attested 与 ledger_coordinated 在双签后排队，但合同批准/登记不安装执行协议、不建立预算、不触发付款，原 ledger_coordinated 执行拒绝保持。Server 配置 FEDERATION_COMMERCIAL_SOCKET_PATH 后后台每十秒消费，90 秒数据库租约、检查点先持久化、网络调用不持锁、提交不确定保留原交易。VALID 才 committed；INVALID/需处理错误进入 needs_review，人工复核保留旧尝试，未知 transaction 不能被放弃。人工重试也按数据库时间判断活动租约，避免应用时钟偏差抢占。既有机构批准记录不因原人员离职消失，新 proposal/披露仍检查当前机构签名信任，商业记录不替代执行授权。

隔离 PostgreSQL 的 9 项测试通过：权限/用途、组织隔离/同文签名/不可覆盖、三模式差异与无执行/预算副作用、检查点持久化/并发/重建、撤权阻止新披露、INVALID 历史保留、未知结果与失效租约、HTTP 严格输入/人类身份/审计脱敏。新增真实数据库 runner 使用已有商业网络，分别由新 Bun 进程处理审批与每次检查点，连接生产 Node Adapter。最终 Fabric 3.1.5 联合运行通过 14 组断言，包含既有 PDC/背书/MVCC/公开块与日志隐私，以及链和 Adapter 离线时直接合同成功且无待办、链停机原检查点保留、提交后写回前退出并等待真实 90 秒租约后恢复原 VALID 交易（数据库仅一个尝试）。临时库、所属网络进程与成功测试材料已清理。

联测修正了两处夹具时序：可读链码不意味着私有传播 peer 已就绪，首次背书只对明确的尚无 eligible peer 错误有界等待；Orderer 进程启动也不意味着 Raft 已选主，测试按数据库原重试间隔继续原 pending 交易，不能假定第一次重启后调用立即 committed。没有降低 requiredPeerCount 或双机构背书策略，没有用新的 txID 绕过未知结果。

全仓其他 package 类型与 protobuf 生成通过；新测试 fixture 的循环推导声明已改成明确的清理记录类型，Server 与 Fabric 测试脚本定向复查通过。配置/签名 45 项、信任 Web 组件 11 项回归通过；lint 无错误（既有 47 warnings/1 info），657 文档目标与 workflow uses 静态检查通过。CI 商业检查改为数据库联合测试，仅上传脱敏断言。日志与报告留在忽略的 temp/federation-commercial-*。

仍需商业合同编辑/审批页面、用量自动采集与报告、市场/唯一认领与商业 gate、锁额/账单/争议/结算、介质交付、归档恢复、完整 Slurm/PBS/Fabric 联合验收及 PR 预览。当前未推送或部署 main，完整蓝图目标保持进行中。


## 商业合同 Web 编辑与签名交换

机构合作页面新增商业合同页签，共用活动组织和显式批准权限。支持从既有执行协议创建商业条款或导入完整 JSON、精确整数价格/慈善零价、核对后签署、合同导出、签名交换、链状态及复核重试。列表只返回双方名称和摘要，不含价格/正文/签名；详情核对机构与修订，切换机构或登录清除私有草稿。直接模式不查询链，待提交十秒刷新，手机只读。签署、存证与执行/账单/付款明确分开，不放开 ledger_coordinated 执行门禁。

35 个不同前端场景及 9 个隔离 PostgreSQL 场景通过；全仓类型检查与最终 Web 定向类型通过，lint 无错误（既有 47 warnings/1 info）。数据库摘要测试按真实 HTTP 日期序列化后校验 wire schema，确认不含私有文本；未放宽生产接口类型。浏览器以真实组件和显式虚构 API 夹具检查桌面列表/详情/重试/编辑/签署、390 px 手机及英文深色，共七种画面，无页面异常或页面横向溢出。手机重试弹窗关闭后补等退出动画，仅重拍受影响画面，确认此前残影为截图时序。价格表在窄屏内部横向滚动。

截图/日志在忽略目录 temp/federation-commercial-ui*；这是渲染检查，不是真实登录、PR 预览或作业/链联合验收。当前只调整商业查询摘要及 Web，不重复运行已通过的真实链恢复检查。下一项为持久用量证据和报告，完整执行编辑器、市场/gate/结算、介质交付、归档恢复、Slurm/PBS/Fabric 联合验收和 PR 预览仍须继续。未合并或部署 main。


## 联邦 Job 终态与独立原始证据原子保存

新增 terminal-evidence schema、独立表与事务写入函数。JobService 完成/失败/取消，以及数据集和数据授权撤销两个批量取消路径，在原 Job 行锁和事务内保存一份证据。证据绑定原预留、任务/尝试、接收 Workflow、动态调用路径和执行快照摘要，核对原执行归属，不依赖仍有效的批准人员、商业合同或链。普通 Job 无联邦证据；联邦标记丢失关联或归属不符时拒绝静默跳过。迁移 0115 由 db:generate 生成，没有手改迁移/快照。

保存的是原始平台观测，不是可直接计费的调度器实际消耗：用终态前的开始时间区分 start-unobserved / clock-inconsistent / observed-interval，调度器会计数据显式 unavailable，平台取消不声明远端停止。CPU/GPU/内存请求保留整数字符串，内存从 PostgreSQL bigint 文本读取，避免现有 number 映射损失精度。证据正文不复制命令、环境变量、脚本输出或真实用户身份；本地外键不允许 Job/Workflow 删除顺带抹去证据。

9 个新增隔离 PostgreSQL 场景通过，覆盖八路并发相同事件只存一次、新实例/迟到终态不覆盖、证据失败时 Job 和事件去重同回滚、原事件重试、超出 JS 安全整数的内存原值、缺失/倒退时钟、普通作业排除、身份或绑定异常、合作撤销后的两种数据撤销、原计量服务失败不丢证据。原 JobService/事件/安装取消 47 个回归场景通过，共 56 个不同数据库场景；失败仅定向复查，不累计重跑次数。首次测试修正了 Drizzle thenable 断言、数据集合法 accessMode 与 ready 版本 immutableAt 夹具，没有放宽生产约束。

lint 无错误（既有 47 warnings/1 info），完整类型检查结果见本节收尾。测试用隔离数据库和受控历史联邦记录，不执行真实集群作业，也不证明 Slurm/PBS 已提供实际会计数据。数据库均由 runner 清理；证据日志在忽略目录 temp/federation-terminal-*。下一项仍为用量报告生成/更正及商业链提交，完整蓝图和 PR 预览目标未完成，未合并或部署 main。


终态证据收尾检查还发现平台准备失败会携带 expectedAgentId，已修正来源判定：须同时有持久 Agent 事件 ID 才标 agent-status，其他写入标 status-update；带 Agent 的平台准备失败定向测试通过，计数不增加。平台取消来源使用 platform-cancellation，避免将后台取消误标为人工操作。新增测试派发替身的返回类型改为原接口要求的 boolean，未改变生产派发逻辑。

最终全仓各包类型检查通过：首次 Server 仅测试替身返回类型报错，修正后 Server 通过；来源判定调整后 Shared/Server 再定向通过。protobuf 生成与独立 Fabric 脚本类型检查通过；最终改动文件 lint、657 个本地文档目标、workflow uses 和 diff 空白检查通过。临时 Vite、数据库端口转发及隔离测试数据库均已清理。


## Slurm/PBS 计量随持久终态事件传输

为用量报告补上调度器来源：新增独立 SchedulerAccounting schema，分别保存 elapsedMilliseconds、cpuTimeMilliseconds 与 allocatedCpus，只接受整数/字符串并保留缺失；时间解析用 BigInt，亚毫秒截断，不以核数乘时间冒充累计 CPU 消耗。Slurm sacct 精确匹配 JobIDRaw 汇总行，保留步骤参与统计，不累加 .batch 等子行；重复 ID 无法唯一匹配时回退状态，计量缺失。PBS Pro 从实时或历史 resources_used 读取，不使用 Resource_List 申请值。

JobRunner、SQLite outbound 的写入/新实例重放、protobuf 可选 accounting、生产 gRPC 和联邦终态证据已贯通。旧消息无计量仍兼容，新事件保留精确整数及原 eventId，Server 在 ACK 前完成保存；绑定调度器类型、Job ID 和 Agent 事件，错误绑定回滚原终态，原事件可重试。原始证据不因重复回报被替换；没有新增数据库迁移，protobuf 通过生成命令更新，未手改生成文件。

208 个不同单元/协议场景与 12 个 PostgreSQL 场景通过（包括此前的回归）；覆盖 duration/大整数/真实零与未知、Slurm 汇总/步骤/重号、PBS 历史及请求值排除、runner、SQLite 重放、proto 二进制精度/旧消息、gRPC 先保存再 ACK、原证据重放以及错 Job/调度器拒绝。首次回归发现编辑时误删了独立身份恢复查询的 --allocations，已恢复该查询，Slurm 全部 74 场景定向通过；计量查询保持不使用该选项。检查复跑不重复计数。lint 无错误（既有 47 warnings/1 info）；完整类型与文档检查收尾记录如下。

这轮使用真实 SQLite、protobuf、PostgreSQL 和受控调度器 CLI 输出，不是真实 Slurm/PBS 会计或 Fabric 作业联测。计量是调度器的断言，仍须在部署验收验证会计插件；迟到补采、取消后的最终计量、Torque/Kubernetes/GPU/内存来源以及签名报告/更正/合同口径绑定均待继续。独立分支与完整 PR 预览目标保持，未合并或部署 main。日志位于忽略目录 temp/federation-accounting-*。

本轮收尾：完整类型检查（含 protobuf 生成、全部 package 与 Fabric 脚本）通过，后加二进制协议测试的 Proto 定向类型也通过；lint 无新增错误/告警，657 个文档目标、workflow uses 与 diff 检查通过。隔离 PostgreSQL 已清理，所属端口转发关闭。当前没有运行新真实集群作业或重复执行未改动的 Fabric 隐私/恢复测试。


## 终态证据自动汇总与提供方签名报告

新增按预留唯一的持久报告工作项及不可变报告表（生成迁移 0116）。从已商业双签的终态 Workflow 发现任务，锁定工作项，核对原绑定和全部叶 Job 证据，用 BigInt 按合同明确的三种指标汇总；证据集合排序并绑定价格版本。缺失保留缺失，未知旧指标不猜测，不签部分报告；超过 4096 Job 或 38 位数量进入复核。时间覆盖取实际 Workflow 创建至完成，不把窗口当 CPU 用量，也不裁剪到合同期限。

本地签名、报告和可选链待办同事务提交；直接合作无需 socket，不探测链、不修改预算。存证报告待对应合同注册 committed 后提交；合同状态查询排除用量提交，避免混淆。组织范围的查询/重试 API 保留权限、no-store、严格空请求体与脱敏审计，已出报告不可重生成。后台历史报告不以批准人员离职或随后合作撤销抹除计量，但签名必须有当前有效机构信任和专用用途。

修复终态证据摘要的实际边界问题：protobuf 可选字段转换后可能含 own undefined，schema 会保留而 canonical encoder 拒绝。证据在保存边界统一 JSON 规范化后再摘要、入库；精确整数仍为字符串，严格摘要规则不放宽。部分计量字段缺失的 PostgreSQL 回归覆盖该路径。

29 个不同隔离 PostgreSQL 场景通过（21 个既有终态/商业回归及 8 个报告场景），另有 4 个纯汇总测试通过。覆盖并发/重启唯一生成、精确签名及证据摘要、缺失/真实零/越界/篡改、数据库写入回滚、签名用途、历史撤权、合同提交依赖、无 Fabric 的 worker、组织隔离、HTTP 严格输入及权限、超出协议窗口拒绝裁剪。首次测试暴露事务时间查询缺少 FROM，已修复并只重跑失败/新增场景；测试复跑不重复计数。

这轮没有真实调度器 CLI 或自动报告到 Fabric 的联合验收；真实数据库测试中的 ledger prepare 使用受控 Adapter。原链码未改动，不重复跑已通过的链隐私检查。更正、迟到补采、对方交换、Web 报告页面、市场/gate/结算、物理介质、归档恢复及完整 PR 预览仍待完成。未合并或部署 main。日志保留于忽略目录 temp/federation-usage-*。

收尾检查：全仓类型检查（含 protobuf 生成及 Fabric 脚本）通过，最后调整后的 Server 定向复查通过；全仓 lint 无错误，新增测试告警已修正并定向通过，保留既有 47 warnings/1 info。658 个文档目标、workflow uses 和 diff 空白检查通过。


## 提供方技术更正与顺序存证

增加显式技术更正输入/证据 schema、报告上的可空 correctionEvidence（生成迁移 0117）以及组织范围的追加 API。要求 agreement.approve、完整合同指标/单位、原因和佐证摘要；用随机盐绑定声明与原报告摘要，再生成独立 CommercialUsage 签名。数据标为 provider-technical-correction，不覆盖或冒充原 Agent 观测；不接受改写合同/任务/时段，不改变预算、账单或执行权。佐证是操作人声明，未实现文件接收/摘要内容验证，机构须保管可核验原材料。

原工作项行锁使更正头线性增长；同一请求 UUID/内容幂等恢复，旧请求重放不回退头，变更内容或两个并发更正仅一个成功。所有报告、声明、审计和链待办原子提交，失败全部回滚。原报告读取新增分页及 hasMore，避免更正增多后无法读取原始记录。存证 worker 除等合同登记，还等待前一报告 committed，pending/needs_review 不允许越过；不新增链码或修改原生背书规则。

6 个新 PostgreSQL 更正场景及 5 个不同报告/HTTP 回归通过，共 11 个不同场景（复跑不计数），覆盖签名/摘要、不可变历史、幂等/并发、单位/完整性/签名用途/权限、待办失败原子回滚、三级提交顺序、严格 HTTP/自动化拒绝及分页。首次执行发现编辑误将新列加到结果导入表；修正源 schema，用 drizzle-kit drop 删除本轮未发布迁移再 db:generate 重生，未手改迁移。只运行隔离随机测试库，已清理。测试夹具类型过窄的报错已改为共享输入类型，未放宽生产约束。

技术更正当前为 API 能力，尚无 Web、对方交换、自动迟到计量补采，也未以这条新路径做真实 Fabric 联合验收；已通过的链码更正与隐私逻辑未改动，不重复执行整套链测试。完整蓝图、真实调度器到链联合验收和 PR 预览目标继续，未合并或部署 main。日志在忽略目录 temp/federation-correction-*。

收尾：Shared/DB 与最终 Server 类型检查通过，修改文件 lint 无错误/告警，659 个文档目标及 workflow uses、diff 检查通过。前序依赖查询按 UUID 主键匹配报告，避免对报告 ID 转文本而失去索引；顺序存证场景定向复查通过。没有重复全仓或未改动真实链检查。


## 私有机构通道自动交换用量与更正

新增带 challenge/短时窗口/原委派绑定的用量查询与单条报告页。源站根据已接单委派和同文商业双签建立持久同步工作项，执行方在 mTLS 证书及专用签名用途下披露报告；双方都保留历史签名，更正还核对本地前序摘要与声明数量。自然到期的旧报告密钥仅在当前提供方新鲜响应重申原字节后按签署时点验证，撤销旧密钥仍拒绝新导入。请求不携带真实用户身份，响应不携带本地 Job/用户 ID 或原始 evidenceSet。

生成迁移 0118，增加读取状态/租约和收到的不可变报告表；原商业 worker 接入自动发现及推进，不引入独立轮询框架。网络调用不持锁，保存前复查信任与租约；每页及读取位置同事务提交，过期旧 owner 不能覆盖新 owner。仍有后续记录立即续读，最新记录每 60 秒检查后续更正；失败保留待重试或复核，不改预算/账单。组织范围读取、分页及刷新 API 使用原权限体系与 no-store，不暴露内部租约或原始页签名。源站后台不依赖历史人员仍在职；当前人类读取必须重新核验。

9 个不同隔离 PostgreSQL 场景通过：原报告/更正并发及重启续读、缺失与断线、重放 challenge 和保存失败回滚、串任务/撤权与历史读取、自然到期密钥轮换、HTTP/组织/只读权限、错误序号/更正摘要/数量、过期租约迟到回包、专用用途与无 Fabric 后台同步。首次检查发现详情仍返回内部租约字段，已改为公开字段投影并定向复查；列表与详情均无租约 token。

15 个单元/协议/真实 TLS 通道场景通过：现有签名六项、新协议两项、生产 HTTPS 客户端五项及 Node 网关两项。网关新增路由后，夹具累计调用数从八改九，实际 TLS 证书和身份头剥离检查定向通过。未伪装网络验收：数据库交换使用实际签名/服务但受控 send 回调与证书登记夹具；TLS 客户端/网关单独使用真实证书测试，尚未把两个生产 Server、真实 Slurm/PBS 计量和 Fabric 串成此次报告验收。

完整类型检查已通过（含 protobuf 生成与 Fabric 脚本），全仓 lint 保留既有 47 warnings/1 info、无错误；最终补测与投影改动继续定向检查。Web 报告与更正页面、自动迟到补采、商业 gate/市场/结算、物理介质、容量/归档恢复及 PR 预览仍须完成。没有合并或部署 main，日志保存在忽略目录 temp/federation-usage-exchange-*。

收尾：最终 Shared/Server 定向类型检查及修改文件 lint 通过，660 个文档目标、workflow uses 与 diff 检查通过。测试只创建随机隔离库，已全部删除；所属数据库端口转发关闭。未运行未改动的完整链测试或部署预览。


## 商业用量报告与技术更正界面

商业合同详情接入用量页签，覆盖提供方任务/缺失/历史报告、追加更正核对与未知响应原请求重试，以及委派方已收报告、同步时间和人工刷新。数量全程保持整数精度，导出保留签名，存证状态与本地签名分开；仅最新头允许更正。组织/登录版本隔离、撤权清草稿、错误态收起旧操作、可见页轮询和手机只读沿用现有规则。增加三个标准计量选项，成对更新指标/单位；自定义和旧口径保留原值。顺带修复增加价格行未追加 priceIds 的既有问题。无新迁移，不改变预算或账单。

24 个不同组件场景通过（包含修复后定向复跑，不重复计数），覆盖精确数量、缺失不补零、接收同步、更正核对/幂等重试、无效输入、权限变化、跨合同响应、历史分页、存证重试及标准口径选择。完整类型检查通过，后续 Web 定向类型检查通过；全仓 lint 无错误、保留既有 47 warnings/1 info，最终九个修改文件 lint 无诊断。

真实浏览器渲染实际组件和虚构 API 夹具，完成八张截图：提供方列表/报告、更正核对、缺失计量、接收报告、390px 手机、英文暗色和标准口径编辑。无页面异常/横向溢出，手机无更正操作；修复英文选择器宽度和标签关联后复查通过。截图及日志仅保存在忽略的 temp/federation-usage-ui*。这是夹具界面检查，不是实际 PR 预览、真实登录或两个生产 Server/Slurm/PBS/Fabric 联合验收。

自动迟到补采、真实调度器到链联合验收、商业 gate/市场/结算、物理介质、容量/归档恢复、完整执行协议编辑器及 PR 预览仍未完成。未合并或部署 main。


## 关闭机构通信后保留用量历史

修复启动装配把报告查询接口绑定到发送通道的问题：机构签名仍配置时始终创建报告交换服务，关闭发送通道只停止发现/同步，不隐藏已有报告。详情增加 syncEnabled，Web 继续展示历史和导出，明确通信未配置并隐藏同步按钮；服务端在组织权限校验后拒绝不可执行的刷新，保留游标及原状态。未改变关闭整个签名身份时的启动边界。

新增一个真实隔离 PostgreSQL 场景覆盖 HTTP 历史/权限/no-store、刷新拒绝和后台不修改状态；两个不同 Web 场景覆盖正常同步及关闭后的可读界面。桌面/390px 手机两张实际组件夹具截图无页面异常或溢出。首次数据库断言将 Date 与 HTTP 字符串比较，改为比较前后服务视图；HTTP 仅校验公开协议字段，保持严格 unknown 类型，无生产数据修改。

联合验收准备时确认现有 Compose Slurm AIO 模板关闭 AccountingStorageType 和 JobAcctGatherType，不能作为真实累计 CPU 计量验收环境。下一步须使用启用 sacct 的隔离 Slurm 会计配置，并与 PBS 的 resources_used 分别核对；现有无会计环境应继续显示缺失，不能靠 scontrol 或申请核数编造 CPU 消耗。

收尾检查：全仓 lint 无错误，保留既有 47 warnings/1 info；完整类型检查发现新增 HTTP 测试直接读取 unknown 响应，已改为结构断言。其余包检查通过，修正后的 Server 类型检查与 Fabric 脚本类型检查分别通过；受影响数据库场景定向复查通过。660 个文档目标、workflow 引用与 diff 检查通过，所属临时数据库/转发及浏览器开发服务均已清理。


## 真实 Slurm 会计采集与汇总一致性

在随机 namespace 内启动真实 Slurm 19.05.5、MariaDB 与 slurmdbd，开启 linux 采样；容器限额 1 CPU/1200 MiB，作业申请 1 CPU/64 MiB/60 秒，运行约 2 个 CPU 秒的 Python 循环并校验输出。没有替换科学软件二进制，没有修改 main 或现有集群。首次临时探针缺少日志目录导致调度器在启动前失败，补齐探针目录后重试；不计为平台计算成功。

真实查询暴露完成后短暂不一致：汇总行 ElapsedRaw=0、batch=2、TotalCPU=00:02.018；后续汇总变为 2。适配器现在检测同任务步骤状态与汇总关系，未终态/未知步骤或任一步骤时间、CPU 超过汇总时保留作业终态、舍弃本次计量。既不汇总步骤造成重复计量，也不拿申请核数推算或把矛盾零值签为有效用量；原有合法零值兼容。

77 个 Slurm 适配器场景通过，新增未知步骤状态后定向 1 项通过，共 78 个不同场景。三个首次新增场景分别覆盖时长未合并、CPU 未合并和步骤仍运行，并验证后续一致查询恢复。已将实际原始行加入回归，旧“不累加步骤”夹具中不可能的子步骤 CPU 大于汇总值改为合法数据。

新增可复现脚本 scripts/federation-slurm-accounting.ts、容器内探针与启动配置，完整入口实际执行通过：最终作业运行 2000 毫秒、CPU 2024 毫秒、1 核，原 sacct 汇总/步骤相符，输出标记校验成功。脚本只使用 pinned 镜像、独立随机 namespace 和临时会计数据库，保存安装版本/配置/原始观测，结束删除所属资源；证据在忽略的 temp/kq-accounting-44079a26。详情见部署说明。

这轮是实际调度器和生产适配器采集检查，不包含 Agent 消息投递、两个 Server、PBS 或 Fabric 联合链路。探针轮询不等于已实现生产迟到补采；终态首次计量缺失仍需追加观测能力，不能覆盖原证据。完整目标及 PR 预览继续。

收尾：完整类型检查通过，包含 protobuf 生成、全部 package 及新增真实计量脚本；全仓 lint 无错误，保留既有 47 warnings/1 info。662 个文档目标、workflow 引用及 diff 检查通过。两次创建的所属 namespace 均已确认删除，无残留测试容器。


## 初始报告缺失计量的持久补采

Server 商业 worker 已接入原 Agent 流的只读补采。数据库保存请求代次和 60 秒租约，网络发送在事务后；Agent 依原 SQLite 派发收据、Job UUID、执行代次和账户在查询前后定位原 Slurm/PBS Pro 任务。离线或暂时无计量保持待重试，身份冲突进入复核。单份观测须满足合同全部指标；接收观测和唤醒报告生成同事务保存。迁移 0119 独立保存补采观测及摘要，报告同时承诺原始证据与补采摘要，原终态、已签报告和商业链协议不改写。现有 retry 可恢复复核任务，没有增加独立公共接口或轮询框架。

五个不同隔离 PostgreSQL 场景通过：补采生成签名报告/重复不改写，并发领取/租约过期/重启/迟到隔离，外部 Agent/错误绑定拒绝，断线及人工复核恢复，失败回滚及不完整样本继续等待。三项 SQLite/查询单测、四项既有聚合检查、一项补采摘要聚合及一项注册身份检查通过；protobuf 新请求/响应/能力往返测试及既有九项通过。复查锁的 TypeScript 链式调用不兼容后，改为单次锁定集合和 Job，五项数据库检查定向复查通过，不重复计数。

真实 Slurm 限额探针再次运行成功：2000 毫秒运行时长、2018 毫秒 CPU、1 核；补采模块通过 SQLite 收据和两次 UUID 定位返回一致用量。证据在忽略的 temp/kq-accounting-0031c91a，所属 namespace 已确认删除。收据与原证据摘要是受控输入，不是 Server 的真实派发；尚未完成 Server/Agent 通信、PBS、双站报告及 Fabric 联合验收。

全仓类型/lint 已执行；最终 Server 与 Proto 类型检查、修改文件 lint、文档目标/workflow 引用及 diff 检查通过，全仓保留既有 47 warnings/1 info，无新 lint 错误。已签报告、完整但不准确的原计量不由补采自动更正；原收据或调度器历史丢失继续显示缺失。完整商业 gate/市场/结算、物理介质、容量/归档恢复、执行编辑器和 PR 预览仍待完成，未合并或部署 main。


## 真实 Server / Agent 的补采与签名链路

在隔离 PostgreSQL 和随机 namespace 中启动完整生产 Server；通过注册 API 和 CLI 正式签发 Agent 证书，使用直接 mTLS 连接。真实 Slurm 任务限额 1 CPU/64 MiB/60 秒，实际运行 2000 毫秒、累计 CPU 2018 毫秒。受控构造首次终态缺失计量及原 SQLite 派发收据，Server 商业 worker 自动发现 missing_data，并在 Agent 未上线时保留 AGENT_UNAVAILABLE 待办。

重启完整 Server 后再启动生产 Agent 与看守，后台沿原数据库待办，经实际双向流完成 UUID/代次身份查询和 sacct 读取，独立保存观测、自动生成并验签唯一报告。HTTP 用量详情已核对同一摘要，原终态证据前后完全相同；直接模式没有商业链待办。未手动调用补采 receive 或报告 advanceNext，未用内存通道替代网络。证据在忽略的 temp/federation-accounting-live，过程脚本在 temp/accounting-live-*，未纳入公开资料。

边界：初始 Workflow/Job 终态及派发收据为受控数据库输入，真实调度器任务通过生产适配器提交；不将本轮描述为完整联邦委派或真实终态消息验收。尚缺双站报告交换与真实任务/Fabric 联合链路，也未验证 PBS。完整 Server、数据库、Agent 所属 namespace 与临时凭据已清理，没有 main 部署或 PR 预览发布。


## 公共需求唯一认领与原生多数背书

新增 shared market 协议和独立 kq-market CCAAS，复用现有 Fabric 依赖，没有引入第三方包。发布仅允许明确公开的资源/平台/摘要/有效期字段；机构 MSP/site/role 必须匹配部署信任。相同请求幂等，按 expectedVersion 从 OPEN 认领为 CLAIMED 或由发布方撤回为 CANCELLED。截止不自动重新开放，已认领不能经未认领撤回路径释放；激活尚未开放。

六项链码单测通过，覆盖幂等/内容冲突、机构与角色绑定、过期/旧版本、撤回边界、额外私有字段/体积/未知激活拒绝及信任配置。真实 Fabric 3.1.5 三 Peer 验证五组断言：单机构发布背书 INVALID（ENDORSEMENT_POLICY_FAILURE）、两机构 VALID，B/C 同版本同时背书后仅 B 提交有效而 C 为 MVCC_READ_CONFLICT，原请求重试不回退认领，以及覆盖/错误撤回/无 gate 激活被拒绝。没有用内存 ledger 的串行结果证明链上并发。公开任务采用通道原生 MAJORITY，lifecycle 为 ALL，信任配置键要求全部机构。网络启动脚本增加 --market，已有证据/商业路径保留原策略。

断言摘要 temp/federation-market-network-report.json，完整本机证据 temp/fabric-network-jXpCgc，未公开上传测试凭据；所属 Peer/Orderer/CCAAS 已停止。CI 新增同一命令及仅断言摘要上传。当前只完成公共认领基础，市场 Adapter/Server/Web、PDC 锁额、跨链码 gate、结算及真实计算验收继续推进，未合并或部署 main。

收尾：完整类型检查（含 protobuf 生成和全部包）及 Fabric 脚本检查通过。全仓 lint 无错误；新增测试的两处非空断言提示已改为显式检查，修改文件复查无诊断，原有 47 warnings/1 info 保留。667 个文档目标、workflow 引用和 diff 检查通过；没有重复运行已通过的旧商业/证据网络检查。


## Market Adapter 与真实提交恢复

新增独立 Market Adapter、私有 Node runtime 入口和 Server UnixMarketClient，复用 FabricSubmission 的签名提案与加密检查点，不引入第二套恢复账本。仅允许发布、认领和撤回未认领需求；固定机构/通道/链码，规范化载荷摘要与链码回执一致，原生 Gateway 发现多数背书。恢复用途为 kq-market-v1，配置/机构证书/治理 generation/恢复密钥变更拒绝旧检查点。准备、已背书、待提交、有效提交分别处理，不将 committed 解释为可执行许可。

三项 SDK 单测覆盖三种方法的准确载荷/调用与加密检查点绑定、越机构/任意调用拒绝、恢复配置与密文变更拒绝；三个不同私有 socket 场景覆盖 evidence/commercial/market 路由隔离、严格输入与错误脱敏，共六项通过。实际 Node Market Adapter 和 Server 客户端经真实 Unix socket/mTLS 连到 Fabric：发布提案保存、背书 prepared、Orderer 停止返回 pending；Orderer 恢复后原交易 VALID，立即退出 Adapter 而不保存成功响应，再由新进程读取原检查点，恢复同一 transactionId/blockNumber，重复查询不变。

首次恢复脚本错误地把 Orderer 进程监听视为 Raft 已选主，遇到正确的 pending 时断言失败；改为限时推进同一检查点，未重造交易或放宽 VALID 判定。另一次在并发认领背书阶段失败且原日志仅有 EndorseError，补充本机详细失败记录及 B/C 实际跨机构查询路径就绪检查，避免仅由 A 查询成功推断全部 Gateway 可用。最终真实网络六组断言通过，前五项为既有市场检查的回归，不重复计为新增场景。证据 temp/fabric-network-LgZ0Mv，摘要 temp/federation-market-adapter-network-report.json；三次网络所属进程均已退出，本机诊断/测试凭据留在忽略目录。

完整类型检查通过（含 protobuf 和全部包）；最终脚本类型检查、修改文件 lint、文档/workflow 引用与 diff 检查通过。全仓 lint 无错误，保留既有 47 warnings/1 info。Server 尚缺持久市场待办、公开 API/查询与 Web，私有锁额、跨链码 gate 和结算仍须实现；既有链上协调执行入口保持拒绝，未合并或部署 main/PR 预览。


## Server 市场操作持久待办与组织权限

新增迁移 0120，保存不可变操作意图、逐次 Fabric 交易、加密恢复检查点和 90 秒租约。复用商业 worker：提案先落库再背书，交易先落库再提交，断线/重启沿原交易恢复；失效租约不能覆盖新 owner。未知交易禁止重新造单，已知 INVALID 保留历史后允许授权人员重试。提交结果和业务状态同事务保存。机构接受后的待办不因最初操作人离职而静默撤销；新建、读取和人工重试均重新核验当前组织成员与明确能力。

增加组织范围操作列表、详情、创建和重试 API，严格限定公开市场载荷；不暴露恢复密文或内部租约。发布与认领权限互不隐含，均蕴含读取；撤回须属于当前组织已确认发布的需求，最终仍由链校验 OPEN。启动装配使用 FEDERATION_MARKET_SOCKET_PATH，未配置时保留可读历史和待办；沿用现有 worker，不新增计时框架。权限设置界面同步中英文标签。

七个不同隔离 PostgreSQL 场景通过：并发幂等与组织隔离、持久检查点/断线/服务重启、并发领取/租约过期/迟到回包、未知交易重试/无效历史保留、明确能力/撤回归属/撤权、HTTP 身份/组织/严格输入/公开投影，以及错误交易响应拒绝与提交状态保存失败的原子回滚。首轮发现 Drizzle 无 FROM 的时钟查询不执行，已改为绑定当前用户行并复查。一个既有双语权限覆盖测试通过。数据库测试使用受控 Adapter 回调，不代表 Server/数据库/真实 Fabric 已贯通。

完整类型检查通过（含 protobuf、全部包及 Fabric 脚本），最终 Server 类型检查通过；全仓 lint 无错误，保留既有 47 warnings/1 info。文档目标、workflow 引用和 diff 静态检查通过。临时随机数据库均删除，凭据和日志留在忽略的 temp/。公共市场目录、Web、私有锁额、跨链码 gate、结算、物理介质和归档恢复仍待完成，链上协调执行入口继续保持拒绝；未合并或部署 main/PR 预览。


## 公共需求分页查询与真实链读取

kq-market 新增 ListDemands，使用 Fabric 原生书签按需求键分页（最多 50 项），沿用 market/commercial 角色读取权限。Market Adapter 增加固定 query 接口，仅 evaluate 公开目录与单条需求，不提交查询交易；校验 schema、请求 ID、摘要、页大小与重复项。Server Unix 客户端和 /api/federation/market/demands、/:id 已接通，网络前后复核当前组织 market.read；读取期间不持数据库锁。未配置/断线返回 503，错误响应 502，不存在返回 404；不把故障转成空列表。observedAt 是读取时间，不能证明区块新鲜度；跨页不是同一快照。没有新增迁移、本地镜像表或轮询任务。

七项市场链码单测、四项 Adapter SDK 场景及三类私有 HTTP runtime 检查通过（其中多数是既有场景回归）。九个隔离 PostgreSQL 场景通过，新增两项验证公共查询前后权限、只读能力、断线/缺失/错误响应与 HTTP 分页边界；最终错误响应修正后定向两项通过，不重复计数。首次 SDK 调用误用了未导出的 EvaluateError，改为真实 GatewayError；测试类型的字面量与 unknown 展开问题也已修正。

实际 Fabric 3.1.5 三机构网络七组断言通过：前六组回归多数背书、竞争认领和原交易恢复，第七组通过生产 Node Adapter/Server Unix 客户端逐页读取两条真实提交需求、校验详情、不重复书签及不存在记录。证据 temp/fabric-network-fXO5Lf，摘要 temp/federation-market-query-network-report.json；所属 Peer/Orderer/CCAAS 均由测试入口清理。首次入口因未设置工具路径在启动前拒绝，补齐已验证工具目录后运行；不算链测试失败或通过。

本轮仍不是 Server 数据库到 Fabric 的完整联合验收，目录读取也不允许执行。市场 Web、私有锁额、跨链码 executionGate、结算、物理介质与归档恢复及 PR 预览继续待办。未合并、未部署 main。

收尾：完整类型检查执行后仅 Adapter 的上述导入/测试类型错误未通过，其余包检查通过；修正后 Adapter、Server 及 Fabric 脚本定向类型检查均通过。全仓 lint 无错误，保留既有 47 warnings/1 info；最终 14 个修改源码文件 lint 无诊断，672 个文档目标、workflow 引用及 diff 检查通过。随机测试数据库已删除，所属数据库转发已关闭。没有重复运行未改动的商业/证据网络验收。


## 私有预算预留与同通道执行许可

新增 CommercialReservation/CommercialRelease 双签正文及专用签署用途；完整委派和预算只存双方 PDC。公开认领固定 commercialDomainId，预留 ID 等于 claimId；链码核对当前认领、双方、资源、合同摘要、材料/软件锁、期限和封顶额度。预算按 domain/budgetDomain/epoch 唯一，BigInt 计算，合同换 revision 不能增大上限或重置余额；同 task/attempt、operationId 及 releaseId 均防复用。不将提供方用量报告当成增发额度的依据。

ReserveExecution 同事务写私有预算/预留/唯一映射/READY gate。gate 只包含可公开的路由、版本、激活期限与带盐私有预留摘要，仍保存在 PDC；GetExecutionGateHash 仅返回当前私有数据哈希。Market ActivateDemand 在同通道读取该 hash，验证批准公开的 gate 原文并写 ACTIVE；ReleaseExecution 反向读取公共 CLAIMED，减少锁额、追加回执并将 gate 升版 REVOKED。旧许可不能激活，已激活或仅自然到期不允许释放。未新增私有载荷接收机构，没有改变原生 PDC AND/市场 MAJORITY/治理 ALL。

真实 Fabric 暴露重复预留直接返回回执而没有私有写入时，交易会落到商业链码默认 ALL 背书，导致双方提交 INVALID。已改为写回原私有记录，保持集合双方 AND，不重置余额/gate；重复释放也采用同样约束。原生双向竞态和实际区块检查通过：释放先提交使旧激活因 hashed read 的 MVCC_READ_CONFLICT 失效，激活先提交使旧释放因公共状态 read 冲突失效；同时锁最后一份预算只有一笔有效，另一笔重试明确 BUDGET_EXHAUSTED。缺 B 背书 INVALID，释放 ID 跨预留重用拒绝。真实私有区块核对余额为 18014398509481986、锁定数量 2，未发生浮点舍入或重复释放。

三机构真实网络共五组断言通过，覆盖角色独立证书、两份同通道链码、两类竞态、余额和隐私。A/B 获取私有写入，C/C、C 请求 A、A 请求不持私有副本的 C 均拿不到正文；公共区块和服务日志无合同/金额/签名探针。首次脚本错误使用被 Site schema 过滤的目录字段，改用已验证的证书路径；第二次启动就绪只查本地，改为核验实际跨机构查询路径；第三次发现并修复上述幂等背书问题。最终增加释放 ID 防复用后再定向联合验收通过，不能把重跑次数当成新增覆盖。证据 temp/fabric-network-HcX7hn，断言摘要 temp/federation-gate-network-report.json；所有所属网络进程已清理。

37 个不同单元场景首次通过，后增一项预算修订不能重置检查，共 38 项；最新重复预留/释放和 ID 防复用场景已定向复查。预算修订测试首次夹具对 38 位全 9 金额加一超出协议上限，改成合法小于上限的固定预算后通过，没有放宽生产精度约束。共享条款校验拆出 assertDelegationTerms，但原 assertDelegationPolicy 对 ledger_coordinated 的拒绝仍保留并经既有测试覆盖。

新增 test:fabric:gate 与 CI 入口，部署说明和验收覆盖映射已同步。完整类型检查通过（含所有包、protobuf 和 Fabric 脚本）；全仓 lint 无错误、保留既有 47 warnings/1 info。最终修改文件 lint、676 个文档目标、workflow 引用和 diff 检查通过。

这仍只证明链码协调，不是 Server/Agent 真实执行。新用途的 Server 信任管理、双签审批、Adapter/数据库待办与执行验权、ACTIVE 终态/结算/重开、物理介质、容量/归档恢复、完整 Web 和 PR 预览均未完成。没有合并或部署 main，目标继续保持完整范围。

## 执行许可生产 Adapter 与恢复

Commercial Adapter/Server Unix 客户端接入双签预留、释放和固定 gate 哈希查询；Market Adapter 接入公开激活。私有操作绑定摘要、域、记录标识、双方与专用密钥用途，并只向 PDC 的两个 MSP 发送 transient。恢复继续使用原加密协议；DATA_WAITING 重试，明确预算/政策拒绝进入复核，混合错误保留基础设施失败语义。现有用户 HTTP、商业业务接口和市场持久输入不扩大，不能用发布权限直接激活。

本增量 23 个不同单元场景通过：原批次 21 项成功、一项旧 DATA_WAITING 错误预期失败，修正后定向通过；新增激活与哈希错误分类各自定向通过，哈希场景属于原集合内扩展而非新增计数。哈希测试首次引用 SDK 不存在的 EvaluateError，改用实际 GatewayError 后通过。未重复跑未改动的合同链网络。

真实 Fabric 3.1.5 三机构七组断言全部通过，证据 temp/fabric-network-pklZKA，摘要 temp/federation-gate-adapter-report.json。五组链码/私有区块回归后，通过生产 Node runtime 和 Server Unix 客户端以新进程分别完成释放、预留、激活，成功提交后故意丢失响应，再恢复相同 txId/区块；预留额外在 Orderer 停机期间保持 pending，恢复后提交。查询核对 REVOKED/READY 哈希、明确不存在与完整匹配的 ACTIVE 需求。私有区块遍历覆盖前五组，不把后续 Adapter 恢复当成另一次私有区块覆盖。网络所属进程已清理。

完整类型检查通过（所有包、protobuf 生成与 Fabric 脚本）；全仓 lint 无错误，保留既有 47 warnings/1 info，最终新脚本与扩展测试 lint 无诊断；676 个文档目标、workflow 引用及 diff 检查通过。仍未接通 Server 双边审批/持久协调和 Agent 实际执行，亦未完成终态结算、重新开放、物理介质、归档与完整 Web/PR 预览。未合并、未部署 main。

## Server 预留/释放审批与提交依赖

迁移 0121 增加机构/组织/合同范围的不可变执行审批，复用商业待办与 worker 提交预留和激活前释放。新增 API 提供分页、确认签名、对方签名附加及安全的最近提交状态，复核复用原 retry。双方同文商业合同、当前组织 agreement.approve 和专用签署用途缺一不可；信任管理目录和中英文标签已支持新用途，旧密钥权限不变。市场预检在数据库事务外，返回后重查权限；最终锁额/释放仍由链码原子校验，不以预检代替执行授权。

同 ID/内容重试保留原签名，已签记录不会因随后 ACTIVE 而丢失可恢复性；不同内容、错配签名、合同/资源/摘要/claim 版本不符拒绝。双方签名附加、待办和摘要审计同事务，写入冲突完整回滚。后台合同 committed 后才推进预留，原预留 committed 后才推进释放；重新发送提案前重验双方当前信任及准确签署用途。资金不写入本地双边预算，也没有开放 Job 派发。

隔离 PostgreSQL 共 15 个不同场景通过：首轮 13 成功、1 个新测试末尾误用不存在的预算列失败（业务恢复断言已通过）；改为实际 domainId 后定向通过。随后补充市场 503/502、认领期限和预留发送前密钥撤销检查通过，最终两项定向检查通过。迁移在随机测试库应用，全部测试库均由 finally 删除，所属数据库转发已关闭。共享信任目录/用量协议两项检查通过。此批使用真实 PostgreSQL 与 Adapter 替身，没有重复运行未改动的真实 Fabric 网络，也不把两种独立检查称为完整联合验收。

完整类型检查通过；后续预检错误映射和用例更新的 Server 定向类型检查通过。全仓 lint 无错误，保留既有 47 warnings/1 info；最终修改源码 lint 无诊断，677 个文档目标、workflow 引用和 diff 检查通过。当前没有自动机构握手、公开激活持久编排、执行 gate 到实际 Job 的授权；终态结算/重开、物理介质、容量与归档恢复、完整 Web 和 PR 预览继续待办，未合并、未部署 main。

### 审批归属补查

后续复核补齐同机构内的组织边界：源站新预留必须引用本组织已 committed 的市场发布，提供方必须引用本组织已 committed 的认领。只核对公共 siteId 不足以证明组织归属；审批现持有对应市场记录的共享锁，其他组织或尚未确认的操作在网络预检前即拒绝。既有签名的幂等读取不产生新的授权。

新增一项 PostgreSQL 场景分别验证源站/提供方缺失或他组织记录拒绝、未确认发布拒绝、合法自身记录通过；与提交依赖场景一起定向通过，扩展提供方分支后仅重跑该场景通过，累计 16 个不同商业数据库场景。Server 定向类型检查和修改文件 lint/diff 检查通过；不重复未改动的全仓检查或真实 Fabric。临时测试库和本轮数据库转发均已清理。

## 源站公开激活持久待办

新增专用 activate API，只接受 activationId；从当前组织已双签且私有预留 committed 的原记录生成公开 gate。源站必须同时具备 agreement.approve/market.publish，当前双方业务签名可信，本组织原发布已 committed；已有同预留双签释放时不接收新的激活。通用市场 enqueue 与 HTTP schema 仍拒绝 activate-demand，不能借普通发布权限绕过审批。公开意图不包含私有委派、额度、材料/环境锁摘要或双签正文。

迁移 0122 扩展市场持久提交，复用既有 Market worker。按本机构/预留建立唯一激活意图；同 ID 重试返回原结果，过期后也不产生第二次授权，不永久占用同需求未来的新认领。审计与意图同事务；未知提交恢复原 txId，INVALID 保留历史后才新建尝试，retry 同时要求两种权限。已接受意图代表机构操作，不因原人员离职自动消失，实际运行的当前授权仍需执行方单独核验。

隔离 PostgreSQL 新增五项激活场景及九项市场回归全部通过，覆盖锁额前拒绝、公开载荷隐私、并发幂等、原期限后的重复读取、双签释放/密钥撤销拒绝、检查点恢复、INVALID 历史和通用入口绕过拒绝。唯一约束初稿过宽地按 demandId 限制，复核后改为 reservationId；未提交的生成材料移至忽略目录，从上个已提交快照重新运行 db:generate 得到最终单份 0122，未手改 SQL/快照。最终迁移在新随机库应用，幂等/唯一场景定向通过；重跑不计新增覆盖。

完整类型检查通过（protobuf、全部包及 Fabric 脚本）；全仓 lint 无错误，保留既有 47 warnings/1 info；最终七个修改源码文件 lint 无诊断，678 个文档目标、workflow 引用和 diff 检查通过。此轮数据库检查使用 Adapter 替身，没有重复跑未变更的真实链码/Adapter 网络。尚未验证本审批数据库到真实 Fabric 的联合流程，亦未开放实际 Job 执行。自动机构握手、实际执行授权、终态结算/重开、物理介质、容量/归档、完整 Web 与 PR 预览继续待办。

### 真实 PostgreSQL/Fabric 激活联合检查

新增 test:fabric:gate:integration，保留原无数据库入口。复用五组原生链码竞态/私有区块检查，随后启动生产 Node Commercial/Market Adapter 和随机隔离 PostgreSQL。两家机构使用不同组织、真实业务签名和显式权限，经生产商业与执行审批服务确认合同、原预留、释放和新预留，真实链确认后生成公开激活待办。历史发布/认领来自本轮原生链探针，以对应内容导入本地夹具，未声称从所有市场 HTTP 入口启动。

真实链第一次联合运行即通过。旧私有预留幂等确认，释放后的 gate 哈希匹配；新预留成功后，激活 prepared 检查点先保存，再停 Orderer，数据库保留 pending/原交易。恢复 Orderer 后故意丢失 VALID 响应，新的服务实例按生产退避继续恢复，最终只有原交易一个尝试，真实需求 ACTIVE 的 activationId 和预留一致。此处是服务实例/响应故障，不是完整 Server SIGKILL，亦无 Agent/Job。公开日志检查包含新增生产 Adapter 日志；私有区块完整遍历仍只覆盖前置竞态交易。

最终七组断言通过，证据 temp/fabric-network-7aYWxs，摘要 temp/federation-gate-database-report.json。所属 Adapter/Peer/Orderer/CCAAS、随机数据库和本机数据库转发均已清理。Fabric CI 的 gate 项改为联合入口，无数据库跨进程恢复入口保留。完整类型/lint 在本轮业务增量已通过，新增联合脚本另经 Fabric 脚本类型检查、五个相关文件 lint、679 个文档目标、workflow 引用及 diff 检查通过；没有再跑未修改的整个项目测试。源站实际委派、提供方执行验权、自动握手、终态结算/重开、物理介质、容量/归档、完整 Web 和 PR 预览仍未完成，目标保持完整范围。


## 链上协调协议的本地执行同意

迁移 0123 将已安装协议的本地 budgetDomainId/epoch 外键改为按模式约束：双边模式必须保留与签署条款一致的本地预算，ledger_coordinated 必须两列均为空。完整商业预算标识仍保留在原签署条款中；不会建立零额假预算、复制链上可用额度，也不删除或改写原双边余额。原预算外键、双边 epoch 唯一性和守恒约束保留。

执行协议 approve/counterparty 与底层 installApprovedAgreement 现在允许链上协调协议的本地同意。前提是同站点、同组织、同 revision 已有商业双签，嵌入的完整执行条款必须一致；每次批准/安装重新验证两份商业原文、摘要、当前机构信任和 commercial-agreement 用途。提供方仍须选择当前有效的受限服务账户，普通 agreement 签署权不能替代商业签署权。对方执行签名、安装与审计在原事务内提交，失败回滚；并发同请求只安装一份，不创建本地可用额度。

这里保存的是执行同意，不是运行许可。接单仍明确拒绝 LEDGER_REQUIRED，源站发送、材料披露和执行准备原有拒绝规则不放宽；context.supportedModes 暂仍只列可运行的两个双边模式，Web 不提前开放协调执行。审批 API 可用于准备同意，不能把 installed/active 状态当作链上 ACTIVE 或已派发 Job。实际执行还须绑定精确私有预留、公开激活和本地当前授权；旧 Peer 查询或调用方布尔值不能代替这项检查。

验证：由 db:generate 生成 0123，并在随机隔离 PostgreSQL 从空库迁移。新增 5 项覆盖并发无本地预算、缺少双签/条款不符/跨组织、商业签名与用途和机器身份、数据库模式约束、单独商业密钥撤销及底层安装绕过；原接单与审批测试另有 25 项通过，异步存证定向回归 2 项通过，共 32 项不同用例。数据库约束按 UUID 类型比较预算标识，保留合法大写 UUID 的历史协议兼容性。首次约束测试传入 Drizzle thenable 导致测试断言失败，改为执行 Promise 后定向检查通过，没有将该失败误记为数据库约束缺陷。本轮无 Fabric/Agent/科研作业验收，未发布预览或部署 main。

静态检查：全仓 lint 无错误（原有 47 warning / 1 info）；全仓 typecheck 首次发现异步存证调用方的可空预算类型问题，修复后 Server 定向检查通过，其余包、protobuf 和 Fabric 脚本检查均通过。最后一次锁序修订已再通过 Server 类型检查及上述 5 项定向数据库测试。681 个本地文档目标与差异格式检查通过；测试库、转发进程均已清理。


## 有期限的链上执行确认

Market 链码与生产 Adapter 新增 AuthorizeExecution/authorize-execution。确认固定本机构、原需求/activationId/公开 gate，交易须读取当前 ACTIVE 和同通道私有 gate 哈希，并取得 VALID；第三方不能申请，当前哈希变化拒绝。最长 5 分钟有效，确认原文不能换内容或通过恢复延长；当前状态按需求/机构覆盖为最新确认，历史交易仍保留。Server 消费时仍须核对原私有执行期限及本地当前授权，不能把查询结果、prepared/pending 或已经过期的 committed 作为许可。详见[协议与存储边界](../../../deploy/federation/fabric-execution-gate.md#有期限的链上执行确认)。

17 项链码/Adapter 单元测试通过，其中 4 项为新增确认测试；覆盖身份、ACTIVE/gate 绑定、私有字段拒绝、绝对期限、单方有序续期、旧确认不能覆盖、当前状态条数与恢复载荷。test:fabric:gate 通过 8 组检查：新增真实确认的 public ACTIVE/private-hash 原生读集检查、同机构并发确认的 MVCC INVALID、两方可确认/第三方拒绝；生产 Node Adapter 与 Server Unix 客户端验证确认在 Orderer 中断和进程退出后恢复同一原交易。原有锁额/释放竞态和公开区块/PDC 隐私检查继续通过，新增原生确认交易包含在这轮区块遍历中。

test:fabric:gate:integration 通过 9 组检查，包含真实 PostgreSQL 双签审批、私有预留/释放/替换及公开激活，随后从实际激活结果取得原 gate 并申请执行确认，验证同一原交易恢复。CI 联合入口已纳入该确认恢复检查。两入口有重叠，不把分组数相加为独立场景。全仓 typecheck（含 protobuf 与 Fabric 脚本）通过；全仓 lint 无错误，仍为原有 47 warning / 1 info；最终修改文件的 Biome 与差异格式检查通过。

本轮没有 Server 自动确认待办、接单/材料/派发消费或 Agent 作业；已有生产协调执行入口仍拒绝。未增加 ACTIVE 停止/终态释放或重新开放，不能用这轮确认竞态代替这些未实现转移的验收。未发布 PR 预览或部署 main。真实网络与临时数据库均已由测试清理，私有诊断材料仅在忽略目录。

## Server 执行确认待办与事务内验权

新增 FederationExecutionConfirmationService：按当前组织和精确双签私有委派构造确认，复用原市场 worker 的持久检查点；人工 confirm API 只接受空请求体并要求 agreement.approve。并发申请去重，余期不足一分钟时创建新确认，旧确认不会被延长。事务内 authorize 重查本地执行同意、商业双签、已提交预留、签名信任、取消状态及提供方受限账户，只消费匹配的 VALID 交易证据，返回最短绝对期限。迁移 0124 由 db:generate 生成，新增固定操作约束和查询索引；不创建本地预算。

隔离 PostgreSQL 37 项测试通过（7 项新增确认测试及原商业/市场回归），覆盖并发、未提交拒绝、续期、期限、组织/精确委派、暂停、签名与执行身份失效、交易证据和摘要、审计回滚、跨网络权限变更及 HTTP 空请求体。全仓 typecheck 通过，lint 无错误（原有 47 warning / 1 info）；最后新增联动脚本再通过 Fabric 脚本类型检查及 Biome，684 个本地文档目标检查通过。

真实 test:fabric:gate:integration 通过 10 组检查。新增服务端真实申请及消费测试经过生产 Node Adapter、真实 Peer/Orderer 与随机 PostgreSQL：pending 和 prepared 均拒绝，只有 VALID 后返回有期限证明，暂停本地协议后再次拒绝。原真实私有预留/释放/激活竞态、公开区块隐私及确认原交易恢复继续通过。本轮各组是同一联合网络中的检查，不能算作 10 个完整端到端作业。网络和测试库已清理，私有材料仅留在忽略目录。

接单、材料授权和派发尚未接入新服务，协调作业仍关闭；尚无 Agent/科研作业验收，未发布 PR 预览或部署 main。下一项是把确认接入实际消费者和执行租约，保留双边流程不依赖 Fabric。

## 协调执行消费者与租约

源站提交/后台发送/材料披露、提供方接单/准备/绑定及派发已接入执行确认服务。生产构造共用确认服务，网络续期在事务外，最终操作事务内重新验权；接单按协议串行后保持与本地暂停相同的锁序。接单回执采用精确商业预留 ID，并发请求只保留一份，不创建或扣减本地预算。源站仍检查接单数量及私有精确条款；接收回执必须匹配原商业预留。下载凭据、派发及原运行续期均受确认的绝对期限约束。

内部续期遇到短暂 Fabric 故障，可使用仍有效的原 VALID，最终事务再次验证；过期确认、权限撤销或无效 Adapter 响应不降级放行。已接单的回执恢复不需要新链确认，但不能据此获得材料或执行权。对外人工提交遇到待确认状态返回无缓存的 503/LEDGER_PENDING，继续由现有待办处理；双边模式没有新增 Fabric 依赖。

新增数据库验证贯通源站提交、接收方回执、真实材料映射、工作流绑定及最终派发检查：同一商业预留、并发幂等、不生成本地预算、未 VALID 拒绝、身份失效拒绝、截止后拒绝，另覆盖短暂断链续期与提交 HTTP 待确认响应。使用测试 Adapter 和进程内传输，没有真实 Agent Job、调度器、跨站 mTLS 或完整真实链计算。真实链仍沿用上一节的确认协议/持久化验证；Web、自动商务握手、ACTIVE 停止/结算/重开及完整联合验收未完成，PR 预览尚未发布，未合并或部署 main。

验证结果：商业/市场 40 项用例中，首次 39 项通过，新增测试误用绑定方法名后已修正；协调链路/续期 5 项及最终 HTTP 链路定向复验通过。接单/协议/材料/出站 310 项回归首次 307 项通过，3 项失败来自共享站点的历史测试任务抢占工作线程批次；单独运行三项均通过。修正测试夹具清理后，完整出站复验 175/176 通过；最后一项还受旧普通 API 取消任务干扰，补齐源站夹具隔离后，取消/材料相关 25 项定向复验全通过。没有重跑已通过的其他套件，也未修改生产批次大小或放宽断言。每项已有通过记录，不将定向复验重复计入用例总数。

全仓 lint 无错误（原有 47 warning / 1 info）；全仓类型检查发现新增测试两处可空断言，修正后 Server 定向类型检查通过，其余包和 Fabric 脚本均通过。最终修改文件 Biome、差异格式及 684 个本地文档目标检查通过。随机测试库与临时转发均已清理。


## 真实 Fabric、双平台与 Kubernetes 文件工作流

人工预先批准机构信任、商业合同、执行协议与模板映射后，真实三 Peer Fabric 网络、两份独立 PostgreSQL、两个完整生产 Server、四个 Node Adapter 和两个正式注册的 Agent 已通过联合执行。生产 worker 实际完成公开发布/认领、双方私有合同/预留、源站激活与双方有期限确认；不是直接在数据库伪造 committed。源站 HTTP 重复提交同一委派，提供方从零份清单按签名摘要拉取输入与环境锁，通过真实 mTLS、受限执行身份和 OCI sandbox 完成两个 Kubernetes Script Job：`6` → `42` → `verified:42`。

源站查询并验签远端状态，取得仅包含 Persistent 产物的清单；独立源站 Agent 复制、实读 SHA-256 校验并整单登记到独立的版本化对象存储，云盘实际下载得到准确的 12 字节，再取得对端签名接收回执。重复委派保持一份预留/一个 Workflow/两个 Job，重复结果导入保持同一份云盘文件。两份数据库均无本地预算；成功任务目前仍保留链上 ACTIVE 和私有锁额，不能把作业完成或回执 recorded 当作结算释放。

把原本位于忽略目录的联调脚本整理为 `test:fabric:execution`：明确 opt-in、专用本机单节点 k3s、固定镜像摘要、可配置 PostgreSQL 工具路径、自动读取本机节点地址、独立环境/账号与私有诊断目录；原生链进程复用既有测试生命周期。数据清理前导出交易 ID、VALID 验证码、区块号、预留/作业映射及无本地预算的证据；清理失败明确报错并保留材料。完整条件和边界见[执行验收说明](../../../deploy/federation/execution-lab.md)。

此前临时脚本成功运行的材料位于 `temp/federation-coordinated-live`。整理后的首轮因全仓类型检查并发占满 CPU（Agent 99%，生产上限 95%）被真实调度器拒绝，没有派发 Job；未修改调度保护。静态检查结束后，加入业务提交前真实 Agent 负载观察，成功场景复验通过，证据 `temp/federation-execution-success-u168s_ho`。源站记录 5 笔、提供方记录 4 笔已 VALID 的商业/市场交易，全部有区块号；交易数不是独立业务场景数。

范围仍是同一主机模拟机构、人工业务预批准和直接委派 API。此轮没有 Spack 安装、科研计算、Slurm/PBS、普通源站 Workflow 动态调用或真实机构治理；自动商务握手、ACTIVE 停止/结算/重开、物理介质、容量与归档恢复、完整 Web/CLI 和 PR 预览继续待办，未合并或部署 main。


### 真实断链、确认到期与恢复

故障场景实际运行 `sleep 600`，确认进程存在后仅停止本轮自建 Orderer；不修改签名、数据库时间或期限。最终独立 `outage` 复验退出 0，证据 `temp/federation-execution-outage-v1lrqcke`，Fabric 材料 `temp/fabric-network-1jrD10`。原确认在 2026-11-07 15:26:40.802 UTC 到期，Kubernetes 的 Job 删除时间记录为同一秒；Pod 使用实际 30 秒优雅终止宽限期。终态观测时原 Job/Pod 都已消失，平台 Job 为 cancelled、Workflow 为 failed，下游未派发、没有产物。过期 VALID 的事务内 authorize 拒绝，期间没有新的 committed 确认；原公开需求保持 ACTIVE、私有 gate 哈希不变，双方本地预算均为空。恢复 Orderer 后继续观测 15 秒，没有重启旧任务。此处验证停止与锁额保留，未实现终态结算释放。

前两次故障尝试用于修正测试观测：最初错误依赖沙箱 stdout 的运行中标记，而 stdout 在退出后才发布，现改为读取容器内真实 sleep 进程；随后 20 秒停止观察窗短于 Pod 的 30 秒终止宽限，已有证据显示到期当秒发起删除，并保持停止待确认。现同时要求到期 10 秒内观察到删除请求，以及经过实际宽限期加 30 秒状态回收后 Job/Pod 真正停止，不把删除已接受当作停止。一次 namespace 清理等待 40 秒超时后，已核实 namespace/RBAC 和 PostgreSQL 均停止并清理遗留私有目录；脚本改为有界的 90 秒删除等待。最终场景全部自动清理成功，不把早期失败轮次算作验收通过。

新增测试 Server 入口复用生产全部配置与处理器，仅将开发登录 HTTP 绑定 loopback；实际检查两端监听均为 127.0.0.1，Agent 继续用独立 mTLS 通道。成功场景和最终故障场景分别有完整通过证据，没有声称同一轮默认双场景命令最终全绿。全仓 lint 无错误（原有 47 warnings/1 info），全仓 typecheck 通过；最后新增测试入口另经 Fabric 脚本类型检查和 Biome。Python 语法、格式、两入口未 opt-in 拒绝、文档链接与 workflow 引用检查通过。没有重复未修改的其他业务测试，也没有运行 Slurm/PBS/Spack。

## 链级停止意图与续期竞态

Market 新增 RequestExecutionStop、Adapter 新增 request-execution-stop，双方任一机构可按原 ACTIVE 版本请求停止。首份请求将公开需求推进 STOPPING，另一方保留独立不可变回执；精确历史重放不改变后续状态。同机构同次激活不能换请求，第三方被拒绝。请求仅含公开绑定，不包含原因、合同、用量或价格；不要求对方业务签名，不释放私有额度，也不证明调度器已经停止。已有 VALID 仍受原绝对到期时间约束。通用市场 HTTP 创建接口暂不开放该操作。

39 项不同链码/Adapter 测试通过，覆盖停止身份、幂等、版本和状态绑定、过期后停止、STOPPING 拒绝确认及商业释放；后续状态约束复验与原测试存在重叠，不累加计数。真实 test:fabric:gate 退出 0，通过 9 组检查：停止先提交使已背书续期 MVCC INVALID，双方停止收敛，第三方拒绝，私有 gate 不变且不能释放。生产 Node Adapter 与 Server Unix 客户端在 Orderer 中断和进程退出后恢复原停止交易 ID；公开区块/PDC 隐私检查包括新停止交易。测试网络已清理，证据留在忽略目录 temp/federation-stop-report.json、temp/federation-stop-network.log。

全仓 lint 无错误（原有 47 warning / 1 info），全仓 typecheck 含 protobuf 与 Fabric 脚本通过。此轮没有数据库服务/迁移变更，未重跑数据库集成或真实 Agent 作业；Server 持久化停止接口、本地停止防线和取消联动尚待接入。启用前必须同步升级链码、Adapter 与读取新状态的 Server；不能让旧严格 schema 读取 STOPPING。未发布 PR 预览，未合并或部署 main。

## 平台停止待办、本地禁止续期与真实主动停机

新增机构专用空正文 stop API，要求当前组织 agreement.approve；源站普通取消沿用 delegation.cancel 或持久 Workflow 取消授权，在原事务内同步保存链停止意图，不要求提交用户具备商业批准权。迁移 0125 通过 db:generate 生成，在原商业预留审批上保存停止 ID、请求人/时间和投递重试信息，不改签名正文。并发重复请求保持同一 ID，停止与审计原子提交；断链、合作失效或已到期不清除已保存停止。

执行确认的最终事务共享锁与停止写入互斥，本地停止后旧 VALID、已排队续期或上链 needs_review 均不能恢复材料/派发/续期权限。独立 Workflow 监控额外读取本地停止，准备流程临时故障时仍可调用原取消机制。后台查询精确 activation 后才构造公开 stop，复用市场持久检查点；未知已提交交易保留原 ID。市场重试要求 market.read 加 agreement.approve，不误用 market.publish。机构专用接口不冒充另一方签署用户取消，另一方已有离线许可仍以 STOPPING 和原绝对期限为边界；普通源站取消继续走已有签名通道。

隔离 PostgreSQL 从空库迁移后，10 项新增停止测试和 40 项商业/市场回归通过，共 50 项不同用例：双方本地断链停止、并发幂等、网络续期竞态、重启/未知交易恢复、错误激活绑定、激活前待办、跨组织/机器身份拒绝、审计回滚、重试权限、SQL 约束、独立 Workflow 取消及普通源站取消联动。8 项新测试与其余 42 项分开运行，没有重复累加。数据库已停止并清理。测试 Adapter 不当作真实链证据，模拟 runner 的取消调用也不当作进程退出。

新增 KQ_FEDERATION_LAB_SCENARIO=stop 复用真实链、双 Server/独立数据库、两个 Agent 与轻量 Kubernetes sleep 任务。首轮在提交作业前遇到测试脚本未处理 Agent 初始 CPU 采样 null，异常退出并清理；修正为等待有效采样，没有改变 80% 就绪阈值或生产调度保护。此失败不计为业务验收通过。

最终主动停止复验退出 0，私有证据 temp/federation-execution-stop-igwwckad，网络材料 temp/fabric-network-5VNoiS。实际读取到 sleep 600 进程后停自建 Orderer；提供方 HTTP 在 2026-11-07 16:02:17.097 UTC 保存停止，两次调用返回同一 ID，Kubernetes Job 删除时间为同一秒。Pod 原终止宽限 30 秒；16:03:18 UTC 观测时 Job/Pod 均消失，平台 Job 和 Workflow 均 cancelled，无下游与产物，此时原 VALID 仍要到 16:06:43.834 UTC 才到期。事务内 authorize 明确返回 CANCELLATION_REQUESTED，期间私有 gate 与 ACTIVE 均不变，双方没有本地预算。恢复 Orderer 后同一停止 ID 的唯一交易取得 VALID（区块 20），需求变为 STOPPING，私有 gate 未改变；再观察 15 秒旧作业未重启。所有自建进程、数据库、namespace/RBAC 与临时凭据清理成功，保留的诊断与测试链材料仅在忽略目录。

全仓 lint 无错误（原有 47 warning / 1 info）；全仓 typecheck 首次仅发现两处新测试的可空数组断言，修正后 Server 定向类型检查及 Fabric 脚本检查通过，其余包与 protobuf 已通过。最终 Python 格式、语法、文档链接/workflow 引用与差异格式检查通过。本轮只重跑失败的主动停止场景，没有重复此前成功的文件回传与自然到期场景；不覆盖 Slurm/PBS、Spack、真实科研计算或独立机构。终态停止/完成证明、结算释放与重开、自动商务握手、物理介质、容量归档、完整 Web/CLI 与 PR 预览仍待完成；未合并或部署 main。

## 双方终态确认与公共关闭协议

新增 CommercialTerminal 与独立 commercial-terminal 签署用途，正文绑定原私有预留摘要、原 activation、gate 版本、执行证据/可选结果摘要、终态结果、观测时间和随机盐。RecordExecutionTerminal 要求双方同文签名及双方集合原生背书，只接受精确 ACTIVE/STOPPING 激活。完整原文留在预留私有记录中，唯一 ID 索引只存预留标识/回执/盐，避免重复存储签名正文；gate 升版为 TERMINAL，不修改 locked、spent 或预留数量。公共 CloseDemand 只传不含终态明细的 gate 原文，经同通道私有哈希检查推进 CLOSED；双方任一方可提交固定 terminalId，同文重放不增版，旧停止或关闭不能重开任务。

54 项链码/Adapter 用例通过，其中 8 项新增：完成/失败/取消三种终态、合作窗口到期后的确认、错激活/错版本/第三方/错签/撤销密钥拒绝、预算不变及旧释放拒绝、ACTIVE 与 STOPPING 两条关闭路径、重复确认和关闭、终态专用签署用途、私有 transient 和公开载荷隔离。后续私有唯一索引缩减为回执标记，4 项终态用例与 Commercial 类型检查定向复验通过，未重复累加用例数。

真实 test:fabric:gate 退出 0，通过 10 组检查，证据 temp/terminal-network-report.json、temp/terminal-network.log，网络材料 temp/fabric-network-ZRqlCf。新增真实私有终态提交先于已背书续期，后者得到 MVCC_READ_CONFLICT；新续期被拒绝，原两方可关闭同一激活并保持 CLOSED，终态重放不释放资金。零金额预留仍占用一个名额，原生 PDC 区块遍历确认预算精确且计数保持占用；第三机构包括跨 Peer 身份读取均无法取得私有正文，公开区块和服务日志未泄漏新终态签名、执行证据摘要或盐。原锁额、停止和释放竞态继续通过。生产 Node Adapter 与 Server Unix 客户端新增 terminal/close，在 Orderer 中断、进程提交后退出和重复恢复时保留原交易 ID，最终读取 TERMINAL gate 哈希与 CLOSED 状态。网络已清理，私有材料只在忽略目录；最终索引去重不改变 gate、公有载荷、预算、签名验证或读写依赖，仅另做上述定向检查。

全仓 lint 无错误（原有 47 warning / 1 info）；全仓类型检查首次发现非法输入测试的 TypeScript 多余属性报错，改为沿用变量传递的边界测试形式后 Adapter 定向类型检查通过，其余包、protobuf 和最终 Fabric 脚本类型检查均通过。最终修改文件格式、差异及本地文档/workflow 引用检查通过。数据库仅扩展签署用途的 TypeScript 类型，没有 SQL 结构变化；没有重跑数据库集成或 Agent 作业。Server 通用商业 worker 明确拒绝尚未接入证据审批流程的 terminal 操作，通用市场入口也不开放 close，数据库提交约束未放开。

这一轮真实链使用双方签署的测试终态声明，不是由真实作业证据自动产生的业务闭环。下一项仍是 Server 证据归集与永久禁止新执行的事务约束、双方终态审批/自动交换和持久提交，随后接独立账单确认、结算、争议与重开。完整 Web/CLI、自动商务握手、物理介质、容量归档及 PR 预览继续待办；未合并或部署 main。


## 提供方终态证据、审批与永久禁止重派发

新增提供方专用终态 GET/POST，POST 只接受空 JSON，要求本组织人工 `agreement.approve`，GET 要求 `agreement.read`。首次查询匹配原 ACTIVE/STOPPING 激活后，持有商业预留写锁，从原签名入站委派、唯一持久 Workflow 和所有 Job 归集证据；不允许调用者上传 outcome 或任意摘要。核对快照、调用路径、执行身份、任务/尝试、派发代次与终态观察。取消/数据撤销必须收到确认；安装仍运行时只能用明确 installation-stop 回执作为停止依据。源方取消还须等待原取消监控完成及输入清理，完整保留该取消摘要和输入状态。

成功任务配置了结果交付策略时，要求源方签名接收回执并校验绑定与唯一清单；无结果交付策略时不虚构结果。失败/取消不声称交付。签署、私有证据、本地永久执行防线和审计在同一事务保存，迁移 0126 使用 db:generate 生成。最终执行确认取得原预留共享锁，在防线落库后拒绝旧 VALID 消费与续期；独立 Workflow 监控也拒绝重派发。并发/重启返回同一记录，事务回滚不留下半份防线。持有 run/job 的并发业务使用 NOWAIT 避免锁顺序互等。原执行期限已到不妨碍确认历史终态，但业务密钥仍需通过当前信任与显式 commercial-terminal 用途检查。

隔离 PostgreSQL 从空库完整迁移：新增 13 项终态测试最终同轮全部通过；另有 50 项既有商业/市场回归通过，共 63 项不同用例。覆盖完成/失败/取消、并发与重启幂等、旧 VALID 拒绝、续期网络竞态、执行期限结束后签署、签名用途、组织/提供方权限、HTTP 拒绝自报证据、原始观察缺失、调用路径冲突、安装停止代次、待清理回执、源方取消监控、结果接收签名/摘要、审计回滚和锁冲突。测试使用真实 PostgreSQL、生产服务和模拟市场 Adapter，没有运行新 Fabric 网络或真实 Agent 作业。

早期测试夹具缺少执行 lease 与正常取消确认，已补齐；完整静态检查与测试同时运行时触发过默认 5 秒测试超时，最终定向验收使用 30 秒上限（最终各用例约 1–2 秒）。新检查最初将旧 SQL 本地时间 createdAt 与 Server UTC acknowledgedAt 直接比较，Asia/Shanghai 隔离库揭示错误：现仅检查真实确认存在且不晚于观察时间，代次/Agent/安装停止校验保持。原始旧时间字段未迁移。早期失败不算通过，重跑次数不累加用例数。证据留在忽略目录 temp/execution-terminal-pg.log 与 temp/execution-terminal-regression-pg.log。

静态检查：全仓 lint 无错误，保留原有 47 warning / 1 info；新增和最终改动文件 Biome 通过。全仓 typecheck 首次仅发现测试夹具漏传取消 outbox 的 dispatcher，修复后最终 Server 定向类型检查通过，其余包与 protobuf 已通过，Fabric 脚本类型检查另行通过。693 项本地文档目标、workflow 引用和差异检查通过。

范围仍是提供方生成并签署终态，不是双方自动确认闭环。源方复核/签署、机构交换、终态与关闭的持久上链待办尚未接入；商业 worker 和通用 HTTP 继续拒绝任意终态材料。此轮不释放预算、不批准账单、不执行支付，也未覆盖新功能的真实多平台运行、Web/CLI 或 PR 预览；未合并或部署 main。下一项接源方按自己的结果导入/取消证据复核，之后才允许双签终态进入既有链协议。


## 源方终态复核与双签私有提交

提供方可按专用 proposal GET 导出三字段材料；源方专用 countersign POST 验证当前机构人工审批权限、原商业预留/激活和双方签名，核对完整提供方证据摘要及 Job/安装/取消/清理绑定。源方必须独立拥有原 accepted 委派及接单签名、匹配的已核验终态报告；要求结果交付时必须有匹配的 available 导入与签名接收回执，并校验原模板/输入/环境锁/清单/完成时间/文件数与字节数。源方取消过任务时必须有自己的 stopped 回执和相同取消摘要。不能仅凭对方给出的一个任意摘要签署。

源方同事务保存原文签名、私有复核材料、本地执行防线、审计和 record-execution-terminal 待办。新迁移 0127/0128 均由 db:generate 生成。保留原委派、接单、状态、结果报告和取消回执的签名原文，源方导入 ID 不随 proposal 披露。原终态 issuedAt 保持同文，源方复核时间单独记录。并发/重启返回同一份记录，已签同文可在链离线时重放；换材料或对方签名被拒绝。源方原有执行确认消费同一终态防线，旧 VALID 不能复活任务。

商业 worker 仅在匹配本地双签终态及原预留已提交后接单，Adapter 披露前重验原文、双签、当前信任和本地审批；篡改的待办进入 needs_review。检查点继续保持原交易 ID，终态 GET 可查 submission、交易阶段和区块。只提交带盐终态正文与双签，不提交完整 Job 证据、源方导入 ID 或复核材料。通用商业 API 仍不接受 terminal 正文。

隔离 PostgreSQL 从空库完整迁移后，75 项不同测试同轮通过（12 项新增源方用例、13 项提供方终态及 50 项原商业/市场回归）。覆盖三类结果的并发/重启双签、原 VALID 拒绝、篡改证据/签名/激活、无本地状态、伪造已停止声明、当前组织与撤销密钥、结果尚未导入/清单变化、待确认取消/不同取消摘要、私有提交和 Adapter 断线恢复原交易、披露前篡改阻断、审计回滚、错误接单额度与 HTTP 人工权限。之后只增加复核签名原文留存字段，完成/结果两项定向复查通过，不累加测试数。早期首次测试发现新增共享子路径未登记 package exports，补齐后通过。证据 temp/terminal-source-final-pg.log、temp/terminal-source-retention-pg.log 均保持忽略。

静态检查：全仓 lint 无错误（原有 47 warning / 1 info）。全仓 typecheck 首次只发现测试中 nullable 接单签名的断言类型，补显式非空检查后最终 Server 定向检查通过；其余包/protobuf 已通过，Fabric 脚本类型检查另行通过。最终改动文件格式、693 项本地文档目标、workflow 引用及差异检查通过。

这些用例使用生产 Server 服务、真实 PostgreSQL 及模拟 Adapter/对端签名消息；结果导入和停止状态是测试夹具，不代表本轮运行过 Agent 或真实拷贝。此轮未启动新的 Fabric 网络、未跑真实双平台任务。下一步仍须接自动机构交换、公共关闭待办和真实终态联验；账单/结算/争议/重开、自动商务握手、介质与归档容量、完整 Web/CLI 和 PR 预览继续待办，未合并或部署 main。

## 私有终态后的持久公共关闭

迁移 0129 由 db:generate 生成，允许内部 close-demand 并按本机构/activation 唯一约束。源方商业 worker 在私有终态最新交易获得 VALID 区块确认后，同事务保存确认、固定 terminalId 的关闭待办和审计；升级或重启可沿用原队列补办已确认而未入队的历史终态。入队不访问网络，不要求重新业务签署；首次公开准备和提案推进前重新核对本地双签、原预留、私有回执与完整关闭正文。未知已提交结果继续恢复原交易。

关闭仍锚定原 ACTIVE 版本，STOPPING 不改变锚点；gate 使用原准入 expiresAt。终态 GET 分别返回私有提交与公共关闭的状态/错误/交易回执。公共正文没有 outcome、Job 证据、私有签名或费用，通用市场创建接口继续拒绝该操作。未发送的续期/停止提案遇到本地终态进入 needs_review，已经发送的交易继续查询原结果；尚未入队的停止在精确 CLOSED 后结束投递，本地防线不撤销。关闭不确认账单、释放额度、退款或重开。

隔离 PostgreSQL 从空库完成迁移后，82 项商业/市场用例通过；随后仅运行新增的 4 项终态后待办用例，共 86 项不同用例，无失败。覆盖私有 pending/INVALID/缺有效回执时拒绝关闭、原子审计回滚与原交易恢复、并发重启补办、旧签名密钥撤销后的历史确认、伪造关闭正文、ACTIVE/STOPPING 版本绑定、错误 CLOSED 归属、未发送续期阻断与已发送交易恢复。证据为忽略目录 temp/closure-pg.log、temp/closure-fence-pg.log；数据库已清理。这些数据库测试的 Adapter 为夹具，不代替真实链验收。

全仓 lint 无错误（原有 47 warning / 1 info），全仓 typecheck 含 protobuf 和 Fabric 脚本通过；验收脚本最终修改另经 Fabric 定向类型检查。693 个本地文档目标、workflow 引用与差异格式检查通过。

成功场景真实联合验收退出 0：temp/closure-execution.log；私有业务证据 temp/federation-execution-success-8e1ekkal，测试链材料 temp/fabric-network-VQpIgh。三个 Fabric 机构、四个生产 Adapter、双 Server/独立 PG、双 Agent 与独立存储实际执行两节点 Bash 文件工作流；源方实读 verified:42 的 12 字节结果并完成签名回执。提供方从这两个真实 Job 归集证据，源方从自身导入记录复核后签署；生产 worker 获得私有终态 VALID（区块 20）和公共关闭 VALID（区块 21），重复审批返回原记录。两端分别读到 CLOSED、同一 TERMINAL gate 哈希且无本地预算；两端本地重新执行均返回 POLICY_DENIED。所有自建进程、数据库、namespace/RBAC 与临时凭据已清理；证据/链材料仅留忽略目录。

这次延伸并实际运行成功场景，没有重复此前已通过的断链到期/主动停止场景或原生链级金额与背书竞态。机构终态审批由测试驱动专用人工 API，不是自动 mTLS 交换；没有 Spack、Slurm/PBS、真实科研软件或独立机构验收。下一项为机构间终态材料自动交换、提供方接收对签及双端业务状态收敛；结算、物理介质、归档、完整 Web/CLI 和 PR 预览仍待完成。未合并或部署 main。

## 终态材料自动分块交换与对签回传

迁移 0130 由 db:generate 生成，新增源方同步与临时分块表。后台自动发现已接单的协调预留，按原合同、请求、任务和尝试，通过固定 mTLS 路径读取提供方已批准的终态；每次 64 KiB，整体最多 16 MiB。固定材料摘要/总长度/偏移，分块与游标事务提交，完成后核对全包摘要、提供方原业务签名及原预留绑定，保存完整 proposal 并删除临时分块。ready 只表示收到材料，不代表本机构批准。

新增当前组织只读交换接口、空正文的已接收材料批准接口及人工重试入口。批准仍沿用原源方本地独立复核服务；后台随后自动回传原源方终态签名，提供方在事务内保存同文对签与审计并返回签名 ACK，源方验证后标记 complete。丢回包与重启不重复批准或审计，不生成第二份私有终态，也不向对端传源方复核记录、用户或本地结果导入 ID。交换 complete、私有存证 committed、公共关闭 CLOSED 各自记录，不混同付款或额度释放。

新增四个独立签署用途、Node 网关/HTTPS 客户端固定路径和管理页面中英文标签，保留原单条 JOSE/签名正文限额。发现原终态 HTTP 上限 16 MiB 与规范摘要默认 1 MiB 不一致，终态整体摘要显式使用 16 MiB，普通材料默认上限与编码字节不变。独立加载新协议测试暴露 status 经总入口引用错误类型的循环导入，已把原 FederationError 类移到无依赖模块并由原入口继续导出，保留类身份和错误语义。

隔离 PostgreSQL 43 项终态、源方复核、关闭、执行防线与交换用例通过；后续仅追加 1 项错误 JSON/禁用发送通道用例，共 44 项不同数据库用例。8 项新增覆盖超过 1 MiB 的分块与重启、ACK 丢失、撤销证书/错误用途/错任务、签名分块长度冲突、对签冲突、审计回滚、网络期间撤权、迟到租约、当前组织 HTTP 权限及空正文批准；错误数据进入 needs_review，禁用发送不影响历史读取。证据在 temp/terminal-exchange-final-pg.log、temp/terminal-exchange-json-pg.log；早期 5 项是同一用例的先行验证，不重复累加。

共享联邦协议 22 项、真实 Node mTLS 网关 2 项、HTTPS 客户端 5 项通过（共 29 项不同测试，重复运行不累加）。初次网关测试因新增两个合法路径仍沿用旧调用总数失败，修正夹具计数后通过；新协议独立加载首次失败的循环导入已修复并通过全部共享联邦测试。全仓 lint 无错误，保留原有 47 warning / 1 info；初次全仓 typecheck 通过，最后新增测试的字符串数组断言类型错误已加字面量约束，Shared 定向复验通过，Server/DB 最终定向检查通过。真实链验收脚本已更新为后台取材料与回传对签，业务批准仍由专用人工 API 显式触发。


最终复查另补两项恢复测试并通过：原下载未完成时人工通过既有接口批准了同一份材料，交付对签后清理原临时分块；租约到期但无人接替时迟到响应不把任务误标 needs_review，后续 worker 可直接重领。与上述 44 项合计 46 项不同数据库用例，日志 temp/terminal-exchange-recovery-pg.log。最终 Server/Fabric 脚本类型检查及 lint 另行运行。

首次真实交换验收在作业提交前的双边合同登记阶段失败，证据 temp/terminal-exchange-execution.log、temp/federation-execution-success-xuz52vid、temp/fabric-network-UKD3mD。三方 Peer 日志均确认同一重复登记交易因 PDC 哈希版本冲突被标记 MVCC_READ_CONFLICT（区块 12），另一份已在区块 11 成功。测试环境已清理。验收夹具现只在确认错误码 11、另一方精确同文意图已有 VALID 区块回执且本请求尚未复核重试过时，作为已授权测试机构调用现有人工复核接口；保留原 INVALID 历史，其他失败仍终止。没有把生产 needs_review 改成自动接受。


最终成功场景真实复验退出 0，证据 temp/terminal-exchange-execution-final.log、temp/federation-execution-success-g8b8yugf，测试链材料 temp/fabric-network-szDQpc。两份真实 Kubernetes Job 完成并经独立 Agent 回传 verified:42 的 12 字节结果后，源方生产后台通过 mTLS 自动取得提供方 7,844 字节终态材料；人工 API 只提交空正文批准已接收材料，后台自动回传原源方签名，提供方保存对签并返回签名 ACK，源方 exchange=complete。私有终态交易取得 VALID（区块 20），公共关闭取得 VALID（区块 21）；双方查询同一 CLOSED/TERMINAL gate 哈希且无本地预算，再执行均被拒绝。重复批准保持原终态和业务签名。该真实样例材料不足一个分块，大材料和跨重启续传由上述隔离 PG/签名协议用例覆盖；本次最终运行没有再次触发合同 MVCC 冲突，不能把它描述为实际复验了夹具的新复核分支。

测试自建进程、数据库、namespace/RBAC 和临时凭据均已清理，私有材料仅在忽略目录。本轮未重跑断链到期/主动停止、原生链金额/背书竞态，也没有运行 Spack、Slurm/PBS 或真实科研软件。终态批准目前仍需两端机构显式发起，无人值守批准政策、自动商务握手、结算与争议/重开、物理介质、容量归档、完整 Web/CLI 和 PR 预览继续待完成；未合并或部署 main。


最后补充人工 refresh 清除已过期租约 token 的约束，防止旧 worker 的迟到网络错误覆盖刚刚批准的重试；对应单项隔离 PG 测试通过，日志 temp/terminal-exchange-retry-pg.log。本轮共 47 项不同数据库用例（36 项原终态相关回归、11 项新增交换/恢复用例），此前重复执行不累加。最终 lint 无新增问题，最后 Server 类型检查在所有行为及测试修改后执行。


## 按协议版本的机构终态预授权

在终态自动传输基础上新增机构业务授权：迁移 0131 保存不可变的本地组织/协议 revision/合同摘要、允许的终态结果和有效期，双方分别配置。授权创建、分页历史、撤销和异常复核重试已接人工组织 API；默认不启用，平台管理员身份不隐含业务权限。授权可用于该版本已有及后续双签预留，不会自动批准新合同、接单、账单或付款。机构授权独立于授权人的后续个人角色，须明确撤销；范围修改或续期需要新 ID，旧签名和执行防线保留。

提供方自动批准复用真实 Job、Workflow、停止与结果回执归集；源方自动对签复用本地 accepted 委派、可信报告、实际结果导入或停止回执的独立复核。链查询前后及签名落库前复查授权，最终事务持有授权共享锁并锁定原预留。后台选择已结束工作或完整接收材料，SKIP LOCKED 与持久退避支持并发/重启；幂等终态避免再次签署。正常等待、链断线和短暂数据库锁冲突可重试；权限/证据冲突进入 needs_review，替换授权不自动清除此状态。

签署记录保留 authorizationPolicyId 和原授权人；自动签署、签名交换和公共关闭入队审计使用 terminal-policy 标识，不伪装人工会话。完整策略与真实用户信息留在本地，链上仍只有原带盐业务正文、双签及最小公共 gate。批准不改变金额、锁额或预留数量。接口说明见[终态预授权](../../../deploy/federation/fabric-execution-gate.md#按协议版本预授权终态批准)。

本轮共覆盖 56 个不同 PostgreSQL 用例：43 个终态归集/源方复核/关闭/交换回归及 13 个新增授权用例。首轮业务断言 54 项全部通过，但旧 afterAll 按用户清理审计，遗漏了新机构授权 actor，导致清理失败；改按隔离组织清理后，新功能 13 项再次通过，其中 2 项是新补充用例，不累计重复运行数量。覆盖默认关闭、独立双边授权、跨机构/预留拒绝、过期、链查询期间撤销、并发一次签署、结果限制、等待回执、网络及数据库忙退避、迟到错误不覆盖人工重试、审计原子性、批准后清理旧错误与严格 HTTP 输入。全仓 typecheck（含 protobuf/Fabric 脚本）、lint、文档链接、workflow 引用、Python 语法和差异格式检查通过；lint 保留原有 47 warning / 1 info。

真实成功场景也已通过：提交作业前双方通过 API 各自预授权 completed，真实双 Server/PostgreSQL/Agent、mTLS、对象存储、Fabric 和 Kubernetes 完成两个 Bash Job，源站下载 verified:42 的 12 字节文件并核对 SHA-256。终态阶段不调用人工 approve/countersign；提供方后台核验证据后签署，源方自动取材料、独立复核并对签，再回传签名取得 ACK。私有终态 VALID 在区块 20，公共关闭 VALID 在区块 21；双方各自终态关联自己的政策 ID。日志与完整私有证据保留在忽略的 temp/terminal-policy-execution.log 和 temp/federation-execution-success-u03r7233。

这轮没有重跑已通过的断链/主动停止或原生链金额/背书场景，没有 Spack、Slurm/PBS 或真实科研软件。合同、预留和执行准入仍由夹具预先批准；完整自动商务握手、账单/结算/争议与重开、物理介质、容量归档、完整 Web/CLI 及 PR 预览仍待完成。未合并或部署 main。


## 已批准商业记录的自动签名交换

迁移 0132 增加商业合同、预留和释放的持久交换队列。双方独立批准后，生产商业 worker 通过固定私有 mTLS 入口取得对方原业务 JWS；本地未批准或对方未批准都不会产生新签名。等待响应单独签名并绑定原查询，业务响应保留原字节，不套入更大的签名信封；正文/JOSE 上限仍为 256/512 KiB。新传输用途 commercial-approval-query / commercial-approval-waiting 与商业签署用途分离，不加入 Fabric 商业签名治理。第三方机构、错误正文/摘要/类型、过期查询、撤销证书或密钥、用途与端点变化均不能补齐签名。

自动入口复用人工导入的原商业组织、合同、原预留与本地市场意图检查，不创建新业务批准或执行许可。原对签、交换完成、审计与可选上链意图同事务写入；审计使用商业交换身份而非原用户交互会话。直接合作不创建链工作，其余模式继续使用原提交队列。租约和 token 隔离迟到结果；网络/数据库失败退避，信任与内容冲突需人工复核，不能抢占活租约或重置 complete。只配置签名、不配置发送通道时可读取历史和被动响应，不主动交换。已批准释放可在合作合同到期后继续补交，沿用原释放约束；没有放宽链上 READY/未激活条件，也没有自动批准退款。

组织进度和人工重试 API 已接入，保留原人工签名导入入口。交换 complete 仅表示本地取得对签，不能代替对方交换状态、链 VALID 或执行确认。详细边界见[商业签名交换](../../../deploy/federation/fabric-commercial.md#已批准商业签名的自动交换)。

验证共 24 个不同 PostgreSQL 用例（16 个新增、8 个原审批/提交回归），以及 13 个协议和真实 TLS 传输用例，均通过。包括独立同意、直接模式无链、响应丢失重启/并发、错误及越权签名、证书撤销、签名用途和端点的网络竞态、等待响应错绑、过期租约、人工重试隔离、审计回滚、人工导入后恢复、角色变化不抹除已签同意、预留/释放、HTTP 组织边界及合同到期后的已批准释放。后一个用例起初同时让测试证书过期，证书检查正确拒绝；将证书有效期与合同到期分离后通过。全仓 typecheck（含 protobuf/Fabric 脚本）通过，补充边界用例后 Server 定向检查通过；全仓 lint 无错误，保留原有 47 warning / 1 info；文档链接、workflow 引用、Python 语法及差异检查通过。

真实联合成功场景已移除商业合同和预留的人工对签搬运。双方各自批准后，由实际 Server worker 经 mTLS 交换，两端各有 agreement/reservation 两项 complete。随后两份私有预留、激活及两端准入确认均提交成功，两个 Kubernetes Bash Job 完成，源站实际下载 verified:42 的 12 字节输出并核对摘要。既有机构预授权继续完成终态自动双签和 ACK；私有终态与公共关闭分别在区块 20/21 取得 VALID，双方 CLOSED 与同一 TERMINAL gate 检查通过。

首轮已通过自动交换、私有预留及激活，但被测试外层 120 秒截断（内层每步允许 180 秒）。同轮实际触发一次双边重复提交的原生 MVCC 冲突，夹具在验证另一方同文 VALID 后按已有授权复核流程恢复，两边预留随后 committed；这不是生产端自动批准 INVALID。修正仅给商业测试编排显式的总等待上限后，重跑完整成功场景通过，最终运行未触发该复核分支。证据保留在忽略的 temp/approval-exchange-execution-final.log 和 temp/federation-execution-success-3f1t8979；新 approval-exchange.json 保存双方四项交换进度，terminal-evidence.json 保存终态双签及 VALID 回执。验收时发现新进度文件尚未复制到保留目录，已按本次 ledger-proof 精确匹配运行目录保留原文件，并在脚本加入相同复制步骤；未修改业务证据。自建服务、数据库、namespace/RBAC 和临时凭据已清理。

本轮没有重跑原断链、主动停止、原生金额/背书或科学软件安装测试。合同和任务本身、基础执行同意、市场动作与执行准入仍由夹具显式批准；长期授权下的新任务自动批准、执行同意自动交换、完整商务编排、账单/结算/争议与重开、物理介质、容量归档、Web/CLI 和 PR 预览仍待完成。没有合并或部署 main。

## 新任务预留的机构预授权基础

迁移 0133 由 db:generate 生成。新增机构预留策略，固定本地组织/站点、原双签合同 revision 与正文摘要，人工明确授予单次金额、累计签署金额、任务数和有效期；继承原合同中的模板修订、资源与执行目标范围。只允许协调模式预留，无偿合同只允许零金额，任务执行截止时间不得越过策略期限。策略创建、分页历史和显式撤销已接组织 API，默认不启用，修改或续期必须先撤销旧 ID。

内部 approvePreauthorized 复用原预留批准路径：当前可信的商业合同双签、本地已 committed 发布/认领意图、链上 CLAIMED 版本和资源检查；提供方额外要求源方同文原签名，源方不能借提供方策略批准。查询前后重新检查政策和信任，最终事务锁定策略行，保存原批准、累计授权消耗及机器审计。签名落库还重新验证当前签署密钥用途，补齐先前人工路径中仅检查密钥有效期的间隙。并发不同任务不能超额，同一记录重试不重复计数，审计失败完整回滚。授权人个人角色变化不撤销机构策略；显式撤销阻止新批准，已有记录保留策略 ID、原授权人和原签名。

累计计数只是机构签署权限，不创建本地资金余额、不证明用量或付款，也不随终态、释放或取消恢复。人工批准保留独立归属；替代策略不会重置链上预算。管理接口和内部审批服务已经可用，新提案跨站自动投递/发现、市场动作和执行确认尚未接入本服务，不能把这一步当作完整无人值守流程。既有已批准签名交换和终态自动化保留。

本轮 20 个不同 PostgreSQL 用例通过：15 个新增策略用例，5 个原预留审批、释放、对签和提交顺序回归。覆盖默认关闭、范围/机构/模式边界、无偿合同、超安全整数精确金额、零金额任务数、并发最后额度、重复请求、个人角色与机构撤销区别、查询期间撤销/到期、原签名/用途/合同信任变化、本地市场意图、断链、审计回滚和严格 HTTP。首轮 17 项通过，1 项测试误按不存在的站点列查询本地预算表；改用实际预算域列后只补跑该项通过，再追加两个金额/合同边界用例，未重复累计。证据在忽略目录 temp/reservation-policy-pg.log、temp/reservation-policy-replay-pg.log、temp/reservation-policy-bounds-pg.log。

全仓 typecheck（含 protobuf/Fabric 脚本）通过，最终补充用例另做 Server 定向检查；全仓 lint 无错误，保留原有 47 warning / 1 info；701 个本地文档目标及差异格式检查通过。本轮没有重复运行真实 Fabric/Kubernetes 联合场景，没有触碰 main。完整自动商务编排、结算/争议与重开、物理介质、Peer 容量归档、完整 Web/CLI 和 PR 预览仍待完成。

## 新任务提案跨站传输与自动预留批准

迁移 0134 新增持久任务提案，源方保存人工任务意图和本机构策略，提供方保存原源方业务 JWS、接收证书指纹及自己选择的机构策略。源方提交要求当前人工组织 delegation.submit；签署不使用提交人或授权人的个人会话。后台复用机构预授权和原 CLAIMED/合同/本地市场意图检查；提供方在链查询后还重新验证原接收证书。签名、累计授权消耗、提案批准进度和审计同事务提交，租约过期不能保存迟到批准或覆盖复核重试。

原业务 JWS 经固定 mTLS 路径发送，不嵌套大型签名信封，原正文/JOSE 限额不变。新增 reservation-proposal-receipt 用途仅用于传输回执，明确与 Fabric 商业签署用途分开，并更新信任配置和中英文标签。回执只证明提案持久落库，不证明批准、双签、链提交或执行。源方 pending/sending/delivered 与提供方 pending/approved 分别保存；原商业交换自动取得两边新签名并入队私有预留。签署后撤销策略不抹除既有同意，发送仍受原截止时间、合同和当前信任约束。

人工组织接口提供创建、分页进度与空正文复核重试，不返回原 JWS、证书指纹或租约 token；自动化会话不能授予策略或伪装人工提交。默认无发送配置时不批准源方排队请求，但提供方可处理已接收的提案。每个政策限制 128 份未批准积压，不能通过接收回执绕过机构额度或原市场许可。没有增加市场自动发布/认领、合同或基础执行协议自动批准、激活和准入确认授权。

隔离 PostgreSQL 共 32 个不同用例通过：14 个新提案/生产 worker 集成用例，15 个原机构策略回归和 3 个原签署/对签回归。覆盖自动批准到原双签提交队列、接收与批准分离、丢回包/重启/并发、人工/组织/策略边界、原签名/证书/端点变化、链断线、活租约与迟到成功/失败隔离、人工批准恢复不追扣策略额度、审计原子回滚、发送禁用和私有 HTTP 入口。首轮 28 项通过，1 项故障注入约束错误覆盖前面测试的既存审计记录；将约束限定到本用例政策后，该项与 3 个后补恢复/集成用例共 4 项通过，重复用例不累加。证据 temp/reservation-proposals-pg.log、temp/reservation-proposals-recovery-pg.log。

协议与真实 Node TLS 共 10 项通过，证据 temp/reservation-proposals-wire.log；全仓 typecheck、lint 和 702 个本地文档目标检查通过，lint 保留原有 47 warning / 1 info。最终新增数据库用例另做 Server 定向类型检查。真实联合脚本已改成双方在任务创建前预授策略，源方只入队任务；不再调用双方逐笔预留批准服务，并保存 reservation-proposals.json 原提案、回执和策略消耗证据。真实运行结果在本节后续记录。

本轮真实联合成功场景一次通过，日志 temp/reservation-proposals-execution.log，完整隔离证据 temp/federation-execution-success-6w0j8tnb，测试链材料 temp/fabric-network-o1XKbk。实际双 Server/PostgreSQL/Agent、Node mTLS、RustFS、Fabric 和 Kubernetes 跑通：任务发布前双方各自授予 1 次、金额 1 的机构策略；源方仅提交新提案，生产 worker 自动签署与交付，提供方持久接收后自动批准。两边各消耗一次授权；源方 delivered、提供方 approved，两边保存完全相同的原源方 JWS，源方保留签名接收回执。原商业交换随后自动补齐双签并提交两份私有预留。

在原有显式市场激活与执行确认后，两个真实轻量 Bash Job 完成，接收方从零份清单拉取源端输入及环境锁，源方通过独立 Agent 和独立桶实际下载 verified:42 的 12 字节结果并核对 SHA-256，原签名结果回执被对方确认。既有终态预授权自动完成提供方证据归集、源方独立复核与双签回传，交换 complete；私有终态 VALID 在区块 20（bdffa0c6ba0b372ebe232f7589cdb9f54de29b164e1a1fc2555543e6439bdfe7），公共关闭 VALID 在区块 21（9b04bdfbb98cf78b0578196c62c23aa716f394928e005757559b8d2ea4e96edf）。本次未触发重复商业提交的 MVCC 人工复核分支，不能据此声称该生产异常已自动处理。

运行退出 0，自建进程、数据库、临时凭据和集群 namespace/RBAC 已清理。没有重跑先前断链/主动停止、Slurm/PBS 或 Spack/真实科学软件；本次证据证明新任务提案自动签署与传输及其后续轻量链路，仍不是完整无人值守平台验收。自动市场与执行准入、基础执行同意交换、普通 Workflow 协调编排、账单/结算/争议与重开、物理介质、Peer 容量归档、完整 Web/CLI 及 PR 预览继续待完成，未合并或部署 main。


## 原预留的自动激活与首次执行确认

迁移 0135 为机构预留策略增加默认关闭的 allowActivation / allowExecutionConfirmation；前者只允许源方并要求授权人当前有市场发布权。只有该策略实际批准的原预留才能使用新增权力，旧策略、替代策略和人工批准不追溯升级。复用原激活与执行确认服务，保留双签合同、基础执行同意、受限执行身份、停止/终态及实际 VALID 检查。原提案增加独立初始执行进度和租约，不另建业务队列；新市场待办保存原策略 ID、授权人和机器审计。

生产商业 worker 在双签提案就绪后按机构开关入队动作，源方等待激活 VALID，再由双方各自申请首次确认。未知提交等待，INVALID/needs_review 停下复核，不新造交易绕过。只授权激活不产生运行许可；只授权确认等待另行激活。已有人工激活可接续但保留人工归属。撤销阻止新动作，不抹除已入队/已提交的同意；阻断任务仍使用停止/取消。完成表示初始许可就绪，后续操作继续独立校验并按原规则续期，不是作业终态。

提案 GET 增加执行进度、错误和动作 ID；独立 execution-retry 接口要求当前人工审批与空正文，不能抢租约、换策略或重置完成状态。链查询前后及落库前复查授权和租约，审计失败回滚。未开放自动市场发布/认领、基础执行同意交换、普通 Workflow 协调编排或资金结算。

本轮 48 个不同 PostgreSQL 用例通过：35 个既有预留/机构策略/提案回归，13 个新自动执行用例。初轮 10 个新用例因夹具把执行账号建成 researcher 而失败；修正为生产要求的 user/serviceAccount 后只重跑新增 10 项通过，未放宽身份检查。后补单开关与人工 HTTP 重试 3 项也通过。新增覆盖撤销/到期/停止、原身份停用、个人角色变化、并发及人工意图兼容、未知/INVALID 交易、无真实回执的假 committed、查询期间租约丢失和审计原子回滚。日志在忽略的 temp/execution-automation-pg.log、temp/execution-automation-new-pg.log 和 temp/execution-automation-options-pg.log。

全仓类型检查的各 package 已通过，Fabric 联调脚本因数组闭包类型推断失败，补充显式类型后定向脚本检查通过；同时补上联调策略的明确开关，避免使用默认关闭值。最终新增用例做 Server 定向类型检查；发现新增断言误传数据库而非事务，按真实事务调用修正后仅补跑该用例通过，重复验证不累加计数。全仓 lint 无错误，保留原有 47 warning / 1 info；704 个本地文档链接、workflow 引用、Python 语法及差异检查通过。真实联合入口已移除逐笔人工激活与执行确认，保存独立 execution-automation.json；运行结果继续记录如下。


本轮真实联合运行日志 temp/execution-automation-execution.log，隔离证据 temp/federation-execution-success-dcduww8d，测试链 temp/fabric-network-gWenEr。双方在任务创建前各自授予机构策略，源方明确允许激活与首次确认、提供方仅允许首次确认；后台自动完成新提案批准、签名交换和私有预留，随后无人工激活/确认调用地完成三份市场待办。execution-automation.json 核验每笔待办的政策归属及实际 VALID：激活区块 17（c523342cd0656a5a477a06e1232c839d4a685ebf52d89c3099e92faa1bfc1c9b），提供方确认区块 18（4b81de9252195384718179cac9f4248d00291ee6cdef30ca6f29c3baecf17a62），源方确认区块 19（4ed31d593f35ddd15a34555f1b01c577ee0baa9af3ef832b84a59b41357ba7bd）；两端初始执行进度 complete。

其后的真实双 Server/PostgreSQL/Agent、mTLS、RustFS 和 Kubernetes 文件工作流已完成：目标方从零份清单取得原输入与环境锁并运行两个轻量 Bash Job；源方独立 Agent、独立桶实际下载 verified:42 的 12 字节文件并核对 SHA-256，签名结果回执和重复导入幂等通过。既有终态预授权随后完成双方独立签署、原签名回传及 ACK，交换 complete；私有终态 VALID 在区块 20（08842778f2ed11277ee975daff437318a10614a97e104e6c8e7058cd1bd58795），公共关闭 VALID 在区块 21（b11396cfc10871e0bc1be926fd9bbc508f9755417342461b9f0bc2867690a0e2）。本次未触发双边重复商业提交的 MVCC 人工复核分支，仍不能据此宣称该异常已自动处理。


真实运行一次通过并退出 0，自建服务、数据库、临时凭据和 scheduler namespace/RBAC 已清理。最终 Server 定向类型检查通过。没有重跑先前断链/主动停止、原生金额/背书或 Spack/Slurm/PBS/科学软件场景。本轮证明新任务预授权之后的初始激活/确认自动推进及轻量执行收尾；市场发布/认领、基础执行同意对签和实际委派仍由夹具显式发起。完整自动商务编排、普通 Workflow 协调节点、生产 MVCC 同意复核、账单/结算/争议与重开、物理介质、Peer 容量归档、完整 Web/CLI 和 PR 预览均继续待完成，未合并或部署 main。


## 基础执行同意的自动签名交换

迁移 0136 保存独立的执行协议交换进度，外键绑定原本站批准，不依赖商业合同队列。双方人工独立批准后，后台通过固定 mTLS agreement-approvals 入口交换原 agreement JWS；尚未批准时只返回绑定原查询的等待回执。新增 agreement-approval-query / agreement-approval-waiting 两个传输用途，信任目录扩至 34 项并更新中英文标签；不加入 Fabric 商业签名用途。原协议的执行账户、真实用户与组织 ID 不进入查询或等待消息，原 JWS 不套第二层大信封。

内部自动导入与人工入口共用原执行同意安装事务，新增事务内原签名用途/摘要与身份不变检查。双方信任、协议状态/期限与提供方受限执行身份继续有效；协调模式仍须原商业双签，不能创建本地可花费预算或实际执行许可。直接/异步存证只在接收方安装一次原预算，不因后台交换依赖链。对签、安装、预算、机器审计和 complete 同事务；原个人角色变化不撤销已签机构同意，协议暂停/撤销或执行身份停用仍阻止新安装。

后台租约隔离迟到成功/错误，网络故障持久退避，信任与内容冲突需要复核。已有人工导入可幂等恢复，但不替换原签名或把原人工审计改为机器批准。无发送配置时不发现/推进；固定私有入口仍能回复已批准记录。GET exchange 仅向当前组织返回脱敏进度，POST exchange/retry 只接受当前人工审批及空正文；不能抢占活租约、改原账户/签名或重置完成。生产商业 worker 复用轮询与退出机制，运行不要求配置商业链 Adapter。

隔离 PostgreSQL 一次通过 30 个不同用例：13 个自动交换用例和 17 个原人工审批/执行同意回归。新增覆盖两种双边模式和协调模式、独立同意等待、并发/丢响应/worker 重启、角色变化、状态/用途/端点竞态、身份停用、过期租约迟到成功/错误、审计回滚、人工补入恢复、错机构/证书撤销、HTTP 权限与发送禁用。日志 temp/agreement-exchange-pg.log。原 HTTP 脱敏断言被静态检查指出 unknown 类型访问，改用序列化字段不存在断言并只补跑该项，重复用例不累加。

协议与真实 TLS 共 11 个不同用例：初轮 10 项通过，新网关路径已返回 200，但夹具仍按原 13 次请求计数导致网关用例失败；更新为实际 14 次后仅重跑该项通过，非法查询串仍 404。日志 temp/agreement-exchange-wire.log、temp/agreement-exchange-gateway-final.log。全仓 lint 无错误，保留原有 47 warning / 1 info；707 个本地文档目标、workflow 引用、Python 语法和差异格式检查通过。全仓各 package 类型检查除上述测试访问外均已通过，修正后追加 Server 定向检查及原流程尚未运行的 Fabric 脚本检查。真实联合入口已移除基础执行同意的人工对签搬运，并保留 agreement-exchange.json；结果继续记录如下。


最终 Server 定向类型检查与 Fabric 脚本类型检查均退出 0，修正后的 HTTP 用例通过。真实联合运行一次通过，日志 temp/agreement-exchange-execution.log，隔离证据 temp/federation-execution-success-06o05k4v，测试链材料 temp/fabric-network-qiodwi。双方在原商业合同登记后各自批准基础执行协议，不再调用人工 attachCounterparty；生产 worker 经真实 mTLS 自动交换原 JWS，两端原签名精确核对、交换 complete，agreement-exchange.json 保存双方进度。随后新任务机构预授权、提案投递、预留双签、私有提交、自动激活和两端执行确认全部贯通；激活 VALID 在区块 17，提供方/源方确认分别在区块 18/19。

两个实际 Kubernetes Bash Job 完成，目标方从零份清单取得签名输入及环境锁；源方独立 Agent、独立桶实际下载 verified:42 的 12 字节文件并核对 SHA-256，结果回执与重复请求幂等通过。既有终态机构预授权完成双方签署、回传与 ACK，私有终态 VALID 在区块 20（94ebf0f45d08182fb7f62b4cf46868afe454a890422bf2a4321b7793a06d35f9），公共关闭 VALID 在区块 21（7cb0e3e79ef14744e68d85871753e1f923c866788b3efb76f4b4e7ba091f6b09）。本次未触发重复商业提交的 MVCC 人工复核分支，不能据此声称已提供生产自动恢复。运行退出 0，自建 Server、数据库和 scheduler namespace/RBAC 等运行资源已清理，私有测试证据留在忽略目录。

本轮真实验收使用协调模式；两种双边模式的无链交换由独立数据库专项验证。未重复先前断链/主动停止、原生隐私/背书/金额、Spack/Slurm/PBS 或科学软件验收。市场发布/认领和实际委派仍由夹具显式发起；全自动市场编排、普通 Workflow 协调节点、生产 MVCC 同意复核、账单/结算/争议与重开、物理介质、Peer 容量归档、完整 Web/CLI 与 PR 预览继续待完成。没有合并或部署 main。


## 机构授权的市场请求自动编排

迁移 0137 为原预留策略增加默认关闭的 allowMarketPublish / allowMarketClaim，并增加绑定原合同/策略的持久市场请求。源方当前人工委派权限提交后，生产后台只发布公开 demand；原私有 CommercialReservation 通过独立 market-request 签名与固定 mTLS 入口交付。提供方按自己的不可变策略、原证书/签名及当前链状态认领，必须保存原提交的 VALID 尝试；源方独立检查 CLAIMED，再同事务完成请求和创建原预留提案。received 只证明接收，claimed 只报告已认领；均不直接批准执行或释放资金。

稳定原 operationId 等于 reservationId；公开需求和私有原请求的源机构、资源、期限与需求 ID 必须一致。累计市场任务数和原 maxAmount 按策略锁下不可变请求行统计，独立于原预留签署计数及链上余额，重复请求不重复计数，另限 128 项未完成积压。机构权限不随个人角色变更而失效，撤销/到期仍阻止新动作；已经入队的市场同意保持原交易跟踪。来源、正文/摘要、端点、证书和租约前后复查，冲突人工复核，未知结局/INVALID 不换 ID 绕过。GET 隐藏私有正文与证明，人工重试不能抢占租约或重置完成。

本轮隔离数据库包含 15 个新市场请求场景及 42 个原预授权/提案/执行自动化回归，共 57 个不同场景。初轮漏导入测试验签函数导致一个场景失败，修正导入后定向验证相关两项；同时补齐测试类型导入。新增覆盖生产 worker 公开字段边界、实际持久尝试、个人权限变更、并发累计额度、重复/断线恢复、篡改/其他认领人、未证明 commit、伪造认领回执、撤权与端点竞态、租约迟到成功/失败、审计原子回滚、HTTP 组织范围与重复需求标识冲突。数据库夹具使用测试 Adapter，不等同真实链，真实验收另记。协议及真实 TLS 9 个不同场景通过；尚未执行过的真实入口已改为只调用一次市场请求提交，不再由夹具发布、认领或创建预留提案。

全仓类型检查已运行；Server 测试缺导入和真实夹具的 TypeScript 推导问题修正后，Server 与 Fabric 脚本定向检查均退出 0，其余 package 已通过。全仓 lint 无错误，仍为原有 47 warning / 1 info；709 个本地文档目标、workflow 引用、Python 语法和差异格式通过。伪造 claimed 的测试额外断言没有一般重试错误，确保执行的是独立链状态检查，定向复跑通过；不累加重复用例数。

真实联合运行一次退出 0，日志 temp/market-requests-execution.log，隔离证据 temp/federation-execution-success-w3ha1a2y，测试链材料 temp/fabric-network-GngXGC。原双方合同/基础执行同意已自动交换，源方只调用一次市场请求提交；生产 worker 自动发布和认领，双方请求 complete 且归属原策略，原操作 ID 保持不变。公开发布 VALID 区块 13（60d245c2dbc077413f0b776eda0fb7b58a7f7b35ec7865d62dbc8c4676bacacf），认领 VALID 区块 14（d86106ed12329d58f937840b8b270c2584e3309462bb858e9002937b4a9765cd）。原请求、签名回执、公开提交、实际 VALID 尝试保存在忽略目录的 market-requests.json；不提交私有原文或凭据到 Git。

随后自动完成预留提案、机构签署、双签交换、私有预留、公开激活和双方执行确认。两个实际轻量 Kubernetes Bash Job 完成；接收方从零份清单拉取原输入/环境锁，源方独立 Agent 和独立桶实际下载 12 字节 verified:42 结果，SHA-256 校验、签名接收回执及重复请求幂等通过。终态双方预授权、独立审核、签名交换与 ACK 自动完成，私有终态 VALID 区块 20（d315997bf9b3c2faaa88c24cfff3605757c8f6feb9b777da836b0b327864eaee），公开关闭 VALID 区块 21（e9772ae571d3a117185c929b88ae50fcfaabf985de1778db21d85e2cc496725f）。本次未触发重复商业交易的人工 MVCC 复核；自建 Server、数据库、临时凭据、scheduler namespace/RBAC 均已清理。

实际委派仍由夹具显式调用原 outbound API；本轮完成已选机构下从新任务意图到预留许可的自动推进，未声称完成普通 Workflow 协调节点或开放市场发现匹配。生产安全 MVCC 复核、商务减免/账单/结算/付款/争议与重开、物理介质交付、Peer 容量归档恢复、完整 Web/CLI 与 PR 预览继续待完成。没有重跑原断链/停止、原生隐私/背书或真实 Spack/Slurm/PBS/科学软件场景；未合并或部署 main。


## 普通 Workflow 协调市场编排

Federation 节点新增可选 market（policyId/title/description），协调协议明确配置，双边节点继续原路径。公开平台/架构只从不可变环境锁读取，文案由提交者显式指定。原 bindWorkflowDelegation 的意图摘要绑定市场选择，保留无 market 时的旧摘要编码；不新增第二套工作流状态表。参数/文件快照和原操作 ID 先持久固定，随后复核原材料映射、当前身份及机构策略，在工作流租约事务内保存原市场请求，分配一次需求 ID/salt。节点等待 LEDGER_WAITING，原提案及初始许可完成后仍执行原有效回执准入检查，再创建持久 outbound；后续结果自动回传和下游文件复用原执行器。

新增父工作流持久状态检查用于源机构发布、预留签署、激活/确认及准入，网络前后通过原授权事务复核。取消时扫描所有原调用；即使尚无 outbound，也为已有商业批准写入原本地停止意图，不依赖链或额外人工审批。已入队的同意、链上冻结金额和历史证据不被抹除；父工作流取消不是退款/结算证明。原始市场 HTTP 不能代替工作流租约操作已有绑定请求。

新增 9 个数据库场景全部通过：普通节点贯通原市场、签署、VALID 许可、实际生产 outbound/接单服务，恢复保留一份原任务与一次权限消耗；变更公开文案/原始 API 绕过拒绝；配置缺失/只有发布权限拒绝；旧租约拒绝；发布前取消无链操作；签署后取消先写本地停止；链查询期间取消不产生迟到提案；审计失败回滚市场权限并恢复原调用。另有 20 个市场/商业/自动执行回归和 16 个普通 Workflow、动态参数、文件输入、取消与结果回传回归通过，共 45 个不同 PostgreSQL 场景。Workflow schema 15 项（含 1 个新配置边界）通过。日志 temp/workflow-market-new-pg.log、temp/workflow-market-regression-pg.log、temp/workflow-market-schema.log；数据库用测试 Adapter，不替代真实链验收。

第一次真实 workflow 场景在普通 API 提交阶段返回 400，未创建远端作业；源 Server 日志明确为 SandboxPlannerError（no candidate satisfies placement constraints）。原因是原本地规划器把 Federation、NoAction 等非本地计算节点也分配给 Agent。修正共享规划入口，只为 Script/SoftwareUsecaseComputing 构造本地候选、身份和相互边；实际工作流依赖图不变，远端执行和真实输入传输仍走各自授权/调度路径。纯远端编排不要求源机构已有计算 Agent，不虚构远端本地费用。

新增一个真实数据库规划场景通过：源方没有 Agent 时 Federation → NoAction 得到零本地分配，增加本地计算节点仍因缺候选被拒。原规划算法及预算/约束 8 项回归通过。本轮累计 46 个不同 PostgreSQL 场景，另有 schema 15 项、规划器/计划服务 8 项。首次真实失败日志 temp/workflow-market-execution.log、证据 temp/federation-execution-workflow-91mqxsiy 和 temp/fabric-network-balDd0；隔离运行资源已清理。修正后继续同一新增 workflow 场景，未重跑原 success/outage/stop。


修正后的真实 workflow 场景退出 0，日志 temp/workflow-market-execution-final.log，隔离证据 temp/federation-execution-workflow-9kvunvi3，Fabric 网络 temp/fabric-network-gGxEE3。普通 /api/workflows 创建 Federation → NoAction 后，由原工作流租约生成唯一市场意图；没有人工提交市场请求、outbound 或结果导入。后台完成发布（区块 13）、认领（14）、双签预留、激活（17）及双方执行确认（18/19），均为 VALID；本次未发生需要夹具复核的重复商业 MVCC 冲突。

目标方从零份清单拉取输入及环境锁，实际运行两个 Kubernetes Bash Job。源方独立 Agent/桶接收原结果并自动发布为本地 File；原 Workflow 的 remote/consume 均 Succeeded，父运行 completed，waitingInvocations 为空，节点输出文件 ID 与原导入成员一致。实际下载 verified:42\n 共 12 字节，SHA-256 为 87730d8e29a90b06728319cb30fcf8dbae523f785f3043c82ea4df6386c83f7f。其后双方终态策略自动独立批准、交换签名并 ACK；私有终态 VALID 在区块 20（dbd60dc3ad9391fc8bb3fb06e03e78a24bc87a99f580cec570e075cd44250db3），公共关闭 VALID 在区块 21（7a7b104a0afef0a98257eaca03627e4d99a1aab5d892f303b641b98a7d63d35e）。关闭不释放预算，也不代表商务结算。

自建 Server、数据库、临时凭据与 scheduler namespace/RBAC 已清理。该样例证明已选合作机构、预授权策略和普通 Workflow 的自动协调闭环；下游 NoAction 验证文件绑定，未声称另一次本地计算。它使用轻量 Bash，不包含 Spack/Slurm/PBS/科学计算或完整计量；未重复原 success/outage/stop 场景。开放市场匹配、混合/嵌套/多机构协调、生产 MVCC 复核、账单/结算/争议、加密物理介质、Peer 容量归档及完整 Web/CLI/PR 预览仍待完成。

最终全仓 lint 退出 0（原有 47 warning / 1 info）；本单元全仓及后续变更包的类型检查已通过，文档链接、workflow 引用及差异检查通过。没有为同一结果重复累计测试数。


## 执行协议签名交换 Web 入口

协议详情接入现有 exchange / exchange/retry API，共享 schema 校验 enabled、sync、状态和时间。状态按组织、登录版本和协议 revision 缓存，复用页面刷新；需复核时展示原因与原错误码。重试复用原审批确认弹窗和空正文，只允许审批者、电脑端、当前已启用协议且通信开启；pending 留给原后台退避，complete 不提供重试。无通信配置保留历史验证，读接口失败隐藏旧动作。服务端仍独立检查组织、授权、原意图和活租约，不改变协议或业务状态机。

保留原界面布局与令牌，新状态放在本地许可之后、条款之前；不新增仪表卡片或重复说明。完成明确称为“对方签名已验证并导入”，不声称对端也完成或作业、链、结算完成。中英文及手机只读一致。24 个不同组件场景覆盖原签署/导入/撤销及新增等待、复核确认、权限/暂停/移动端/通信关闭/完成、历史验证和读取错误。初次 23 项通过，暂停夹具因一次性 mock 顺序错误失败；修正夹具后该项通过。类型检查发现测试误用了浏览器 API 的 exact 选项，删除后补查 Web；相关文案和读取错误三项定向重跑不重复计数。

四张浏览器夹具截图位于忽略的 temp/agreement-exchange-ui：桌面复核、确认弹窗、手机只读、英文深色离线历史；无页面错误或横向溢出。已逐张核对新增状态与现有布局；原离线历史夹具的对方签名字段已修正为与 complete 一致并重拍该状态。本轮没有真实 PR 预览，也没有再运行 Fabric/调度器验收；协议交换后端此前已有真实双平台验收。

本单元全仓 lint 退出 0（保留原有 47 warning / 1 info），全仓类型检查其余包通过，修正上述测试类型后 Web 定向检查退出 0；一次 Web 补查被 SIGTERM 中止，串行补查已完成。711 个本地文档目标与差异格式检查通过；浏览器临时 Vite 服务已停止。没有新依赖、迁移或业务权限放宽。


## 商业重复提交的 MVCC 自动核对

新增固定成员回执查询，覆盖合同、用量、预留、释放和终态原记录。链码保持 PDC/角色边界，只输出不可变 recordId/digest；Adapter 校验本机构域、响应大小、结构及 ID，不接受任意集合/链码读取。Server 仅把具备查询能力的第一次明确 MVCC_INVALID 送入核对，保留原失败交易，匹配后原意图重建检查点并等待原生背书及新 VALID。无需新表或迁移；原 lastError 的 MVCC_RECONCILING 标记在短暂查询/数据库失败时持久保留，人工复核明确清除标记后仍走原人工路径。

检查点保存事务中重新核对原待办、最新尝试和当前业务签名信任，追加机器审计；旧租约、审计失败、查询/准备期间撤权不能发布新检查点。未知交易从不换 ID，原记录不存在/不匹配、其他 INVALID 和第二次冲突不自动放行。只读回执不是执行许可或提交确认。原真实 Workflow 夹具的临时人工 MVCC 重试分支已删除，异常必须由生产后台处理或让验收失败。

本轮 14 个不同 PostgreSQL 场景通过（10 个新增、4 个原路径回归）：真实租约并发/恢复、断线、精确原意图、原 INVALID 保留、新 VALID 门槛、缺失/错摘要、人工复核兼容、恢复次数上限、查询/准备期间撤权、迟到租约、审计回滚、非 MVCC 与未知结果。初次发现机器审计 actor 不允许 null，已改为 commercial-worker:<siteId>，受影响场景定向通过；审计故障夹具随后限定到本次 target，避免已有成功审计污染，单项补查通过。日志 temp/commercial-mvcc-pg.log、temp/commercial-mvcc-recovery-pg.log、temp/commercial-mvcc-audit-pg.log，不重复计数。

商业链码、Adapter 与私有运行入口 35 个不同用例通过，补充回执成员隔离、原五类记录、缺私有数据、严格查询白名单与有限响应；后续新增错误映射/释放回执/路由断言的 4 项定向补查通过。日志 temp/commercial-mvcc-unit.log、temp/commercial-mvcc-query-final.log。真实 Fabric/PostgreSQL 场景增加独立竞争交易，明确制造原提交校验码 11，再要求生产 worker 自动核对并取得新 VALID；执行结果记录如下。


真实 Fabric 3.1.5 三机构链码/Adapter/PostgreSQL 联合入口退出 0：日志 temp/commercial-mvcc-network.log，证据 temp/fabric-network-BgkR6g/commercial-mvcc-reconciliation.json。测试先把两个相同私有合同意图分别原生背书，再提交竞争交易；竞争 VALID 在区块 15（e36439b77bee8cdc1eec6bf707864876ce6c363f6e65f3a401ccdfc0c27f30a8），原持久交易 INVALID 11 在区块 16（d5afa34953ccfa41f1b2c9f75c48f7a5d2a14926fe84c73950346f68c42cc113）。新进程生产 worker 独立核对成员原回执后保存第二份原意图检查点，重新背书并在区块 17 VALID（b3ead1fc10e4ff94abb4b0fc5f1ea9ed61bd584c8322ee822ddd2fc7de6a5428）；原 INVALID 字段逐项未变，机器审计恰为一条，无人工 retry 调用。

本入口同时通过既有原生双方背书、第三方 PDC 隔离、公开块/日志无商业探针、断链原交易恢复、提交成功后退出及真实租约到期恢复等检查，共 15 项。竞争交易由隔离夹具经同一生产 Adapter 发起，恢复由新 Server worker 进程完成；这证明真实链上的精确重复意图恢复，不冒称本轮又运行了两台完整 Server 的文件 Workflow 或 Slurm/PBS。自建链进程和数据库已清理；隔离链测试凭据随私有证据按显式开关保留在忽略目录，不包含部署环境凭据。

全仓类型检查的其他 package 通过，Adapter 新测试对 unknown 的断言类型修正后定向类型检查通过；Fabric 联调脚本类型检查通过。全仓 lint 无错误（原有 47 warning / 1 info），713 个本地文档目标和差异检查通过。本轮不含业务对账/付款、争议/重开、物理介质、Peer 容量归档或完整 Web/CLI/PR 预览，这些仍是完整目标的待办。

## 不可变账单与独立商务减免

新增共享协议和精确核算、`RecordDiscount`/`ConfirmBill` 私有链码与生产 Adapter。账单明确逐项向上取整，完整匹配原合同费率/单位/计量，分别记录原价、封顶扣减、商务减免与应付；双方签署新账单才表示同意取整规则，旧执行批准不自动扩权。减免绑定唯一账单和原报告，是提供方独立签署的追加事实。

链码拒绝旧用量、同任务重复账单、变更原记录、越权签署和缺失 PDC 原文；协调账单必须匹配原终态预留，确认不改变 locked/spent 或 gate。后续技术更正保留，不能改写已确认账单；执行过期允许历史核对，当前签名信任仍须有效。新增用途必须显式授予，普通参数/响应不包含商业正文。

当前边界：Server 账单持久审批、机构间交换及 Web/CLI 尚未接通，数据库待办约束暂不开放新账单操作；无扣款、退款、付款或争议调整。共享计算可用于直接模式而不连接链，真实双平台直接/异步账单流程仍待实现。本节不把 L03/L09 或完整蓝图标为完成。协议与验证入口见[账单说明](../../../deploy/federation/fabric-commercial.md#账单确认与商务减免)。

验证：共享金额计算 8 项、商业链码 32 项、生产 Adapter 11 项和完整签署用途目录 1 项通过，共 52 个不同场景；协调终态时间边界修改后仅重跑对应场景。真实 Fabric 3.1.5 隔离网络 13 项检查通过，包含新减免/双签账单 VALID、应付金额 93、并发两账单仅一份 VALID（另一份原生 MVCC INVALID 11）、第三机构拒绝、实际公开块与 PDC/日志探针隔离，以及既有 Adapter 退出恢复与 Orderer 中断。链进程已清理，私有原始证据只留在忽略目录。本轮未运行双 Server/Agent/科学作业，也未运行 PostgreSQL 账单流程。

已执行根 lint/typecheck；新增测试夹具类型和信任 JSON 的 TypeScript 用途类型问题修复后，Server、商业链码及验收脚本的受影响范围复查通过，其余包在根检查中通过；脚本补充 tuple 类型后单独复查该 probe。lint 保持原 47 warning/1 info，没有新增告警；715 个文档本地引用有效。没有数据库结构迁移、主分支部署或 PR 预览发布。

## Server 账单人工审批与持久存证顺序

迁移 0138 增加本机构账单和减免记录，按组织授予独立 `billing.approve`，现有合同批准不自动扩权。Server 从本地原委派、终态和用量生成未签草稿，复核金额后分别批准同文、导入提供方减免及原对签；提供 API 读取原记录和本机存证状态。直接模式无链依赖；其余模式在提供方确认事务中保存待办，链故障不阻塞业务签名。新能力和签名用途的管理显示已有中英文文案。

账单、审计和待办在同一事务提交，重复请求不会重复审批，组织/原报告/原请求/金额/签名均校验；任何已签账单不因后来的用量更正自动失效。新草稿只能选择最新报告，已签原文可以补齐对签，原更正报告继续追加。本地 worker 保持原合同、原用量、可选减免、原协调终态、账单和后续更正的先后关系，披露前重核批准与信任；未对签的旧账单会让后续更正存证等待，解除须另行实现双方作废/调整协议，不能删除签名。

尚未接通自动账单传输、预授权自动批准、Web/CLI、对端存证状态同步、余额结算、付款退款和争议解决。本节不把整个结算蓝图或 L03/L09 标记完成；协调分支和真实双平台流程仍需联合验收。接口和边界见[Server 账单审批](../../../deploy/federation/fabric-commercial.md#server-账单审批)。

验证：隔离 PostgreSQL 从空库应用生成迁移；13 个新账单场景及 2 个受影响既有场景通过（共 15 个不同场景，修正测试导入和账单/更正顺序后仅重跑受影响范围）。覆盖两端手动签署、减免导入、预算不变、并发幂等、跨组织/权限/用途拒绝、审计和 outbox 原子回滚、断链保存、当前信任、原签名复核、账单先于后续更正、HTTP 隐私及专属重试权限。两端运行同一隔离数据库内的生产服务，传输和链客户端为受控输入/替身，不能据此宣称真实 mTLS/Fabric 联合流程完成。

根 lint/typecheck 已通过，最后的 Server 修改另作 package 类型复查；lint 仍为既有 47 warning/1 info，717 个本地文档目标有效。隔离数据库已清理，未应用部署库、未合并 main、未发布预览。本轮没有重复运行已通过的原生 Fabric 核算/隔离测试。


## 已批准账单自动对签交换

迁移 0139 将账单加入现有商业签名交换通道。后台只交换双方已批准的原签名，未批准保留等待、正文不同进入复核，不创建新业务批准。补齐对签、同步状态、机器审计和提供方异步存证待办同事务提交；重启、响应丢失及手工附签后补办不重复创建待办。旧执行合同到期仍可交换历史账单，原员工停用不抹除机构同意；当前机构/密钥信任和租约仍在保存响应前重验。bill 重试要求独立 billing.approve，协议批准权不自动扩权。

修复共用查询构造中的时钟边界：issuedAt 和 expiresAt 取自同一次时钟观测，避免两次读取相隔数毫秒就超过协议规定的 60 秒窗口。

验证覆盖 12 个账单交换场景、16 个既有商业交换回归场景、2 个共享协议场景，共 30 个不同场景。沿用前轮已通过的账单故障记录，仅补跑新增 HTTP 权限/隐私、手工导入补办及受影响共用交换回归；隔离 PostgreSQL 从空库应用生成迁移，测试完成后清理。本次新增两项与既有交换回归共 18 项通过，涵盖直接模式、租约、审批者停用、证书/端点/用途、原签名及释放到期恢复。全仓 lint 无错误（保留既有 47 条 warning 和 1 条 info），typecheck 各包通过，新增测试随后单独通过类型检查；文档本地链接检查通过。

边界：两端生产业务服务在同一隔离 PostgreSQL 中运行，机构传输为受控替身；未重复运行真实 mTLS/Fabric/Agent 联合验收。草稿及独立减免仍需人工传递，未实现自动账单审批、专用 Web/CLI、对端链状态同步或实际结算。升级及 API 见[账单审批](../../../deploy/federation/fabric-commercial.md#server-账单审批)。


## 真实 Kubernetes 用量与账单联调

新增 Kubernetes 单 Pod/单容器的原 UID 终止时长采集，明确只支持 job.elapsed；不推算 CPU 用量/核数，缺数据、重启及多 Pod 保留未知。共享协议、终态入库及商业汇总检查来源；新增用量查询单次时钟采样，避免 60 秒窗口因两次取时多出数毫秒而被拒绝。

发现并修复协调账单等待错误：终态由需求方提交，提供方没有本地终态上链待办。现改为背书前读取原 terminalId 的成员限定 PDC 回执并核对摘要，缺失等待、错摘要复核、网络查询后重验当前签名信任；不伪造提供方本地 committed。隔离 PostgreSQL 验证上述分支及有效回执推进，无需重复提交终态。

首次真实双平台验收完成两个 Kubernetes Job、签名材料交换、12 字节结果实读/SHA-256、终态自动双签和链上关闭；用量生成被 REPORTING_INTERVAL_INVALID 拒绝，未把这轮写成账单通过。根因是数据库默认 Asia/Shanghai 与旧无时区 Workflow 列的 UTC 解码混用。createPgDb 现固定会话 UTC，专项在非 UTC 连接验证数据库默认创建时间与应用完成时间一致，不改写历史记录。首次脚本执行过快，Kubernetes 原始起止时间同秒；样例新增真实 sleep 1 并要求正用量，以验证非零账单。

本单元新增及受影响验证：Kubernetes 会计/报告 75 个不同单元场景已覆盖；两项终态来源数据库场景、单次时钟窗口、协调账单远端原回执、非 UTC 数据库会话各一项，以及七项 Workflow 登记回归通过。协调回执场景包含缺失、错误摘要、查询中撤权与正确回执，不要求提供方伪造本地终态待办。首次单元夹具断言修正后仅重跑受影响项，不重复累计。全仓 lint 退出 0（保留原有 47 warning / 1 info），全仓类型检查连同 Fabric 联调脚本退出 0；720 个本地文档目标及差异格式检查通过。

修正后的真实双平台 success 场景退出 0：日志 `temp/billing-live-positive.log`，私有执行证据 `temp/federation-execution-success-ixigxfnt`，Fabric 网络 `temp/fabric-network-Ys3sFY`。两个独立 Server/数据库、真实机构 mTLS、两端 Agent 与独立对象存储完成自动协议交换、市场认领/预留/许可、两个轻量 Kubernetes Job、签名材料交付与 12 字节结果实读；双方预授权终态自动确认，私有 TERMINAL 与公共 CLOSED 完成。

独立读取 Pod 容器起止时间得到累计 1,000 job-millisecond，与提供方自动签署并传至需求方的原报告一致；测试费率每 1,000 毫秒 1 个实验单位，逐项向上取整后原价及应付均为 1。停 Orderer 后，两端 HTTP 分别明确批准同文账单，生产后台经 mTLS 自动交换原签名；提供方 pending，源方无账单链待办，重复批准返回各自原签名。恢复后原待办 `ccb81220-8ada-4c30-8bf2-9487fc8b65ac` 得到唯一 VALID（validationCode 0），区块 23，交易 `f02c40d12723423270ad2d860c52def011879105340a4329d9d1e24cc7dce70d`。断链与恢复证据分别保存在 `billing-offline-evidence.json`、`billing-committed-evidence.json`；最终 gate 保持 TERMINAL，公共需求 CLOSED，两端不复制本地预算。

自建 Server、临时 PostgreSQL、测试凭据及调度器 namespace/RBAC 已清理，无遗留本轮进程。原始私有证据保存在忽略目录，不纳入版本控制。本次只运行新增账单涉及的 success 场景，未重复已通过的 outage/stop/Workflow 场景。样例使用真实 Bash 和 sleep，计量仅为 Kubernetes 终止时长；不声称 CPU 消耗、Slurm/PBS/Spack 或科学结果验收。自动账单批准、减免自动传递、专用 Web/CLI、付款/余额结算、争议、物理介质、归档及完整 PR 预览仍未完成。


## 商业账单 Web 核对入口

合同详情新增账单页签，复用现有布局、组织/登录缓存和刷新。提供方从最新用量报告生成无减免草稿，双方可导入/导出同文 JSON、核对精确金额后分别批准，保留手动对签及提供方原存证重试。原价、封顶、减免、应付和原报告分开展示；确认不会付款或释放预留。独立 billing.approve 与手机只读规则生效，合同批准权不扩权；跨机构/登录切换丢弃私有草稿，未知批准响应保留原请求。直接模式不要求存证，需求方无本地记录明确表示对端状态未同步。

新增共享 HTTP 读取 schema，验证机构、合同、任务域、原报告及草稿身份；未添加后台自动批准或新迁移。页面没有减免管理、签名交换故障专用复核、对端存证状态同步、CLI、实际付款/结算或争议处理。完整范围仍按验收契约，不把账单 UI 等同于完整商务闭环。

50 个不同组件场景已覆盖并通过（25 个新增、25 个原商业/用量回归），包含金额精度、人工确认、响应丢失原文重试、源方/直接模式状态、独立权限、手机只读、跨机构/登录切换、错误响应和最新报告入口。初次按钮名称、夹具函数名及测试查询类型错误已修复，仅重跑受影响项，不重复累计。真实浏览器四张夹具截图位于忽略目录 `temp/billing-ui`：中文桌面待存证、批准弹窗、手机只读、英文深色需复核；无页面异常或页面横向溢出。逐张检查后修复手机表格文字竖排并移除重复刷新，受影响截图已更新；这不是 PR 预览。

全仓 lint 退出 0，保留原有 47 warning / 1 info；全仓其他 package 类型检查通过，新测试的查询类型修正后 Web 定向检查退出 0。本轮未重复真实 Fabric/调度器验收；上一单元的双平台真实账单已通过。页面使用现有服务，不改变后台业务签名或资金状态机。

本单元最终检查：726 个本地文档目标有效，差异格式检查通过；临时 Vite 服务已停止。没有新增依赖、数据库迁移或部署环境写入。


## 独立双签额度结算

新增独立 commercial-settlement 及精确守恒校验；业务同意绑定原账单，应付不能借结算改写。协调链码将原终态预留由 terminal 变为 settled，在同一 PDC 事务扣除原 locked、增加应付 spent、归还差额并减少未结算计数，保留终态 gate。异步存证只追加记录，不新建或消耗链余额；直接模式拒绝链提交。生产 Adapter 验证专用签名用途、双方同文和路由后才披露 transient，原参数和回执无商业正文。当前尚未接 Server 独立结算批准、双边本地余额或 Web/CLI，原 worker 显式拒绝未授权结算。

共享核算/链码 48 个不同场景、Adapter 11 个场景通过（合计 59，包含 8 个新增结算场景及扩展的 Adapter 校验）。首次发现 Zod 非致命字段校验后仍进入 BigInt 精化导致小数输入抛异常，已在精化前确认金额字段有效；协调夹具的终态时间修正为覆盖原报告，不放宽生产校验。仅定向补查失败及相关结算场景。验证覆盖精确金额、单位/账单/终态替换、独立用途及双方签名、幂等、第二结算拒绝、私有数据丢失拒绝、异步不重复记账。真实链上的并发/组织背书/额度守恒验收正在补充，不将模块测试当作其证明。


真实 Fabric 3.1.5 gate 入口退出 0，日志 `temp/settlement-live.log`，私有证据 `temp/fabric-network-9F7bad/gate-settlement.json`。独立测试预算 100、双签账单应付 7，另签结算归还 93；结算 VALID 位于区块 57，交易 `185b863b978c41a8d5b465c639ba9e9549e3d51047f72b05ece3979680d0a97e`。缺 B 背书的交易为 INVALID 10，两份已背书竞争结算中第二份为原生 MVCC INVALID 11；相同结算重放有效但没有第二次预算写入。独立读取实际 PDC block events，核验该预算最终 locked=0、spent=7、reservations=0，原 gate 哈希不变且公共需求仍 CLOSED。C 及跨 Peer 读取没有私有正文，公开区块与服务日志没有敏感探针。

同入口共 11 项检查通过，包含既有预留/激活/停止/终态竞态及 Adapter 跨进程、断 Orderer 恢复。新结算的真实链路径通过 SDK 显式双签验证；本轮没有新增 Server 结算 API，也不把既有七类 Adapter 恢复算成新结算专用崩溃验收。账单与终态为链测试夹具，不冒称再次执行实际作业或完成两台平台结算。测试链进程已清理，私有原始证据留在忽略目录。

新增签名用途的数据库 JSON TypeScript 联合类型和最大选择数量已同步，信任页面中英文目录与共享 schema 一致；补充的目录边界测试通过，共 60 个不同模块/组件场景。全仓 lint 保持原有 47 warning / 1 info；全仓类型检查中 Server 暴露用途类型遗漏，修正后 Server 和 Fabric 联调脚本定向检查退出 0，其余 package 已通过。新增目录测试最初使用未导出的 trust 子路径，改为现有 federation 导出后通过；只补查受影响项。


## Server 独立额度结算与双边记账

迁移 0140 保存按本机构/原账单唯一的结算批准、对签及本地处理时间，加入独立 settlement.approve。既有在线权限管理及中英文标签同步支持；合同读权限包含结算审批者，不隐式授予账单、付款或执行权限。草稿来自双签原账单并绑定协调终态，签署 commercial-settlement；本地批准不能改应付或释放另一任务的额度。

提供方预算新增 spent，守恒 limit=available+reserved+spent。双方分别记账，预留/源方 outbound 保留原 amount、receipt 和执行状态，只增加 settledAmount；源方预算统计保留消费，只释放未用部分与任务名额。双边直接不创建链待办，异步存证本地处理与提供方待办同事务，不等待链。协调模式双方各自入队原结算，必须持久化 VALID 后才处理本地名额，没有本地可花费的链预算副本；私有链码仍是协调资金唯一权威。

后台复用商业签名交换，新增 settlement 记录类型，按租约核验当前机构信任后附加原签名。商业 worker 披露前核对持久双签结算及用途，查询原账单 PDC 回执；缺失等待，不因签名齐全就推断上链。签名、账目、审计与待办事务失败全部回滚。原记录重试不重复消费，单独的账单批准不能进行结算。

隔离 PostgreSQL 共 11 个不同专项通过：直接模式并发附签与精确退还、独立权限/组织/正文、事务失败回滚、异步交换不等链、交换租约失效、签名用途撤销、HTTP 私密与自动化拒绝、账单存证等待和同提交恢复、需求方与提供方接单余额/名额、协调 pending/INVALID 不释放而 VALID 仅处理本地名额。协调用例明确使用预批准记录和受控 Adapter 结果，只验证 worker 结果投影；不冒称完整协调审批或真实链联合验收。预留 60、消费 53、退回 7 后双方后续最多可预留 47，原回执重放保持一致；异步上链完成不再次扣账。首轮 worker 夹具误用非 base64 恢复令牌，被生产校验正确拒绝；修正夹具后仅重跑失败项及尚未执行的相关接单测试。

日志 temp/settlement-service-pg.log、temp/settlement-service-extra-pg.log、temp/settlement-coordinated-pg.log；每次隔离数据库均已清理。既有在线权限组件 8 项通过，包含枚举标签检查。全仓类型检查（含 protobuf 与 Fabric 脚本）已通过；新增末批测试的 Server 定向检查也已通过。最终 lint 无错误，保留原有 47 warning / 1 info；733 个本地文档目标与差异格式检查通过。没有重跑已通过的真实 Fabric gate，也没有运行科学软件。真实双 Server/mTLS/Fabric 结算及断链恢复、专用结算 Web/CLI、自动审批、支付退款/争议、物理介质、归档与 PR 预览继续待完成，未合并或部署 main。API 与升级见[Server 额度结算](../../../deploy/federation/fabric-commercial.md#server-额度结算)。


## 真实双平台结算与断链恢复

既有 success 样例增加真实结算：双方显式授予 settlement.approve 和 commercial-settlement 签名用途；成功任务预留额从 1 调到 10，让真实账单之外保留可验证的退额。生产接口从已双签原账单生成草稿，两端独立 HTTP 批准，后台经 mTLS 交换原签名。停止 Orderer 时两端 pending、appliedAt 为空、名额未释放；恢复后必须由同一持久待办取得 VALID 才应用本地投影，批准重放保留原 JWS。

最终运行退出 0：日志 `temp/settlement-live-execution-final.log`，执行证据 `temp/federation-execution-success-ukslgumi`，网络材料 `temp/fabric-network-n5VyBU`。两个轻量 Kubernetes Bash Job 的原始时长累计 1,000 毫秒，应付 1，结算预留 10、消耗 1、退回 9。提供方原交易 VALID 在区块 24；需求方原交易在区块 25 发生 MVCC INVALID 11，生产 worker 保留原失败记录，核对同一原 PDC 回执并重新背书，自动取得区块 26 的 VALID，无人工重试或重新批准。

新增独立 Node Gateway 证明脚本读取 A/B/C 真实区块：核对两端持久交易确实位于所称区块且 VALID，断链 checkpoint 全部保留；A/B 各看到一次预算写入、一次原预留 settled 写入、两次相同结算写入。预算 locked=0、spent=1、reservations=0；C 可见公共交易，但三类私有写入均为 0。执行 gate 未变、公共需求仍 CLOSED，无额外 Job；两端没有复制链预算，原接单金额/回执/执行状态保留，settledAmount=1。

证据文件为 settlement-offline-evidence.json、settlement-committed-evidence.json、settlement-private-ledger.json，私有材料仅保存在忽略目录。首次运行因样例预留 1 与实际账单 1 相等，无法验证正退额，在发现后主动停止并正常清理；它不是完整通过记录。修正仅涉及成功样例预留额，不放宽生产校验。最终运行后的临时服务、PostgreSQL、Fabric 进程及两次测试 namespace 已清理。

本次只新增协调结算的真实联合验收，未重复 outage/stop 场景，未运行 Spack 或科学重负载。直接/异步结算沿用隔离数据库证明，尚无真实双平台结算证明；Orderer 中断与实际 MVCC 恢复不替代结算专用进程崩溃验证。专用 Web/CLI、自动账单/结算授权、付款/调整/争议、物理介质、归档及完整 PR 预览仍待完成，不将本次结算通过视为全蓝图验收。

收尾检查：全仓类型检查（含 protobuf 生成及 Fabric 联调脚本）退出 0；lint 退出 0，保留既有 47 warning / 1 info；735 个本地文档目标有效，差异格式检查通过。


## 独立结算 Web 核对入口

商业合同增加“结算”页签，从已双签账单带入原 billId，也可填写原账单生成草稿；双方导入同一原文后分别核对批准，支持导出、原签名手工附签及本站链待办重试。复用既有合同/账单布局及生产 API，不增加数据库迁移或自动审批。共享读取 schema 检查本机构、合同、账单和结算身份，金额不转浮点；只有独立 settlement.approve 可以操作，合同/账单审批权不扩权，手机只读。机构或登录切换清空私有草稿，响应未知重试原正文，填写和批准期间暂停结算轮询。

签署、本地记账时间和链状态分开：直接合作无链等待；异步存证可已记账但仍待存证，需求方未同步的提供方状态不推断；链协调需求方也显示本站持久待办，VALID 前未记账。appliedAt 不代表银行付款或对端已同步。专用 CLI、自动审批、商务调整/退款/付款/争议仍待实现。

79 个不同组件场景通过，其中 29 个新增及 50 个账单/合同/用量回归；覆盖三模式显示、精确整数、原账单生成与响应身份、同文批准、响应丢失原请求重试、跨域导入拒绝、独立权限、手机只读、机构/登录切换、手动对签、原待办重试和分页。浏览器四张截图保存在忽略目录 temp/settlement-ui：中文桌面异步已记账/待存证、批准弹窗、手机只读、英文深色协调未记账；逐张检查，无页面异常或横向溢出。首次浏览器断言将已记账与其子元素时间一起精确匹配而超时，修正定位后四种状态通过，未改变生产逻辑。

页面使用受控 API 响应夹具，不能替代 PR 预览。前一单元真实协调结算证据保持有效；本轮没有重跑 Fabric、Agent 或科学软件任务。临时 Vite 服务已停止，私有夹具及截图未纳入版本控制。

收尾检查：全仓 typecheck（含 protobuf 生成及 Fabric 联调脚本）退出 0；lint 退出 0，保留既有 47 warning / 1 info；737 个本地文档目标有效，差异格式检查通过。


## 账单与结算的机构预授权

新增 closing policy 及批准记录的授权外键（生成迁移 0141_absurd_invaders.sql）。bill 与 settlement 独立授权，固定合同/机构、允许终态、单笔/累计金额、次数和有效期；仅人工持相应独立权限可授予或撤销。主 Server 已挂载分页查询、授予及撤销 API。原有两种批准服务抽出共用事务路径，内部自动入口使用政策持久授权，不冒用当前人类会话；普通 HTTP 批准仍要求原人工权限，不接受政策参数。

自动批准锁定政策并核对合同原双签、当前机构/密钥用途，账单另验证原报告签名，原用量/终态/账单一致性不降级。新签名、授权来源、累计批准计数和机器审计同事务保存；计数不是预算，自动批准本身不附对签或处理余额。原批准重复调用和政策替换不重新计数或改写来源；撤销与签署串行化，已完成的签名保留。原员工失去个人权限不等于机构主动撤销政策。

隔离 PostgreSQL 从空库应用生成迁移后，13 个新场景及 5 个原账单/结算回归场景通过。覆盖双方独立授权、同单并发签一次、单笔/累计/次数边界、过期/终态/合同摘要、跨组织/站点/类型隔离、当前对方用量签名用途、个人权限与政策撤销分离、审计失败完整回滚、签后到期回滚、旧政策来源保留、HTTP 权限/私有缓存及金额 schema。原减免、手工审批、并发任务账单唯一性及直接结算余额守恒回归保持有效。日志位于忽略目录 temp/closing-policy-pg.log 与 temp/closing-policy-extra-pg.log；临时 PostgreSQL 已停止并移除。

当前只完成管理 API 与生产服务的事务内自动批准能力，生产 worker 尚未接后台发现、草稿生成和跨站提案传递，专用政策 Web/CLI 也未接通；不能把这项核心验证当成完整无人值守验收。没有新增链协议/签名用途，没有重跑已通过的真实 Fabric/调度器或 UI 场景，没有修改部署环境。

收尾检查：全仓 typecheck（含 protobuf 生成及 Fabric 脚本）退出 0，补充最后两项测试后 Server 定向类型检查退出 0；lint 无错误，保持既有 47 warning / 1 info；739 个本地文档目标有效，差异格式检查通过。


## 自动账单与结算编排

生成迁移 0142_thin_zodiak.sql 新增提供方 closing task；生产商业 worker 有界发现已报告用量和双签账单，复用原审批服务原子生成/绑定原文。私有 mTLS 新路由传递原业务 JWS，需求方按独立本地政策批准；无新签名种类或链协议。待办沿原编号恢复，材料缺失/临时传输重试，授权拒绝人工复核；租约和端点/信任复查阻止迟到结果写入。原批准不因政策撤销而删除或重复计数，准备减免不会被自动全价账单绕过。

13 个新增隔离 PostgreSQL 场景已通过：生产 worker 双方自动账单/结算、direct 无链、attested 无 Adapter 先记账、对方缺政策、缺用量、响应丢失后撤销、晚到租约、生成时租约丢失整体回滚、签署中证书撤销、未启用通道/政策、准备减免和原减免账单复用、端点变化、最终授权回调后政策到期、任务 API 作用域及独立重试权限。生产服务采用受控进程内传输；7 个网关/客户端场景另使用真实 TLS，均通过。初次运行的测试夹具缺导入、清理遗漏和存证断言范围已修正，只重跑失败和新增场景。

待办完成表示原签名交换完成，协调额度投影仍等待本站 VALID；自动收尾的真实双平台/Fabric 验收与专用政策 Web/CLI 仍待继续。临时测试库已停止并移除，未修改部署环境。

补充 10 项原人工账单、减免、结算与预授权回归全部通过。全仓类型检查仅报告测试夹具可选路径未收窄，补充显式检查后 Server 定向类型检查通过；其余包全仓检查及 Fabric 联调脚本类型检查均已通过。lint 无错误，保留既有 47 warning / 1 info；740 个本地文档目标检查通过。


## 真实双平台自动商务收尾

既有 success 执行验收改为：在真实轻量 Kubernetes 工作流及跨站文件返回完成后，先停 Orderer，再由双方各自通过管理 API 授予有限账单政策；生产 worker 自动发现实际用量、生成唯一账单、独立批准并经 mTLS 传递原文。恢复原账单存证后再次停链，双方另授结算政策，由后台自动生成和对签。验收不调用账单/结算草稿、逐单批准或手工附签 API。

实际 1,000 毫秒用量形成账单 1，结算将原预留 10 分为扣用 1、归还 9。两端每种政策均只批准一笔、累计批准额为 1；断链时两个 closing task 已完成原签名交换，结算仍 pending、appliedAt 为空，原名额未释放。恢复后原待办均 VALID 才应用本地投影；提供方在区块 24 确认，源方区块 25 的 MVCC INVALID 被保留并由后台自动核对，随后区块 26 VALID。验收未调用人工复核重试结算。

独立 Node Gateway 从 A/B/C 私有区块事件核对：原预算只扣一次，原预留只结算一次，两个同文结算回执不重复扣用；终态 gate 与公开 CLOSED 需求不变，C 的私有写入为零。跨站文件内容及 SHA-256、单份预留/运行和结果重复导入检查同时通过。完整入口退出 0；自建 Server、Agent、数据库、凭据及随机 Kubernetes namespace 已清理。

证据仅保留在忽略目录 temp/closing-auto-live.log、temp/federation-execution-success-exwyoedg 与 temp/fabric-network-dNr87J，不提交测试身份或私有记录。复现步骤见[执行验收](../../../deploy/federation/execution-lab.md)。这是一台机器上的机构模拟，政策于作业结束后才启用，验证历史任务自动发现和商务收尾；不代表独立机构长期运行、直接/异步模式真实结算、Slurm/PBS 或科研软件安装验收。专用政策/待办 Web/CLI 及整体 PR 预览仍待完成。


## 商务自动审批 Web 管理

合同详情新增自动审批页签，使用已有业务服务管理机构 bill/settlement 授权。单笔/累计金额、次数、结果与到期时间经显式核对，撤销和原待办复核使用对应独立权限；金额不经浮点转换，机构/登录切换清除私有草稿，手机只读。创建响应未知先读取核对，不重发可能已经生效的授权。处理完成明确标为双方签署，继续到原账单/结算查看记账和链状态。

共享 commercial 模块增加授权/待办读取 schema，并迁入原 Server 输入 schema，授权契约不变；账单与结算的现有列表增加可选 recordId 参数，在原组织/站点/合同约束内精确过滤。Web 使用该参数进入原记录，返回恢复完整列表，不靠反复翻页寻找 ID。

100 个不同 Web 组件场景通过（原 79 项、新增 21 项；首轮 5 项夹具过早点击加载中按钮，修正等待后定向重跑，另补 6 项导航/父页权限检查）。覆盖授权类型隔离、精确金额、上下限/结果校验、未知响应、撤销、到期/零金额、历史分页、机构/登录/权限变化、源/提供方视图、原 ID 导航和手机只读。5 个隔离 PostgreSQL 场景通过，包括原授权 schema/HTTP、生产自动收尾回归、待办重试权限及原账单/结算 recordId 查询；无效 UUID、查无记录与跨组织访问分别验证。临时数据库已清理。

四张真实 Chromium 夹具截图验证中文桌面、授权确认、手机只读及英文暗色主题；无页面错误、无横向溢出，并验证账单跳转发送原 recordId。截图与日志仅在忽略目录 temp/closing-ui*。没有重跑上一轮已通过的真实 Fabric/调度器验收，也没有部署生产。CLI 和整体 PR 预览仍待完成。

收尾检查：全仓类型检查除新增 PG 测试直接读取 unknown JSON 的三处类型错误外均通过；改为结构断言后，Server 与 Fabric 脚本类型检查退出 0，该数据库场景定向重跑通过。补充父页测试后的 Web 类型检查退出 0；lint 无错误，保留既有 47 warning / 1 info；744 个本地文档目标和差异格式检查通过。本地 Vite 夹具服务已停止。


## 联邦财务 CLI 与机构上下文保护

新增 `kq federation`，覆盖合同读取、账单/结算原文草稿、显式批准与附签、政策授予/撤销和原待办复核。复用现有 API 和独立财务权限，不增加直连 Fabric、机器审批权、新依赖或数据库迁移。金额保留精确整数，预留/扣用/归还分别标明；双方签署、本站记账和本站存证独立显示。

检查 CLI 接入时补齐主 Server 的机构断言：`--org` 发送预期机构，principal 绑定后失配即拒绝，不通过请求头切换或授权。CLI 的 use 命令显式调用既有登录会话切换接口；Web 已有机构请求头同样受保护，无头旧客户端兼容。联邦请求拒绝重定向并限制 30 秒，不自动重试写入；响应未知先查原授权或原业务记录。输入最多 600000 字节，原文导出用 0600 新文件且拒绝覆盖；批准/附签响应核对正文与内外记录编号。

25 项轻量测试通过，覆盖实际 loopback HTTP、机构头、精确金额、三模式状态、有限授权、独立权限、中文/JSON、分页、原文草稿/批准/附签、撤销、成功回执、异常响应、重定向及文件边界。另以真正 CLI 子进程、生产商业路由和新建 PostgreSQL 执行 1 项联合场景、18 个断言：会话切换失配无副作用、缺 billing.approve 拒绝、机器身份拒绝、政策创建/读取/撤销及原结算筛选均通过。联合测试注入已绑定身份，不宣称验证完整登录。数据库与临时文件已清理。

没有重复运行已通过的 Fabric/调度器场景，没有修改生产环境。执行/市场/材料/减免/付款/争议等 CLI 能力及整体 PR 预览仍待完成；本单元不代表全蓝图交付。完整使用说明见[联邦财务 CLI](../../federation-cli.md)。

收尾检查：全仓 typecheck（含 protobuf 生成及 Fabric 联调脚本）退出 0；lint 无错误，保留既有 47 warning / 1 info；751 个本地文档目标与差异格式检查通过。


## 结算后的私有账务调整

新增 commercial-adjustment、共享原文核对、AdjustSettlement 链码与生产 Adapter adjust-settlement。新记录固定原合同/账单/结算、前一笔调整及变更前后净额；支持调减与原任务上限内调增，不修改原用量、账单、结算或历史调整。协调预算仅按差额更新 spent，保留 limit、locked、预留数和 TERMINAL gate；余额不足拒绝，慈善不变收费，不把账务调整当成银行付款或退款。

当前前驱索引、调整和余额在同一私有事务写入，重放原记录不回退索引或再次退额。缺私有正文不能当首次调整，原生集合背书仍需双方，新增业务签名用途须显式授予。Adapter 只在成员 transient 中发送原文；共享信任用途及中英文名称同步，旧密钥不自动扩权。Server 本地调整审批与记账尚未接入，队列和重试入口明确拒绝 adjust-settlement，避免落入合同审批权限。

69 个不同共享协议、链码与 Adapter 场景通过，其中 10 项新增调整场景，两个已有 SDK 边界场景增加调整操作。覆盖整数精度、跨对象/机构/单位、前驱/摘要、时序、原限额、无变化/负数/小数、自引用、慈善、缺用途/撤钥、成员隔离、原文与历史不变、重复提交、其他任务锁额占用，以及私有索引/正文缺失。首次大整数测试沿用小任务上限，系统正确拒绝；修正夹具的原任务/预留限额后只重跑相关 4 项通过，未改生产规则。

真实 Fabric 3.1.5 三机构验收入口 `test:fabric:gate` 完整退出 0，共 12 项通过。新调整在区块 61 将原 spent 7 调减为 4，区块 63 经另一次同文双签调增为 5；缺一家机构背书校验码 10 INVALID，竞争旧前驱校验码 11 MVCC INVALID。历史调减和原结算重放后仍为 5，任务 CLOSED 与终态 gate 哈希不变。独立读取有效私有区块写入核对 7/4/5 的实际预算，C 及跨 Peer 非成员身份没有私有写入，公开块与服务日志没有原因/签名/盐探针。原预留、激活/释放竞态、终态、结算及既有 Adapter 的断 Orderer/进程退出恢复回归同轮通过。

入口按成功默认行为清理临时网络和私有目录；本轮保留运行日志 `temp/adjustment-live.log`、模块测试与静态检查日志，不声称已保留可重新查询的 Peer 历史。新增调整的真实链操作使用 Node Gateway，生产 Adapter 的新操作仅验证 SDK 提案构造与边界；其跨进程恢复、多平台本地记账与实际管理流程仍须随 Server 接入继续验收。本轮不运行科学软件或改动生产环境，没有数据库迁移。

操作约束见[账务调整](../../../deploy/federation/fabric-commercial.md#结算后的独立账务调整)。Server 独立权限/API、原签名交换、Web/CLI、支付/争议及其他蓝图项目仍未完成，整体目标继续。

补充核对：商业 trust 已由 Init 固化，原链未预置新签署用途时，尚不能仅替换配置完成升级；本轮新建网络验收不覆盖旧链信任/代际迁移，该项继续保留在 O04 交付范围。

收尾检查：全仓 typecheck 首轮仅发现数据库 JSON 签名用途类型遗漏新值，补齐该 TypeScript 类型后，DB/Server 与 Fabric 联调脚本类型检查均退出 0，其余包首轮已通过，protobuf 已生成。lint 无错误，保持既有 47 warning / 1 info；756 个本地文档目标与差异格式检查通过。


## Server 人工调整与持久增额占额

生成迁移 0143_solid_starjammers.sql 新增独立调整记录、源站 adjustmentHeldAmount 及 adjustment.approve，生成 0144_cool_lilith.sql 扩展商业待办操作约束。主 Server 已挂载原结算下的草稿、同文批准、附签和精确记录分页 API；平台权限管理可授予独立调整能力，不复用合同/账单/结算权限，机器身份不能批准。

原结算行锁与本站/结算序号、前驱唯一索引禁止分叉。正差额在直接/异步批准时先占额：提供方 available 转 reserved，源方保存原出站占额并加入新接单聚合；尚未双签的调减不退额。双签后差额转为当前净额投影，旧账单/结算/接单金额不变；当前调整未应用时不得签下一笔。已签占额不因员工撤权、超时或签名失效自动释放，原文收尾与未来双方解除/争议流程分开。

链协调不创建本地可花费余额，原待办披露前验证本地双签和当前密钥/用途，查询原结算及前驱成员私有回执。只有本站 VALID 才更新本地净额；异步模式先记账后补存证，后续确认不重复应用。独立重试权限与原 INVALID/MVCC 恢复机制保留。

13 个新增隔离 PostgreSQL 场景通过：直接调减/调增与原文不变、同文并发批准只占一次、两端预算不足拒绝、源站真实接单计算增额占额而不额外占任务名额、跨机构/原文/单位与独立权限、错误对方签名、异步无链先记账、审批/应用审计失败完整回滚、HTTP 人类权限和私有缓存、原结算链回执等待、协调双签后等 VALID、缺新签名用途回滚占额、双方并发附签各记一次。另有 4 项旧直接/异步/协调结算及源站接单投影回归通过。数据库从空库应用生成迁移，临时库均已停止移除。

首轮发现待办 SQL 操作白名单遗漏新类型，已通过生成迁移补齐；测试的额外源站操作携带旧状态报告不合法，修正测试夹具；HTTP 新草稿 schema 从含 refinement 的对象 pick 会在路由挂载时报错，改为独立共享草稿输入 schema 后定向复测通过。只重跑失败/新增和受影响原路径，没有重复真实 Fabric 或科学计算任务。

本轮协调结果由测试 Adapter 提供，证明 Server 应用边界而非新的真实多平台恢复；上一轮真实链证据保持其原范围。自动签名交换与调整 Web/CLI 尚未接入，当前通过人工同文与原签名完成流程，后续继续完善。升级需停止旧接单/商业 worker 后应用 0143/0144 并同步启动双方新版，不能混用忽略占额的旧接单程序。操作及解除占额限制见[Server 账务调整](../../../deploy/federation/fabric-commercial.md#server-账务调整)。

收尾检查：全仓 typecheck（含 protobuf 生成和 Fabric 联调脚本）退出 0；lint 无错误，保留既有 47 warning / 1 info；759 个本地文档目标和差异格式检查通过。当前工作仅在实现分支，未部署生产或发布完整 PR 预览。

## 已批准调整的后台签名交换

在原商业签名交换中新增 adjustment 类型和生成迁移 0145；复用原 mTLS 入口、分钟查询窗口、每种 8 条的发现批次和租约恢复。仅传递本站已批准的原文签名；双方尚未同意时保持等待，已签增额占额不撤销，不套用账单/结算自动审批政策。

附签服务将当前信任/端点/租约重核、原文校验、记账、链待办、同步完成和审计放在同一事务。员工失去批准权不销毁机构已有签署，但不能批准新调整；主动重试必须有 adjustment.approve。签名用途撤销或端点改变阻止附签；旧租约响应不能覆盖替代租约。先手动附签的记录可直接完成同步，不重复发送或记账。

验证：9 项新增隔离 PostgreSQL 交换场景通过，涵盖独立批准前等待、调减/增额、丢响应重启并发恢复、员工撤权、密钥用途/端点变化、迟到响应与独立重试权、手动附签竞争及审计失败整体回滚；另 5 项原账单/结算交换回归通过。协议 schema 的 2 项测试通过。HTTP 入口另验证调整类型、机构隔离、无私有原文泄露及独立重试权。

本轮未重跑真实 Fabric 或调度器，不将数据库内的双站交换视为真实双平台网络恢复验收。调整专用 Web/CLI、实际 Adapter 恢复、支付/争议、物理介质、归档治理和完整 PR 预览仍未完成。


## 账务调整 CLI

新增 adjustments draft/approve/attach/list，复用现有合同作用域和文件/网络边界。草稿显式要求原结算、新净额和原因，可带佐证摘要；CLI 校验服务端返回的金额/原因/佐证及各层编号，不悄悄改变用户原意。双方批准同一原文，自动交换或手动附签完成同文收尾。列表分开呈现调整前后金额、批准时占额、签署、本地记账和链状态，保留精确整数。

新增 8 项 CLI 测试，原附签测试扩展至调整，全文件 27 项通过。实际 CLI 子进程、loopback HTTP、生产路由与隔离 PostgreSQL 的新联调通过：原净额 53 调至 60，错误会话机构/缺独立权限/机器身份不能批准；批准占额 7，附签后 spent 60，再附签不重扣。共享响应 schema 由实际响应验证，测试身份由夹具注入，不宣称正式登录或真实跨机构传输已经验收。

调整专用 Web、真实多平台及 Adapter 进程恢复仍待继续；未运行 Fabric、Slurm/PBS 或科学计算重负载，尚未建立整体 PR 预览。


## 账务调整 Web 与原结算历史

商业合同新增账务调整标签，已应用结算可进入原结算筛选的历史。页面支持完整原文导入/导出、草稿、独立批准、原签名附签、原存证待办重试；显示前后净额与 BigInt 差额、原因、佐证及原记录关系。签署、本地应用、链状态各自呈现，批准时占额明确标为历史。手机保留查看，只有独立 adjustment.approve 的桌面用户可修改；撤权和机构/会话切换清理私有草稿，迟到草稿不恢复批准入口。

Server 查询新增可选 settlementId 及 summary，不改变旧列表调用，也无需迁移。原结算共享行锁保护当前头与分页查询一致；历史按序号降序，当前净额不从正在查看的旧记录推断。原结算未应用返回空当前值，已签待完成调整不提前改变净额。跨组织与不存在的原结算拒绝，HTTP 校验新增筛选参数。

96 项页面及原商业/结算回归检查先通过，随后新增 2 项针对原结算导航与导入筛选边界的检查通过，共 98 个不同页面场景；2 项新增 PostgreSQL/HTTP 场景验证分页当前净额、待应用调整及未应用原结算。真实 Chromium 在源码页面及隔离 API 夹具下完成中文桌面历史/详情/批准框、390 手机详情、英文深色协调待应用等 5 个画面检查，无页面错误或横向溢出。截图不作为真实平台登录/链网络验收证明。

整体目标继续：真实多平台调整与 Adapter 恢复、支付/争议与双方解除占额、物理介质、归档治理、完整集群矩阵和 PR 预览仍未完成。

独立 UI 复核通过。补真实键盘检查发现批准框关闭后焦点落回 BODY，已保存触发元素并在关闭时恢复；提交成功或撤权移除触发器时，回到具名面板而非页面正文。新增取消/成功提交两项焦点回归，累计 100 个不同页面场景；真实浏览器验证 Tab/Shift+Tab 保留框内焦点、Esc 返回触发按钮。屏幕阅读器尚未单独验证。首次类型检查发现测试响应的 unknown 读取，已改为共享 schema 解析后读取，HTTP 场景复验通过。

最终全仓 lint、typecheck（含 protobuf 生成与 Fabric 验收脚本）、焦点修复后的 Web 类型检查和离线文档链接检查通过；lint 保留原有 47 个 warning / 1 个 info，无新增错误。隔离 PostgreSQL 与本轮 Vite 服务已停止，未变更部署环境。


## 账务调整真实双平台与进程恢复

扩展已有轻量 success 验收，无新生产逻辑或迁移。两套完整 Server/独立 PostgreSQL、生产 Node Adapter、A/B/C 三机构 Fabric、真实 Kubernetes Agent 与对象存储通过合同/预留、材料拉取、12 字节结果回传、自动终态、账单及原结算。随后人工通过生产 HTTP 分别批准两笔调整，后台 mTLS 自动交换原签名，实际净额 1 → 0 → 1。

第一笔在 Orderer 停止、两站保存已背书交易后，强制结束两个自建 Server 进程组（-9）与两个商业 Adapter（137）；原数据库、配置、恢复密钥和签名密钥重启，原提交编号、交易 ID、恢复检查点摘要不变，链未确认不应用。恢复链后双方分别 VALID；两笔调整均实际遇到一站 MVCC INVALID 11，再由原生产 worker 核对不可变回执自动收尾。未修改数据库时间/租约或新建业务 ID。重复批准返回原记录，第二笔绑定第一笔摘要。

独立 Node Gateway 逐笔核对实际区块与私有写集：原结算及两笔调整各有双方 VALID；每笔预算仅改变一次，调整头各改变一次，双方同文重放不再次改余额。原账单/结算/预留/gate 不被调整改写，第三机构 C 无私有写入。原结算/两次调整都分别保存证明，不能以当前余额掩盖中间失败。私有证据保留在忽略目录，不提交凭据、原签名或日志。

全仓 lint/typecheck 和 Python 语法检查通过；真实 success 命令退出 0，自建 Server、数据库、测试 namespace、Adapter 与 Fabric 进程已清理。lint 沿用原有 47 warning / 1 info。没有重复跑无关 outage/stop/Workflow 场景或科学计算重负载。

本轮仅补齐协调调整的真实恢复证据。全目标仍包括直接/异步真实多平台、任务前无人值守策略与 Slurm/PBS 矩阵、支付/争议/解除占额、物理介质、容量/归档/治理迁移和真实 PR 预览；仍保持待完成，不将本轮通过视作整体交付。


## 直接合作的真实无链成功路径

新增 `test:federation:direct` 独立入口，仅创建两家机构临时业务密钥，不要求 Fabric 工具目录且不启动 Peer/Orderer/Adapter；移除继承的链配置。共享 `execution-fixture.json` 从链基础设施中分离站点身份和商业域，协调入口仍从原网络生成同一身份配置。复用原完整 Server/Agent/存储实验，不复制一套执行系统或改变生产准入。

本轮真实命令退出 0：两套 Server、独立 PostgreSQL 和真实 Kubernetes Agent 自动交换执行与商业原签名；重复委派保留一份工作流和两个 Job；目标从零材料开始拉取清单，产出 42 → verified:42，源站独立 Agent 实读校验 12 字节结果和 SHA-256，云盘版本、对端签名回执及重复导入断言通过。

账单与结算独立政策在任务提交前由双方通过 HTTP 分别授予。后台自动测量、交换报告、生成同文、批准并附签，两种政策双方各只批准一次；用量与实际 Pod 起止时间一致。原净额 1，后续两笔人工调整为 0、1，源方正差额占额生效，最终提供方预算分别为 99/0/1 → 100/0/0 → 99/0/1（available/reserved/spent），总额始终 100。原记录重复批准不改账，原账单/结算和完成作业不变。

所有阶段快照的市场/商业提交与尝试、存证 outbox/尝试/证据批次都为空；Server 启动源码亦只在显式 socket 配置下实例化对应客户端。无链路径没有调用 Orderer 控制或私有账本查询。全仓 lint/typecheck、Python 语法与离线文档链接检查通过；lint 仍为原有 47 warning / 1 info。共享测试调用方已核对，本轮未重复运行上轮已通过的真实 Fabric 完整场景。自建 Server、数据库、namespace 和临时身份已清理，私有证据仅在忽略目录保留。

未将真实科研软件安装、银行付款、正式登录/页面、直接模式全部故障边界或长期承载能力视为已通过。下一项继续异步存证的真实断链期间执行/账务及恢复补交，完整蓝图与 PR 预览目标不变。


## 异步存证真实 Orderer 中断与原待办补交

既有真实网络新增 bilateral_attested 选择，部署商业与证据链码及分离的 commercial/attestor 身份；复用第二链码端口和既有构建/lifecycle 过程，不部署市场链码或绕过 A/B 集合背书。接单证据域与商业域在测试夹具明确配置，运行时不临时修改集合或信任。首次启动发现测试端口仅按旧 gate 条件分配，已改为按第二链码是否存在分配；该失败发生在业务启动前，清理后重跑成功。

真实联合入口在 Server 启动前停止 Orderer，完成双方协议交换、提交前预授权账单/结算、材料拉取、两个 Kubernetes Job、12 字节 verified:42 文件回传与签名回执；随后自动用量/账单/结算、人工两次调整均成功，本地净额 1 → 0 → 1。此时七条商业提交仍 pending，提供方两条接单证据形成一个原签名批次和已背书检查点，未伪造链成功。

恢复 Orderer 后，七条原商业提交全部 committed，接单批次 anchored；源方合同实际有 INVALID 11 后同文恢复的历史，其他商业提交和批次一次 VALID。未调用人工重试、清租约、改时间或换业务 ID。逐项检查商业原意图、原批次正文/签名、交易检查点摘要、本地预算/预留/出站净额、账单/结算/调整、已完成 Job 不变，证据序号恰为 1、2。

新增独立 Node Gateway 证明读取 A/B/C 实际区块和私有写集：8 笔 VALID，各成员对应 8 份私有原记录、2 个接单证据索引、1 次序号更新及2次调整头更新；C 无私有写入。公开块未含原签名信封和正文盐值；链上不出现预算、预留或执行 gate 写入，补交不造成第二次扣费或第二套可花费余额。

最终全仓 lint/typecheck、Python 语法和离线文档链接检查通过；真实入口退出 0，测试 Server、数据库、namespace、Adapter、Peer 与 Orderer 已清理。lint 保留原有 47 warning / 1 info；本轮未重复协调/直接成功场景或重负载软件测试。受限私有证据留在忽略目录，不提交原签名、测试身份或日志。

这补齐排序服务中断的成功路径，不代表全部链组件断网、长期容量/归档、跨机构 Slurm/PBS 矩阵、支付/争议/解除占额、加密介质、治理迁移和正式 PR 预览完成。完整目标保持不变。

## 异步存证的接单积压上限

执行协议新增可选、无默认值的 `attestationLimits`，由双方签署执行次数、原预留额和最久等待上限，仅允许异步存证模式。提供方在原准入锁和事务内检查，旧请求重放在限额检查之前处理。按 reservation 去重，把本地未结算、接单凭证未 anchored，以及合同/用量/减免/账单/结算/调整未 committed 的关联尝试计入；needs_review 不释放容量，金额用原预留额与 BigInt。已结算旧任务的新调整使用新待办时间，避免把多年以前的作业日期当作刚产生凭证的年龄。SQL 通过 UUID 主键及等值连接关联原记录，避免逐任务与全部凭证作多条件比较。

超限返回不含私有统计的 `ATTESTATION_BACKLOG` / 503，源方原发送器保持同一签名和 operationId 重试，不延长原有效期。准入先检查新请求的协议授权，避免已过期请求被积压错误无限延后；已接请求仍可取回原回执。原回执恢复、既有任务收尾和补交入口不受新准入检查阻断；恢复 anchored 后可再次接单。查询复用提供方本机构 `agreement.read`、人工会话与 no-store。Web 条款核对显示签署上限，提供方详情显示当前数量/原预留额/最久等待及观测时间；无配置、无待办和加载失败分别显示，不把源方未知进度显示为零。

新增 7 项 PostgreSQL/HTTP 场景均通过；相关准入、协议、信任与存证回归以及原发送器重启恢复合计覆盖 53 个不同数据库场景。初次回归暴露测试共用已撤销证书，已改为独立机构和证书，信任测试整文件复跑通过。共享 schema 与真实 mTLS 发送器 15 项通过，Web 30 项通过；浏览器使用明确的测试响应，检查中英文、深浅主题、390px 手机及失败恢复共 5 张截图，没有页面异常或横向溢出。浏览器验证不等同真实登录/PR 预览；本轮没有重复运行已通过的真实 Fabric/Kubernetes 工作流。测试数据库、证书和页面服务均已清理，截图及过程日志仅保留于忽略目录。

此项不新增数据库迁移，不改写旧签名，不自动启用旧协议上限。全站跨 revision 容量、磁盘占用/增长监测、收尾空间预留、物理写满、私有历史恢复和旧链治理升级仍按完整蓝图待完成，O01 不标记整体通过，整体 PR 预览目标保持进行中。

全仓 lint/typecheck 与离线文档链接检查通过；lint 保持原有 47 warning / 1 info，文档检查覆盖 775 个本地目标。未启动或修改正式部署，尚未发布 PR 预览。

## 存储侧签名容量观测与接收委派保护

新增只读 observer，依据管理员在真实存储卷设置的绑定标识采样 `statfs` 字节与 inode，使用独立 Ed25519 密钥签署并原子发布报告。Server 通过显式私有策略校验本站身份、卷绑定、公钥、时间与阈值，未启用明确返回 disabled；启用后缺失/错卷/伪造/过期/压力均拒绝新 reservation，跨机构只返回 `STORAGE_PRESSURE` / 503。原回执恢复绕过新负载检查；采样 I/O 后再次核验授权与期限，不能延长已过期任务。运行中保留每卷已见时间，拒绝倒序报告，不将内存记录描述成跨副本持久反重放协议。

按模式配置必需卷，保证直接/异步合作可不依赖 Peer/Orderer 观测。基于平台联邦基础设施权限的管理 API 返回卷状态、阈值及观测时间，不返回路径和密钥；专用 Web 页面未接入。提供独立 Bun 打包入口、observer Dockerfile 与 Compose overlay，数据库卷只读挂到观察者，Server 只读报告目录。外部分离的 WAL/tablespace/节点卷需要逐项配置；远程报告同步和 Kubernetes 接线尚未实现。

验证覆盖 52 个模块/配置/运行时场景、25 个 PostgreSQL/HTTP 场景，及打包后的 CLI 真实进程发布。独立 mount namespace 中的 16 MiB tmpfs 实际写到 ENOSPC，验证签署状态为 pressure、新接单检查拒绝，清理自有填充文件后恢复，停止更新 2.1 秒后 stale 再次拒绝。未向正式数据库或 Peer 填盘，没有启动科学计算负载。临时数据库、私有密钥、填充文件和挂载已清理；本机无 Docker 命令，镜像构建/启动未执行，Compose 仅静态解析验证。全仓 lint/typecheck 和离线文档链接检查通过；lint 保持原有 47 warning / 1 info。

这是接收委派入口的容量观测与压力保护，不是全平台写入开关。源方新提交/市场等其他新增写入、实际磁盘缓冲、跨副本容量预留与增长预测仍待继续；阈值中的 completionHeadroomBytes 不是已分配的物理空间，也不能阻止外部写入抢占。没有据此宣称实际 PostgreSQL 写满后已接任务仍可收尾，O01 和完整目标均保持未完成。历史归档/恢复、治理迁移、物理介质、支付/争议、完整调度矩阵及真实 PR 预览继续保留在交付范围内。


## 源方、市场与商业预留的容量边界

沿用原签名观测，补齐 Server 的源方直接/异步出站、工作流首次委派、人工市场发布/认领、自动市场意图双向交换、独立商业预留提案和人工商业批准入口。没有新配置、依赖或数据库迁移。工作流在捕获文件/派生材料前预检，首次写入绑定前复检；容量不足进入 `STORAGE_WAITING`，保留原工作流等待机制。

协调模式把新负载检查放在本站首次接受意图的位置。后续步骤通过本站已保存的批准、提案或市场意图核对机构、协议、reservationId、完整提案和摘要，保持原认领/预留/批准/执行交接通道；同 ID 改内容不能豁免。接收端 I/O 后重查原证书、签名及政策有效期；人工商业批准在市场网络查询后的最终事务中再次检查。容量错误返回无私有明细的 503/no-store，原自动待办保持可重试，不消费新审批额度、不换编号、不因压力转人工复核。

验证覆盖 73 个不同的 PostgreSQL/HTTP 场景（包括 9 个新增场景及协调模式压力下的既有执行验证）。第一次市场测试少推进了一个交易检查点，补齐测试步骤后通过；回归发现重排源方检查后，并发请求可能在等待机构锁时错过另一事务写入，已在取得锁后再次核对原请求。协调模式三路并发、直接模式并发及预算守恒、丢回执重启恢复均通过。临时数据库已停止并删除，私有测试日志留在忽略目录。

这完成当前计算意图入口的容量接线，不等于文件上传限流、物理收尾缓冲或跨副本持久容量预算。没有重复运行已通过的真实 Fabric/Kubernetes 工作流，也未宣称真实数据库满盘时能完成任务。完整 O01、归档/恢复、治理迁移、完整调度矩阵、支付/争议、加密介质与正式 PR 预览目标继续保留，尚未合并或发布。

全仓 lint/typecheck（含 Fabric 脚本类型检查）与离线文档链接检查通过；lint 保持原有 47 warning / 1 info，文档检查覆盖 781 个本地目标。


## 物理收尾预留与真实 PostgreSQL 满盘恢复

新增可选 reserve controller，在管理员指定的真实数据文件系统私有目录，通过 Linux fallocate 分配非稀疏文件，核验大小/块数并 fsync。控制状态要求不同文件系统上的私有持久目录；低水位先持久保存 released 阻断标记，再删除日志中随机 allocationId 对应的自有普通单链接文件。中断后只继续完成释放；provision 不能悄悄恢复已释放预留，必须明确 restore。OS flock 提供进程互斥，活动锁返回 75，不使用 PID 推测或过期抢锁；常规 watch 不刷状态日志。

只读 observer 把预留状态放进原签名报告，Server 的可选 requiredCompletionReserve 校验 reserveId 与已分配字节；缺失、非 armed、不足或替换均阻止新接单。即便策略尚未配置预留下限，报告明确声明释放也不能视为健康。释放后可用容量虽增加，guard/Server 逻辑实例重建与普通磁盘清理都不解除标记；只有显式恢复并发布新观测后才可能接新任务。受限文件读取及原子发布抽到共用工具，旧权限/大小/符号链接检查保留。

独立 512 MiB ext4 loop 文件系统上运行真实 PostgreSQL 16 与项目迁移，通过生产 admission 保存请求，在签回执边界注入中断；填充文件真实触发 ENOSPC，数据库 INSERT 实际返回 SQLSTATE 53100。控制器释放 32 MiB 后保留填充文件、重启数据库，生产 completeReceipt 成功保存原接单回执，核验签名与原 operationId/reservationId；新请求仍拒绝，原预算没有重复消费。清理填充文件后仍拒绝，显式重新分配预留后下一笔请求成功。测试初次启动发现隔离 socket 目录权限不合适、后续新请求预算不足掩盖容量条件，均修正测试布置后完整通过。未对现有数据库填盘，临时数据库、挂载、镜像文件与测试密钥全部清理。

60 个模块/配置/发布测试通过，包含物理块、稀疏/符号链接/硬链接/损坏状态、释放与显式恢复、原分配恢复及打包后 CLI 并发/活动锁。观察者独立 Bun 打包通过；Compose 两份 overlay 仅做 YAML 静态解析，本机没有 Docker，未构建或启动镜像。新增物理预留 overlay 对数据库主体保持只读，只给 PGDATA 以外、同一文件系统上的专用预留目录写权限，避免进入数据库备份；观察者仍只读该目录，控制目录独立。没有新 npm 依赖或数据库迁移。

该联合实验验证一个原接单回执恢复，不代表完整科研作业/结果/取消、Peer 私有数据恢复或任意并发写入下都能收尾。预留大小尚未按跨副本未完成任务预算计账，采样窗口、外部写入、inode 和底层共享快照仍有边界；O01 与完整交付目标均保持未完成。正式 PR 预览、归档治理、完整调度矩阵、支付/争议、加密介质等既定范围保留，尚未合并或发布。

全仓 lint/typecheck（含 Fabric 脚本）与离线文档链接检查通过；lint 保持原有 47 warning / 1 info，文档检查覆盖 784 个本地目标。初次静态检查发现测试对联合返回类型未收窄，已补充状态存在性判断并复检通过。


## 跨副本数据库收尾预算（部分完成）

新增 [completion-capacity](../../../packages/server/src/federation/completion-capacity.ts) 与 Drizzle 生成的 [0146](../../../packages/db/migrations/0146_worried_swarm.sql)。同站点各 Server 副本、各协议 revision 共用持久策略与完整请求绑定的占额；工作流绑定、市场请求、提案、批准与正式接单沿用一笔任务占额，手工公开发布/认领另计。策略启用补计历史记录，拒绝漏算既有任务；策略修改保留每笔原分配字节。原任务不受新分配锁竞争影响，容量分配失败与业务落库一起回滚，物理报告读取后重验授权期限。

平台管理 API 可读写本地容量策略并记录审计。预算必须有健康的数据库物理预留报告支持，缺报告/配置的副本无法新接任务；副本争用可沿原 ID 重试。已有能力没有自动释放占额，也不提供按超时或作业状态强制清空的入口；历史完成任务仍保守计入，自动回收、增长预测、结果/取消完整满盘恢复和 O01 总验收仍待完成。此项保持可选，尚未应用到部署环境。

本轮隔离 PostgreSQL/HTTP 检查 **49 项通过**，包含两个独立数据库连接池的争用、首次启用与旧接收事务的竞争，以及已有占额不等待新接收锁。物理观测为受控测试报告，没有重复启动 Fabric/Kubernetes 或科学计算作业。
全仓 lint 无错误（原有 47 warning / 1 info），全仓 typecheck（含 Fabric 实验脚本）与 789 个本地文档目标检查通过。迁移只应用于隔离测试库。


## 收尾占额的后续写入保护

新增 Drizzle [0147](../../../packages/db/migrations/0147_icy_penance.sql)：保留已释放状态和原占额身份，未释放记录有独立索引。新增恢复占额事务，与账务调整、用量更正/接收、新账单/减免、输入/结果导入和取消的首次写入接通；原字节数不因策略调低而减少，身份冲突拒绝，失败同时回滚存储占额与资金预留。精确业务重放不重复占额，仍在占额的任务只锁自己的占额，不阻塞无关任务的新接收。用量同步因容量不足保留原游标重试，已修正误转人工复核的分支。

生产仍没有自动释放入口。测试中的已释放状态是受控夹具，用于验证未来释放后不会漏算新义务；没有据此宣称作业/结算一结束就能释放空间。自动释放的完整判据、扫描 worker、市场撤销及真实满盘完整任务联合验收继续保留在 O01 范围内。

本轮 **107 项不同的 PostgreSQL/HTTP 检查通过**：80 项更正、调整、同步、传输及取消相关检查，25 项账单/减免回归，新增 2 项账单恢复占额与已接意图在物理压力下发起取消的检查。只验证事务/接口和受控存储报告，未重跑真实集群或满盘实验。
全仓 lint 无错误（原有 47 warning / 1 info），最终全仓 typecheck（含 Fabric 实验脚本）与 791 个本地文档目标检查通过。迁移只应用于隔离测试库，未部署或合并。


### O01 已结算任务的自动占额回收

新增完成判据和 Drizzle 迁移 0148，由既有商业 worker 分批扫描。任务必须匹配双签账单和已应用结算，并完成关联执行、状态回执、取消、商业/接单存证、签名交换及文件收尾；市场发布/认领须有已提交的关闭记录。检查失败保留阻塞原因并退避，扫描跳过活跃占额锁；释放和审计同事务，不删除任何凭证、文件或物理预留。

补齐后启自动结算策略与执行停止的首次写入占额恢复，包括人工入口、源方取消、工作流取消、主 Server 与私有 Ingress。自动结算发现按候选独立提交，容量失败不留下新任务，也不阻止既有收尾推进。源方末次状态轮询和待交付停止意图加入阻塞判据。

75 个不同 PostgreSQL/HTTP 场景通过（12 个新增），包含审计写入失败后的事务回滚；使用隔离数据库并清理。全仓 lint/typecheck（含 Fabric 脚本）通过，lint 保持原有 47 warning / 1 info；离线文档检查覆盖 794 个本地目标。真实 Fabric、真实文件交付与完整满盘任务实验本轮未重复运行；数据库中受控 committed/文件状态不作为链或存储验收证据。早期意图保守保留，协调闭环、增长预测、远程观测/Kubernetes、Peer 恢复与治理迁移、完整调度矩阵、支付/争议、加密介质以及真实 PR 预览继续在完整交付范围内，O01 和整体目标保持未完成。

### 执行前释放后的市场关闭

修复双签 ReleaseExecution 已释放链上额度，但公开需求仍停在 CLAIMED、停止待办永久等待激活的问题。复用 CloseDemand 加入 REVOKED gate 分支：源方以当前 PDC 哈希证明私有门槛已撤销，把原认领关闭为 CLOSED，保留 activation=null；不重新开放、不替代 ACTIVE 任务的停止与 TERMINAL 凭证。商业 worker 从本地最新 VALID 原释放自动排入同 ID 关闭，并恢复旧提交遗漏的关闭；提供方不代替源方排队。停止 worker 核对完整原任务绑定后结束原停止交付。

迁移 0149 扩展原提交约束；原终态关闭和普通市场写入口保持原权限。新增关闭生成与提交前核验，历史 VALID 不依赖当前私钥或业务签名有效期。26 个模块与 15 个数据库场景通过；包括审计回滚、INVALID、原私有交易恢复、错绑关闭和机构隔离。新增真实网络专项参数，保留完整 gate 原验收入口。

本次不把公共 CLOSED 等同于所有本地义务已清理。早期任务容量、未批准提案关闭、直接模式未执行退款和预授权自动释放仍需继续；存储、治理、支付/争议、物理介质、完整调度矩阵和真实 PR 预览等总目标保持不变。


追加隔离真实 Fabric 专项通过：缺少 B 背书 INVALID、释放/激活两种提交顺序的 MVCC 冲突、A/C 对 REVOKED 公共关闭背书、重放和旧激活拒绝，共 4 项。未运行 k3s 或科学计算，所有自建进程和临时私有目录已清理。全仓 lint/typecheck（含脚本）通过，保留原有 47 warning / 1 info；离线文档链接通过。真实网络只覆盖新增链码路径，不扩大为完整 Server/Agent 或 O01 验收。

### 执行前释放的本地占额回收与重试封锁

接通协调模式无账单任务的回收判据，复用已有私有释放 VALID 证据，不生成账单或删除历史。提供方可依据自己的已提交释放回收任务及手工认领占额，源方还须等待同一释放对应的公共关闭 VALID。任务摘要、双方签名字节及原预留必须一致；正式接单/出站、账单、活动父工作流、签名交换、市场/提案待办、自动执行租约和停止交付继续阻止回收，未知或不唯一的释放不推测成功。

双签释放后封住自动发现、自动执行授权和人工重试；已排队任务先退出自动执行，再允许回收。签名交换的发现与签名附加改为事务内互斥，避免关闭后补入旧待办。另一个 releaseId 不能重复取得双签释放，同一释放精确重放返回原结果。发现时逐笔保留授权拒绝原因，不因单笔失效阻断整轮；账本前置凭证不足保持等待。

隔离 PostgreSQL 回归覆盖 75 个不同场景，新增 6 个。首次回归发现同一预留的并发自动激活存在共享锁升级死锁，改为直接锁定原批准行后，对受影响的 19 项重跑全部通过，其余 56 项沿用本轮已通过结果。覆盖双方不同回收时机、停止待办、INVALID/错绑证据、释放后发现/重试、重复释放、签名附加竞争及既有容量回收。没有新增迁移或依赖；临时数据库已停止并清理。

全仓 lint 无错误（保留原有 47 warning / 1 info），全仓 typecheck（含 protobuf 生成及 Fabric 脚本）通过；离线文档链接检查覆盖 799 个本地目标。

这仍是数据库与链适配替身验证，未重复运行真实 Fabric/Kubernetes/科学作业，也未部署或合并。真实链与本地回收联合验证、未获双签提案关闭、直接模式未执行退款、预授权自动释放，以及完整 O01/治理/存储/调度/支付/介质交付仍未完成。

### 执行前回收的真实 Fabric 联合验证

复用已有 gate 网络，增加 `--gate --preexecution-closure --database` 专项组合，保留完整 gate 恢复矩阵。原数据库验收会在私有释放新建公共关闭后直接检查下一笔激活；本次先完整消费关闭，避免两笔不同市场事务混用检查点。

隔离 Fabric 3.1.5 的 A/B 商业身份各自通过生产 Node Adapter 提交，A 使用独立市场身份。生产商业服务记录原双签预留和释放，提供方在本地私有释放 VALID 后从 100 回收至 20 个测试字节；源方仍保持 100。公共关闭实际 VALID 后故意丢弃响应，本地保持 pending 与 100；重建市场服务等待原退避，使用原 txId 确认后才降至 20，原市场 CLOSED 且 activation=null，旧激活被拒绝。余下 20 为另一笔未完成市场意图，不能随本任务清空。

4 项原生链安全条件和 1 项新增 Server/Adapter/PostgreSQL 回收联合检查通过。测试使用同一隔离数据库中的不同站点记录，物理容量观测仍为受控报告；不宣称已覆盖独立部署双 Server、Agent、磁盘满载、完整 O01 或全部交付。临时数据库、Peer/Orderer/Adapter、私钥和账本已清理，仅保留忽略目录内的脱敏通过记录。完整验收范围及 PR 预览目标不变。

全仓 lint/typecheck（含 Fabric 脚本）通过，lint 保持原有 47 warning / 1 info；离线文档链接检查通过，覆盖 801 个本地目标。未改链码、数据库迁移或依赖，未重跑无关调度器或科学计算测试。

### 未锁额认领的原子关闭

新增 `close-unreserved-demand` 公开操作和 `unreservedClosure` 状态，保留原认领且不重新开放。发布方/认领方之一可关闭尚无私有 gate 的原任务；Commercial 的 `GetExecutionGatePresence` 只对已配置域返回明确缺失，未知域或错误不冒充 absence。Market 在同通道读取原 gate 的哈希存在性，与公开 CLOSED 写入共同进入原生 MVCC，已有 READY/REVOKED/TERMINAL 均继续使用原释放/终态流程。

Node Adapter、Server 原持久市场提交/API 与重试接通。源方核对本组织原发布及 publish 权限，提供方核对本组织原认领、商业域、版本及 claim 权限；同原意图并发去重，另换 closureId 拒绝，未知交易不换编号。新关闭待办锁定原市场占额，已释放记录拒绝新写入。原 CancelOpenDemand 因认领竞争失效不阻止后续正确关闭。修正市场人工重试未等待异步校验的问题，校验失败不再先排入重试。数据库约束由 Drizzle 生成迁移 0150，未手写迁移或新增依赖。

71 项链码/Adapter 模块、13 项市场 PostgreSQL、2 项原停止/激活重试回归通过。最后调整撤回与关闭的衔接后，仅重跑受影响的 1 项源方用例通过。真实 Fabric 3.1.5 专项另验证两种顺序：提供方经 A/C 背书先关闭，原并发私有预留 INVALID；私有预留先 VALID，缺失哈希读冲突使关闭 INVALID。原关闭可重放，非参与方及迟到锁额被拒绝。所有临时进程、数据库、私钥与账本清理，只留脱敏报告。

这补齐了未预留认领的权威关闭事实，尚未据此自动结束本地提案/签名交换队列或回收任务占额，也未完成 Web 操作、自动工作流取消编排及独立 Server/Agent 联合验收。现有任务预算继续保留，不将本项误报为 O01、L06/L07 或整套联盟链交付完成；完整 PR 预览目标继续推进。

全仓 lint/typecheck（含 Fabric 脚本）通过，lint 保持原有 47 warning / 1 info；离线文档链接检查覆盖 803 个本地目标。迁移仅应用于隔离测试库，未部署或合并。


### 未锁额关闭的本地持久确认与队列终止

新增 [unreserved-closure](../../../packages/server/src/federation/unreserved-closure.ts) 与 Drizzle [0151](../../../packages/db/migrations/0151_secret_ultimatum.sql)。商业 worker 按原本地发布/认领逐笔轮询本站受信任的 Adapter，核对完整身份与摘要，保存任意一方发起的最终关闭及审计。查询期间不占数据库事务，观测写入与同需求的新义务写入通过事务锁互斥；网络返回后重验原意图，缺失/异常不能被解释为关闭。

确认后，本地待办分批转为 closed 并保留签名字节和回执：未完成市场请求、提案、自动执行及预留/释放签名交换不再进入后台队列。活跃租约不被抢占，迟到批准/附签重新校验；发现过程跳过关闭需求，人工重试不能重新开放。已完成的市场请求和签名交换保留其原状态。停止 worker 接受严格绑定的未锁额关闭，结束原停止交付而不等待激活。市场和商业交易检查点在结果未知时仍按原交易恢复，只有需要新提案的路径拒绝重试。

此项没有删除原业务记录或收回累计预授权，收尾占额仍保持分配。后续还需确认未决链提交的收尾判据并接通早期任务占额回收；直接模式退款、自动取消编排、Web/CLI 市场操作及完整 O01/治理/存储/调度/支付/介质和 PR 预览目标均保留。


本轮新增 12 个数据库用例已通过，并运行相关的提案、预授权、签名交换、市场请求、自动执行、停止与既有释放回收回归。首次新增检查拒绝了旧夹具的占位摘要，已为新用例改用真实摘要，并补齐新外键的隔离库清理顺序；生产校验未放宽。覆盖双方独立观测、错绑与断网、审计回滚、原意图网络后变更、事务锁竞争、迟到批准、活跃/过期租约、未知原交易恢复以及关闭后的释放签名。所有自建 PostgreSQL 数据和进程已清理，未重复运行未修改的真实 Fabric 或科学计算作业。迁移仅用于隔离测试库，尚未部署或合并。

全仓 lint/typecheck（含 protobuf 生成与 Fabric 脚本）通过；最后权限检查顺序调整后补充 Server 类型检查及两个受影响数据库用例通过。lint 保持原有 47 warning / 1 info；离线文档检查覆盖 806 个本地目标。没有新增依赖，完整交付目标仍保持进行中。

### 未锁额关闭后的本地占额回收

接通 [未锁额回收判据](../../../packages/server/src/federation/completion-unreserved.ts) 与 [原提交退役](../../../packages/server/src/federation/unreserved-ledger.ts)，由原商业 worker 执行。双方各自依据本站受信任 Adapter 保存的关闭事实，核对原市场意图、任务、商业域、摘要和签名字节；关联队列、停止交付、父工作流及租约全部收尾后，才能释放本地逻辑容量。矛盾私有提交、已正式接单、账单或终态证据保持阻断，不按年龄推断结束。

未广播的 proposal 保留原交易编号和恢复字节并标 abandoned；安全结束的提交转 closed，退役与审计同事务。未知 transaction 必须按原 txId 恢复，不能借关闭提前抹去。已保存 committed 但进程未清理租约的记录，仅在租约到期后清理租约，成功状态及交易证据不变。新市场意图被关闭事实拦截，同原意图精确重放保留原结果。原任务新增写入共享占额行锁，回收持排他锁并跳过活动写入；Drizzle 生成 [0152](../../../packages/db/migrations/0152_next_quasimodo.sql)，没有新增依赖。

新增 11 个数据库场景通过，覆盖提案退役、未知原交易、损坏或矛盾证据、活动工作流、审计失败回滚、活跃/过期租约及并发写入保护；相关市场、商业与容量回归通过。首次回归中一个新增断言误用了仅列合同登记的查询接口，修正测试后通过，未扩展无关接口。隔离 PostgreSQL 均已停止清理。

真实 Fabric 3.1.5 的 `--gate --preexecution-closure --database` 组合共 6 项通过。新增提供方独立 Market Adapter：A 准备私有交易但未提交，B 的未锁额关闭实际 VALID，双方分别观测；B 退役未广播提交后回收，A 在原交易未知时保留 80 个测试字节。A 使用原 txId 恢复得到 MVCC INVALID（11），再退役并回收到零，迟到批准拒绝。保留原有双签释放、公共关闭丢响应恢复的联合场景。临时 Peer、Orderer、Adapter、数据库、私钥和账本全部清理。

实验仍是同一数据库内的独立站点记录，容量观测为受控报告，未覆盖独立部署 Server/Agent、真实磁盘满载或完整 O01；未修改链码，不重复未变化的科学计算与调度器测试。资金退款、累计预授权回收、工作流取消编排、Web/CLI 市场操作及完整治理、存储、调度、支付、介质和 PR 预览验收继续保留，整体目标未完成。

全仓 lint/typecheck（含 protobuf 生成与 Fabric 脚本）通过；最后补充过期租约处理后，Server 与 Fabric 脚本类型检查、全仓 lint 均通过。lint 保持原有 47 warning / 1 info；离线文档链接检查覆盖 812 个本地目标。迁移仅应用于隔离测试数据库，尚未部署或合并。

### 直接合作的执行前取消退款

新增独立 `commercial-refund` 协议、[退款服务](../../../packages/server/src/federation/refund.ts)、人工 HTTP API 与 Drizzle [0153](../../../packages/db/migrations/0153_worried_bloodscream.sql)。固定原任务、合同摘要及提供方签名取消回执，双方分别使用 settlement.approve 与明确的新密钥用途签署。提供方在与接单/最终准备相同的协议锁内重查永久取消、原预留、零关联 Workflow 和清理状态；源方重查原出站与停止回执。不把 stopped 解释成零费用，不生成虚构用量。

本站双签后只归还一次原预留金额，金额以 BigInt 计算，预算、签名、已应用标记和审计同事务；原任务/接单/签名/取消防线保留。没有接单的取消不增加提供方预算；原接单重放仍返回原编号。退款首次写入接入收尾占额，后启容量策略补计没有原接单的退款记录；资金归还不自动回收存储预算。新增密钥用途同步提供中英文平台管理标签。

10 个新增 PostgreSQL/HTTP 场景通过，覆盖两种接单时机、超安全整数金额、并发附签及重启幂等、换编号拒绝、财务权限/密钥用途、历史已创建工作流、篡改身份/金额/签名正文、未确认取消、审计回滚、人工会话与 no-store、未接通模式明确拒绝，以及历史退款容量补计。另有 12 个容量回归通过。接单使用生产 admission；取消凭证为真实业务签名的受控数据库夹具，不能当作独立双站点取消/退款联合验收。自建 PostgreSQL 已停止清理。

本轮接通直接模式人工批准与附签，未接自动交换/预授权、退款 Web/CLI、异步私有存证及退款后的容量回收；异步模式仍拒绝该入口，协调模式沿原释放/终态结算。未运行未改动的 Fabric/调度器/科研软件，未发布或合并。独立站点、完整 O01、治理/归档/支付/争议/物理介质及 PR 预览等完整交付目标保持进行中。

相关 26 个共享协议回归和 1 个 Web 签署用途/中英文完整性检查通过。新增用途后将允许列表上限同步为 41；发现旧市场协议测试把用途总数固定为历史的 36，去掉该陈旧数量断言，保留必需用途存在性与完整目录可解析的校验，受影响用例复检通过。全仓 lint 无错误（原有 47 warning / 1 info）。全仓 typecheck 首次仅发现新增测试的可空断言，补充存在性检查后 Server 与 Fabric 脚本复检通过，其他包沿用本轮已通过结果；包含 protobuf 生成。离线文档检查覆盖 817 个本地目标。


### 退款原签名自动交换与异步私有存证

已批准退款加入原机构签名交换通道，使用独立 refund 记录种类，核对合同摘要、完整任务及机构身份；只传原签名，不替代双方审批。自动附签复查交换租约并与退款同事务提交，旧响应不能越过已过期租约。新增 Drizzle [0154](../../../packages/db/migrations/0154_rainy_masked_marvel.sql) 扩展交换和提交约束。

异步提供方在本地额度归还事务中持久写入 record-refund；断链继续本地退款，待办保存失败整体回滚。原提交 worker 复用检查点、交易恢复和 MVCC 对账，提交前重查本地原双签与已应用记录；链确认不再改变额度。退款列表提供可空 ledger 状态及原提交编号，积压统计包含未完成退款凭证。

商业链码与 Adapter 验证显式 commercial-refund 和 cancellation-receipt 用途，仅允许异步模式、双方组织背书。私有写入限制为 refund/refund-head/refund-operation；不产生链上预算或 gate。与首次用量/账单共享任务索引，重复编号、换编号和矛盾先后提交均受保护。旧链 trust 迁移仍未实现，不能把本次新建网络验证当作旧链升级验证。

链码及 Adapter 整文件 59 项通过；新增/相关数据库首次运行 29 通过、1 个夹具失败，原因是测试把接单待办置 anchored 却没有相应批次。修正为在该夹具隔离独立接单队列后，受影响用例通过，另运行完整接单存证 10 项回归。最新列表/交换验证 3 项、Adapter 2 项、共享协议 2 项通过。数据库验证覆盖独立批准等待、丢响应恢复、租约过期、断链持久退款、不重复记账及待办插入失败回滚；不声称该退款夹具完成了接单凭证上链。

真实 Fabric 3.1.5 原生商业验收共 14 项通过，新增两种退款/用量提交顺序的 MVCC INVALID（11）、原退款重放、换编号拒绝、私有写入范围及 A/B 可读而 C 不可读检查。临时网络目录、进程与私钥/账本均已清理；没有重复调度器或科学计算测试。本轮仍未完成退款独立双站点 Server/Adapter/数据库联合验收、机构预授权、Web/CLI 与容量回收；整体交付及 PR 预览目标继续保留。

全仓 lint/typecheck（含 protobuf 生成和 Fabric 脚本）通过，lint 保持既有 47 warning / 1 info；本轮变更文档离线目标检查通过。迁移仅应用于隔离测试库，尚未部署或合并。


### 双边退款后的收尾容量回收

沿用 [completion-readiness](../../../packages/server/src/federation/completion-readiness.ts) 和原商业 worker，将已应用的双签退款作为独立收尾依据，复用原文件、父工作流、签名交换和租约检查。核对原请求及两种摘要口径（签名原文与规范化任务占额）；单签、损坏身份、矛盾用量/账单、未确认永久取消均保留占额。提供方从未创建执行工作流且原预留已归还才可回收；取消先于接单不要求虚构预留。异步提供方还须有原退款提交的最新 VALID 和区块号，单独改 committed 状态不足以回收。无需新表或迁移，不删除原证据、不重复退款。

新增数据库用例暴露了实际的无期限状态轮询：执行前退款没有终态 Workflow，原 status worker 永远等待运行终态。现由退款事务同时清除源方 statusClaim、statusNextAttemptAt 和 statusLastError，原已验证观察保留；正在返回的轮询成功/错误都不能重新写回排队。通过真实生产查询路径注入网络延迟与断线验证，未放宽取消或财务授权。

8 个新场景全部通过，覆盖接单前/后双边回收、单签等待、交换/租约收尾、异步原尝试确认与接单存证独立等待、损坏身份/取消确认、审计失败回滚、并发行锁和两类迟到轮询。首次新增检查修正了将签名原文摘要误当成规范化摘要的实现；一次测试夹具直接改 complete 触发原交换约束，改为调用生产交换 worker 后通过，没有放宽数据库约束。另有原容量 12 项、商业容量 4 项、执行前释放/未锁额关闭 12 项及原结算回收 9 项回归通过；只复检受失败或新增改动影响的范围。

异步回收测试使用隔离 PostgreSQL 与 Adapter 替身；先明确检查接单存证未完成仍阻断，再在夹具中隔离该队列，不声称接单凭证已上链。前文真实 Fabric 验证沿用本轮已通过结果，链码未改，不重复运行科研软件或调度器。本轮未完成退款独立多站点/真实满盘验收、退款预授权与 Web/CLI，整体治理/归档/支付/争议/物理介质、完整集群矩阵和 PR 预览目标继续保留。

补充迟到接单回执的收尾：接单返回事务依据当前行的已确认取消和零净扣用额，保留原回执但不重新启动轮询。原有延迟接单用例扩展为未退款/已退款两种情形，2 项通过；不是丢弃迟到接单证据。全仓类型检查发现新增测试容器的隐式 any，已显式声明数组元素类型，Server 和 Fabric 脚本最终复检通过，其余包沿用本轮通过结果（含 protobuf 生成）。最终全仓 lint 无错误，保留原有 47 warning / 1 info；422 个文档本地目标及 diff 空白检查通过。隔离数据库已停止并清理；无新迁移，尚未部署或合并。


### 退款 Web 与 CLI 管理入口

[退款面板](../../../packages/web/src/components/federation/CommercialRefundPanel.tsx) 接入现有合同详情，源方按原委派生成草稿，双方导入同文后独立确认。金额、原因、签署、本站记账与链状态分别展示；提供方存证失败可重试原 submission，源方不把本地退款当作对端链确认。沿用 settlement.approve、机构/登录作用域和手机只读；确认关闭恢复焦点，权限撤销后的迟到草稿不会重新开放审批。没有添加重复刷新控件或新的样式体系。

共享新增退款草稿、批准响应和列表 schema；原 GET 接口支持 recordId 精确筛选，仍限定本机构、本地站点和原合同。CLI 复用既有命令结构添加 refunds draft/approve/attach/list，固定原编号与原因，不覆盖私有原文文件；核对完整合同与请求范围、签名字节及响应身份，不改变退款协议或数据库 schema。

CLI 命令文件 32 项通过，新增实际 CLI 子进程、loopback HTTP、生产退款路由与隔离 PostgreSQL 联调：草稿不批准、同文签署、原签名保持、全额归还、原编号/不存在编号过滤、重放与机构/权限变化。人类身份由测试中间件注入，对端批准调用生产服务，取消事实为已签夹具，不能当作正式登录或独立多站点取消流程。

退款/合同组件已覆盖权限、精确金额、两种模式、源方链状态缺失、跨机构和原文错配、未知响应与原编号跳转。真实 Chromium 以 1440px/390px 渲染中文列表/详情/批准、手机只读和英文源方状态共 5 张截图，未发现脚本错误或横向溢出，键盘确认关闭恢复原触发控件。截图与夹具仅保存在本地 temp/refund-ui；不冒充 PR 预览或真实业务数据。初次浏览器选择器误把含日期的状态当作独立文本，修正选择器后完整通过；组件首轮仅修正了与既有文案不符的测试选择器。

本轮没有重复未变化的 Fabric、调度器或科学计算验证。机构自动退款政策、独立双站点/满盘收尾、完整部署治理归档与正式 PR 预览仍属完整目标，未标记交付完成。

退款组件 19 项与合同页 42 项通过；新增存证重试用例核对仅提交原 submission，权限撤销期间的迟到草稿检查通过。中英文实际文字对比度最低分别为 4.80:1 与 6.46:1；原文原因采用现有 prose 宽度约 579px。全仓 lint/typecheck（含 protobuf 生成、Fabric 脚本）通过，最后界面改动及测试另有 Web 类型复检；lint 保持既有 47 warning / 1 info。418 个本地文档目标检查通过。隔离数据库、CLI 测试服务、Chromium 和本轮 Vite 已停止清理；没有新迁移，尚未发布或合并。


### 独立双平台取消退款与断链进程恢复

在原 [双平台验收脚本](../../../deploy/federation/execution-lab.md#执行前取消与退款验收) 增加 `refund`，复用两个独立 Server/PostgreSQL 数据库、真实 mTLS 和生产后台，不另造取消或退款夹具。协议交换后暂停源方自建入口，提供方接单占额并进入真实 DATA_WAITING；源方通过 HTTP 取消，收到提供方永久停止签名回执后恢复入口。双方通过 HTTP 独立批准同一退款，生产后台交换原签名并各自应用，随后重放批准/附签及更换编号检查。没有创建 Workflow 或 Job，没有虚构用量和零账单。

直接模式完整通过：双方各一份退款，提供方预算由 99/1/0 回到 100/0/0，源方只有原出站零净额，没有复制可花费余额；所有链待办/尝试为空。异步模式在 Server 启动前停 Orderer，本地退款仍完成，原存证持久 pending；合同与接单存证已有背书检查点后，强制结束两端 Server 和商业 Adapter，再用原数据库/密钥启动。恢复 Orderer 后双方合同及提供方原退款共三条商业提交 VALID，两条接单证据在同一原批次上链；原编号、恢复检查点、签名、已应用时间、本地余额和零作业状态不变。独立 Gateway 从 A/B/C 读取四笔实际交易及 PDC：A/B 各四份原件和两个退款索引，C 没有私有原件/索引，公共块不含原文或携带商业正文的 JWS，链上没有预算/预留/gate 写入。

首轮测试准备误用源方缺少材料触发等待，生产准入正确拒绝；改为暂停源方材料入口，源方仍保有提交所需材料。随后修正测试网关正常退出码，并补齐原测试配置缺少的提供方 cancellation/cancellation-receipt 及双方 commercial-refund 用途；没有放宽生产权限。两个模式均以完整入口退出 0 为通过依据，临时 Server、Agent、存储、数据库、namespace 和成功测试链均已清理。

异步实测额外发现执行协议签名交换偶发 INVALID_MESSAGE：分别读取两次时钟生成起止时间，使一分钟窗口跨毫秒后超限。检查同类调用后修复执行协议与终态交换两处，统一从一次取时推导到期时间，保留原一分钟与租约约束。两个确定性回归在旧代码下均失败，修复后协议交换整文件 14 项、终态交换 12 项通过。真实异步场景随后完整通过；测试脚本也会在交换进入 needs_review 时立即报告错误，避免盲等超时。既有复核记录仍须按权限核对原因并重试，不批量改状态。

这是同一主机内的独立服务/数据库验收，不等于跨主机机构信任或正式登录。未重复已通过的直接场景、科研软件、Slurm/PBS 或未改动的链码模块检查；机构自动退款政策、完整满盘/容量回收、治理/归档/代际迁移、支付/争议/物理介质与完整集群矩阵继续保留。PR 预览尚未发布，完整交付目标保持进行中。没有新增依赖或数据库迁移。

全仓 lint/typecheck（含 protobuf 生成及 Fabric 验收脚本）通过，lint 保持既有 47 warning / 1 info；828 个本地文档目标和 diff 空白检查通过。过程日志与签名证据仅保存在忽略的私有 temp 目录；首轮失败留下的自建 Fabric 网络、私钥及账本也已清理。尚未推送、发布预览或合并。


### 机构自动退款策略与原收尾通道

复用 closing policies/tasks 扩展 refund；只允许 direct/attested 永久取消且从未创建执行工作流的任务。双方独立授予 settlement.approve 下的有限政策，源方自动发现并发起，提供方验证自己的政策和取消原件；原账单/结算授权不扩权。批准原件保留 authorizationPolicyId，人工为 null，政策计数/精确金额、任务引用、签名和审计同事务；已有签名沿用且不重复消费政策。未完成源方退款任务纳入原容量回收判据。迁移 [0155](../../../packages/db/migrations/0155_blue_hitman.sql) 由 Drizzle 生成，隔离 PostgreSQL 从空库迁移通过。

新增自动退款数据库 14 项通过，覆盖双方独立授权、direct/attested、未接单不加提供方余额、财务权限/模式/结果范围、机构授权与个人权限分离、签名用途撤销、单笔/累计/次数限额、取消未完成、到期回滚、原人工批准复用、丢响应和撤销后重放、租约失效、收尾占额、审计失败回滚及显式替代政策恢复。原 bill/settlement 相关政策/收尾自动化 27 项回归通过。最初 3 个失败分别为测试漏导入丢响应异常及取消未完成的错误码预期不符，修正测试后受影响范围通过，没有降低生产校验。

Web/CLI 已支持退款政策及原任务重试，退款固定取消条件，链协调无入口；详情显示原策略编号，源方从处理历史按 refundId 打开原件。组件 80 项通过，另补父页面原编号导航及财务/手机权限 5 项通过；CLI 文件初轮 30 通过，退款夹具补可空授权编号且修正 retry 模拟合同读取后，受影响 5 项通过。后续仅运行变更范围，不重跑未改动科研软件或调度器矩阵。

新增 refund-auto 真实场景，保留原 refund 人工批准场景。直接模式已通过两套独立 Server/数据库、真实 mTLS：委派前 HTTP 各自授予政策，材料等待时取消，生产 worker 自行生成并双签退款，无手工退款草稿/批准/附签调用。双方各消费一次政策；源方任务完成，撤销后完成任务拒绝重试、原件/金额不变，没有 Workflow/Job 或链待办。异步模式也完整通过：Orderer 预先停止仍自动退款，强制中断两端 Server/商业 Adapter 后原数据库和密钥恢复；双方合同与提供方退款共三条原商业提交 VALID，两条接单证据随原批次 anchored。原本地账目、签名、授权引用、应用时间与恢复检查点不变。独立 Gateway 读取实际四笔区块交易，A/B 各四份私有原件与两个退款索引，C 无私有正文/索引，链上没有预算或许可写入。两个场景均已清理自建服务/数据库/namespace/临时身份；完整 PR 预览尚未发布。


本轮全仓 lint 通过，保持既有 47 warning / 1 info；离线文档链接 833 个目标通过。没有新增依赖、修改链码或重跑已通过的手工退款/科研软件矩阵。真实证据保存在受限忽略目录：直接 refund-auto 为 temp/federation-execution-direct-1cdiwydx，异步为 temp/federation-execution-attested-jsev8ntm；不上传原签名或实验凭据。完整任务/结果/取消满盘恢复、Slurm/PBS 联邦矩阵、治理/归档/代际迁移、支付/争议/物理介质与正式登录/PR 预览继续保留，未将整体目标标记完成。


最终类型检查发现 CLI 原策略/任务列表缺少 refund 的中英文标签，已补齐；新增两种语言的列表回归均通过。其余包首轮类型检查通过；修复后完整 bun run typecheck 通过（含 protobuf 生成及 Fabric 验收脚本），最终 lint 通过且保持既有告警。未因此重跑真实网络验收。


### 取消退款与物理满盘的双平台联合恢复

在原双平台实验增加显式 `KQ_FEDERATION_LAB_DISK_PRESSURE=1`，仅用于 refund-auto，不影响默认场景。私有 mount namespace 挂载自建 1 GiB ext4，两个独立数据库位于同一 PostgreSQL 实例，数据与 WAL 共用实验卷。两站通过生产服务配置各自 64 MiB 物理预留、每任务 16 MiB 逻辑收尾预算，真实 observer 持续签署报告，原 Server 加载 guard 并运行回收 worker。配置、日志、观测报告在实验卷外。

直接模式通过：材料等待时暂停提供方网关，源方 HTTP 持久化取消；强制结束两端 Server，在实验卷真实写满至 ENOSPC，隔离 SQL 探针产生 53100。通过生产 reserve CLI 显式释放两份预留，立即停止并重启原数据库与 Server，网关恢复后继续原取消、自动退款与一次性占额回收；填充文件一直保留到收尾完成。原取消签名摘要、task identity、请求摘要、分配字节不变。新 HTTP 委派返回 503/STORAGE_PRESSURE，删除填充文件仍拒绝，明确 restore 后预留 armed、guard 健康。没有创建 Workflow 或 Job。

异步模式也通过同一故障链，且 Orderer 在 Server 启动前停止。本地退款成功后，生产扫描明确记录 refund-ledger 并保留提供方 16 MiB 占额。两端 Server 与商业 Adapter 再次强制退出，以原数据库/密钥恢复，补交三条原商业记录和两条原接单证据；全部 VALID 后才回收。真实 Gateway 核对四笔实际交易，A/B 各四份原件、两个退款索引，C 无私有正文；原金额、签名、恢复检查点不变。

首轮测试把取消初始 queued 误写为 pending，按现有接口修正。第二轮已触发真实满盘，但恢复脚本漏带原 PostgreSQL 端口/socket 参数；统一初次启动与恢复函数后通过，并把 PostgreSQL 私有日志纳入清理前留存。这两处均属测试编排修正，没有放宽业务校验。成功的直接证据在 temp/federation-execution-direct-l8gqg44h，异步在 temp/federation-execution-attested-khol_3y4；失败两轮也完整清理。最后成功入口均退出 0，停止所有自建 observer/服务/数据库、卸载磁盘、删除镜像和 namespace，Fabric 网络同样清理。

本轮新增真实验收接线，没有业务数据库迁移或生产业务逻辑修改，不重复未变化的单测和非压力网络矩阵。实际错误由隔离探针表触发，Server 在注入时已中断；仍不覆盖每个业务 SQL 失败位置、运行中任务、结果正文、独立 WAL/Peer 卷、自动 reserve controller 或跨主机部署。O01、Slurm/PBS 联邦矩阵、治理/归档/代际迁移、支付/争议/物理介质与正式登录/PR 预览继续保留，整体目标未完成。

全仓 lint 与完整 typecheck（含 protobuf 生成和 Fabric 验收脚本）通过；lint 保持原有 47 warning / 1 info，836 个离线文档目标及 diff 空白检查通过。没有发布或合并，PR 预览仍待完整目标完成后验收。


### 加密介质包的签名、流式归档与真实 age 底层

新增 `media-manifest` 专用签署用途，贯通共享 schema、信任配置、数据库 JSON 类型和中英文用途标签；数据库 SQL 结构不变，无迁移。清单覆盖不可变数据集、任务输入及任务结果引用，逐文件保留 SHA-256、大小、许可证及 provenance，缺失字段显式 null。现有签名验证仍检查当前可信密钥、有效期和撤销，增加来源/接收机构核对；浏览器公共 schema 不引入 Node 加密实现。

Agent 增加受管目录流式 tar 导出与隔离区导入。归档只接受固定编号普通文件头和精确清单，拒绝路径覆盖、链接、特殊类型、头部/大小偏差、非零 padding、尾随文件或数据。文件读取、写入和摘要均分块执行；预检本地限额、可用块及 inode，写入错误/取消/最终流认证失败清理本次隔离子目录。大文件使用标准 GNU base-256 大小字段，Python tarfile 独立解析 1 TiB 头成功，没有生成 TB 数据。

age 固定官方 1.3.2，核对 GitHub release 发布资产 SHA-256 后记录 Linux amd64/arm64 归档与可执行文件 pin；运行时核对本地二进制并执行原文件描述符。未新增 npm 依赖或运行时自动下载。私钥走标准输入，密文文件通过继承文件描述符读取；本机临时文件只保存随机包公钥。最初尝试额外 Node stdio 管道时，Linux socket 描述符不能由 age 按普通文件打开，真实试跑暴露 EPIPE；已改为标准输入传私钥，不放宽密钥隔离规则。

针对性 schema/归档 9 项通过；签名 helper 保持在服务端 signatures 入口后，相关共享联邦回归及真实 age 2 项共 49 项通过，另补运行中取消 1 项通过。共 57 项不同测试通过，其中本轮新增 12 项。真实测试使用独立 X25519 包身份与 RSA 签名、256 KiB 合成数据，覆盖加密后清单不可见、往返隔离导入、错误密钥、末尾认证损坏、截断和可执行文件篡改。新空间估算改为逐项 BigInt 相加后，仅补跑受影响的超额/空间测试通过。

全仓 lint 通过，保持既有 47 warning / 1 info。全仓类型检查首轮只有新增 Agent 子进程管道 nullable 与字节缓冲类型错误，其余包和 protobuf 生成通过；修正后 Agent 及首轮未执行到的 Fabric 验收脚本类型检查均通过，没有重跑其他已通过包。839 个离线文档目标通过。没有重跑已通过的取消退款、满盘或科研调度器网络实验，没有启动新的 Server/数据库/集群任务。真实工具只在本机缓存安装，未部署生产或 PR 预览。

这是后续交付服务的底层，尚无 Server 交付单/密钥授权通道、Agent 操作入口、原子副本发布、导入回执和生命周期记录，也不自动解除 DATA_WAITING。详细格式、版本 pin、验收入口和限制见[介质包实现边界](media-package.md)。W07/W08、付款争议、治理归档/Peer 恢复、完整集群矩阵和 PR 预览仍未完成，整体目标保持进行中。


### Server 介质包登记与接收方本地批准

确认现有 Data Market 通用 createReplica 仍是未配置的 501 入口，没有把它当作已实现的物理介质协调器。本轮把接收方签名包库存与独立本地批准接到真实 Server API：包清单在本站/当前组织范围内不可变登记，同编号只允许原清单重放，保留最初签名和显式缺失 provenance/许可证；登记不发布 dataLocations，也不授予数据使用权。

新增独立 media.import 权限，用于批准/撤销具体 Agent 与受管目录的导入，带字节上限和最长 7 天有效期；asset.map 仍管理材料元数据，包括包登记/撤销，asset.read 查询原件。本地授权每次使用前重查原批准人的成员/权限状态、合作协议、双方站点、来源密钥及签署用途、目录启用和 Agent/目录归属。原包与授权撤销后不能重放恢复；新授权必须显式换编号，已撤销包不能借此恢复。批准及审计同事务，目录/原件不暴露给其他组织，HTTP 拒绝自动化身份绕过人工审批。

API 已在设置 FEDERATION_SITE_ID 的 Server 中挂载；查询包摘要不从数据库载入完整清单/签名，详情保留原件并分页列出授权历史。权限页面已有中英文选项/说明。Drizzle 自动生成 0156_many_shiva.sql 及 snapshot/journal，增加两张表和 media.import 能力约束；没有手工编辑生成迁移，也没有把密钥存入这些表。

隔离 PostgreSQL 真实迁移后验证 10 项不同数据库/API 场景，包括 HTTP 签名登记、并发幂等、同编号内容冲突、跨组织/权限隔离、限额/到期/目录限制、当前权限检查、暂停合作保留库存但拒绝导入、撤销后重放、审计失败回滚、SQL 身份/期限约束和 101 条授权历史分页。首轮 8 项通过，1 项测试把 Drizzle 查询对象直接交给 rejects，未触发 SQL；补 execute 后受影响约束测试通过，未放宽数据库规则。后续只补跑改变的摘要查询和新增分页范围；权限页面 8 项通过。

仍缺来源方当前披露许可、密钥受控发放、Agent 命令/租约/持续撤权、校验后原子发布与回执，以及运输批次/介质和副本生命周期。这里的本地批准不释放密钥、不启动任务、不解除 DATA_WAITING。参见[介质包 API 与实现边界](media-package.md)。W07/W08 及整体联邦目标仍未完成；未发布 PR 预览，也未部署生产。

全仓 lint 通过，保持既有 47 warning / 1 info；后续权限文案与测试修正的定向 Biome 检查通过。全仓 typecheck 首轮只有分页测试的 JSON 响应 unknown 类型报错，其余包及 protobuf 生成通过；测试改用显式 Zod 响应校验后补跑该场景通过，Server 及首轮未执行到的 Fabric 验收脚本类型检查均通过。840 个离线文档目标及 diff 空白检查通过。所有自建 PostgreSQL 实例、临时目录均已停止/删除，没有运行中的实验服务；没有重跑原加密、取消退款、满盘或调度器矩阵。

### 来源方介质导出批准与独立包密钥托管

来源准备 API 已挂入 Server：独立 `media.export` 批准/撤销，`asset.read` 查询，所有操作限定当前组织人工会话。只接受版本/位置编号和收件机构，从已发布的不可变数据集版本读取实际文件清单、大小、摘要、许可证及完整 provenance，不接受调用者提供路径或文件列表。数据策略必须显式允许下载、再分发和跨中心复制，公开可见或资产所有权不能代替披露许可；批准期受合作、数据许可和 7 天上限约束。当前只支持本组织 Agent 受管目录中的 cp-local 数据集来源。

每包用固定版本官方 age 生成独立身份，沿用现有 AES-GCM/HKDF 将私钥加密托管，派生域绑定站点/包/清单；新独立 wrapping key 不复用 JWT/SSO。普通 API、列表和审计不包含私钥或其密文。生成过程在事务外执行，提交前重查当前策略、原始元数据及签名信任；并发同编号重放保留原签名、密文和一次审计，原批准撤销不能重放恢复。使用 guard 重查原批准人当前能力、协议/站点/密钥、位置归属及数据授权。

官方 age 包装器移至 shared 的独立 Node 入口，避免 Server 运行时依赖只作为开发依赖的 Agent 包；浏览器聚合入口没有导出工具实现。Drizzle 自动生成 0157_fancy_mathemanic.sql 及 snapshot/journal，增加来源批准/密钥托管表和 media.export 能力约束。新增环境配置及运维边界见[介质包说明](media-package.md)。

真实 age 与隔离 PostgreSQL 的 7 项新场景通过：HTTP 原签名/完整元数据、托管密钥恢复及真实加解密、域/密钥不匹配、披露策略限制、并发幂等、当前权限与位置变化、生成时撤权以及重启后撤销保持。测试初始化曾用错协议接收方、同时设置互斥所有者字段，修正夹具后完整通过；并发冲突分支补查原签名信任后，仅重跑该场景并通过。共享清单 2 项、权限页面 8 项、配置 1 项通过。真实测试显式配置工具目录，没有以跳过测试代替验收；自建数据库已停止并清理。

边界：同机隔离数据库中的站点夹具和 4 字节合成数据不能代表双平台交付。数据策略管理写入 API/页面、密钥独立通道、Agent 命令/租约、运行中撤权、原子副本发布/回执、任务输入与结果来源准备、运输介质生命周期仍待继续；没有解除 DATA_WAITING。另已定位既有数据集联邦映射对 raw SHA-256 与 sha256: 引用比较不兼容，待实际材料接线时修复并验收。W07/W08 及完整蓝图保持未完成，未推送、部署或发布 PR 预览。

静态检查：全仓 lint 通过，保持既有 47 warning / 1 info。全仓 typecheck 首次暴露 provenance 的 Zod 内部 JSONType 无法跨包命名；改为显式公开递归 JSON 类型后，数据库、Server、shared 和 Fabric 脚本的受影响检查通过，其余 package 沿用同轮通过结果，未重复检查。离线文档链接 842 个目标及 diff 空白检查通过；无新依赖，生成 protobuf 未产生文件改动。

### 在线数据披露许可及 CP 版本管理入口

CP 数据管理在选择资产/版本后提供跨机构数据授权，按当前机构和单个不可变版本批准、续期、撤销；新增 GET/POST `/api/cp/data/versions/:versionId/disclosure-policy`，正文不能选择其他机构/用户。沿用原资产 manage 与 enforce 鉴权，事务内锁定并重查当前真人成员、资产归属和机构管理身份；平台角色不替代成员身份。批准要求 published/ready/immutable，撤回资产后仍能撤销许可。数据策略及审计原子提交，修改以原 updatedAt 比较；并发同文重试只保留一次审计，不同修改只接受一份。

检查既有数据授权发现 download 同时参与本地 use 判断，因此新入口使用独立 export 数据策略，不把披露批准隐式扩展成本地下载/运行许可。共享 DataAccessPolicySchema 接受 export，普通 DataAccessCapabilitySchema 保持原范围；来源导出识别新 export 策略，也兼容已有 download 加完整披露标志的许可。新编辑器不覆盖已有 download/manage 等复杂策略，展示当前用户/机构适用的其他规则，实际导出仍检查全部限制。沿用现有表，不增加依赖或数据库迁移。

Web 中英文、手机只读、组织/版本/登录隔离已接通；表单首次编辑固定原策略版本，后台刷新不能替旧草稿换版本。提交结果未知时要求先刷新核对。浏览器组件嵌入原 CP 数据页，没有建立重复的数据管理首页；新增授权不发密钥、不执行介质任务。部分本地原有策略仍需通用管理入口，此处只完成明确的版本披露许可。

隔离 PostgreSQL/真实 Hono/官方 age 验证 5 项新增场景及 1 项披露限制回归：在线批准使来源准备成功、撤销阻止原导出、旧请求不能恢复权限；组织越界/自动化/正文夹带拒绝；并发、外部鉴权拒绝及鉴权后归属变化、混合策略保护、已撤回资产的撤销、审计失败回滚。新增断言证实 export 不赋予普通 use。新 Web 7 项及原 CP 页面 18 项通过，共享 schema 边界 1 项通过。初次 Web 测试使用了未启用的 jest-dom 断言，改用现有 Vitest 断言后通过；未修改产品代码掩盖测试配置问题。

真实 Chromium 使用 HTTP 夹具检查完整 CP 页面：中文桌面未授权/已授权、手机只读、英文深色和权限失效，共 5 张截图，无页面错误或横向溢出，并验证按当前机构提交及错误后隐藏旧策略操作。截图和日志在忽略目录 temp/disclosure-ui*，不是实际登录或 PR 预览。原 all-package typecheck 的 Web 断言错误已由修复后的 Web 检查关闭，Server 与其余 package 通过；Fabric 脚本检查通过。全仓 lint 维持既有告警；离线文档 843 个目标及 diff 空白检查通过。

后续继续独立密钥交付、Agent 导出/隔离导入、原子发布回执、运行中撤权、数据集版本复用及真实材料映射摘要兼容性。支付争议、治理归档/Peer 恢复、完整调度器矩阵与正式登录/PR 预览继续保留，完整蓝图目标未完成，本轮没有推送或远程部署。


### 机构间独立介质密钥端点与加密响应

来源 Server 已接入专用 mTLS `/federation/v1/media-keys`，查询和发放使用独立签署用途；普通清单签署权限不能代替密钥权限。内部接收方服务在发送前后检查本地批准、实际 Agent/受管目录和当前信任，来源端复查当前披露许可、原批准及清单。来源将原 age 身份用 RSA-OAEP-256/A256GCM 加密给查询中的 Agent 公钥并签署，绑定查询摘要、双方站点、包、协议、授权及目录，响应最长 60 秒。普通用户 API 与审计没有明文私钥或密钥响应。

Drizzle 生成 0158_safe_tag.sql，保存原查询摘要及原加密签名响应；并发同编号只保留一份，换公钥重放拒绝，重放仍复查当前来源授权与签署用途。响应与脱敏审计原子提交，审计失败回滚。历史响应目前保留，没有自动清理器；过期响应不可继续领取。

隔离 PostgreSQL/真实 age 新增 6 项测试通过，覆盖双方撤权、错误 Agent、并发重放、公钥替换、响应范围/时效、独立签署用途撤销及审计回滚。实际非对称加密 2 项、真实 Node TLS 网关 2 项、真实出站 TLS 6 项通过，共 16 项不同测试。网关初次失败是新增一条成功请求后计数期望遗漏，修正后仅补跑网关及编码修正涉及的加密测试。数据库测试采用同一隔离数据库与指纹登记夹具，真实证书传输单独验证，不能当成双平台/Agent 端到端交付。自建 PostgreSQL 已停止并清理。

来源端点已生产接线，接收 requester 仍是内部服务，尚无真实 Agent 命令及临时私钥持有流程。已获得密钥不能靠撤权在密码学上召回；后续继续命令绑定、租约与运行中撤权、原子发布/回执、介质生命周期及数据集复用。实际扫描版本的 raw SHA-256 与联邦摘要兼容性问题仍待修复。完整蓝图、W07/W08 与 PR 预览验收继续保持未完成；本轮未推送、合并或部署。

全仓 lint 通过，保持既有 47 warning / 1 info。全仓 typecheck 首轮只有 shared 加密 helper 的 TextDecoder 编码类型错误（Server 引用同一文件）；修正后 shared、Server 及首轮未执行到的 Fabric 脚本检查通过，其余包沿用同轮成功结果。843 个离线文档目标与 diff 空白检查通过，无新依赖，生成迁移以真实 PostgreSQL 验证。


### 实际扫描数据集与联邦摘要格式兼容

修复材料映射将数据库原始 SHA-256 直接与联邦 sha256: 引用比较的问题。在统一 inspectLocal 数据集检查处接受两种等价表示，不改写已签署引用、不改数据库摘要、不迁移现有数据；注册、查询和派发前复核沿用这一检查。错误摘要、空值、重复前缀和非规范大小写继续拒绝；版本不可变、位置可用和数据授权规则保持生效。

隔离 PostgreSQL 定向 2 项测试通过：新回归覆盖实际扫描格式、幂等注册、解析后原摘要保留、旧格式兼容及错误摘要拒绝；原映射回归覆盖 DATA_WAITING、可用位置、私有权限拒绝和资产撤销。数据库已停止并清理；没有重复加密、TLS、满盘或科学计算实验。该修复解除实际材料接线的一处阻碍，Agent 命令/密钥持有、原子发布与完整蓝图验收仍待完成。

检查下游发现工作流投影也把带前缀的联邦摘要当作本地摘要，仍会在本地数据规划/派发时冲突；已改为使用 resolver 校验过的本地版本摘要，保持签署输入原样。材料转换 16 项回归通过，同时覆盖原始和带前缀两种本地存储格式；未重跑未改变的数据库场景。

全仓 lint/typecheck（含 protobuf 与 Fabric 脚本）通过；本地投影补充修改后仅补跑 Server 类型检查和受影响文件 Biome，均通过。lint 保持既有 47 warning / 1 info，843 个离线文档目标和 diff 空白检查通过。已同步实现方案中滞后的来源许可/密钥端点状态，不把内部 requester 描述为真实 Agent 交付。未增加依赖或迁移，未推送、合并或部署。


### 来源介质包的真实 Agent 导出操作

新增显式 POST exports/:id/run 和 GET exports/:id/operation，沿用当前机构人工会话及 media.export/asset.read；准备批准不自动产生文件。来源 Server 通过持久操作表和后台扫描向原 Agent 派发，只接受已验证证书、已协商能力和当前连接；新增 protobuf 命令、租约和回报，使用生成器更新类型。Drizzle 生成 0159_secret_crusher_hogan.sql，记录原包的当前执行代次、状态和密文摘要，启动/重试/结果与审计同事务。失败重试新代次，旧回报不能覆盖新任务。

Agent 可配置独立私有 mediaDirectory 和固定版本 ageDirectory，与数据/作业/受限材料根目录隔离；网页不能指定磁盘输出路径。来源/收件机构、包、签名清单及摘要均核对，命令仅含包公钥。最长 30 秒租约在流处理每 15 秒及最终发布前复查，Agent 断线/到期中断；导出与既有联邦输入/结果传输共用单操作槽位。Server 记录结果时再次检查当前来源披露、原批准人和操作发起人权限，源数据变化拒绝继续。

输出在独立临时目录流式加密，完成逐文件摘要、文件/元数据同步和最终授权后整体 rename，再同步父目录。固定 outbox/<packageId>/bundle.age 与 receipt.json 只发布完整包；重试核对绑定及原密文摘要后复用原件，被篡改的产物拒绝覆盖。容量预检保留余量，普通异常/断线/授权失败清理本次临时目录；不将预检冒充空间预留。新增完成目录复用不是 SIGKILL/掉电恢复证明，遗留临时目录自动回收和真实 ENOSPC 仍待完成。

隔离 PostgreSQL/真实 age 的 3 项测试通过，包括 HTTP 发起、实际后台待办扫描、真实 Server 传输与 Agent 客户端写出文件、摘要回报、并发幂等、错误 Agent、撤销披露、重试代次与旧回报、审计失败回滚。该联合测试采用内存命令信道与证书上下文夹具，没有运行真实跨主机 AgentStream。RPC 5 项验证有效/拒绝/旧 Agent/未验证证书/替换连接，授权响应不阻塞心跳；Agent 客户端 5 项验证授权绑定、拒绝、断线与到期停止；实际文件导出 2 项验证独立解密、完成文件重用、篡改拒绝、发布前撤权与流失败清理，另有原 protobuf 10 项通过。共 25 项不同测试通过。

初次文件测试给隔离导入的保留空间小于既有最低限额，修正夹具后仅补跑该项；RPC 测试入口的相对 .. 路径被 Bun 当作匹配过滤器，改为规范路径后通过。类型检查发现新 channel 能力未初始化及跨包测试直接引用 Agent 源码越过 rootDir，已补初始化并沿用现有工作区包导出方式引用测试所需类；Server 运行路径仍不依赖 Agent 包。所有隔离数据库均已停止和删除。

来源实际导出已接通；接收 Agent 密钥持有/解密导入、原子副本发布/回执、介质运输和副本生命周期、真实崩溃/满盘联合验证、UI/CLI 操作入口继续推进。密钥端点的 requester 尚未连接接收操作。完整蓝图及 PR 预览目标保持进行中，没有推送、合并或远程部署。

最终复核为启动/重试审计保留新旧代次，并定向验证；联合测试改走实际后台扫描入口后通过，没有只验证直接调用 dispatch。全仓 lint 通过，保持既有 47 warning / 1 info；全仓 typecheck 的 Server 初次错误修复后，Server、Agent 和 Fabric 脚本的受影响检查通过，其余包沿用同轮成功结果。后续包导出/审计修改补跑 Server 检查通过，最终测试入口调整的定向 Biome 与执行通过。844 个离线文档目标、diff 空白检查通过；无新依赖，生成 protobuf 没有手改文件。


### 接收介质包的真实 Agent 私有导入

接收端新增人工运行/状态 API、持久 queued/verified/failed 操作、失败重试代次、后台扫描及独立 protobuf 能力。Server 只派发给已验证证书且仍为当前连接的 Agent，密钥请求异步处理不阻塞心跳。Drizzle 生成 0160_stiff_jack_flag.sql；操作与结果审计同事务，普通 API 不返回最新加密密钥凭证。

Agent 配置 AGENT_FEDERATION_MEDIA_IMPORT，复用固定 age 工具和现有单传输槽；可与导出共用私有 mediaDirectory，受限根目录去重后仍检查目录重叠。每次运行在内存生成不可导出的临时 RSA 私钥，仅发送公钥；接收 Server 在机构请求前后复查本地许可，来源独立复查披露授权。共享校验函数供 Server 与 Agent 使用；来源响应期限新增双方签名密钥和原清单密钥到期上限。

导入固定 inbox/<packageId>/bundle.age，逐文件流式验证后同步文件和目录，最终复查授权再整体 rename 到受管根的私有 .federation-media/<packageId>。短期租约、断线及错误中断；已有完成副本只在原清单、文件集合与摘要一致时重新授权复用，不覆盖异常目录。操作确认保留最后有效来源凭证，拒绝过期、旧代次或错 Agent 回报。

21 项不同测试通过：实际文件 7 项（5 项新接收场景及因提取共享夹具而回归的 2 项来源场景）、新客户端 5 项、接收 RPC 5 项、隔离 PostgreSQL/真实 age 4 项。联合测试经实际待办扫描串起来源导出、复制密文、接收客户端解密与 HTTP 状态，明确没有创建可用数据位置；另覆盖重试、授权到期/在途撤销、审计失败回滚及来源密钥即将到期。数据库均为临时独立实例，测试后已停止删除。命令使用内存信道及证书上下文夹具，不等于跨主机 AgentStream 验收。

接收结果目前是私有 verified，未创建 Data Market 资产/位置，不授予来源数据使用权，不签署导入回执，不解除 DATA_WAITING。下一步继续独立来源使用授权、接收方策略、原子副本发布/回执及版本复用，之后接介质运输/副本生命周期与故障恢复。支付争议、治理归档/Peer 恢复、调度器矩阵、UI/CLI 和 PR 预览仍属完整目标，未因本次导入实现缩减。未推送、合并或远程部署。

全仓 lint 通过，保持既有 47 warning / 1 info；全仓 typecheck（含 protobuf/Fabric 脚本）通过，随后新增测试的受影响 Agent/Server 类型复核通过。Server 新测试曾直接读取 unknown JSON，现以 schema 校验后读取，并只补跑该 HTTP 联合测试。最终复核将目录去重限定为导入/导出介质根，避免与受限材料根相同的错误配置被去重掩盖；Agent 类型检查通过。845 个离线文档目标和 diff 空白检查通过，无新依赖，未手改生成文件。


### 独立来源数据集使用许可与短期签发

新增 dataset.use.approve 机构能力，接入现有中英文权限选择器；资产管理、导出、导入或平台角色不隐含该能力。来源使用政策绑定不可变版本、接收站点、协议和期限，和介质包编号独立，支持长期审批及同版本重新制包。审批人需当前真人成员、该独立能力、资产所有/机构管理身份和 Data Market manage（含外部鉴权）。资产归属检查从披露服务提取并复用，保留原规则与错误行为。

人工 API 支持批准、分页读取和不可逆撤销。相同编号只接受同一原请求，不允许续期覆盖；批准/撤销与审计同事务。机构独立能力可撤销原审批人已离开的历史许可。有效使用还受当前协议、站点、版本、禁止策略约束；licensed-material/entitlement 保留原有效使用授权及期限，资产所有权不绕过它。

专用 mTLS dataset-use 端点和出站路径已接入生产启动。dataset-use-query/grant 为独立签署用途，查询绑定完整资产引用、来源政策、接收 replicaId/Agent/受管根，不携带实际账号。来源复查原审批人、归属和当前信任，签发最长 60 秒且不越过政策/协议/entitlement/双方签名密钥期限。重复 queryId 保留原签名与一次审计，换副本/目录/摘要或撤权后重放被拒绝。该路径不接 Fabric，不将使用许可扩展为披露、下载或再分发。Drizzle 生成 0161_silly_living_mummy.sql，持久化审批与签发原件，并扩展能力约束。

22 项不同测试通过：隔离 PostgreSQL 12 项（11 项新使用许可场景，1 项受影响的原披露管理回归）、真实 TLS 8 项、共享凭证边界 1 项、双语权限标签/效果 1 项。覆盖源方独立审批及 HTTP、并发重放、撤权/权限/归属/禁止策略/密钥用途/到期、外部鉴权及竞态、审计回滚、密钥与 entitlement 寿命。首次数据库运行被测试编辑时误插入的额外 schema 参数阻止；修复夹具后针对性重跑通过，没有改变产品校验掩盖错误。所有自有临时数据库都已停止并移除。

本轮完成来源许可管理和签发端，不把它描述为已执行的数据访问限制。接收方续租、结构化外来副本归属、Data Market 发布、所有者/机构成员的隐式使用路径防绕过、作业派发与运行中撤权、签名导入回执、版本复用仍继续推进。介质生命周期、故障恢复、支付争议、治理归档/Peer 恢复、调度器矩阵、UI/CLI 与真实 PR 预览仍属完整目标，未推送、合并或部署。

全仓 lint 通过（既有 47 warning / 1 info），全仓 typecheck 含 protobuf/Fabric 脚本通过；新增测试与 entitlement 复核后的 Server/Shared 受影响类型检查、对应文件 Biome 通过。849 个离线文档目标与 diff 空白检查通过，无新依赖。未重复运行无关作业、退款或满盘验收。


### 接收方数据集发布、来源授权续期和派发限制

`FederationDatasetPublicationService` 将已 verified 的 dataset 包接入实际 Data Market：网络请求前后复查接收组织能力、原导入批准及代次，再验证独立来源使用凭证；资产、不可变版本、文件清单、固定 Agent/受管位置、结构化来源与审计同事务提交。资产按接收站点/组织/来源站点/来源资产去重，同版本清单、摘要、license/provenance 完全一致才复用。Drizzle 生成 0162/0163，未手改生成 SQL 或快照。

来源归属不依赖 metadata 或 accessMode。单对象权限、批量候选、可用位置/版本和实际派发共同执行来源检查，本地所有者/组织成员/管理员不获得隐式使用权；普通上传/扫描/版本导入、再次对外披露/导出/使用审批拒绝外来资产。Agent 普通扫描拒绝私有 .federation-media 目录、其父目录及指向内部的受管根别名，防止把内容另登记成本地自有资产；受管只读派发仍可解析原目录。

发布为机构可见、受限且需要申请的 provider 资产，复用原 Data Market 申请/批准流程，申请者活动组织必须为接收组织。资产权限投影待办与发布一起持久化，不依靠手写本地 grant 才能使用。后台默认随既有联邦签名/mTLS 服务启动，持久令牌限制并发续期及过期接管；晚到响应不能覆盖撤销或接管后的新凭证。网络失败保留旧签名的原有效期，不能自行延长；原导入窗口自然结束不等于来源使用权结束，但包/导入批准显式撤销仍阻止使用。

文件派发租约取来源签名与信任/协议期限的上限，不能固定重新签发 60 秒。授权事务使用 NOWAIT，防止持有 Job 锁时等待来源副本/撤权行形成锁反转。并发修改导致本次授权失败，沿用现有派发重试流程。

本轮共 86 项不同场景验证通过：11 项接收发布/续期/HTTP/权限及派发测试（其中一项使用真实 age 与实际 Agent 客户端完成导出、复制密文、接收校验，再经服务发布和本地申请审批）；原数据派发 PostgreSQL 22 项；Data Market 28 项；文件派发 12 项；Agent 根目录/扫描 11 项；续期 worker 2 项。覆盖幂等、同版本复用、审计回滚、在途撤销、令牌接管、错误机构、来源/本地许可分离、短租约、密钥用途、位置变更和普通扫描防绕过。新增夹具曾把导入期限设在批准前、或使用错误活动组织，被原约束正确拒绝；调整夹具后相应场景通过。实际文件往返使用隔离内存信道，不等同于跨主机 AgentStream 或 Slurm/PBS 作业验收；全部自有临时 PostgreSQL 均已停止删除。

签名导入回执、任务输入/结果介质、运输批次/交接、副本删除与运行中撤权、SIGKILL/满盘恢复、跨主机 DATA_WAITING/调度器矩阵、支付争议、治理归档/Peer 恢复和 UI/CLI/PR 预览仍属完整目标。未因本次发布能力缩减交付范围，未推送、合并或部署。

全仓 lint 通过，保持既有 47 warning / 1 info；全仓 typecheck（含 protobuf 和 Fabric 脚本）通过，后续边界修订的 Agent/Server 类型检查与对应文件 Biome 复核通过。849 个离线文档目标和 diff 空白检查通过。无新依赖，没有运行真实集群或远端部署。


### 介质私有接收的双签回执与补报

verified 导入结果现在与 `verified-private` 回执事实同事务保存；后台签署后经独立 mTLS media-receipts 路由发给来源。来源核对原清单摘要、文件数/字节数、双方/协议、实际密钥发放及接收时间窗口，保存原声明和签名确认。media-import-receipt / media-import-receipt-ack 是独立用途，生产启动、网关/出站白名单、管理查询/重试与中英文选择器均已接通。Drizzle 生成 0164_flaky_carmella_unuscione.sql，无手工修改 SQL 或快照。

回执保存历史事实，不授予使用/下载权，不等待 Fabric，不因后来许可或协议到期/撤销丢弃原接收记录。领取令牌防止人工重试/接管后的迟到回复覆盖状态；源端已提交但响应丢失时返回原确认。双方审计失败各自原子回滚，旧 verified 操作可从原校验记录重建待报事实，冲突条目退避而不挡住其他包。密钥轮换重新签署同一事实，不改 receivedAt/recordedAt；来源保留最初收到的回执签名。慢回执与 Agent 导入扫描分开运行，正常停机等待在途请求。

23 项不同测试通过：隔离 PostgreSQL 13 项（10 项新回执故障/权限/恢复场景、1 项真实 age/Agent 客户端导入发布及回执联合场景、2 项受影响的原导入撤权/审计回归）；真实 Node TLS 8 项；共享回执 schema 1 项；双语签名用途 1 项。覆盖未知提交结果、并发重放、伪造范围、错证书、到期后的历史补报、双方审计回滚、人工重试令牌、在途密钥撤销、双方密钥轮换、HTTP 机构隔离、历史记录恢复和慢网络不阻塞导入。新增用途检查暴露原数量上限未同步，已按实际 48 种用途修复；TLS 夹具的新增成功请求计数也已更新，对应失败场景重跑通过。临时 PostgreSQL 均已停止删除。

这不等于跨主机进程崩溃验收；文件命令仍使用同进程内存信道。介质运输/交接、任务输入/结果包、副本删除、SIGKILL/真实 ENOSPC、跨主机 DATA_WAITING/运行中撤权、Slurm/PBS 科学作业矩阵、支付争议、治理归档/Peer 恢复、完整 UI/CLI 和实际 PR 预览仍属于完整目标。未推送、合并或远程部署。协议与操作说明见[介质导入回执](media-receipts.md)。

全仓 lint 通过（既有 47 warning / 1 info），全仓 typecheck 含 protobuf/Fabric 脚本通过；回执扫描独立化后的 Server 类型检查及对应文件 Biome 通过。857 个离线文档目标和 diff 空白检查通过，无新依赖。


## Agent 介质操作的 SIGKILL 与真实满盘恢复

导出和导入统一使用各自父目录内的 `.media-work/pending`，通过持久文件描述符和内核 flock 串行化清理、写入及发布。新进程只在持锁后删除该工作区的未完成内容；不会误清理仍活动的另一进程，也不按时间猜测进程死亡。已完成包仍在工作区之外，原有授权/摘要重查和整体 rename 语义保留；收到旧完成包不意味着来源使用权或 Server 完成记录已生效。没有数据库迁移、依赖更新或生产部署。

新增真实进程四种中断场景：导出/导入在内容写入后发布前强制结束，以及完整落盘但回报前强制结束。重新执行验证遗留清理、活动锁拒绝、完成文件 inode 不变、没有 inbox 时完整副本复用及当前授权撤销拒绝。另验证工作区外数据不会被软链接清理、锁权限过宽及硬链接拒绝。两个独立 96 MiB tmpfs 场景在容量预检后真实写满，确认导出和导入写入抛出 ENOSPC、清除未完成内容、释放填充空间后重试成功；完成包再次遇到满盘也可复核，恢复完成回报不要求新建临时目录。挂载均已卸载，测试临时目录均清理。

共 14 个不同场景：7 项新增恢复/满盘，7 项受影响的原导入/导出回归。最初子进程输入使用了错误的 Bun FileSink.end 参数、目录列表断言依赖顺序，以及满盘夹具用 Bun.file.exists 判断目录；均修正测试夹具后仅重跑失败范围，通过。没有以更改业务逻辑掩盖测试错误。真实加解密使用固定官方 age 1.3.2、小型合成数据；不是跨主机 Server/Agent 或真实科研作业验收。

全仓 lint 通过（既有 47 warnings / 1 info），全仓 typecheck（含 protobuf 生成与 Fabric 测试类型）通过；最后调整完成包满盘恢复后，相关 7 项恢复/满盘测试、Agent 类型及 lint 再次通过。859 个文档目标离线检查及 diff 检查通过。

旧版未加锁的临时目录不能安全自动认领；升级须先停止共享目录的旧 Agent，再核对处理。当前清理按下一次操作触发，不包含定时扫描；主机掉电、跨主机 DATA_WAITING/运行中撤权、介质运输/副本生命周期、任务输入/结果包、Slurm/PBS 完整矩阵、支付争议、治理归档/Peer 恢复及 UI/CLI/PR 预览仍属于完整目标。未推送、合并或远程部署，完整目标保持进行中。操作要求和复现入口见[Agent 恢复](media-package.md#agent-中断与满盘恢复)。


## 介质导入副本的 Sandbox 执行接线与运行授权

检查真实执行路径时发现：已发布副本固定为受限 cp-local，但原 RestrictedSandboxDeliveryBinder 只接受 object-download，Agent 同时拒绝将受限原始 DataDelivery 直接交给调度器。因此原有发布/权限验证并不能证明副本可被工作流使用。本轮新增明确的 protobuf 本地数据来源和独立 Agent 能力，Server 把本地文件绑定到签名 FileBatch，Agent 从配置根复制到私有 Sandbox 输入并按原摘要校验；不借 file://、任意绝对路径或对象存储中转。protobuf 由 buf 生成，没有手改生成文件，无数据库迁移。

来源位置、受管根及相对路径作为不可变派发内容，续租仅更新许可。准备时固定位置并在事务内复核；运行时检查原位置仍有效、归属原 Agent、包含原文件，并返回实际来源凭证期限限制执行许可。测试覆盖同一版本还有有效副本时撤销当前副本，确保不能借另一个副本续租。缺少来源许可会走已有 DENIED/租约到期和独立 watchdog 停机路径，未增设第二套停止机制。常规非联邦任务尚无该持续授权，Server/Agent 明确拒绝，完整目标仍需后续补齐适用路径及实际跨主机验收。

本地输入的 Data Market 解析和签名挂载在未启用 NetDrive 时也接线，MinIO 仅用于对象输入。Agent 拒绝链接、特殊文件、非受管根、路径越界、混合 URL/本地来源；每块复制响应授权取消，签名内容校验仍由 SandboxStager 执行。原本地数据权限、受限无网络/输出与独立调度器 watchdog 边界均保留。

129 个不同相关场景通过：组件与 dispatcher/proto 94 项（含真实 age 导入到 Sandbox 输入及无对象存储路径），Agent stream 7 项（3 项新路由/拒绝，4 项既有运行拒绝/超时/接管/停机重试），隔离 PostgreSQL 28 项（5 项新发布→准备→运行授权，1 项受影响的来源租约，22 项原派发/运行校验回归）。初始新增夹具使用了非法 assetKind，扩展准备验收时将测试步骤误放进过期分支，均修正夹具后重跑相应范围；类型检查发现两处夹具推导和一处派发内部 DTO 未同步，按真实接口补齐。没有修改数据库约束或放宽执行策略以通过测试。

全仓 lint 通过，保持既有 47 warnings / 1 info；修正后全仓 typecheck（含 protobuf 生成与 Fabric 测试类型）通过，861 个文档目标离线检查和 diff 检查通过。全部自建 PostgreSQL 已停止删除。

本轮未执行真实跨主机 AgentStream、Slurm/PBS Sandbox 或科学软件任务；DATA_WAITING 自动恢复、真实来源撤权停机、介质交接/副本生命周期、任务输入/结果包、支付争议、治理归档/Peer 恢复、其余 UI/CLI 和 PR 预览仍属完整交付。未推送、合并或远端部署，整体目标保持进行中。


## 导入数据的真实 Slurm 执行与映射身份恢复

真实调度验收发现两类组件测试未暴露的问题，现已修复。第一类是映射账号不能穿过 root 私有准备目录，也无法在只读作业根创建调度日志；现在专用 Sandbox 根只开放穿过权限，作业目录按映射组可读取/进入，嵌套输入父目录可穿过且不可写，脚本与输入保持只读；日志独立放在执行账号所有的 `.scheduler-logs`，Slurm/PBS/Torque 共用该布局。挂载限制在规范的 inputs/outputs 子树，避免侵占脚本、上下文或日志目录。程序不修改 Sandbox 根以外的目录权限，部署须提供可穿过的父目录。

第二类是 Slurm 恢复默认查询 Agent 本身的 UID，遗漏映射账号提交的作业，导致独立 watchdog 无法确认并停止目标。Agent 恢复和 watchdog 现在从持久 Sandbox 意图提取已验证账号；Slurm 活动/历史/保留作业查询按执行 UID 核对，同时保留 Job UUID、代次名称和 account 条件；PBS/Torque 对应核对 Job_Owner。未增加可从用户输入任意指定取消账号的接口。

新增[可复现的隔离实验](../../../deploy/federation/media-slurm-lab.md)：固定缓存的真实 Slurm 19.05.5、官方摘要校验的 Apptainer 1.4.3、实际签署和验签的最小 Bash SIF、真实 age 1.3.2。256 KiB 合成数据经导入和签名清单校验后，由非 root 映射账号执行，核对完整输入长度、只读限制及无默认网络路由。三个不同场景通过：正常 COMPLETED/0；写入原运行收据的 stopping 决定后实际 CANCELLED 并保存停机证明；Agent SIGKILL 后原 15 秒租约到期实际 CANCELLED 并保存证明。最后一项额外暂停 supervisor 的自动重启后单独复查，确认在没有新 Agent 参与时独立 watchdog 仍完成停止，随后恢复 supervisor。实验 Pod 上限为 1 CPU/1 GiB，所有自建 namespace 均清理。

254 项不同相关测试通过：准备/适配器渲染 38 项（含真实降权文件读写及其他账号隔离），三个调度适配器/独立 watchdog/派发处理 203 项，Agent 断进程与 SQLite 重开恢复 13 项；另有上述 3 个真实 Slurm 场景。首次真实试验的清单 profileId、root 身份、租约上限及最小运行时缺少 sleep 均属于夹具问题，按现有生产约束修正；等待启动标记另补充足够的 stdout 字节以穿过已有 head 缓冲。没有放宽授权或改短生产租约来通过验收。真实执行另外证明必须允许 Apptainer 读取当前作业目录，作业根因此采用只读可进入的映射组权限。

全仓 lint 通过，保持既有 47 warnings/1 info；全仓各包 typecheck 和 protobuf 生成通过；新增实验脚本最初缺少数据库环境变量判空，补齐后 Fabric/实验脚本类型检查通过。866 个本地文档目标离线检查和 diff 空白检查通过。没有数据库迁移、生产依赖变更或远端部署。实验使用一次性 privileged Pod 容纳嵌套 Apptainer；安装 setuid 包和小型动态库仅发生在该 Pod，没有更改宿主 sysctl。实验准备需要软件源，不能据此声明离线科学软件安装已通过。

范围仍有明确边界：停止决定由探针调用生产收据服务注入，不是来源撤权 API；没有验证跨站 mTLS/AgentStream → 发布 → DATA_WAITING → 源方撤权的完整链路，也没有验证主机掉电、PBS 真机或生产完整安全能力证明。介质运输/副本生命周期、任务输入/结果包、支付争议、治理归档/Peer 恢复、其余 UI/CLI 与 PR 预览仍属完整目标，未推送、合并或部署，整体目标保持进行中。


## 导入数据的真实 PBS 执行与强制停机

隔离 Pod 内以固定 OpenPBS 23.06.06 源码编译真实调度器，构建限额 2 CPU/2 GiB、make -j2；保留源码摘要、提交、基础镜像与本地安装归档摘要。缓存恢复到另一个全新 Pod 后，实际 age 导入、签名 Apptainer、非 root 映射账号正常读取只读输入、持久停止决定及 Agent SIGKILL 后独立 watchdog 停止三项全部通过。运行器现统一为 federation-media-hpc.py，支持 Slurm/PBS，Slurm 正常执行另做一次针对改名/日志读取的回归通过。公开 PBS 构建脚本通过语法检查；它的无缓存自动分支没有重复编译验收，不冒充发布方认证的二进制。

真实 PBS 暴露两类问题并修复。生产 entrypoint 原先一律以 kq 启动 Agent，不能执行签名映射账号的 setpriv；现在仅在显式 root impersonation 配置下启用 root Agent，冲突配置拒绝，默认仍为 kq。另发现重复 qdel 会重置 MOM 的强制停止截止，导致撤权后无法停机。联邦取消现对 R/S/U 先发送调度器原生 qsig KILL，再 qdel；E 等待退出、F 核验终态，不强删记录。watchdog 使用验证后的持久收据代次，嵌入执行器首次运行与恢复均保留代次并传入取消。命令成功仍不等于停止，受限输入必须等正向停止证明才能清理；实验异常清理也复用此规则。

132 项不同相关测试通过：PBS/独立 watchdog 75 项、嵌入执行器/调度 entrypoint 回归 50 项、PBS Agent 启动身份 7 项。实际 PBS 最终三个场景均通过；最初失败停机任务曾人工 KILL 诊断，不计通过。PBS 运行中观察 MOM spool，结束后通过生产日志接口核验，没有改变产品日志模式。实验采用 256 KiB 合成数据和 Bash/sleep，不安装科学软件。全部自建 PBS/Slurm namespace 已删除，无生产改动。

这里仍直接写入原运行收据的 stopping 决定，不是跨站来源撤权。两个独立 Server/数据库/Agent 的加密导出导入、显式发布与本地授权、DATA_WAITING 自动恢复、实际来源政策撤销到调度器确认停止仍需联合验证；将复用现有双平台实验，使用独立介质根、真实 mTLS/AgentStream、实际授权 API，禁止以直接改任务状态代替。这轮没有验证 root PBS Agent 的普通未映射作业，不允许据此开放 root 作业。介质交接/副本删除、任务输入/结果包、完整调度矩阵、支付争议、治理归档/Peer 恢复及 Web/CLI/PR 预览仍是原完整目标。未推送、合并或部署。

本轮全仓 lint 通过（既有 47 warnings / 1 info，无新增），全仓 typecheck（含 protobuf 生成及 Fabric/实验脚本）通过；867 个文档目标离线检查、Python AST、Bash 语法和 diff 空白检查通过。没有新增依赖或数据库迁移，未手改生成文件。


## 双平台介质交付、签名回执与来源撤权

新增直接合作的 media 场景，复用两个独立生产 Server/数据库、真实机构 mTLS 网关和分别通过注册 API/CLI 接入的 Agent。初始数据集、元数据、披露许可和人员能力为显式夹具；包准备/导出、登记/导入批准、导入、来源使用审批、发布及撤权全部走实际 HTTP。每个 Server 使用独立临时 wrapping key，Agent 独立数据/介质根，机构间加密密钥交付走真实 mTLS；运行器只复制 age 密文到接收 inbox，接收 Agent 实际解密和逐文件校验。

首次双平台请求返回 403，发现来源导出和来源使用政策错误地查询 federation_agreements 并以外键关联该表；它只在接收计算的一方安装，而之前共库测试掩盖了差异。现在两项统一核对本站 federation_agreement_approvals 的双签记录，事务内检查组织、双方站点、状态/期限、双方原签名及当前密钥；生成迁移 0165 将外键改为本站/协议版本联合审批键。不在来源站安装虚假执行账户或预算。历史低层夹具若缺本站审批，须先以真实原双签补齐，迁移不伪造授权。

相关数据库测试共 65 项通过：61 项原导出/密钥/导入/来源使用/副本/回执场景，4 项新增暂停、缺对签、错机构和错误对签。新增测试最初错误地要求廉价 preflight 完成全部协议校验，已改为验证真正的事务内 assertQuery 及审批/原包续权，随后只复跑失败的四项。没有放宽产品校验来迁就测试。

修复后完整双平台命令退出 0。真实证据验证 exported→verified→recorded、独立来源使用批准、显式发布及重复发布不新增副本，接收版本 SHA-256/许可证/provenance 与源端一致；来源撤权后续租失败、原最多 60 秒许可自然失效，不本地延长。当前 HTTP 拒绝记为 RENEWAL_FAILED，此处不是签名即时撤权。已导入文件及历史回执保留。另用该次保留的前后快照验证双方预算完全不变、来源预算为空、双方均无作业/绑定/委派/预留/账单/结算；这项检查已接入运行器，不重新启动实验。全部自建服务、数据库、身份、namespace 和 RBAC 均清理。

本次只用 4 字节合成数据，没有计算提交。受限副本执行需要生态签名脚本和可信 SIF 配置，现有 Kubernetes 普通文件实验不能替代它；下一条完整验收仍是数据等待→导入/授权/映射→真实 Slurm/PBS 执行→来源撤权→正向停止证明。介质运输/副本删除、任务输入/结果介质、掉电/跨主机、完整科学软件工作流、支付争议、治理归档及其余 Web/CLI/PR 预览继续按原蓝图完成，未缩减范围。未推送、合并或部署。

本轮最终全仓 lint 通过（仍为既有 47 warnings / 1 info），全仓 typecheck 含 protobuf 生成及 Fabric/双平台实验脚本通过；870 个文档目标离线检查、Python AST 和 diff 检查通过。迁移完全由 Drizzle 生成，并在隔离数据库与两套真实 Server 的新数据库中实际应用；没有手改生成文件或新增依赖。


## 受限 HPC 节点的 seccomp 强制执行

继续接通双平台真实 Slurm 前，发现 root 代运行的 Apptainer 参数只传 no-new-privs，未加载 seccomp；能力开关不能证明过滤器生效。本轮先修复 signed executionProfile 的受限路径：trusted wrapper 读取本地 root 配置的 KQ_SECCOMP_PATH/KQ_SECCOMP_SHA256，校验策略、wrapper、Apptainer、SIF 及完整父目录链，SIF 强制只读。wrapper 解析固定隔离参数，拒绝覆盖、可写挂载及附加命令，再强制加载 seccomp。Agent 启动时实际调用 wrapper --check-profile，失败不发布可用受限 profile；计算节点执行时重复校验，避免只相信 Agent 本机。没有改变签名协议、数据库或引入依赖。

30 项不同相关测试通过：6 项真实 shell wrapper 测试，覆盖加载唯一策略、缺失/篡改/可写/软链接策略、不安全父目录、参数注入和 wrapper/SIF 篡改；6 项执行 profile 测试包含启动拒绝；18 项原调度渲染/隔离回归。shell 测试首次目录选在 noexec 的 /run，进程未能启动；改为 root 专用 /var/lib 随机目录后仅复跑这 6 项并通过，未放宽生产检查。测试自动清理目录；非 root/Linux 环境跳过这组 root 文件权限实验。

真实 Slurm 19.05.5 和 OpenPBS 23.06.06 各执行一次正常场景，均通过。生产 wrapper 在映射账号的 Apptainer 任务中加载仓库现有 amd64 禁网策略，读取真实 age 导入的 256 KiB 合成数据，输入不可写，检查 /proc/self/status 的 Seccomp=2、NoNewPrivs=1，并要求 Bash 创建网络 socket 返回 Operation not permitted。仅无默认路由无法通过该断言。使用固定缓存和短任务，没有科学软件编译；自建 namespace 均请求清理。本机证据在 temp/federation-pbs/seccomp-{slurm,pbs}.log 及各实验目录，不提交私有日志。

部署须暂停受限派发，在所有节点安装策略及新 wrapper、更新本地和 Agent 的 wrapper 摘要再重启。此修复只证明受限 wrapper 路径；普通非受限 root Sandbox 的完整运行时证明、生产 cgroup 强制限额以及真实跨站 DATA_WAITING→作业→来源撤权停机仍需补齐。介质交接/副本删除、任务输入/结果包、掉电与跨主机、支付争议、治理归档/Peer 恢复、其余 Web/CLI 和 PR 预览继续按原蓝图推进，没有缩减整体目标。未推送、合并或远程部署。

全仓 lint 通过，保持原 47 warnings/1 info；完整 typecheck 含 protobuf 生成、所有包及 Fabric/实验脚本通过。873 个文档目标离线检查、shell 语法和 diff 检查通过；确认两次实验 namespace 已清理。没有重复已通过的停止/崩溃场景，也未把普通 root 路径或 cgroup 配置开关当成实际证明。


## 静态数据集脚本与真实跨站 Slurm 联调

将双平台 media 场景接入实际受限 Slurm 作业。两端仍是独立生产 Server、独立数据库、真实机构 mTLS 与分别注册的 Agent；
接收节点使用签名 SIF、root 管理的受信 wrapper、seccomp 和非 root 映射账号。
脚本通过实际签名 Ecosystem Release 导入两端，数据通过源端 age 加密导出与接收 Agent 解密校验。
源方提交缺少接收版本的委派后，先核验 DATA_WAITING 且无 Job；导入后独立批准使用、显式发布及映射，再等待后台派发。
显式本地数据授权夹具只授予操作员和受限服务身份 use，不伪造任务/执行/来源许可/停止记录。

联调发现并修复三个产品缺口：Script DSL 不允许静态 Dataset、Sandbox 执行器未解析该 contents、提交前数据预检未覆盖 Script。
现在只允许同名 FileBatch 声明，静态引用进入既有 Job dataInputs 与受限交付；递归预检沿用冻结主体的本地权限，不开放 NoAction 或动态 Dataset。
另发现 Agent 注册/心跳直接持久化 Protobuf profile，携带的 `$typeName` 触发后续严格 schema 拒绝；
现在提取七个业务字段并验证后保存，缺失或无效配置不发布。心跳即可更新旧记录，无需数据库迁移。

67 项不同相关测试通过：DSL/槽位/执行器 41 项、Web 输入配置 17 项、递归数据预检 7 项、能力归一化 2 项。
全仓 lint 通过（原有 47 warnings/1 info）；全仓各包 typecheck 与 protobuf 生成通过。
实验脚本检查发现队列名称可为空，改为显式校验后，该项类型检查单独复跑通过；没有重复已通过的产品包检查。
联调还修正了实验启动时的 cgroup 路径、队列清单等待和账号队列授权，未通过放宽产品检查使实验运行。

本次脚本只读取 4 字节合成数据并 sleep，不编译科学软件。Pod 1 CPU/1 GiB 的实际总限额不证明生产逐作业 cgroup 强制；
签名 SIF 为临时实验密钥签署，不替代生产镜像治理。源码/安装包缓存有摘要，临时私钥在分发前删除。
最终完整命令退出 0：实际读取导入数据、只读/禁网/seccomp/no-new-privs 检查通过后，经源方 HTTP 撤权，后台续租失败，原短期许可失效，同一 Slurm Job 变为 CANCELLED；映射账号的 sleep 进程消失，原 jobId/dispatchEpoch/schedulerJobId 的 Agent 停止证明为 true。没有注入停止决定、伪造回执或改写作业终态。
运行中只读观测曾遇到 PostgreSQL NOWAIT 的 55P03 行锁冲突；观测器现只将该特定错误表示为未知并限时重读，未知不能满足允许/撤权断言，其他错误继续失败。
最终双方快照显示源站无计算预算/作业、仅一个委派；提供方只有一份预留、一个工作流绑定和一个作业，预算守恒，直接模式没有任何链待办，未生成账单/结算。SHA-256、许可证和 provenance 保留，撤权后原始导入文件与回执仍存在。所有自建服务、数据库、临时凭据及 namespace 已清理。
PBS 联合链路、掉电/跨主机、介质交接/副本生命周期、任务输入/结果包、真实科学工作流、支付争议、治理归档/Peer 恢复、其余 UI/CLI 和 PR 预览仍按原蓝图推进。
未推送、合并或远程部署，整体目标保持进行中。


最终观测重试修正后，实验脚本类型检查再次通过；最终全仓 lint 保持原 47 warnings/1 info。
875 个本地文档目标离线检查、Python AST、Bash 语法和 diff 检查通过。未新增依赖或迁移，生成文件未变更。


## 双平台加密数据集的真实 PBS 执行与撤权

扩展既有 media 联合运行器，支持实际 `pbs-pro` 注册、workq 清单等待、账号队列权限、PBS SIF runtime binding 和生产 entrypoint。
使用组件实验留下的 OpenPBS 23.06.06 安装缓存；启动前验证源码提交/摘要、归档摘要与固定基础镜像，Pod 内验证 qsub 实际版本。
没有新增源码编译，仅恢复缓存并安装小型运行库。原 Slurm 分支保留，两种配置的调度器类型、只读挂载与 1 CPU/1 GiB 上限通过断言自检。

实际两个 Server/数据库、机构 mTLS、独立注册 Agent 的完整命令一次通过并退出 0。
先确认 DATA_WAITING 且无作业；实际 age 加密导出/解密导入、签名回执、来源使用批准、显式发布、本地授权和映射后，
生产后台在 PBS 上自动启动受限账号作业，实际读取 4 字节合成数据并通过只读、seccomp、no-new-privs 和 socket EPERM 检查。
源方 HTTP 撤销政策后，原许可到期；PBS 历史记录 R→F、退出码 265、原映射 sleep 进程消失，Agent 原 Job/dispatchEpoch/schedulerJobId 的正向停止证明为 true。
探针只读取生产 Adapter、qstat 历史和 SQLite 原收据，不注入许可/停止决定或终态。续租拒绝仍记录 RENEWAL_FAILED，不冒充即时签名撤权。

双方最终账本显示：来源站无计算预算或作业，只有一份委派；提供方只有一份预留、一个工作流绑定与一个作业，预算守恒，直接模式无链待办，未产生账单/结算。
文件 SHA-256、CC0-1.0 许可证和 provenance 保留，撤权不删除原导入文件或回执。完整命令结束后全部自建服务、数据库、凭据、namespace 和 RBAC 清理。
本轮没有产品执行代码修订，不重复已通过的独立 Slurm 运行或此前单元测试矩阵；新增 PBS 联合场景实际覆盖扩展分支。

生产逐作业 cgroup、普通 root Sandbox 的完整证明、掉电/跨主机、介质交接与副本生命周期、任务输入/结果介质、真实科学软件、支付争议、治理归档/Peer 恢复以及剩余 UI/CLI/PR 预览继续按完整蓝图推进。
未推送、合并或远程部署，整体目标未缩减。


本轮完整 lint 通过（原有 47 warnings/1 info），全仓 typecheck 含 protobuf 生成及 Fabric/实验脚本通过；
877 个本地文档目标离线检查、Python AST、Bash 语法、Slurm/PBS 配置自检和 diff 检查通过。
没有依赖或数据库迁移，生成文件未变更。后续资源约束需补齐签名清单中的 CPU/内存上限及计算节点实际逐作业限额校验；
现有 SelfAccount 启动证明中的 cgroup 路径匹配、root 能力开关和 Pod 总限额均不能替代该证明。


## 签名计算资源与派发一致性

Sandbox 新增必须签名的 `resources.cpus/memoryMb`（MiB），RootImpersonation 与 SelfAccount 均取实际 Job 值；
protobuf 使用独立 `compute_resources` 字段。数据挂载追加/重新签名保留原资源，Agent 暂存前核对外层派发值，
拒绝时不消费 nonce、不读取输入、不清除旧输入。调度器提交入口核对实际 CPU/内存与已验证清单，覆盖 Slurm/PBS/Torque/Kubernetes。
联邦续期检查数据库 Job、原 outbox 与签名资源三者一致；不能借仍处于政策上限内来修改原任务。

旧清单拒绝新派发/续期，不补默认值或自动重签。持久化 Agent 运行记录可以缺少签名资源，以保留轮询/收尾/取消能力；
重新提交仍必须有已签名资源。升级先停止新 Sandbox 提交并排空或取消旧任务，再同步 Server/Agent。
此项没有新增依赖或数据库迁移。逐作业 cgroup 强制、计算节点资源证明和完整蓝图剩余项保持未完成，不能把签名一致性当成内核限额。


本轮 466 项不同的相关测试通过，覆盖签名/篡改/数值范围、两种执行身份、数据挂载重新签名、四类调度器参数拒绝、
Agent 消息与旧记录恢复，以及 77 项隔离 PostgreSQL 回归。原有独立 age 暂存测试未启用其专用环境变量，保留 1 项 skip；
实际 age 链路由下面的完整 PBS 联合实验覆盖。全仓 typecheck（含 protobuf 生成及实验脚本）通过。

新增资源字段后的真实 PBS 联合命令退出 0：两套独立 Server/数据库和机构 mTLS Agent，实际加密导出/导入、
签名回执、独立来源使用批准、显式发布/本地映射后，DATA_WAITING 自动恢复。
PBS 原任务申请 1 CPU/128 MiB 并实际读取输入，通过只读、seccomp、no-new-privs 和 socket 拒绝检查；
来源 HTTP 撤权后续租失败，原许可到期，同一调度作业从 R 到 F（退出码 265），进程消失，持久停止证明为 true。
原 SHA-256/许可证/provenance 保留。使用 4 字节合成输入与真实 Bash/SIF，没有科学编译；未重复旧 Slurm 联合场景。
所有临时平台、数据库、凭据和 namespace 已清理；未推送、合并或远程部署，整体蓝图和 PR 预览验收保持未完成。

最终全仓 lint 通过（原有 47 warnings/1 info），878 个本地文档目标离线检查与 diff 检查通过；生成文件、依赖锁和数据库迁移未变更。


## 逐作业 cgroup 检查器与真实内核边界

新增只读 Python 检查器，沿用现有安装监督的内核核验思路，额外绑定实际调度器作业 cgroup。
定位内核挂载/成员关系，核对作业根 CPU quota 或显式 cpuset、内存/交换上限与目录/进程迁移/控制器开关权限。
父 Pod 限额、继承的有效 cpuset、缺失控制器、可写文件或错误 Job ID 均不能当成有效作业证据。
v1/v2 离线夹具共 9 项，含多组失败输入，已接入 Bun 测试入口；Python 3.8 语法检查通过，未新增依赖。

实际受限 systemd 单元实验退出 0：外层 1 CPU/256 MiB/32 Tasks/45 秒，内层按作业设限；
非 root 校验、父级限额拒绝、身份/权限/逃逸拒绝、quota 与独立 cpuset 两种核验通过。
两个短循环触发真实 CPU 限流；64 MiB 作业中 128 MiB 分配被内核 SIGKILL，oom_kill 计数增长，控制进程继续完成。
临时单元和文件清理完成，没有启动真实调度器，也没有修改常驻主机配置。

现有 Slurm 实验关闭 task/cgroup，OpenPBS 23 缓存官方 hook 使用 v1，而本机为统一 v2。
检查器尚未自动接入 trusted wrapper、SelfAccount 或能力发布，仍须完成真正的调度器配置与联合执行验证；
不能用本次内核布局实验替代 Slurm/PBS 验收。细节与命令见[计算节点资源检查](../../../deploy/federation/sandbox-cgroup-lab.md)。
其余蓝图、远程预览与最终验收保持原范围，未推送、合并或部署。

本轮全仓 lint 通过（原有 47 warnings/1 info），全仓 typecheck 含 protobuf 生成与实验脚本通过；882 个文档目标及 diff 检查通过。未改生成文件、依赖锁或数据库迁移。


## PBS cgroup v2 的真实调度作业

核对缓存 OpenPBS 23 与上游官方 hook，均未提供 v2 控制文件支持。新增可由 CP 在明确队列上部署的原生 MOM hook，
读取单 vnode 的实际分配建立 cgroup；launch/attach 再核对后迁入 PBS 指定进程，结束时确认整个原分组停止再删除。
未选队列不迁移；拒绝多节点、未知 vnode 资源、漂移限额、旧进程未停止的 Job ID 复用。hook 使用 PBS 的 builtins 加载入口。
配置与父路径须 root 管理，锁序列化原作业组操作；不自动删除无法核实的中断孤儿任务。

6 项离线测试已进入常规 Bun 边界测试入口。独立 PBS Pod 的真实作业退出 0：
非 root 检查器读到 1 CPU/64 MiB 的本作业限额，CPU 限流计数增加 19，128 MiB 分配触发 oom_kill=1；
尝试迁出分组被拒绝，PBS end hook 删除原 cgroup，临时 namespace 已确认不存在。
初次失败后补充 stdout/stderr/MOM 诊断，修正原生 hook 入口，未放宽检查。
实验分支已整理进既有一次性运行器的 cgroup case，公开入口静态检查通过，未重复部署。

配置及复现见[PBS cgroup v2](../../../deploy/schedulers/pbs/cgroup-v2.md)。检查器与 trusted wrapper/SelfAccount 的强制集成、
启动/队列能力发布、Slurm 配置、MOM/主机中断恢复以及带签名资源的完整联合验收仍待完成。
其他蓝图目标、PR 预览及用户最终验收范围保持不变；未推送、合并或远程部署。

本轮全仓 lint（原有 47 warnings/1 info）、全仓 typecheck（含 protobuf 生成及实验脚本）、888 个本地文档目标与 diff 检查通过。未改生成文件、依赖锁或数据库迁移。

## trusted wrapper 强制逐作业资源检查

Agent 从已验证清单传递 CPU/内存值，trusted wrapper 核对本地 root 配置的检查器摘要、调度器类型及原生作业编号，并在 Apptainer 前核对实际 cgroup。使用系统 Python 的隔离导入模式；遗漏配置不从环境变量继承。依赖漂移、缺少限额、伪造编号均拒绝，用户脚本不会运行。启动 `--check-profile` 只检查文件，不作为逐作业能力证明。

PBS 实验复用一个受限 Pod 内的 hook 安装入口，组件与双平台介质运行器均在提交前安装。旧 Slurm 19 实验仍无逐作业 v2 配置，因此新执行入口会拒绝其作业，须完成现代 Slurm 配置后再验收；没有以关闭检查恢复旧实验。SelfAccount、其他 root 路径、启动/队列能力发布和完整蓝图其余项仍待完成。

本轮 32 项相关 Bun 测试通过（其中两项执行检查器 9 项、PBS hook 6 项 Python 用例），覆盖实际 wrapper 的拒绝顺序、依赖篡改、配置缺失/环境继承、伪造原生 Job ID 及三类 HPC 参数绑定；配置继承测试修正夹具以排除先行摘要失败后单独复验通过。

两套独立 Server/数据库及 mTLS Agent 的真实 PBS 联合流程通过：DATA_WAITING→加密导出/导入→来源使用批准/显式发布→版本映射→受限执行→来源 HTTP 撤权→原许可到期→同一 PBS Job 终止且持久停止证明为 true。执行入口已强制资源检查；运行中内核快照为 cpu.max=100000/100000、memory.max=134217728、swap=0，原分组 populated=1。最终 Job 为 F/Exit 265；实际数据读取、只读、seccomp、no-new-privs 与禁网检查通过。仅使用合成输入和轻量 Bash/SIF，没有科学编译，未重复旧 Slurm 验收。

联合命令最终退出 0，隔离 namespace 已确认删除；未推送、合并或远程部署。原始证据保留于本地 temp，不纳入版本控制。

全仓 typecheck（含 protobuf 生成和实验脚本）退出 0；全仓 lint 通过（原有 47 warnings/1 info），891 个本地文档目标、Python 3.8/Bash 语法及 diff 检查通过。生成文件、依赖锁和数据库迁移未改动。

## SelfAccount 逐作业资源与队列证明

启动探测不再用 cgroup 路径正则冒充资源证明，改为在明确 Slurm 队列中申请 1 CPU/128 MiB 后调用固定摘要检查器。证明 ID 绑定检查器路径/摘要和队列；每次作业执行前核对 root 所有权、完整父目录链、摘要，并执行同一份已读取的字节，避免验证与运行重新读取路径。使用 `/usr/bin/python3 -I`；原生 Job ID 必须与当前内核分组匹配，资源来自已验证签名清单。

新增两个检查器配置项，原有 attestation queue 对 SelfAccount 变为必需。队列经 protobuf `attested_queue` 上报；Server 签发前与 Agent 提交前核对明确目标队列，联邦续租同时绑定原 Job/outbox，不允许默默换默认队列。检查器/队列作为本地事实保留到持久任务，旧记录可轮询/停止但不能据此重提。无数据库迁移或新依赖。

首轮相关单测通过；gRPC 测试最初缺少隔离数据库导致连接 localhost 默认端口失败，已改在独立随机端口 PostgreSQL 中重验通过，没有连接部署数据库。续期测试覆盖证据队列缺失、替换，以及原 Job/outbox 队列被改动。原有 SelfAccount 非 root 暂存测试在 root 下曾直接 return，现显式 skip；另外通过私有 mount namespace 将源码只读映射给实际 nobody 账号，执行该用例及新增的持久化恢复断言，共 8 项断言通过，挂载/目录已清理。没有放宽宿主 `/root` 权限。

此轮尚未运行现代 Slurm 原生调度器，不能以脚本替身或实际非 root 暂存测试宣称 SelfAccount 调度资源验收完成。下一步仍需 Slurm v2 配置、真实 SelfAccount 作业及其他 root 路径的启动/队列能力证明；完整蓝图及预览交付范围保持不变。

验证收尾：Agent/执行器/传输单测通过；隔离 PostgreSQL 中的授权用例及完整 gRPC handler 用例通过，新增队列变更用例使用原任务和原 outbox。初次全仓 typecheck 发现两处测试夹具类型声明不完整（可选配置值的严格断言、选择目标夹具缺少 queueName），已修正；其他包通过，Agent、Server 及实验脚本分别定向重验通过，没有重复已成功的包。全仓 lint 通过（原有 47 warnings/1 info），最终改动文件 Biome、protobuf lint、891 个本地文档目标及 diff 检查通过。依赖锁和数据库迁移未改动，protobuf 由生成工具更新。

隔离 PostgreSQL、非 root 私有挂载及临时目录均已清理。仅缓存了固定平台摘要的 Ubuntu 24.04 公共镜像供下一轮 Slurm v2 实验，尚未启动新 Slurm 容器或原生任务；未推送、合并或远程部署。

## 现代 Slurm v2 的原生检查与回收

新增可重复的本机 k3s 入口，固定 Debian 13 amd64 摘要和 Slurm 24.11.5 二进制包。一次性 Pod 上限 1 CPU/1 GiB、600 秒；通过 cgroup/mount/PID namespace 将 Slurm 的控制器操作限制在自身实验子树内，Slurmd 使用独立 service 分组。无科学编译、无宿主 Slurm/systemd 修改。控制器失败或取消请求清理 namespace。

原生 sbatch 作业以 UID 24001 执行实际产品 SelfAccount 检查命令，读取独立 cpuset=1、memory.max=134217728、swap=0，作业完成后原 cgroup 被 Slurm 删除；最终入口退出 0，namespace 已确认不存在。较早 Slurm 23.11 的 namespace 回收实验出现 EBUSY，未计作通过；24.11 原生回收已验证。

本轮只覆盖资源检查与回收，未覆盖完整启动证明、签名 SIF/Apptainer、跨平台 SelfAccount 派发或 Slurm 的 OOM/限流负载。完整蓝图和 PR 预览范围保持不变。未修改 TypeScript、依赖或数据库；未推送、合并或远程部署。

## SelfAccount 真实运行与启动探测修复

发现原启动探测将命令任意失败当作 seccomp/禁网成功，且不必要地要求正式策略禁止 uname。改为同镜像、同隔离参数的固定对照：未加载待测策略时 uname 可执行、回环连接返回明确连接错误；正式策略下 socket 返回 EPERM；专用 probe 下 uname 返回 EPERM。固定 C locale，要求退出码 1，命令缺失、超时和启动失败均拒绝；同时检查仅存在回环接口，探测不再访问公网。专用 probe 策略摘要绑定证明 ID。真实 Bash 回归覆盖正常路径及八种拒绝情形。

扩展现代 Slurm 入口，在原 1 CPU/1 GiB、600 秒上限内验证真实 SelfAccount：Pod 内签名 SIF，非 root 账号调用产品启动证明，然后使用临时机构密钥构造签名任务，执行产品验签/nonce/暂存/Slurm 提交。实际输入只读、seccomp/no-new-privs、socket EPERM、输出 JSON 与大小校验通过；原生 Job 3 COMPLETED/0，实验入口退出 0。额外断言重放 nonce、未验证队列和资源篡改拒绝。

前两次失败揭示实验镜像与缓存 helper 的 FUSE ABI 不兼容，改用 Debian 13 配套 squashfuse 二进制，不放宽产品检查。临时签名私钥已删除，namespace 已清理。原始证据位于本机 temp；没有科学编译或常驻服务更改。

此处由本地临时密钥代替 Server 签发，不包含双平台联邦派发/介质、跨节点或掉电恢复。SelfAccount 的 restrictedNoEgress 不在支持范围；受控 root profile 和其他能力证明仍需各自验收。完整联盟链蓝图与 PR 预览保持原范围，未推送、合并或远程部署。

本轮相关 12 项单测通过；随后新增 probe 摘要绑定断言，定向重验启动证明 4 项/43 断言通过。全仓 lint 通过（原有 47 warnings/1 info），全仓 typecheck 含 protobuf 生成和实验脚本退出 0；893 个本地文档目标、Python 3.8 AST、Bash 语法及 diff 检查通过。生成文件、依赖锁和数据库迁移未改动。没有因观察超时而重启任何检查或实验。

## 原生探测生命周期与 root 账户边界

检查 root 能力接入时发现，原 SelfAccount 的 sbatch --wait 超时只结束客户端，finally 却直接删除探测文件，不能确认调度器原任务已停止。现改为复用原生 adapter 提交/轮询/取消：每次 CLI 有限时，成功须原 Job COMPLETED/0 与安全节点标记；超时/查询失败仅取消原 ID，正向停止证明通过后才删除。提交结果未知或停止不明保留收据与文件。原子创建固定 .attest-active 目录，历史 .attest-* 阻止新探测，避免周期刷新或并发进程重复提交。收据更新使用临时文件加 rename，保留原 UUID/队列/时间及已知调度器编号；未宣称主机掉电持久性或自动恢复已完成。

root 使用该入口时保持脚本和父目录由 root 管理，仅日志目录由明确非 root 探测账户写入。真实 Slurm 实验通过：产品 SelfAccount 新入口仍完成 SIF 启动证明与签名 Job 3；root 发起的 Job 4 实际 UID 24001、独立 1 核/128 MiB；Job 5 超时后被原账户取消、原 PID 消失，停止确认后文件清理。最终实验命令退出 0，namespace 已确认删除。只有轻量脚本，没有科学编译或远程变更。

本轮是 root 启动证明的共享执行入口与 SelfAccount 失败收尾修复。生产 root 仍未从配置开关切换为真实证明；root 探测账户配置、完整 SIF/ECL 证明、PBS/Torque 实际调度与 Server 签发/续租绑定仍须接通。完整蓝图、跨平台联合验收和 PR 预览保持原目标。没有推送、合并或部署。

验证：相关 14 项单测/90 断言通过，新增并发用例 1 项/5 断言通过；真实 Slurm 入口退出 0。全仓 lint 通过（原有 47 warnings/1 info）。全仓各产品包类型检查及 protobuf 生成通过；实验脚本首次检查发现可变 PID 在回调中的类型收窄丢失，改用已校验常量后实验脚本重验退出 0。新增遗留/并发保护后 Agent 定向类型检查通过，最终改动文件 Biome 通过。893 个本地文档目标、Python 3.8 AST、Bash 语法及 diff 检查通过；无生成文件、数据库迁移或依赖锁变更。

## 完整 root 原生启动证明与 OpenPGP

扩展实际探测函数支持明确的 root 探测账户：拒绝 root/无效/歧义 passwd 记录，CLI 通过 setpriv 与最小环境切换身份，节点脚本核对实际 UID/GID。复用 Slurm/PBS Pro/Torque adapter 及已完成的原生探测收尾；资源检查器分别绑定 SLURM_JOB_ID/PBS_JOBID。SelfAccount 仍只支持 Slurm。

修复 root 签名契约：ECL 使用 OpenPGP，新增固定 PGP 指纹配置，与 PEM 路径/摘要配置互斥。验证全部 SIF 对象、文件系统存在及每项记录的指纹/签名/数据校验，强制 --local 不访问 keyserver。实际实验发现 KeyLocal 只描述个人 keyring，源码确认全局受信 keyring 可以为 false；验证仍要求明确固定指纹与全部完整性结果。ECL 负例必须返回明确签名拒绝和退出码 255，不能接受任意错误。节点还校验 buildcfg 实际配置目录及 ECL/反例 SIF 摘要；账户、指纹和反例摘要纳入证明 ID。探测失败原因现在记录到 Agent 日志，公开 readiness 仍保持固定错误类别。

真实 Slurm 最终入口退出 0：原 Job 6 由 root 发起、实际 UID 24001，完成签名 SIF、ECL 负例、seccomp、禁网和逐作业 1 核/128 MiB；返回完整 root 证明，namespace 清理已确认。前两次失败定位了混合 PEM/PGP 契约和 KeyLocal 语义，不计为通过。私钥只在临时 Pod 中生成并删除，另一个用于确认 JSON 格式的本机临时 keyring/SIF 也已删除；没有改动宿主 keyring、科学编译或远程部署。

完整 root 探测接口已具备证据，但主启动/能力发布仍未接通。下一项必须一起处理：root 能力不再采信布尔开关、启动及刷新调用真实证明、失败后恢复 processor/profile、所有 HPC 逐作业命令使用固定检查器/策略、明确队列和节点约束，以及 Server 首次签发与联邦续租绑定证明。PBS 启动脚本须先安装原生 cgroup hook，再获取证明；现有双平台脚本要补齐探测账户、PGP/ECL/反例和队列配置。不能只打开能力发布而保留未核验的 root 逐作业或默认队列路径。其他蓝图及 PR 预览目标保持不变。

验证：启动证明/账户/配置/资源命令共 64 项相关用例通过（分两批，373 + 10 断言）；真实 Slurm 完整入口退出 0。全仓 lint 退出 0（原有 47 warnings/1 info），全仓 typecheck（含 protobuf 生成、所有产品包和实验脚本）退出 0。894 个本地文档目标、Python 3.8 AST、Bash 语法及 diff 检查通过；没有手工生成文件、迁移或依赖变更。


## root HPC 派发主链路与逐作业约束

已把 root 探测接口接入 Agent 主启动和周期刷新，HPC 能力从实际证明构建并排除过期缓存，不再相信手填安全开关或 signatureVerified。处理器在首次证明失败后仍可恢复，验签始终检查证明；restricted profile 随证明重新验证，清除失效身份。Server 首次签发绑定证明，联邦续租核对原 Job/原 outbox 队列并限制在证明期限内；Kubernetes 走独立验证路径。

所有新 HPC 作业都复制本地证明事实，固定 Apptainer/策略/检查器、资源与队列，Slurm/PBS Pro/Torque 分别使用 nodelist/host/nodes 和原生 Job ID，执行前核对实际 hostname。普通 root 作业也加载 seccomp，受限 profile 保持 trusted wrapper。root 调度 CLI 使用最小环境，旧作业仍可监控/停止。当前只选择证明中首个节点，不推断其他队列节点或 PBS 别名已经验证。

真实 Slurm 完整入口退出 0：SelfAccount Job 3、root 探测 Job 6 和 root 签名执行 Job 7 均完成；Job 7 以 UID 24001 验证只读输入、实际禁网/资源限制和 JSON 输出。原生资源探测及原 Job 超时取消也保持通过。首次新增样例因遗漏派发公钥而失败，补齐临时公钥后通过；两次 namespace 均确认删除。原始证据保留本机 temp，不纳入版本控制。

PBS bootstrap 已保留 ECL 反例、固定 PGP 指纹与策略/检查器摘要，并在 Agent 启动前安装原生 hook。双平台介质实验正在复验。完整蓝图和 PR 预览仍保持原目标，不能将本轮 root 链路视为整体完成。

PBS 联合实验定位并修复首次启动目录缺失：证明函数先以 0700 创建 managed root，再检查规范路径/所有权/权限，root 探测只开放目录穿越权限。三类原生适配器测试均覆盖新目录创建。真实 PBS 随后完成原生探测 Job 0（F/0），Agent 与 restricted profile 都为 ready；数据包导出、解密校验和授权发布通过。该次后续派发被平台 95% CPU 门槛拦截（实际报告 98%，同时有全仓类型检查），未算作联合运行通过。等待静态检查结束后单独复验，未调整产品负载门槛。较早一次挂载参数误传文件路径已终止清理，实验入口增加 age 工具目录检查；这些失败没有算作通过。

最终 PBS 双平台复验在静态检查结束后单独运行，完整命令退出 0：真实 root 启动探测 Job 0 为 F/0，能力/profile 就绪；加密包导出、目标 Agent 解密/校验、签名回执、来源使用批准和目标显式发布通过。DATA_WAITING 自动恢复，原生 Job 1 以已签名资源在 workq/已证明节点运行，读取导入只读数据、seccomp/no-new-privs 与禁网断言通过。来源撤权后原 Job 为 F/265，正向停止确认成立且进程标记消失；数据副本和交付回执保留。临时 Server/数据库/凭据与 namespace 清理均确认。没有降低负载门槛、使用生产凭据、科学编译、推送或远程部署。

检查结果：Agent sandbox/adapters 目录 427 项通过（两项需独立非 root/介质环境的用例按现有条件跳过）；新增和受影响用例另经定向运行通过，包含 root 丢失/过期证明、队列/节点/检查器约束、首次目录创建及 Server 首次签发拒绝。实际 Slurm 和 PBS 链路补充上述原生证据。隔离 PostgreSQL 54 项通过，覆盖 root/SelfAccount 原证明、原 Job/outbox 队列及期限绑定。最终全仓 lint 退出 0（既有 47 warnings/1 info），全仓 typecheck（含 protobuf 生成、产品包和实验脚本）退出 0；352 个相关本地文档目标、Python 3.8 AST、Bash 语法和 diff 检查通过。无生成文件、迁移或依赖锁变化。

此处完成 root HPC 证明到实际派发/续租的一致接入，仍不将完整联盟链目标标为完成。后续保留：跨平台 SelfAccount、Torque 原生矩阵、探测收据自动恢复、跨主机/掉电与完整存储恢复、其余交付/治理/支付争议/归档及 Web/CLI，最后才是完整 PR 预览验收。


## 原生探测进程中断恢复

原 `.attest-active` 会在 Agent 异常退出后永久阻止后续启动证明。现复用仓库已有 util-linux flock 模式，持久锁文件不删除，内核锁随进程退出释放；锁覆盖恢复、提交、停止确认与回收。收据 v1 记录 UUID、调度器、明确队列、实际执行用户名/UID/GID、时间、阶段及已知原生编号。各阶段原子替换并 fsync 文件及目录；准备目录先保存收据再发布，停止确认后先持久退役目录再删除，避免创建/删除中断留下无从判断的活动记录。

恢复先按原 UUID/作业名/提交时间/执行身份查询，要求唯一匹配，已知原生编号不能变化。只有正向确认停止或取消原任务后确认停止，才重做完整探测；不使用旧输出生成证明。not_found 不代表提交失败，不自动重投；旧格式、损坏/不安全收据、账号/队列/调度器变化和不明停止状态保留现场。prepared/submitting 不允许携带原生编号，submitted 必须携带，矛盾记录不自动清理。root 调用者传递原执行用户名，SelfAccount 使用实际进程身份。

48 项受影响测试通过，覆盖真实子进程 SIGKILL 两个时点、活动锁排他、恢复时原任务查找/取消/停止与唯一新提交、阶段矛盾、软硬链接/权限/大小边界、未提交/已停止及部分准备/删除目录清理。真实 Slurm 24.11 入口完成同样两个中断时点：原 Job 6（响应未返回）、8（编号已持久）在探测进程 SIGKILL 后仍存活；产品恢复按原 UUID 找回、取消并正向确认停止，原 PID 分别消失，随后新 Job 7/9 各只提交一次并产生新证明。SelfAccount 与 root SIF/签名执行也通过，完整入口退出 0，namespace 已确认不存在。证据在 temp/kq-slurm-cgroup-365159a6，原始日志不纳入版本控制。

该改动未增加协议/数据库迁移或依赖包；Agent 运行环境需 util-linux flock 和可靠的文件锁、原子 rename、fsync。跨主机共享锁、实际整机掉电及后续完整蓝图/PR 预览仍待验收，没有以此缩减原目标。

复查新增原生编号格式检查：提交响应和恢复查询中的非法编号不进入取消/状态命令，保留未知收据，避免将异常内容当作 CLI 参数。40 项原生探测单测通过；补强的三项相关断言定向复验通过，未重复实际调度实验。真实实验使用边界加固前已打包的实现，其收据/锁/查找/停止/重投路径与最终实现相同，加固仅额外拒绝非法编号。此前 10 项 runtime-attestation 回归通过。首次及边界加固后的最终全仓 lint/typecheck 均退出 0，包含 protobuf 生成、全部产品包与实验脚本；lint 保持既有 47 warnings/1 info。354 个相关本地文档目标、Python 3.8 AST 与 diff 检查通过。无生成文件、数据库迁移或依赖锁变化。


## SelfAccount 双平台派发与恢复入口

复用原 direct 运行器新增显式 SelfAccount 选择，不引入另一套联邦 API 或调度器。提供方以 UID/GID 24001 运行产品 Agent 与 supervisor/watchdog，Server 关闭 impersonation、显式启用 SelfAccount，按真实登记的 Slurm 队列、SIF 证明和映射账号签发。临时 Pod 使用既有现代 Slurm v2 隔离布局；补充真实 slurmdbd/MariaDB，使原计费验收仍核对调度器原始时长，不能伪造 sacct 或跳过账务流程。

新增两步轻量文件工作流的实际进程中断：第一步报告开始且 Slurm 为 RUNNING 后，SIGKILL 提供方 Server 与实际非 root Agent；原状态和原生作业保留。预期恢复后原 UUID/原生编号/派发轮次不变，每个 UUID 一次原生提交，完成下游及独立源平台下载。脚本检查真实签名模式、身份、证明、资源、Slurm 状态/退出码与 SHA-256；尚待本轮完整运行，不能视为联合验收通过。普通 SelfAccount 不用于需要 root 受限 profile 的介质数据。


前三次运行未计为通过：第一次发现 Slurm 24.11 已移除旧 AccountingStoreJobComment，改用 AccountingStoreFlags=job_comment；第二次探针误按普通作业目录读取沙箱日志，现按原 UUID 精确绑定沙箱及保留日志；第三次作业退出 127，但探针未保留失败日志，不能认定具体原因；检查发现轻量 SIF 不包含 id/grep，已将脚本改为 Bash UID/字符串检查和已有 cat/sleep，仍校验实际 UID、seccomp/no-new-privs 与 socket EPERM。三次临时环境均清理，尚未完成进程恢复联合验收。

实际启动另暴露产品 watchdog 先于 Agent 建表读取空 SQLite 的竞态。watchdog 现在等待 Agent 创建原 inbox 表后开始巡检，不执行迁移、不连接 Server、不提交任务；等待中可正常停止，数据库错误仍向外抛出。新增两个真实子进程测试验证空库等待、不偷偷建表、原进程随 Agent 初始化恢复及等待中 SIGTERM 退出；连同原 watchdog 12 项，14 项通过。全仓检查进行中，完成后才重新运行原生实验。

第四次真实运行已观察到 watchdog 在同一进程中等待建表后就绪，但工作流在重启注入前失败：Apptainer 尝试 bind 尚未生成的可选输出文件。产品 Unix stager 现按签名容器输出名准备本作业专用 outputs 目录，三类 HPC adapter 共用目录挂载，输入仍逐项只读；构造命令时拒绝非本作业目录、名称不匹配和特殊路径。不预造可选空文件，收集仍区分不存在、空文件和有效内容，只发布已声明产物。旧已运行作业继续按原持久路径监控/收集。第四次 namespace 已删除，完整联合验收仍待完成。相关 sandbox/adapters 测试 475 项通过，两项保留其既有环境条件跳过；全仓静态检查进行中。

第五次真实作业原生 COMPLETED/0，输出含禁网/身份检查后的开始标记和计算结果，证明可选输出挂载已修复；但短 stdout 经限长管道缓冲，直到结束才被中断探针看到，未注入任何重启，不能计为恢复通过。探针现观察同一作业已声明结果文件中的临时开始标记（脚本最终覆盖为真实结果），同时要求原生 RUNNING，避免依赖日志刷新。第五次 namespace 已确认删除。产品代码检查此前全通过；本次仅调整验收夹具，按仓库规则重新做静态检查后复验，不重复无关调度测试。

第六次完整入口退出 0。提供方 Agent/supervisor/watchdog 实际 UID/GID 24001，首次建表等待正常；已签名模式/证明、seccomp/no-new-privs、socket EPERM 通过。脚本写出开始标记且原生 Job 2 为 RUNNING 后，SIGKILL Agent 与提供方 Server；supervisor 拉起新 Agent，原状态 Server 重启，原 Job 2 仍运行。恢复后的 UUID、原生编号、dispatch epoch 均不变，每个 KQ UUID 仅一个原生作业；下游 Job 4 正常完成，两者均 COMPLETED/0。可选输出保留未生成语义，两个声明产物精确为 3/12 字节，来源 Agent 下载到独立存储、版本化下载与签名回执/重放通过。

真实 slurmdbd/sacct 分别报告 61 秒、1 秒，双方签名报告为 62,000 毫秒；账单原额 62，按任务上限封顶为 10，独立机构预授权自动生成和对签账单、结算，并完成两次追加调整和原文重放，双边账目守恒且没有链待办。没有使用计量替身。证据保留本机 temp/federation-execution-direct-sigc6_y_，原始记录不纳入版本控制；checkout 中所有源文件 SHA-256 与最终实现相同。临时 Server/数据库/凭据已清理，namespace kq-federation-live-60d02d0f 已确认不存在。

验证：sandbox/adapters 475 项通过（两项按既有独立环境条件跳过），watchdog 相关 14 项通过；最终全仓 lint 退出 0（既有 47 warnings/1 info），全仓 typecheck 含 protobuf 生成、全部产品和实验脚本退出 0。Python 3.8 AST/内嵌探针、Bash 语法、文档目标和 diff 检查通过，无手工生成文件、迁移或依赖锁变化。未重复无关 PBS/科学编译或负载实验，没有降低 95% 产品门槛。

此次完成普通 SelfAccount 双平台进程恢复链路，不代替 restricted 数据执行、跨主机/掉电、Torque 原生矩阵、其余交付/治理/支付争议/归档及 Web/CLI，也未完成整个蓝图或 PR 预览验收。


## 介质、批次与交接记录

新增独立 media.logistics 权限和中英文管理说明，主 Server 接通介质登记/查看/版本更新、批次登记/查看及追加交接接口。仅允许当前组织的人员；只关联本站组织已有导出或接收包，批次固定同一收发双方与清单摘要，不复制密钥或数据清单。物理记录不能授权解密、导入、使用或删除副本，也不要求 Fabric。

Drizzle 生成迁移 0166，四张表保存介质、不可变批次、活动占用和交接事件。固定顺序锁与活动占用唯一索引防止重复分配；版本/事件 ID 限制并发推进和响应丢失重试，终态重放不误停用后来复用的介质。返还、交付结束、停用和销毁分别记录；丢失/损坏原子停用介质，状态/占用/审计失败回滚。空间、物理拷贝和物流真实性不由人工状态证明。

隔离 PostgreSQL/HTTP 21 项通过，包含原包登记/批准回归和新增运输约束；来源方另经真实 age 生成签名清单，多包/多介质批次、顺序无关重放和来源不能跳过寄出状态专项 1 项通过（原出口测试中 65 项未变化用例按名称过滤）。两套数据库均从空库迁移并已清理。最终全仓 lint 退出 0（既有 47 warnings/1 info），全仓 typecheck 含 protobuf 生成、全部产品及实验脚本退出 0；352 个本地文档目标与 diff 检查通过。Web/CLI、跨站签名交接、目标副本删除及完整蓝图/PR 预览仍待完成。设计和接口见[介质运输记录](media-logistics.md)。

本轮不改 Agent、链码或依赖锁，不重复已完成的原生调度/科学计算实验。迁移和 snapshot 由 Drizzle 生成，没有手改生成文件。数据库/HTTP 使用隔离人员身份，不代表正式登录或真实跨机构物流验收；未推送或部署。


## 介质运输 Web 与 CLI

2026-11-09：“机构合作”新增介质运输页签，提供介质登记/版本更新、跨页勾选现有介质和包创建批次、批次详情及追加交接时间线。UI 复用既有布局和双语文本，状态控制可用动作；切换登录/机构清空表单，写请求固定上下文。首次提交冻结 UUID、时间和正文，响应不确定时保留原请求重试。共享响应 schema 检查站点/组织/记录身份；客户端 PATCH 同样固定当前会话。CLI 增加 media devices / packages / shipments 命令与 JSON 文件写入。

新增只读物流上下文与摘要清单，复用既有权限，按组织查询出口/接收包的必要 JSON 字段，避免加载完整清单或密钥。站点名称仅关联本页涉及站点；保持原包摘要和许可隔离，无新增迁移或依赖。

实际验证：接收侧隔离 PostgreSQL/HTTP 22 项，来源真实 age 专项 1 项，CLI HTTP 40 项，Web/API 客户端 32 项通过。受控浏览器完成新批次创建和交接查看，7 张桌面/手机、中英文/深色截图无页面错误或溢出。浏览器仅模拟 HTTP，数据库测试注入人员身份，尚未构成登录 PR 预览的联合验收；不重复原生调度器和离线科学软件矩阵。运行方式与具体边界见[介质运输记录](media-logistics.md)。

静态收尾：全仓 lint 退出 0（既有 47 warnings/1 info），全仓类型检查暴露的新增测试参数和 unknown 类型问题已修正，Web 与 Server 定向重查均退出 0；其余包及未变化的 Fabric 实验脚本已有通过结果。178 个本地文档目标和 diff 检查通过，临时数据库与本轮 Vite 服务已清理。未推送或部署 PR 预览。


## 任务介质的对象流基础

2026-11-09：核对私有任务文件存储后，确认不能复用只接受 Data Market 受管目录的导出选择器。新增 Agent 内部版本化对象读取器及包/代次/成员绑定，按本机允许的 HTTPS origin 和最多 30 秒许可读取 1 MiB 窗口，拒绝重定向、版本变化、错误范围及内容摘要；读取完再核对当前授权。空文件使用版本化 GET 核对零字节，避免对 GET 预签名发 HEAD。受管目录与对象源共用流式归档，不增加源端整包明文暂存；原路径、硬链接和变化检查保留。

28 项相关测试通过，含真实 TLS、实际 age 加解密的任务输入/结果包、元数据恢复和原本地介质出口回归。未重复原生集群实验。当前没有生产任务对象命令/许可签发，也未放开 Server 中仅数据集可运行的保护；原任务审批、接收上传和原子发布、DATA_WAITING 恢复、Web/CLI 及完整端到端验收仍需接通。具体接法与剩余组件见[任务介质交付](task-media.md)。

本轮最终全仓 lint 通过；类型检查中的新增测试 Buffer 类型已修正，Agent 重查、其余包与单独执行的 Fabric 实验脚本类型检查均通过。179 个本地文档目标与 diff 检查通过，临时 TLS 服务及文件已清理；未执行远程部署或 PR 发布。


## 原任务介质的来源准备与密钥授权

2026-11-09：沿用原出口表和密钥服务接入 task-input/task-result，严格正文只选择原 operation、收方、协议和本站 Agent。输入沿原工作流所有人及不可变 invocation 快照，复核原委派/接单签名和取消状态；结果沿原执行身份、完成产物和双方 resultPolicy，允许独立结果期限内交付。读取对象版本保留在本站，清单保留 SHA-256，缺失 license/provenance 为 null。真实 age 身份生成后重新校验，原包重放不能更换选择器、期限或文件版本。

迁移 0167 由 Drizzle 生成，数据集与任务选择器互斥；未伪造 Data Market 外键。密钥响应在认证对端后预读外部授权，事务内重新检查原批准，期限覆盖当前协议/请求签名密钥与协调模式确认；直接模式不引入 Fabric 依赖。运行入口仍拒绝对象任务，避免旧 Agent 当成本地目录处理。

首轮新增测试 9 项通过，另 2 项测试代码自身错误（取消方法名、Drizzle 惰性查询未执行）修正后，11 项 PostgreSQL/HTTP/真实 age 专项全部通过。覆盖跨组织/任务/Agent、工作流取消、版本/所有权变化、回执改动、混合选择器、独立结果期限、缺失产物、生成期间变化与密钥零化、密钥绑定/期限/重放。测试在本机隔离双方记录，不是协调模式实际链或完整介质联合运行。Agent 对象命令、版本化许可签发、接收上传/原子发布和完整蓝图/PR 预览继续保留在目标中。

回归验证：原数据集出口 66 项通过，任务介质与相关原委派/网络输入/结果测试 33 项通过（包含上述 11 项）。整组运行发现旧物流用例把同组先前创建的包误当成额外数据，改为核对新增包；另修正新增测试导入时误插入的调用参数，相关原路径复验通过。全仓 lint 通过（既有 47 warnings/1 info），356 个本地文档目标和 diff 检查通过。临时数据库已停止清理，未重复原生调度器或科学软件安装实验。

最终静态检查：全仓 lint 退出 0。全仓 typecheck 中的数据集元数据类型和测试参数问题修正后，Server 最终重查退出 0；其余产品包/protobuf 生成和单独的 Fabric 实验脚本类型检查均通过。生成迁移未手改，没有新增依赖。只提交本地实现，尚未推送或部署 PR 预览。


## 任务介质来源对象派发

2026-11-09：复用原导出持久操作/代次/租约/回报，新增对象命令分支和显式双方能力协商，固定本站对象版本并按 Agent 本地允许的 HTTPS origin 流式进入 age。Server 在存储 I/O 前后复核原任务、操作人员和文件绑定，实际签名 URL 不超过许可且必须含正确版本参数；旧 Agent 不收到对象命令，断线旧通道不收到新凭据。Agent 校验清单完整成员映射和最终授权后才原子发布，重试保留原密文，原容量/工作锁/恢复逻辑继续共用。

20 项来源数据库测试、66 项原数据集回归、6 项数据库 gRPC 测试通过。4 项实际 Agent 子进程 TLS/age 样例验证输入/结果加密导出、解密、密文重放和错许可/最终撤权不发布；再以固定 RustFS 镜像、生产 MinIO 客户端和真实版本签名 URL 通过 1 项存储实验：覆盖同名对象仍只导出原版本。临时 namespace、随机凭据和证书已清理。首轮测试夹具的数据库未配置、reserveBytes 不足和旧模式断言错误已分别修正复验；没有以模拟 HTTP 或声明状态代替该项真实存储证据。

新增 Server `FEDERATION_MEDIA_OBJECT_DOWNLOAD_ORIGINS` 并由 Compose 透传；Agent 原 JSON 配置增加默认空的 allowedSourceOrigins。protobuf 只修改原定义并通过生成器生成，未手改生成文件，无迁移或依赖变更。目标任务上传/原子发布和 DATA_WAITING 恢复、跨平台/掉电与剩余完整蓝图、Web/CLI 和最终 PR 预览仍保持原目标。没有重复科学编译或原生调度器实验。

本轮静态收尾：全仓 lint 退出 0（既有 47 warnings/1 info），全仓 typecheck 含 protobuf 生成及各产品包通过；新增真实存储脚本的版本号类型收窄后，脚本类型检查另行通过。913 个本地文档目标、Compose YAML 与配置透传、diff 检查通过。未推送、部署或缩减完整 PR 预览目标。


## 任务交付方式持久化

2026-11-09：Workflow Federation 节点和原签名委派增加 inputDelivery/resultDelivery，分别选择 network/media；旧请求省略字段保持原摘要和网络行为。原输入/结果 import 保存模式并在领取许可时核对原任务，网络 worker 不领取 media，双方网络下载接口拒发对应数据凭据。来源介质准备必须与原签名交付方式一致，禁止重放时切换。任务清单/授权交换、原配额和独立结果期限继续复用。迁移 0168 由 Drizzle 生成；初次生成前字段定位错误已通过生成器撤回并重新生成，未手改迁移或 snapshot。

该项是任务介质接收的前置约束；尚未放开仅数据集可运行的保护，任务包上传/整包发布及原任务恢复继续推进。没有新增运行中切换或自动网络回退，完整蓝图和 PR 预览目标保持不变。58 项相关 PostgreSQL 用例及 25 项 schema/DSL 测试通过，覆盖旧网络输入/结果、来源介质、重启重放、方式篡改、禁止凭据签发、配额去重和取消。首轮发现可选字段 undefined 进入规范化签名，已修复为省略未设置字段；测试夹具的跨用例 pending 清单与错误文本断言修正后专项复验通过。隔离数据库均从空库迁移并已清理，未重复原生调度器或科学软件实验。最终全仓 lint 退出 0（既有 47 warnings/1 info），全仓 typecheck 含 protobuf 生成、全部产品和实验脚本退出 0；348 个本地文档目标与 diff 检查通过。未推送或部署 PR 预览。


## 任务介质的接收归属与批准

2026-11-09：主 Server 已沿原输入/结果 import 接通签名包登记、接收批准与内部密钥请求。输入保留原执行身份及当前原委派约束；结果只允许原委派所有人，验证原请求、回执、签名结果与工作流/输入/环境锁，保留独立结果期限。完整成员顺序、数量、大小和 SHA-256 均与原清单对应。缺少原预留导入清单时 DATA_WAITING，取消后旧包不能转绑新 import；新记录固定交付方式，不触发网络复制。

迁移 0169 由 Drizzle 生成，包增加方向互斥的原 import 外键，移除错误的执行方协议单向外键以支持结果返还。历史未绑定任务包保持不可授权，不自动猜测归属。任务包的人员 API 限原登记人，结果额外核对原任务所有人；Agent/root 属于原接收组织。原任务/import 先于包加锁，协调授权预取在事务外，密钥在远端响应前后重新核对并限于当前最短许可。注册/批准不发布文件，任务运行入口仍关闭，上传与整包原子发布继续推进。

16 项接收侧 PostgreSQL/HTTP 与实际 age 来源准备专项通过，含私有清单隔离、错任务/成员/Agent、未建立原导入清单、撤销、取消后替换 import、独立结果期限和网络往返中许可缩短。首轮将 JWS 字节摘要与规范化内容摘要混用的问题已修正，日期序列化断言修正后专项通过。原数据集接收/导出/发布 88 项回归、输入发布与交付方式 13 项回归通过；增加的接收方轮换密钥在往返中缩短期限专项也已通过。最终全仓 lint 退出 0（既有 47 warnings/1 info）。全仓类型检查中的新增测试 RSA 指数类型已修正，Server 最终重查退出 0；其余产品包、protobuf 生成及独立实验脚本类型检查均通过。349 个本地文档目标和 diff 检查通过。隔离数据库均已停止清理，未推送或部署。完整双平台实际介质交付、Web/CLI 及 PR 预览仍未完成。


## 任务介质隔离文件的 Agent 上传

2026-11-09：新增严格的 media-upload 内部任务绑定与 Agent 上传器，核对包签名、原任务内容摘要及成员，锁定私有工作目录并固定文件句柄。先校验源内容，再直接分片上传，不增加一份明文；读取/分片/完成分别检查当前授权，目标许可不能长于来源许可，最终路径/元数据变化或撤权拒绝回执。仅返回未提交分片，尚未接通 Server 派发与发布。复用的授权校验同时修复原数据集导入缓存可能超过短期许可的边界。

40 项新上传/句柄与 25 项原路径回归通过；实际 age→隔离文件→TLS PUT 已覆盖输入/结果、普通/空文件、多分片成功与中途撤权，来源/目标授权、文件变化、取消与错误消息脱敏也覆盖。首轮仅成功用例中的目录无序断言失败，修正后专项通过。没有重复科学软件或原生调度器矩阵，也没有启动远端任务。完整目标保持进行中：服务端唯一领取、独立校验、整包发布与恢复，以及后续完整联合验收、Web/CLI 和 PR 预览仍需完成。

静态收尾：全仓 lint 退出 0（既有 47 warnings/1 info）。全仓 typecheck 完成 protobuf 生成与其余所有产品检查；新增测试的联合类型、异步断言和 Buffer 泛型修正后 Agent 定向检查退出 0，独立 Fabric 实验脚本类型检查退出 0。最终回执授权移至文件状态检查之后，相关 6 项专项及 Agent 类型/lint 复查通过。350 个本地文档目标与 diff 检查通过。临时 HTTPS 服务及测试文件均已清理，没有推送或部署。


## 原任务介质领取与私有导入运行

2026-11-09：接通任务包的原 HTTP 排队入口、派发准备、来源密钥请求和私有校验报告，所有阶段重查原任务、操作人、当前领取及期限。生成迁移 0170 增加方向互斥、原 import 唯一活动领取及不可复用代次；失败重试/撤销替换须旧存储全部 cleaned，历史领取只标记释放，审计同事务。未触发对象上传或原任务发布，原配额保持保留。

16 项原接收专项、14 项新领取专项与 17 项数据集导入/发布/回执回归通过。新增来源 grant 轮换密钥夹具曾复用原 keyId，修正为独立标识后相关专项通过。任务专项使用真实 PG/HTTP 与进程内签名协议、注入 Agent 报告；没有宣称任务双平台真实运行通过。已识别后续上传续租不能覆盖原操作 latestGrant，否则会改变历史私有导入回执内容；上传阶段需独立保存/检查当前来源授权。目标继续保持完整范围，上传派发、整包发布、任务恢复、其他未完成蓝图项和 PR 预览仍需推进。

静态收尾：全仓 lint 退出 0（既有 47 warnings/1 info）。全仓类型检查已完成 protobuf 生成及其余产品；新增 HTTP 测试的 unknown 响应断言改为结构断言后，Server 定向复查与独立 Fabric 实验脚本类型检查均退出 0。351 个本地文档目标与 diff 检查通过。所有隔离数据库已停止清理；未重复科学软件或原生调度器实验，未推送或部署预览。


## 上传来源授权与历史回执隔离

2026-11-09：复用原 Agent 密钥请求的 JSON 体，新增显式 task-upload 用途，只接受已验证且持有活动领取的任务包；数据集不能借该用途获取许可。生成迁移 0171，把上传短期授权和请求令牌与私有导入历史回执分开。刷新前清空旧上传许可，网络返回后重新检查当前范围与令牌；并发迟到、来源失败、撤权和过期均不能恢复旧许可。内部上传快照及授权读取器已提供，未放开原网络上传 begin 保护。

10 项任务来源授权/生产传输适配器专项及 14 项原介质导入/回执/用途隔离回归通过。最初直接哈希 JSONB 读取顺序会误拒合法原查询，已按 schema 恢复原字节顺序后核对，并验证字段篡改仍被拒绝。未重复科学软件/原生调度器实验。尚待把领取固化到上传尝试、接入命令与能力协商、目标验证、原子发布、完整联合验收及 PR 预览；完整目标保持进行中。

静态收尾：全仓 lint 退出 0（既有 47 warnings/1 info）；全仓 typecheck 含 protobuf 生成、所有产品包及独立 Fabric 实验脚本退出 0。352 个本地文档目标与 diff 检查通过。隔离数据库均已停止清理，未推送或部署 PR 预览。

## 输入介质目标尝试与发布

2026-11-09：生成迁移 0172 为存储尝试绑定历史介质领取。本轮接通原输入生命周期，显式 claimId 才能开始介质上传；准备、许可、完成和校验持续检查当前领取与来源授权，续租不能复活过期尝试。校验阶段和整包发布刷新来源授权，全部成员须来自同一领取；原配额及原子文件登记复用。撤权后的迟到存储回报与清理继续可用。原网络 worker 不派发 media，没有新增存储实现或依赖。

11 项新 PostgreSQL 专项通过，覆盖原 FileBatch 多成员、私有回执不变、来源/本地撤权、领取变动、续租、迟到 allocation/completion 和清理。首轮夹具误认为单成员，已改为完整批次后通过；目标存储与独立校验报告为注入，未宣称真实对象传输或任务运行。结果接收生命周期、Agent 命令与 worker、纯介质配置和完整蓝图/PR 预览继续待完成，目标保持进行中。

回归：50 项原输入传输/存储/校验/发布及介质领取/来源授权测试通过，与本轮 11 项专项合计 61 项不同用例。全部使用从空库迁移的隔离 PostgreSQL，已停止并清理。353 个本地文档目标及 diff 检查通过；没有重复科学软件编译或原生调度器矩阵。

静态收尾：全仓 lint 退出 0（既有 47 warnings/1 info）。全仓 typecheck 已完成 protobuf 生成及其余产品；新增测试缺少 contentType 与结果类型收窄已修正，Server 定向复查和独立 Fabric 实验脚本检查均退出 0。最终 diff 检查通过。只保存本地实现，未推送或部署预览。

## 结果介质目标尝试与发布

2026-11-09：原结果生命周期已绑定介质领取，目标校验/发布刷新来源授权并保持独立结果期限。原机构和所有人在来源请求前校验，发布固定领取、成员及对象版本，沿用原配额、结果回执及原子登记。补上 multipart 创建后派发前的授权复查；撤权后的迟到上传 ID 和清理继续可用，清理后换上传代次不会丢失或重复占用预留配额。使用已有迁移 0172，无新迁移或依赖。

15 项新结果介质专项与 38 项原结果/领取回归通过，合计 53 项不同用例；首轮签名 URL 测试 helper 作用域错误已修复复验。测试为隔离 PostgreSQL、进程内签名协议、真实 age 来源准备及注入的对象存储/Agent 回报；数据库均已停止清理，不代表真实任务介质 E2E。接下来仍需 Agent 上传命令、能力协商、worker 与纯介质配置，随后完整双平台运行和所有其余蓝图项及 PR 预览。没有重复科学软件编译或原生调度器矩阵。

静态收尾：全仓 lint 退出 0（既有 47 warnings/1 info）；全仓 typecheck 含 protobuf 生成、所有产品包与独立 Fabric 实验脚本退出 0。354 个本地文档目标和 diff 检查通过。工作仅保存本地，未推送或部署 PR 预览。

## 任务介质 Agent 上传命令

2026-11-09：新增上传命令及双方能力协商，生成 protobuf，复用原来源密钥、目标分片许可和输入/结果复制报告。客户端按请求 ID/通道分流，固定两套代次，断线终止，和既有传输共用一个槽。来源刷新同时续租目标（仅申请第 1 分片许可，不发送 PUT），防止本地预哈希长于初始租约；实际许可和运行期限仍取来源/目标较短者。

39 项新测试与 15 项原导入/RPC 回归合计 54 项不同用例通过。2 项真实 age 私有导入→客户端→TLS PUT 已验证输入和结果真实字节；其余覆盖源/目标错误、跨通道响应、共享槽、断线和新旧能力门控。首次真实客户端夹具错误地复用旧导入公钥，且回调信号被当成新公钥参数，已拆成显式 authorizeForKey helper，修正清理调用后复验通过。protobuf lint 通过。实际存储完成/校验继续依赖前述原流程；后台自动派发、恢复、纯介质配置、完整蓝图与 PR 预览仍保持未完成，未重复科学软件或原生调度器实验。

静态收尾：全仓 lint 退出 0（既有 47 warnings/1 info）。全仓 typecheck 完成 protobuf 生成及其余产品；测试回调的可选字段和联合类型修正后，Agent 定向复查与独立 Fabric 实验脚本检查均退出 0。355 个本地文档目标及 diff 检查通过。未重复已通过的运行测试，未推送或部署。


## 任务介质自动上传派发

2026-11-09：主 Server 已启动任务介质上传扫描，按原 import 的待传成员、活动领取、私有 verified、当前本地批准、Agent 组织/能力及原共享传输槽筛选。派发前刷新来源许可，成员序号从原签名输入/结果清单恢复，原 storage 以显式 claim 创建上传尝试，随后重查当前连接。输入/结果轮换优先，每轮最多四个 Agent，扫描延后持久保存。无新迁移或依赖。

14 项新增 PostgreSQL/派发专项与 25 项原上传授权/结果回归合计 39 项不同用例通过，覆盖绑定、双代次、并发 tick、能力、双方撤权、迟到 allocation、断线清理后新代次重试和候选筛选。恢复测试原 60 秒批准不足以覆盖等待加清理，延长夹具批准后通过；筛选夹具最初改变 state 未同步清空 verified 字段，被数据库约束正确拒绝，按合法状态修正后通过。所有隔离数据库由空库迁移，已停止清理；目标存储和 Agent 通道为注入，未宣称真实双平台任务完成。

当前还需纯介质目标配置、真实 Server/Agent/对象存储闭环、完整蓝图中的其余未完成项及 PR/CI/预览；完整目标继续保持进行中。没有重复科学软件安装或原生调度器实验，没有推送或部署。

静态收尾：全仓 lint 退出 0（既有 47 warnings/1 info）。全仓 typecheck 完成 protobuf 生成及其余产品；新增测试的可空成员/尝试断言已补上明确检查，Server 定向复查与独立 Fabric 实验脚本检查均退出 0。922 个本地文档目标及 diff 检查通过。未重复已通过的运行测试。


## 纯介质目标配置与独立能力

2026-11-09：Agent 输入/结果配置允许空或省略 allowedSourceOrigins；仍要求目标 HTTPS origin，网络复制能力仅在来源存在时声明，直接收到复制命令也不启动。Server 的目标存储/worker 不再依赖来源 origins，canCopy 关闭网络候选及派发，来源 GET 在外部请求前拒绝。新增 federation_target_transfer_v1 及独立目标校验响应，原网络配置继续兼容旧协商，纯介质任务不会发给不理解独立能力的旧 Agent。目标完成报告仍走原存储完成、版本/内容校验和原子发布，无新迁移或依赖。

16 项新增及 52 项相关回归共 68 项不同测试通过：Agent 配置/命令、真实 TLS 字节校验、既有复制客户端、Server RPC/版本协商、目标配置与网络派发隔离、目标存储上传/校验和结果原子发布。结果发布测试使用真实隔离 PostgreSQL、签名控制面和注入对象存储/Agent 回报，不代表真实跨站点作业完成。新测试最初漏配 RPC dispatcher、目标 HTTP 夹具未放入已有文件，已修正；联合回归还发现旧任务介质夹具查询整张尝试表并误算其他网络 import，已限定本测试 Agent/import 后带原结果 worker 复验通过。所有隔离数据库已停止清理。

部署说明已补充纯介质 JSON、来源控制面网络要求及新旧版本边界。下一步是连接真实 Server/Agent/对象存储的任务输入→DATA_WAITING→执行→介质结果闭环，并继续其余未完成蓝图与 PR/CI/预览；完整目标保持进行中，没有重复科学软件编译或原生调度器矩阵。

静态收尾：全仓 lint 退出 0（既有 47 warnings/1 info），protobuf lint 及生成通过。全仓 typecheck 完成其余产品；gRPC 入口旧依赖类型补齐 canCopy 后，Server 定向复查与独立 Fabric 实验脚本检查均退出 0。926 个本地文档目标及 diff 检查通过。没有推送或部署预览。


## 私有任务介质真实往返

2026-11-09：新增 `task-media` 场景，复用已有隔离双 Server/数据库、真实 mTLS Agent 与版本化 HTTPS 存储。普通云盘上传和 Workflow File 输入先进入 DATA_WAITING，真实 age 输入包经人工搬运后由生产后台自动校验发布，两个真实 Kubernetes Job 完成，结果通过反向介质包返回，原 Workflow 下游成功。实际下载内容为 `verified:42\n`；SHA-256、固定对象版本、原领取/回执和零预留字节全部通过，无跨站网络复制尝试或共享数据集泄漏。

第一轮暴露测试 Server 缺少独立的介质对象白名单，正确被拒绝；补齐两端本站配置后，完整入口通过。保留两轮私有日志，未重复科学软件编译或原生调度器矩阵。本次只增加验收与配置夹具，生产授权检查未放宽。Web/CLI、治理归档、保留删除、付款争议、O01、完整矩阵和 PR 预览等原目标继续保持未完成。见[任务介质验收](task-media.md#私有任务介质双平台验收)。

静态收尾：全仓 lint 退出 0（既有 47 warnings/1 info）；全仓 typecheck 含 protobuf 生成、所有产品包与实验脚本退出 0。Python 语法、932 个本地文档目标及 diff 检查通过。完整 task-media 入口退出 0，隔离 namespace、数据库、服务和凭据均已清理，未推送或部署预览。


## 任务介质 CLI

2026-11-09：新增来源导出和接收导入命令，复用既有 API、机构断言、原编号与独立权限。批准、运行、私有校验、回执和原任务完成分开；共享视图过滤内部对象/密钥字段，文件新建为 0600，未知写入不自动重试。来源回执、分页批准和撤销入口一并接通。

真实双平台 `task-media` 已通过实际 CLI 子进程操作：普通 Workflow 私有 File、两个轻量 Kubernetes Job、双向 age 介质、签名文件交接与回执、自动目标上传/验证/发布、原下游恢复、最终真实下载及配额归零全部通过。复用既有实验栈，没有新增模拟任务/报告或重复科学软件矩阵。Web 界面、其他蓝图项与 PR 预览继续待完成；操作见[CLI 说明](../../federation-cli.md#加密介质导出与接收)。

验证收尾：CLI 命令文件 52 项通过，回执“已记录但缺原文”的补强单项复验通过；全仓 lint 退出 0（既有 47 warnings/1 info）。全仓类型检查完成 protobuf 生成与其余产品，首轮 CLI 的多余参数已修正，CLI 定向复查和独立实验脚本类型检查均退出 0。Python 语法、938 个本地文档目标与 diff 检查通过。真实 CLI/双平台 task-media 入口退出 0，隔离资源、配置及凭据已清理；没有推送或部署 PR 预览。

## Web 介质交付

2026-11-09：新增独立“介质交付”页，发出／收到列表进入包详情，支持签名文件交接、批准、运行、撤销和双方回执。只读选项 API 限定当前机构／本站，保留协议的独立结果期限；不返回合同条款、密钥或目录路径。原生产授权与任务归属不变，未新增依赖或数据库迁移。

4 项隔离 PostgreSQL 用例验证组织、目录双重归属、活动双签候选、分页和撤权，数据库已清理。网页验证原请求重试、错误刷新、权限／会话切换、过期、错误清单／响应、私有校验与回执代次；最初三项夹具在列表加载前点击禁用按钮，已改为等待可操作后通过。实际浏览器使用 API 夹具验证桌面／手机、中英文明暗主题，没有页面错误或横向溢出；截图审查后区分了包撤销与批准撤销文案。没有重复真实科学软件、原生调度器或上一轮双平台传输验收。

该页仍需从原记录取得委派／数据集版本／副本编号，原任务页面关联、治理归档、保留删除、付款争议、O01、完整调度器矩阵和 PR／CI／预览等完整目标保持未完成。

验证收尾：19 项新增 Web 用例与原联邦页 4 项回归、4 项 PostgreSQL 专项合计 27 项不同用例通过。实际手机浏览器还验证了请求丢回复、选项失败后禁用、恢复查询与同一请求重试，8 个最终截图无横向溢出或页面错误。全仓 lint 退出 0（既有 47 warnings/1 info）；全仓 typecheck 包含 protobuf 生成及独立 Fabric 脚本退出 0，最终网页补强定向类型检查通过。940 个本地文档目标和 diff 检查通过。工作保存本地，尚未推送或部署 PR 预览。

## 原工作流的介质交付

2026-11-09：补齐工作流→介质交付入口、按原运行筛选的发出／收到历史、任务候选选择和工作流范围内登记。来源候选核对原提交人、机构、本站及执行日志／outbox 同文；结果候选核对执行机构、身份和原完成工作流。表单自动带入任务、协议和接收站点，切换范围不沿用草稿；历史查询与当前可执行候选分开。原材料权限和审批、源授权、私有导入／发布状态不变，无新迁移或依赖。

数据库验证发现登记范围查询最初未执行 select builder，随后单表投影又去掉子查询列限定，均在错工作流测试中暴露；改用参数化原始查询并仅绑定一次清单后，错范围拒绝和正确范围登记通过。查询只缩小原权限范围，不信任 URL 或客户端传来的归属。共享测试响应改为 schema 解析，修复 unknown 类型检查。

网页与浏览器检查覆盖原绑定选择、双向列表筛选、登记请求、用途／工作流切换清空、未知写入恢复、入口与返回链接。浏览器使用 API 夹具；数据库使用真实原任务／签名／接单夹具。没有重复科学软件编译或原生调度器矩阵，不将这轮检查称为新增真实跨站传输或 PR 验收。数据集版本／副本选择、治理归档、保留删除、付款争议、O01、完整矩阵和 PR 预览等完整目标继续推进。

验证收尾：本轮 58 项不同 Web 用例（含原工作流／联邦页回归）和 6 项 PostgreSQL 专项通过。最新 HTTP 定向检查验证错工作流登记返回 403 且无新包、正确登记返回 201、原历史查询成功；此前暴露的 SQL 构造问题已复验。10 个实际浏览器渲染场景无页面错误／横向溢出，数据为 API 夹具。全仓检查已生成 protobuf；Server／Web 的测试类型问题修正后，两个产品定向检查与独立 Fabric 实验脚本检查退出 0，其余产品检查退出 0。941 个文档目标和 diff 检查通过，隔离数据库及本地浏览器服务已清理。完整蓝图与真实 PR 预览尚未完成。

最终 lint 退出 0（既有 47 warnings/1 info），diff 检查通过。远端 main 已核对，本分支包含最新 main；尚未创建 PR。

## PR 草稿与干净环境 CI

2026-11-09：建立 [PR #71](https://github.com/kuintessence/kuintessence/pull/71)，静态 CI 通过。Fabric 专项在全新 runner 上因未生成 protobuf 导致独立脚本类型检查失败；已在禁止安装脚本的依赖安装之后显式生成，与现有主 CI 一致，不提交生成产物。完整功能尚未结束，保持草稿；未添加信任标签或绕过预览门禁，尚无 PR 预览验收。

## 数据集版本与来源副本选择

2026-11-09：复用原来源披露授权，增加有界数据集候选查询；Web 按数据集／版本／Agent／目录选择，自动带入配对编号。没有新表、迁移或依赖。禁止转交、到期、撤销与实际导出时的完整清单检查保持生效，查询不读取科研文件字节；分页按存储候选推进，允许空页继续下一页。

12 项 PostgreSQL 用例通过（3 项新增、4 项原选项、5 项原导出／授权回归），25 项 Web 用例通过。网页测试首轮使用了错误标签，随后刷新测试误找了只在未知写入时出现的按钮，均修正夹具后通过。3 个桌面／手机中英文明暗主题浏览器场景无页面错误或横向溢出，数据为 API 夹具。未重复科学软件或原生调度器实验；其余蓝图与 PR 预览继续推进。

CI 第二轮已通过 protobuf 生成、独立类型与链码测试，实际 Peer 启动退出。检查发现夹具只覆盖 ledger 路径，快照仍使用 Fabric 默认的 `/var/hyperledger/production/snapshots`；普通 runner 无权写入，多个 Peer 也不应共享该路径。改为每个 Peer 在隔离临时目录中保存快照，随环境一并清理，继续由远端真实检查确认。未扩大 runner 权限或输出密钥／私有账本。

静态收尾：全仓 lint 退出 0（既有 47 warnings/1 info），全仓 typecheck 含 protobuf 生成和独立 Fabric 脚本退出 0；942 个本地文档目标、workflow 引用和 diff 检查通过。隔离数据库已清理。

## 远端 Fabric 商业初始化夹具修复

2026-11-09：PR 真实隐私与数据库恢复专项通过，主 CI 与 Server/Agent bundle 检查通过。商业专项在初始化时退出，夹具仍用最初仅含 agreement/usage 的枚举重新解析已由共享协议验证的用途列表，误拒新增账单、结算等用途；改为保留原配置列表，不自动增加权限。隔离 PostgreSQL 中实际 worker 的初始化、双方直接审批通过，链待办为零；仅更新本轮私有测试副本的有效期并重新签署模板，原材料未改写，未启动本地链。独立脚本类型检查及全仓 lint 退出 0。下一轮远端继续验证商业恢复、市场和 gate，完整目标与预览保持未完成。

## 外部付款凭证协议与私有链记录

2026-11-09：新增 commercial-payment 与 RecordPayment，固定原有偿合同／账单、机构、整数金额和证明摘要；同一付款的更正引用当前 head，新凭证保留原文，旧重放不回退。新增签名用途须显式授权，无资金操作或新增数据库结构。50 项商业链码用例通过，新增付款 4 项覆盖字节/金额、原始关系、双签、第三方、重放、更正和前驱丢失；初轮终态夹具与错误码断言修正后复验。

复用现有真实 Fabric 商业入口，付款和更正取得 VALID，竞争更正 MVCC INVALID，旧重放不能恢复旧 head；原生区块写集仅 payment/payment-head，A/B 私有可见而 C 不可见，公开块与日志无付款探针。原商业隐私和 Adapter 进程/Orderer 恢复一并通过，隔离服务、密钥和账本已清理。尚未接通付款 Adapter、Server 持久审批／交换及 Web/CLI，完整目标保持进行中。

PR 的旧 head 已通过真实隐私、商业恢复和任务市场，gate 数据库专项的 Adapter 退出。排查到 GitHub checkout 下 provider socket 长达 114 字节；本地 Node 原生测试复现 113 字节路径在绑定后设置权限时 ENOENT、84 字节成功。缩短四个测试 socket 目录并同步调用方，没有放宽权限或改动生产 socket 规则；后续远端验收确认完整 gate 流程。

验证收尾：全仓 lint 退出 0（既有 47 warnings/1 info）；全仓 typecheck 含 protobuf 生成及独立 Fabric 脚本退出 0，新增真实探针的最终脚本类型复查也退出 0。944 个本地文档目标及 diff 检查通过。测试为模块和三 Peer 实验，不宣称已完成付款 Server/Web/CLI 或 PR 预览验收。


## 外部付款的平台审批、交换与生产 Adapter

2026-11-09：新增 `payment.approve`、付款 API 和持久记录，原合同／账单的机构范围与签名核对后才能批准。单方签名不成为当前付款，双方确认、历史 head 切换、审计与异步待办同事务提交。付款标识的事务锁及唯一前驱约束阻止并发签署竞争分支；允许更正为零，旧正文及签名保留，旧重放不回退。直接合作无链待办，存证和链协调模式由提供方异步提交，均不改变资金、账单或执行 gate。后台交换只传递已批准的同文签名，不替双方自动批准。组织权限界面同步中英文用途说明。

生产 Adapter 支持 record-payment，仅把编号放入普通参数，双签信封留在 transient。Server 提交前核验已保存双签及当前信任，等待原账单与前驱的私有链回执；原交易检查点沿用现有恢复机制。生成迁移 0173–0175，包含付款表、能力、审批交换与提交约束。初次 PostgreSQL 验证发现遗漏提交操作约束，确认事务正确回滚，补齐生成迁移后通过。

验证：13 项 Adapter、5 项 Unix/审批协议、8 项权限界面检查通过；PostgreSQL 共 39 项不同场景通过，其中付款 8 项覆盖直接/存证/链协调确认、并发、原文与权限、回滚、交换、HTTP、前驱等待和原提交恢复，其余为原账单/结算/调整回归。协调夹具首轮误用材料规范化摘要代替签名字节摘要，修正原始签名夹具后通过。共享签名用途新增付款后，完整列表超过旧 48 项上限；上限同步为 49，未自动扩大任何已有密钥权限。

真实 Fabric 商业入口通过 16 组断言，新增付款生产 Unix 客户端/Adapter 在 Orderer 停机、恢复、结果返回后进程退出及重放中的同交易恢复；旧隐私、原生背书、MVCC 与商业恢复一并通过。初轮 Orderer 端口监听恢复早于共识就绪，崩溃探针提前要求 committed；仅对 pending 有界重读同一检查点后通过，invalid 仍失败，未重建或替换交易。隔离进程已停止，成功实验账本自动清理。

远端旧 head 的主 CI 与 bundle 通过，Fabric 已通过真实隐私、商业、市场及 gate 数据库部分，后续 terminal/prepare 在另一处长 socket 路径失败。GitHub checkout 下恢复夹具路径为 110 字节；本地原生 Node 复现超长 socket 绑定后 chmod ENOENT，缩短后的私有 socket 正常。恢复夹具统一缩短 market/commercial 目录，继续由新 head 远端专项验证；不改变生产权限或 socket 校验。

付款 Web 操作页、CLI、真实双平台完整付款流程、争议、治理归档、存储压力/保留删除、完整调度器矩阵与 PR 预览仍待完成，整体目标保持 active。未合并 main 或部署生产。

收尾检查：全仓 lint 退出 0（既有 47 warnings/1 info），完整 typecheck 含 protobuf 生成、所有包和独立 Fabric 脚本退出 0；946 个本地文档目标及 diff 检查通过。未重复科学软件编译或完整调度器实验；初次失败的临时 Fabric 目录及凭据已清理，仅保留 ignored temp 内诊断日志。


## 付款 CLI 与原记录筛选

2026-11-09：共享付款审批／列表响应 schema 增加“current 必须已双签、确认时间与对签一致”检查；平台付款历史补 recordId 精确筛选，对签 HTTP 字段统一为已有财务入口的 approvalJws。CLI 复用原财务命令，增加付款草稿、审批、附签与三维历史筛选，核对 paid 原合同、机构、单位、原账单和付款标识。更正保留 paymentId、新建 receiptId，显示完整金额及当前／历史／待确认声明，不累计历史更正金额。

60 项 CLI 命令测试通过，覆盖精确大整数、草稿输入与返回身份、文件不覆盖、三模式独立状态、原文/对签保留和私有作用域。发现原通用 approve/attach 在收到合法 JSON 但机构或编号错误的成功响应后，只提示身份不符；现统一提示写入结果未确认，保持不自动重试，原财务测试同步覆盖。3 项 PostgreSQL 检查通过，含新增实际 CLI 子进程 → loopback HTTP → 生产付款 API：机构切换、自动化身份、撤销审批权限被拒；草稿不批准；原始审批与对签、零额更正、按原编号查询及旧附签重放正确，预算不变。该身份链为夹具注入，不宣称正式登录或真实双站点端到端已验收。

付款网页、真实双平台流程及原蓝图其他未完成项继续推进，没有新数据库迁移，也未重复运行真实 Fabric／科学软件／调度器实验。

本轮收尾：全仓 lint 退出 0（既有 47 warnings/1 info），完整 typecheck 含 protobuf 生成、各包与独立 Fabric 脚本退出 0；948 个本地文档目标和 diff 检查通过。隔离数据库、loopback HTTP 及 CLI 临时文件已清理。前一 head 的主 CI/bundle 已绿，Fabric gate 恢复仍在运行，等待其终态后再推送，避免取消已有验证。

远端确认：head b27e5ad 的 Fabric run 42580409885 已 completed/success，真实隐私与数据库恢复、商业协议与数据库恢复、市场原生背书、gate/数据库/Adapter 恢复全部执行通过，确认两处 socket 路径修复。该 head 主 CI 与 bundle 同样 success，预览因草稿正常 skipped；不把远端通过视为整套蓝图交付完成。付款 CLI 最后响应提示调整的定向类型复查也退出 0，继续推送 CLI 提交。

## 付款确认页面与交互恢复

2026-11-09：有偿合同接入付款确认页签，原账单保留 billId 筛选进入历史，并能回到原账单。支持生成／导入完整原文、独立批准、手工对签、当前金额更正、原件导出和原存证重试；更正保留付款标识，完整金额替换旧值，不累计历史修订。当前／历史／待确认、双方签署和存证分别展示，需求方未同步的提供方链状态保持未知。

付款操作仅取 payment.approve，沿用手机只读。机构／登录切换重建私有编辑状态，权限撤销清空草稿，并用代次检查阻止迟到草稿在恢复权限后重新填回。列表编辑时不轮询，窗口聚焦不刷新。未知写入停止重复提交，以原 receiptId 查询并核对同文及签名；明确 API 拒绝保留可恢复编辑，不当成未知写入永久锁定。

组件检查共 93 个不同用例通过：付款 24、合同面板 46、账单原回归 23。真实浏览器 API 夹具完成 8 张桌面／手机、中英文及深色截图，无页面错误或横向溢出，确认弹窗焦点恢复通过。独立审查发现并修复历史 A 中新增付款 B 后旧 paymentFilter 隐藏新记录，以及明确 API 400/403/409 拒绝错误锁死；两项限定复审均 resolved，disposition ship。截图和组件检查不代替正式登录、真实双平台付款或 PR 预览。

上一提交 9185b85 的主 CI、bundle 与 Fabric run 42581982403 均成功；草稿预览仍为 skipped。付款网页通过后继续真实双平台付款及原蓝图其余条目，不合并或部署生产，整体目标保持 active。

页面收尾：全仓 lint 退出 0（既有 47 warnings/1 info），完整 typecheck 含 protobuf 生成、所有包及 Fabric 脚本退出 0；949 个本地文档目标和 diff 检查通过。文档审查保留现有视觉体系，未新增设计系统；旧付款状态摘要已链接／更新为当前 Web 与 CLI 进度。


## 直接合作付款的真实双平台验证

2026-11-09：原 direct 成功实验加入独立付款权限／签名用途、付款数据库快照和生产 HTTP 审批检查。首次运行实际作业、结果回传、账单／结算／调整均通过，但旧夹具使用 exchange，付款草稿按约返回 403。ExecutionFixtureSchema 增加显式 consideration（默认仍 exchange），仅直接成功场景选 paid；生产付款代码不改。

修正后完整入口退出 0：目标从零材料开始实际拉取签名输入／环境锁，真实轻量 Kubernetes 作业与 12 字节结果回传通过，原计量／预授权账单／结算和两次调整完成。随后两端经生产 HTTP 独立批准同文付款，后台实际 mTLS 交换原签名；首次金额 1、追加更正 0，两边仅一个 current，重放旧原件不回退。前后数据库快照的预算、账单、结算、调整和实际 Job 身份／状态相等，无链配置／提交／交易。证据文本明确为合成外部凭据，保存其真实 SHA-256，不冒充银行回单或科学计算结果。

隔离服务、数据库、凭据及 namespace 均已清理。复现入口仍为 test:federation:direct；没有新增生产迁移，也未扩大权限默认值。该结果仅覆盖直接模式付款，同机多实例不证明跨主机独立信任，异步／协调付款、正式登录、完整蓝图及 PR 预览仍待完成。

最终静态检查：全仓 lint 退出 0（既有 47 warnings/1 info）；完整 typecheck 包含 protobuf 生成、所有应用包和独立 Fabric 脚本，退出 0；951 个本地文档目标和 diff 检查通过。未再次运行已通过的链专项、科学软件编译或完整调度器矩阵；付款异步／协调联合验收仍是下一项。


## 异步付款与原交易补交

2026-11-09：复用真实异步执行验收，在原轻量工作流、账单／结算／调整后加入付款与零额更正；有偿成功场景由明确 fixture 字段选 paid，保留其他场景默认 exchange。链仍停止时双方独立批准同文，原签名实际经 mTLS 自动交换，付款确认不依赖链。

真实实验入口退出 0。付款双签完成后 SIGKILL 两端 Server 和商业 Adapter，恢复原数据库／密钥后再启动排序服务，九条商务待办和接单签名批次按原依赖补交；业务编号、正文／双签、current、本地账务、实际 Job 与原交易检查点摘要保持。Node Gateway 实读 10 笔 VALID：A/B 各 10 份原记录、2 个接单索引、2 次 payment-head；C 全部私有计数为 0。付款写集严格限定 receipt/head，公开块未含私有签名或盐值。

没有新增生产代码或迁移，也没有重复安装科学软件。自建服务／数据库／凭据／namespace 与链服务清理完成。链协调付款恢复与其余原蓝图继续推进，整体目标保持 active。上一提交 9dbace6 的主 CI、bundle、Fabric run 42586731189 已全部成功；草稿预览仍 skipped，不合并 main。


## 链协调付款的真实恢复与私有写集

2026-11-09：沿用真实链协调执行入口，原市场自动接单、执行许可、轻量工作流、12 字节结果实读、终态关闭、账单／结算和两次调整通过后，加入两次付款断链恢复。首次在 payment-before 快照误用 ACTIVE 断言，实际任务已 CLOSED；只补齐运行器已关闭阶段选择，未修改生产策略或降低终态检查。

修正后完整入口退出 0。付款 1 → 0 在各自停 Orderer 时先完成本地双签；首笔背书检查点持久化后 SIGKILL 两端 Server／商业 Adapter，再用原状态恢复。两笔原 transactionId／恢复摘要均取得 VALID；旧重放不回退，源方没有付款提交。数据库前后核对原财务、付款签名/current、预留、委派、实际 Job 和 gate/需求状态不变。

真实 Gateway 区块/PDC 检查通过：每笔提供方一份 VALID，A/B 各 receipt/head 一份，C 全部为零；无预算、预留、结算或许可写入，公开块无付款签名与盐值。审查中补强“原检查点就是最终 VALID”断言，用本次已保存的两组原始快照执行通过；没有为该断言重复运行工作流。隔离服务、数据库、凭据、namespace 和 Fabric 根目录均清理。

本轮没有新增生产代码或迁移。全仓 lint 与完整 typecheck 已通过，最终变化仅 Python 断言和文档，Python 语法及文档链接/diff 继续检查；没有重复已通过的 Web、直接模式或科学软件编译。付款三模式真实链路完成不等于完整联邦交付，争议、治理归档、完整存储/调度矩阵及可信 PR 预览仍待完成。


## 争议授权与裁决执行约束

2026-11-09：结合当前两机构 PDC、商业签名和账务事务补充[争议实现契约](disputes.md)。保留原 A/B 私有域，案件与获批投影另建 A/B/R 集合；禁止向 R 发送可解码出原商业正文的完整 JWS。明确原生组织背书不等于业务批准、裁决不等于记账、证据不足保持争议，以及开案和已签在途财务操作的冻结竞争。

R 无权读取原账目时，也不能替原商业集合完成仿真背书。设计明确链协调裁决的财务应用仍等待原集合背书，不为缺席方绕过隐私或改余额。直接/异步按预授权处理，异步补交不阻塞业务；没有事前授权不能追认扣款。该文档不是已经实现的仲裁功能，下一项仍需共享协议、案件集合、平台/Web/CLI 及真实权限隔离验证。目录首页旧“没有跨平台执行/真实链验收”的总述同步修正。

付款收尾的 Python 语法、960 个本地文档目标与 diff 检查通过；没有新增依赖、迁移或生产部署。


## 争议证据的严格字段投影

2026-11-09：新增共享 disclosure 模块及包导出，六类原件使用固定字段白名单。授权选择绑定案件/政策、原合同域/版本、A/B/R、原件编号/摘要与时间；从完整原件校验后生成独立副本，拒绝错机构、错原件、过期、重复/任意路径、额外字段及签名夹带。账单总额不附带费率行，数组组须明确授权，金额继续使用整数字符串。

8 项测试通过，覆盖六种原件、精度、字段组、原件不变、确定性、身份与时间边界、接收 schema 严格性、嵌套数据及私有错误。首次静态检查发现测试的查找结果可能 undefined，改为明确断言夹具存在，没有使用类型抑制。生产 policy/审批、签署用途、撤权、mTLS、PDC 与案件 UI/CLI 尚未连接；格式校验不构成授权或真实隐私隔离，本轮不标记 L09 完成。

最终全仓 lint 退出 0（既有 47 warnings/1 info），完整 typecheck 含 protobuf、全部包和独立 Fabric 脚本退出 0；962 个本地文档目标与 diff 检查通过。没有新增依赖或迁移，也未重跑已通过的付款/科研软件实验。付款恢复与争议设计 head bbaa9d8 的主 CI、bundle、Fabric run 42593492574 已全部 success；草稿预览仍 skipped，新字段模块另由推送后的 CI 验证。


## 披露政策与双方签名校验

2026-11-09：新增仅授予字段读取范围的 commercial-disclosure-policy，与具体投影正文分别使用双方同文原签名；共享校验绑定本地可信案件、政策、原合同/原件和 grantId。政策与逐条授权撤销均须明确为 false，密钥必须具备独立用途、当前有效且未撤销；错误签署方、模糊 kid、异文双签、字段/期限越界和原件替换均拒绝。该读取政策不授权裁决、改账或银行转账。

用途目录新增两项，完整上限更新为 51，旧密钥及部署夹具不自动扩权。数据库只扩展既有 JSON 列的 TypeScript 用途类型，没有 SQL 结构变动；Web 保持明确勾选，补齐新用途及此前缺失的付款用途中英文名称。9 项真实 RS256 检查、8 项字段投影及 4 项相关协议/用途目录检查通过；信任配置 11 项组件检查通过。首次类型检查发现测试闭包不能延续签署者非空收窄，改用检查后的 const 函数，不使用断言掩盖类型问题。

本轮为共享协议、信任用途和标签接线，仍没有案件人员审批、持久撤销/重放、传输或真实 PDC 披露，不能把 L09 或仲裁标记完成。字段投影 head 07ced77 的主 CI、bundle 和 Fabric run 42595449718 已全部成功，草稿预览仍 skipped；未合并或发布 main。

最终全仓 lint 退出 0（既有 47 warnings/1 info），完整 typecheck 含 protobuf、所有包及独立 Fabric 脚本退出 0，963 个本地文档目标与 diff 检查通过。未新增依赖或迁移，没有重跑已通过的付款工作流、科学软件安装或真实链实验；本轮双签检查使用真实 RSA 密钥的模块测试，不替代生产人员身份与三机构 PDC 验收。


## 披露政策的持久审批与本站撤销

2026-11-09：主 Server 接通草稿、同文批准、对方附签、永久本站撤销及原编号分页查询；独立 disclosure.approve 显式授予，不继承管理员或原合同批准权。数据库迁移 0176 由 Drizzle 生成，保留不可变政策原文、摘要、原签名及确认／撤销时间；三模式均不提交链或修改账务。当前合同双签、接收机构、用途、组织与绑定按事务复核，同编号异文竞争只允许一个提交，附签无法复活已撤销记录。撤销不依赖继续有效的签名信任，避免密钥失效后无法停用政策。

7 项真实隔离 PostgreSQL／生产 HTTP 检查、74 个断言通过，覆盖三模式独立审批与服务重建、能力／组织隔离、并发和撤销、审计失败回滚、错误签名与数据库约束。测试夹具修正 SQL 约束参数与 Drizzle thenable 执行方式后全部通过，未放宽生产校验；临时数据库与进程已清理。另有 17 项共享协议和 8 项联邦权限组件检查通过。

这仍是政策层：路由测试注入 principal，双方服务在一个隔离数据库，不代表正式登录或实际跨机构交换；具体材料 grant、案件冻结、远端撤销同步、自动签名交换、向 R 交付及 A/B/R PDC 尚待接线。L09 与完整目标保持未完成；未合并或部署 main。

前一 head 2bd0815 未产生自动检查，原因未确定；在同一 SHA 手动调度的 CI 42598341378 和 Fabric 42598346067 均已 success。bundle 最新已验证 head 仍为 07ced77，未把手动 CI 描述为 bundle 或预览已通过。

最终全仓 lint 退出 0（既有 47 warnings/1 info），完整 typecheck 含 protobuf、全部包和独立 Fabric 脚本退出 0；965 个本地文档目标及 diff 检查通过。首次类型检查发现测试记录未判空、HTTP unknown 响应未解析，补上显式判空和外层响应 schema 后，数据库 7 项／74 断言再通过。没有重跑已通过的付款、工作流或科学软件安装实验；无新增依赖，未部署预览或生产。


## 本站争议开案与新财务批准冻结

2026-11-09：新增 commercial-dispute 机构签名、dispute.read/open 独立能力及 Drizzle 迁移 0177。生产真人路由支持草稿、原文开案和原编号分页查询；Server 从本站五类原件推导合同、机构和任务，不信任请求自填的冻结范围，不自动披露原商业正文。开案签名只表示当事方提出争议，不代表双方事实确认、仲裁授权或资金裁决。

开案与账单／减免／结算／调整／退款的新批准共享任务事务锁；机构自动批准使用原共用路径，等待时不消耗授权计数。已保存签名仍可恢复／附签并核对原结果，外部付款和用量事实继续追加。当前只保存 FREEZE_PENDING，不把本站暂停写成双方已冻结，不以时间戳推断在途财务边界，也没有管理员解冻入口。

12 项隔离 PostgreSQL／生产 HTTP 检查（77 断言）通过，覆盖五类原件、独立权限／用途、错绑定、同编号并发、事务审计、旧结算收尾和付款事实。实际数据库触发器在审计处暂停开案事务，验证并行新账单等待该事务后被拒绝；自动 worker 不生成签名或消耗计数，调整不增加占额。2 项共享协议及 19 项权限／信任组件检查通过；HTTP 注入 principal，不冒充正式登录／真实跨站验收。

上一 head 270a29b 的主 CI、bundle 和 Fabric 42602132485 已全部 success。案件跨站交换／确认、具体 grant、ABR PDC、协调冻结及和解／裁决／合法解冻仍需实现，L03/L09 和完整目标保持未完成；未合并或部署。

审查补强用量报告与本站预留／委派任务的绑定：即便报告签名正确，错 taskId 或 attempt 也不能据此冻结其他任务；两端拒绝用例已通过。受影响的原财务回归分别 94 项／815 断言（账单、结算、自动收尾、调整和付款）、38 项／254 断言（退款与自动退款）通过，隔离数据库已清理。未重跑工作流或科学软件安装。

最终全仓 lint 退出 0（既有 47 warnings/1 info），完整 typecheck 含 protobuf、所有包及独立 Fabric 脚本退出 0；967 个本地文档目标及 diff 检查通过。首次类型检查仅发现共享测试中的字符串联合未收窄，改用 const 元组后通过，无类型抑制。合计 165 项本轮相关模块／数据库／界面检查通过；迁移已在隔离 PostgreSQL 实际应用，未新增依赖、未部署预览或生产。
