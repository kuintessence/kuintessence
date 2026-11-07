# 私有额度与公共执行许可

本页说明同一 Fabric 通道中的 kq-commercial / kq-market 协议。链码、生产 Adapter 与 Server Unix 客户端已通过隔离真实网络验收；Server 已接通预留/释放的业务双签审批和持久待办，源站公开激活也已接入持久市场待办；执行方验权尚未接入，协调接单入口仍拒绝执行，不能把链码 ACTIVE 当作平台已提交真实计算任务。

## 私有边界与背书

商业正文、完整委派（材料摘要、软件锁、预算封顶）、预算余额和双方签名均只存入双方 PDC。调用 ReserveExecution/ReleaseExecution 只传公开路由参数 domainId/recordId，正文使用 commercial transient；发送端必须明确限制背书节点为集合成员。集合仍要求对应机构 AND 背书，不向第三方发送完整委派或签名。治理初始化仍使用既有全机构策略。

执行许可 gate 也写入 PDC；其中仅包含允许公开的域/认领标识、需求标识、版本、READY/REVOKED、激活截止时间与带随机盐的私有预留摘要。激活者提供这份可公开的 gate 原文，商业链码的 GetExecutionGateHash 只返回当前 getPrivateDataHash，不读取私有原文。因此第三机构可参与公开激活背书，却拿不到金额、合同及委派内容。

公共 ActivateDemand 在同通道调用商业链码，比较 gate 原文的 SHA-256 与当前 hash，并校验当前认领、域、版本、READY 和期限。私有哈希读取进入 Fabric 的提交验证读集；退款改变 gate 的私有哈希，旧激活会因 MVCC 冲突失效。商业释放反向读取公共需求，激活先提交时旧释放也会因 MVCC 冲突失效。不能用应用先查后写替代这一链上读集。

两个链码名称固定，调用显式使用 stub.getChannelID()。必须部署在同通道；不支持跨通道原子性。内部 GetDemand/GetExecutionGateHash 会收到外层调用的 transient，但仅读取允许的状态或哈希，既不解码也不返回该 transient。

## 公开认领与私有预留

新的可执行认领需包含 commercialDomainId，只公开商业域路由标识，不包含条款。旧的、不带此字段的认领仍可读取和重试，但不能锁额或激活；不能在已有认领上偷偷补字段。

CommercialReservation 由双方对相同正文签名，签署用途必须显式包含 commercial-reservation；以前的合同或用量签署权不会自动扩大。预留 ID 固定等于公共 claimId，绑定域、需求、认领版本、已登记合同摘要和完整 FederationDelegation：

- 当前需求必须是该执行机构的 CLAIMED，商业域一致，资源需求与委派一致。
- 合同必须是 ledger_coordinated，当前有效，委派匹配双方、合同修订、预算域/epoch/单位、模板、资源与金额上限。
- 材料及软件锁的摘要在双签正文中固定；实际解析、授权和目标环境适用性仍由后续平台准备流程验证。
- 同一任务 attempt 和 operationId 只能占用一次预留；重复请求保留原记录，内容变化拒绝。
- 慈善预留金额为零，但仍占用并发预留数量，不能绕过数量限制。

预算键由商业域、budgetDomainId、epoch 组成，不使用合同修订 ID。首次预留按双方已确认的固定额度建立预算；后续修订必须匹配原双方、单位、总额度和预留数量上限，不能增大上限或重置余额。整数金额全程 BigInt，判定 locked + spent + 本次封顶不超过 limit，同时限制预留数量。不同合作域不共用一个隐含钱包；这不是可转让货币，也不是提供方报告用量后自动增发积分。

预留、预算增加、唯一映射及 READY gate 在一笔私有交易中写入。仅 VALID 表示锁额成立。相同请求重放写回原私有预留字节，继续受集合 AND 策略约束；不重复扣款，也不重置 gate。

## 激活、释放与当前边界

公开 ActivateDemand 只能由需求机构调用，要求当前 CLAIMED/version、claimId、商业域与 gate 一致。成功写入 ACTIVE 与不可变 activation；重复原激活返回原回执，不能产生第二次授权。gate 的 expiresAt 是激活窗口，执行窗口仍在私有委派 executionExpiresAt 中，执行端须独立核验。

ReleaseExecution 使用专用 commercial-release 双签正文，绑定原预留摘要及 gate 版本。只允许尚未激活的 CLAIMED 需求：同一交易减少 locked/预留计数，保留原始记录，追加释放回执，并将 gate 升版为 REVOKED。重复释放不重复退款；旧预留重放不会把 REVOKED 改回 READY。自然到期不等于已经停止执行，ACTIVE 不能沿此接口释放。

当前没有 ACTIVE 的终态结算/停止证明、公共重新开放、预算扩额/跨域划拨或自动代际迁移。新签署用途已进入链与 Server 信任管理，预留/释放双签审批已接入；既有链信任清单的治理升级/迁移工具仍须补齐。未放开现有 Server 的 LEDGER_REQUIRED 门槛。

## 复现真实网络验证

Commercial Adapter 的固定 proposal 接口增加 reserve-execution/release-execution，验过双方专用签署用途、相同摘要及路由绑定后，才把 transient 发给该域的两个 MSP。固定 query 接口只允许 get-execution-gate-hash，返回 hash 或明确不存在的 null；连接故障和含混错误不会变成不存在，响应不允许夹带私有字段。配置机构必须属于该域。

Market Adapter 增加 activate-demand，恢复检查点绑定规范化公开载荷与 activationId。两类操作均复用原加密检查点，不改变已有恢复用途或密钥文件。必须先保存 proposal，再保存 prepared transaction，最后才提交；提交响应丢失时继续恢复原交易，不能重新创建预留。

这些是本机私有套接字能力。CommercialClient 与持久商业待办现已接受经双签审批组装的预留/释放；公共市场的通用提交接口仍只允许发布/认领/撤回；激活须走下述商业审批专用接口，market.publish 单独不足以授权。DATA_WAITING 保留原交易并等待重试；预算不足、授权或对象冲突进入复核，原始私有错误不会返回用户。

    KQ_FABRIC_TOOLS=/path/to/verified-fabric-3.1.5 bun run test:fabric:gate

复用隔离三机构网络，新增同通道第二份链码及分开的 market/commercial 证书，不使用同一证书冒充不同角色。保留商业全机构默认策略、私有集合双方 AND、市场 MAJORITY、lifecycle ALL。测试进程有现有限额，结束清理所属资源；KQ_FABRIC_KEEP_ARTIFACTS=1 仅保留本机含测试凭据的诊断目录，KQ_FABRIC_REPORT 仅输出无私有正文的断言摘要。

检查提交验证码、原生 MVCC 读集竞态及真实区块中的 PDC 写入：缺 B 背书、释放先提交、激活先提交、并发超额、重复预留/释放及第三方不可见。A/B 应取得私有写入；C 本地查询、C 请求 A 的私有区块及 A 请求没有私有副本的 C 均不能取到正文；公共区块与服务日志也不得出现金额、合同探针或签名。该入口已接入现有 Fabric CI。

同一入口随后通过生产 Node runtime 与 Server Unix 客户端释放一个已锁定但未激活的槽位，预留新任务并激活。每一步使用新进程；提交成功后主动退出、不保存响应，再恢复并核对相同交易和区块。预留额外经历 Orderer 停机/恢复；查询验证 REVOKED/READY 哈希、明确不存在及匹配的 ACTIVE 需求。前述私有区块遍历覆盖链码竞态交易，后续 Adapter 交易验证恢复与公开查询，不能据此宣称完成 Server 数据库或 Agent 的联合验收。


## Server 双签审批与持久待办

迁移 0121 增加按本机构/组织/合同归属的不可变预留与释放审批，商业待办接受两种新操作。双方须已批准同一 ledger_coordinated 商业合同，当前真人具有该组织 agreement.approve，机构签名密钥显式具备 commercial-reservation 或 commercial-release。信任管理页面可为新密钥选择这两个用途；既有密钥记录不可变，须登记并轮换，旧合同/用量用途不会自动扩权。双方及链信任配置须分别同步，平台登记不会擅自修改链治理。

合同下的 API 前缀为 /api/federation/commercial-agreements/:revisionId：

| 路径 | 用途 |
| --- | --- |
| GET /execution-approvals | 本机构组织的审批分页 |
| POST /execution-approvals | 对完整 CommercialReservation 或 CommercialRelease 确认并签名 |
| GET /execution-approvals/:recordId | 原签名、对方签名和最近提交状态，不含恢复密文/租约 |
| POST /execution-approvals/:recordId/counterparty | 提交 approvalJws；同文双签与待办同事务落库 |
| POST /submissions/:submissionId/retry | 复核失败后重排，未知交易继续恢复原 txId |

读取要求 agreement.read（approve 包含读取），写入要求 agreement.approve；平台角色不会自动获得此权。请求必须来自真人活动组织，禁止自动化凭据；接口 no-store。双方目前通过导出/交换签名再附加，不是无人值守的机构握手。审批属于机构业务承诺，原审批人离职不删除原记录；真正运行授权另由执行方策略控制。

新增预留签名前核对合同摘要、双方、资源/模板、私有封顶与期限。源站须持有本组织已 committed 的发布，提供方须持有本组织已 committed 的认领；同机构其他组织的公开需求/认领也不能借用。随后查询当前公共 CLAIMED/版本/claimId/商业域和资源。链不可用返回 503，非法响应返回 502，不生成签名；远程查询前后重新核对组织权限。查询只是预检，最终正确性由提交时的链码读集保证。相同 ID/内容重试返回原审批，即使需求后来激活，也不会另签或重复入队；改内容或跨组织使用原 ID 拒绝。

释放须引用同合同已双签的原预留摘要及 READY 版本；ACTIVE 的新释放审批拒绝。自然到期不自动释放。后台先等合同登记 committed，预留才能推进；释放再等对应预留 committed。发送提案前重新验双方当前密钥信任与专用签署用途；已有未知提交仍按原交易恢复，不能因撤权创建新交易。原有 90 秒租约、检查点先落库、迟到响应隔离和 INVALID 历史保留继续适用。

此审批不创建本地双边预算、不激活执行协议，也不提交 Job。独立数据库已覆盖权限变化、重复审批/附签、错签/错摘要、事务回滚、合同→预留→释放依赖、重启恢复及 HTTP 隔离；基础数据库检查使用 Adapter 替身，追加的真实 Fabric 联合入口已验证双签预留/释放与公开激活。公开激活待办已接通，执行授权与 Web 审批界面继续待接。


## 源站公开激活

迁移 0122 后，POST /api/federation/commercial-agreements/:revisionId/execution-approvals/:recordId/activate 只接受 {"activationId":"UUID"}，返回 202 与持久市场操作 ID；HTTP 成功表示入队，不是链已确认。请求者必须同时具备当前组织 agreement.approve 和 market.publish，且必须是需求源站；普通市场发布接口仍拒绝 activate-demand。

Server 从本组织原双签预留生成公开 gate，不接受调用者提交金额、gate、摘要或对方身份。检查本组织原发布已 committed、合同/委派期限、私有预留提交已 committed 且摘要相同，以及双方当前密钥信任；已有同预留双签释放时拒绝新的激活意图。原签名和预留不能代替最终链验证：后续并发释放或超时由同通道哈希读集裁决，不通过多次应用查询声称原子性。

同一次预留最多保存一个激活意图。同 ID 重试返回原操作，即使其后激活窗口到期也不会产生第二个意图；改 ID 重试冲突应读取原市场操作。唯一约束按预留划分，不永久锁死同一需求未来的其他认领；当前尚未实现重新开放流程。

激活复用既有 Market worker 的先持久化检查点、原交易恢复、90 秒租约与迟到响应隔离。accepted 意图是已批准的机构操作，原请求人离职不会删除后台待办；新执行仍须提供方独立验权。最近状态与历史从 /api/federation/market/operations/:activationId 读取；复核 retry 也同时要求上述两个权限。未知提交不允许换 txId，明确 INVALID 后才可新增交易尝试，保留历史与原公开载荷。

隔离 PostgreSQL 验证权限、锁额前拒绝、私有字段不进入公开意图、并发幂等、过期后读原意图、已有释放/密钥撤销拒绝、原交易恢复、INVALID 历史与通用接口绕过拒绝。基础检查使用 Adapter 替身；追加入口已联通真实 PostgreSQL 与生产 Adapter/Fabric，仍不是数据库→Fabric→Agent 的实际执行验收。


## 数据库与真实 Fabric 联合检查

    KQ_FABRIC_TOOLS=/path/to/verified-fabric-3.1.5 \
    KQ_FABRIC_DATABASE_URL=postgres://user:password@localhost/postgres \
    bun run test:fabric:gate:integration

该入口先验证原生竞态与私有区块，再创建随机隔离 PostgreSQL 库，启动生产 Node Commercial/Market Adapter；数据库账号需要创建和删除测试库的权限。双方业务服务使用各自真实签名密钥、不同组织和显式权限，确认同文合同、原预留、释放及新预留，再通过源站激活 API 对应的生产服务入队。历史市场发布/认领由前置真实链探针创建，并以对应内容导入本机测试数据库；并非全部市场发布也经 Server 完成。

检查释放后的真实 gate 哈希，以及原私有预留、释放和新预留的提交确认。公开激活保存 prepared 检查点后停止 Orderer，保持原待办；恢复后模拟丢失 VALID 响应，新的服务实例继续使用原交易，最终数据库只有一个交易尝试，链上 ACTIVE 关联同一 activationId/预留。这里的恢复是服务实例和响应故障，不是完整 Server 进程 SIGKILL；单独的 test:fabric:gate 入口仍覆盖生产 Adapter 跨进程恢复。

测试结束清理所属 Node/Fabric 进程与临时数据库。该入口已接入 Fabric CI，报告仅含断言摘要；本机含密钥、签名和私有材料的诊断文件只保留在忽略目录。原生私有区块遍历覆盖前置竞态交易，数据库后的检查覆盖真实提交、gate 哈希和公开 ACTIVE，不额外宣称遍历了所有后续私有区块。未启动 Agent 或计算 Job，不代表真实科研软件和 Workflow 已通过联邦执行验收。


## 本地执行账户同意

现有 `/api/federation/agreements/approve` 与 `/:revisionId/counterparty` 支持为已商业双签的 ledger_coordinated 协议保存本地执行同意。两站分别使用当前组织的 agreement.approve；提供方显式选择受限 executionUserId。协议正文必须与本组织商业合同嵌入的 agreement 完全相同，双方商业签名及当前用途会重新验证。

迁移 [0123](../../packages/db/migrations/0123_petite_wallop.sql) 只让协调协议的本地预算外键为空，完整预算标识仍在签署条款中；双边协议仍必须有预算。不要为协调协议人工插入本地余额。批准与安装不需要在线 Fabric，亦不证明商业合同/锁额已经上链；实际接单仍返回 LEDGER_REQUIRED，Web 的可运行模式暂不扩大。这一步不替代公开激活、当前链上运行许可或本地派发授权。
