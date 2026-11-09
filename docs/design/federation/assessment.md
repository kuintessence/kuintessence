# 算力联邦 V2：可行性与风险评估

基于 main `4f359a42dd10e2fc1b355ab76d43fa2b0c74b1d5` 的代码阅读，评估对象是 [具体实现方案](implementation.md)。这是设计评估，不是运行验证结论。

## 结论

方案具备实现基础，Fabric 适合“指定机构才能持有商业明文”和“按机构管理背书”的要求；长期双边任务无需等待链。建议保留三种协议模式，复用现有 Agent、集群调度适配、Registry 和数据副本机制。

整体改动较大，主要成本来自跨实例执行可靠性和账务约束，而非链 SDK。现有系统的单实例权限、内存工作流和尽力计量有其适用范围；以下差距是新增联邦承诺引入的要求，不能直接当作当前产品缺陷。

评审可接受这份实现方向，但不能据此宣称可生产部署。持久 Workflow、接单事务、私有数据边界及链许可并发必须通过 [验收契约](acceptance.md)，缺一项便不满足完整交付。

## 现有能力与必须改动的地方

| 代码证据 | 对新需求的影响 | 实现决策 | 复杂度 |
| --- | --- | --- | --- |
| [async-runner](../../../packages/server/src/workflow/async-runner.ts) 的 `recoverInterruptedRuns()` 会中断运行中的 run 并取消作业；[完成注册表](../../../packages/server/src/workflow/job-completion-registry.ts) 使用内存 Map | 不能承诺 Server 重启后继续无人值守的远端执行 | 同一引擎增加持久 checkpoint；旧 run 保留原恢复语义 | 高 |
| [engine](../../../packages/shared/src/workflow/engine.ts) 包含循环、分支和子工作流；[workflowRuns](../../../packages/db/src/pg/schema.ts) 的 `stepJobs` 按静态节点 ID 记录 | 一个 nodeId 无法唯一标识每次循环调用 | 持久化动态调用路径、决策和固定修订，按 invocation 去重 | 高 |
| [billing filter](../../../packages/server/src/scheduler/filters/billing.ts) 检查额度，不承担原子资金预留 | 多个并发接单不能仅依赖现有 filter 防止超额 | 独立合作域账本、行锁/CAS、预留与接单同事务 | 高 |
| [JobService.submit](../../../packages/server/src/services/job-service.ts) 已在自身事务创建 Job 和 Workflow 关联 | 先提交 Job 再写远端映射会留下崩溃窗口 | 提取内部事务接入点，保留原校验，让 attempt 绑定与 Job 创建原子完成 | 高 |
| [JobService.recordUsage](../../../packages/server/src/services/job-service.ts) 是终态之后尽力写入；[aggregator](../../../packages/server/src/services/metering-aggregator.ts) 默认删除超过 7 天的 raw 数据 | 事后扫描计量表不能保证长期商业证据完整 | 终态事务保存证据意图，独立签名与保留；分配时长和实际采样分开 | 高 |
| [机器身份](../../automation-credentials.md) 已有受限 service account；[Agent mTLS](../../../packages/server/src/auth/mtls-wire.ts) 使用专门信任边界 | 可复用本地权限，但不能把远端机构当 Agent 或管理员 | 单独机构信任登记与 FederationPrincipal，映射本地受限身份 | 中高 |
| [data prerequisite](../../../packages/server/src/services/data-prerequisite.ts) 使用本地身份和版本 ID；[Agent delivery](../../../packages/agent/src/data-market/data-delivery.ts) 已支持数据准备 | 外站 UUID 不能直接交给本地规划器；介质包是新增通道 | 跨站不可变引用映射、持久等待、独立导入/导出命令 | 中高 |
| [canonicalJson](../../../packages/shared/src/utils/canonical-json.ts) 使用 localeCompare；[shared exports](../../../packages/shared/package.json) 默认引用 TS 源文件 | 不能直接视为 Node/Bun/链码统一密码协议及运行包 | 签署并保存精确字节；纯协议子入口和独立 Node 构建 | 中 |
| [取消 outbox](../../../packages/server/src/grpc/dispatcher.ts) 已持久化取消与 epoch；现有 Agent 对接本地调度器 | 可借鉴可靠发送模式，无需重写 Slurm/PBS 或增加另一套调度器 | 联邦建立自己的 inbox/outbox，沿用本地 dispatch 与取消机制 | 中 |
| 尚无联邦 Fabric Adapter、PDC 和链码实现 | 原生能力可选型，但具体业务组合未经验证 | 三链码分工，真实网络检验私有数据、背书及并发状态机 | 高 |

以上是改动性质，不是工期估算。当前没有足够基准支持复用百分比、吞吐承诺或人日数字。

## 已纳入实现方案的设计修正

1. **“不阻塞”有明确范围。** 异步存证不进入任务同步路径；本地证据不能持久化或超过双方批准的积压风险上限时停止新接单。既有任务结束回执须预留存储空间。
2. **恢复依赖持久业务事实。** worker 租约到期不能证明远端作业已停；响应丢失不能释放额度后另投 C。先核对原请求与调度器状态，未知时保持待核对。
3. **Job 与远端关联一起提交。** 避免“作业已创建、映射没保存”的重复运行窗口。外部调度器不在数据库事务内，仍需现有 dispatch/取消与核对机制。
4. **计量不等于财务证据。** 独立保存报告、验收、账单、更正、支付和存证状态；终态事务留证据意图。不能等 raw 计量清理后再补造证据。
5. **链隐私覆盖全部传输面。** PDC 不能弥补普通参数、响应、事件、日志泄漏。AND(A,B) 是两家机构背书，不能由 B 的两台 Peer 代替。
6. **许可必须读取当前状态。** `market` 激活与 `commercial` 释放通过同一通道内链码调用形成可验证读集；过期 gate、撤销与并发退款不能只靠应用先查再写。公共验证只接触承诺，不能泄漏私有正文。
7. **快照不是压缩或完整备份。** 只支持替换运行 Peer，历史、交易 ID、当前状态和 Orderer 空间仍需预算；私有明文有独立恢复来源。

## 选型条件与未验证事项

| 事项 | 当前判断 | 交付时须提供的证据 |
| --- | --- | --- |
| Fabric PDC 与机构背书 | 满足需求方向；隔离不等于交易关系匿名 | C/G 在 Peer、区块、网络负载、查询及运维输出中均无法获取 AB 商业明文；缺任一指定机构背书不能提交有效写入 |
| 公共激活与私有锁额 | 同通道读集可用于并发约束，但具体 gate 编码、哈希与策略组合仍需实现验证 | 激活/撤销/退款并发交错，只允许满足账本状态的一方有效；没有锁额的任务不能执行 |
| SDK、链码和运行时 | 蓝图版本均为候选组合 | 固定版本与镜像摘要，构建及恢复测试通过；Node 运行时交付时仍在维护期，不能仅因旧方案指定版本而继续使用过期运行时 |
| SmartBFT 与联盟治理 | 四个独立管理的 orderer 是参考部署；同一 VPS 四容器不构成独立信任 | 故障域与成员责任记录，容错与恢复测试；ALL 治理导致成员离线时升级阻塞须被接受 |
| 业务签署和联盟信任 | 机构签名能证明声明来源，不能证明计算实际发生或科学结果正确 | 协议批准角色、密钥轮换/撤销、独立验收规则与争议证据 |
| 密钥与指定机构隐私 | 非成员无明文；合法接收方仍能复制其已获授权的数据 | 密钥分用途、私有备份范围及数据导出权限；不能承诺撤销后收回对方已经持有的明文 |
| 容量与性能 | 无实际负载基准 | 每批交易与证据实际大小、日增量、索引/副本/备份占用、恢复所需余量及积压上限 |

## 两个仓库的交付边界

主项目 `kuintessence-reborn` 负责协议、权限、账本、Workflow、Adapter/链码、介质通道、UI/CLI、部署与运维。现有软件 seed 导入路径继续复用，不让软件包生成机构授权。

`kq-bundles` 只需提供可重复的验收材料：真实小任务、隔离且可恢复的模拟环境、跨 Slurm/PBS Workflow、软件/数据摘要、许可证、provenance 和依赖锁。修改以主项目最终协议为准，本轮不改包格式、不重新导入腾讯云，也不夹带生产凭据、真实合同或自动批准配置。

## 本次评估边界

本评估记录设计时的代码基线，后续实现与验证见 [实现进展](progress.md)。Fabric、调度器与跨机构完整流程仍须分别验收；文档静态检查不能证明方案运行正确，内部模块测试也不能代替端到端验收。


原生争议冻结的平台确认现已接线（迁移 0182）：在途财务及占额／释放原件和收据均为双签前提，双方各自取得匹配私有冻结收据后才确认，失败保留原阶段、签名和交易。26 项不同相关 PG 检查通过；真实双 Server/Fabric 完整入口已验证停链、两端 Server／Adapter 重启、原交易恢复与独立 PDC 隔离，并修复生产网关漏放行争议路径的问题。验收使用同机机构及轻量 Kubernetes 脚本，此处不将 L09、完整争议或预览目标标为完成。实现边界见[平台确认](disputes.md#原生冻结的平台确认与恢复)。
