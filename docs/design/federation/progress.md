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

全仓 lint 无错误（原有 47 warnings、1 info）；全仓 typecheck 通过，最后的执行器调整按 Server 范围复查。生产 `makeRunner` 尚未传入 `executionLease`，现有重启取消规则不因此改为自动续跑。只有普通 Script 的按 Job 分离产物行为已接入现有调用路径。

**自动恢复仍有明确依赖**：生产 lease 心跳、原子运行创建/联邦预留映射仍待接通；下文已补齐已分配 Job 的准备恢复与派发终点校验，分配前的软件安装等待恢复仍需衔接；执行统计已改为按 Job 幂等贡献（见下），但其他恢复依赖尚未完成。另已确认 Script 的 File 输出返回 `artifactId`，下游输入当前只接受 `fileMetadataId`，需要接通受管副本/文件解析，不能把这次绑定测试当成文件工作流端到端通过。

## Script 执行统计按 Job 去重

- [统计服务](../../../packages/server/src/services/sandbox-execution-stats.ts)锁定终态 Job，在同一事务内写入统计标记与聚合值；重复完成回调和恢复重放只贡献一次。执行器传递实际 Job ID，普通生产调用同样生效；不引入独立记账队列。缺失/运行中的 Job 或与终态不一致的成功标记拒绝计数。
- [0086](../../../packages/db/migrations/0086_gorgeous_pestilence.sql)由 Drizzle 生成，新增可空统计时间戳；不追溯归因旧聚合值。此统计用于输出量预测，不是联邦计费或结算账本。
- 新增 [PostgreSQL 测试](../../../packages/server/src/services/sandbox-execution-stats.pg.test.ts) 3 项通过：24 路回调对成功、失败、取消的 3 个 Job 只累计 3 个样本；聚合写入外键失败回滚 Job 标记，重试成功；不存在/非终态 Job 拒绝。统计和执行器的 9 项相关单元测试通过。全仓 lint 无错误（原有 47 warnings、1 info）；全仓类型检查发现测试数组索引可能为空，改用明确的成功 Job 参数后 Server 范围复查通过，其余包与 Fabric 脚本检查均通过。

## 派发取消检查覆盖最终投递

- [派发 outbox](../../../packages/server/src/grpc/job-dispatch-outbox.ts)的授权落库与补投统一按 Workflow → Job → outbox 顺序加锁，与现有执行 journal 一致。补投重新核验运行状态、提交者、Agent 和 epoch；同步写入 Agent 通道队列完成后才释放锁，消除“查完未取消、释放锁、此时取消成功、仍然发出指令”的窗口。
- 不在数据库事务内等待网络回执。若已入通道但事务提交失败，仍按原始指令/epoch 重投，由 Agent 持久 inbox 去重；取消只能阻止尚未投递的指令，已投递任务仍须走原有取消协议。
- [真实 PostgreSQL/Agent SQLite 测试](../../../scripts/workflow-dispatch.pg.test.ts) 13 项通过，包括原有断线重放、重复回执、并发补投、停止运行和固定 Spack 意图保护。新增三项验证：在实际入队边界用独立进程探测 Workflow 和 Job 行锁，均返回 `55P03`；取消事务先取得锁时，首次授权落库和已有 outbox 补投都实际等待该事务，取消提交后均不发出指令。检查使用数据库阻塞关系确认先后顺序，不靠固定等待时间碰运气。全仓 lint 无错误（原有 47 warnings、1 info）；全仓类型检查和新增测试脚本的独立严格类型检查通过，524 个本地文档链接通过。临时 PostgreSQL 已停止，其自建数据目录已清理。

**仍待接通**：这次修复运行/Job 取消与投递的竞争；下文已补齐执行租约代次在最终授权提交处的检查，以及已分配 Job 没有完整 envelope 时的准备恢复。Script 的 File 输出转换也尚待实现；FileBatch 的 Agent 校验结果已有成员摘要，但 Server 尚未保留成员和逐文件持久映射，不能把目录当成单个云盘文件交给下游。

## 已分配 Job 的准备恢复与最终租约检查

- [提交桥接](../../../packages/server/src/workflow/job-submitter.ts)直接传递完整的 `JobSubmission`，保留准备后的 Spack pin、软件/用例修订、输入、资源及候选队列；不再通过手写字段投影丢掉恢复所需信息。生产 Job 行仍使用不可直接执行的 Spack 占位命令，手动队列的提取保留在 JobService 调用处。
- [Placement](../../../packages/server/src/services/placement-orchestrator.ts)接收内部执行租约，核对持久 invocation、运行、用户与组织。已有完整 outbox 或终态 Job 不重做准备；已有分配但尚无 outbox 的 Job，只允许原 Agent、provider、队列目标和原 epoch 继续准备。原 Agent 不在线时抛出可恢复中断，不改派，也不标成计算失败。恢复重新检查目标的软件与授权条件；不会为已经分配的 Job 另起软件安装。
- [JobService](../../../packages/server/src/services/job-service.ts)为调度记录、分配、Sandbox manifest、epoch 检查及准备失败状态增加可选事务边界，使用现有租约事务的前后检查。旧 token 不能通过晚到失败把新执行器的 Job 终结。普通调用保留原写入方式，状态通知与计量仍在事务提交后执行。
- [Outbox](../../../packages/server/src/grpc/job-dispatch-outbox.ts)对持久 invocation 强制要求匹配的当前租约，完整指令落库与租约检查在同一事务内完成。即使 epoch 检查刚成功后旧执行器失去租约，也不能提交或发送新指令。已经获准并落库的指令仍可由 outbox 独立补投，不因运行器换代重新签名或重新安装。
- Script 已将内部租约传入 placement。没有完整指令时交由上述恢复路径处理，已有指令时继续等待原结果。

验证：新增[准备恢复 PostgreSQL 测试](../../../packages/server/src/services/placement-recovery.pg.test.ts) 4 项通过，实际使用 JobService、placement、租约事务和 outbox；在文件准备、epoch 检查后主动释放租约模拟执行权丢失。验证原 Job/Agent/epoch、固定 Spack pin 保留、原 Agent 离线等待、已有 outbox 不重做准备、旧 token 无法再写失败或提交指令，以及不同运行/身份与缺少 outbox 的拒绝。Script 恢复 6 项、派发 13 项、原有调度 23 项、JobService 33 项均通过，共 79 项数据库相关检查；提交桥接与 Script 的 17 项单元测试通过。测试使用受控通道和下载 URL，没有运行真实调度器、安装科学软件或传输实际文件。全仓 lint 无错误（原有 47 warnings、1 info）；全仓类型检查发现测试 Spack 版本字面量需显式类型，修正后 Server 复查通过，其余包、Fabric 脚本和派发测试脚本的严格检查均通过。529 个本地文档链接通过；本轮临时 PostgreSQL 已停止并清理。

**生产自动续跑尚未启用**：`makeRunner`/异步运行器还需接入持久模式、心跳与重启扫描、用例的原子绑定、动态调用取消清单和文件产物转换。此次恢复覆盖已分配 Agent 后的准备中断；分配前的软件安装等待、跨实例联邦预留到 Workflow 的原子映射仍待完成，不能据此认定联邦作业已经可用。

## 尚未接通，不能宣称支持

协议审批与机构信任管理 UI、源站发送与状态查询、额度结算/退款、联邦准备到实际派发的连接、生产持久 Workflow 恢复、完整的数据/软件物化与介质交付、双方证据确认与完整用量/结算记录、商业/市场链码及真实联邦作业与 Fabric 联合运行、归档恢复、Web/CLI 和部署配置均未完成。

接下来连接联邦预留与实际 Workflow/Job 派发，接通已有 Script 原子绑定、补齐准备恢复与目标环境授权检查，完成真实执行不被链故障阻塞的联合验证。同时仍须补全用例内部标识与受管文件转换、native lock/Agent 检查，将本地输入连接到既有授权执行路径，并接通联邦任务/工作流映射与派发待办消费；只有本地资源、数据和软件授权及 Job 映射完整后，预留才能进入执行。完整交付仍须通过所有端到端验收，不将本轮基础模块单独宣传成可用联邦平台。
