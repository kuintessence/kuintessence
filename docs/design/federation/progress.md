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
