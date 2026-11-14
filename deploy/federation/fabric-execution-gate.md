# 私有额度与公共执行许可

本页说明同一 Fabric 通道中的 kq-commercial / kq-market 协议。链上 ACTIVE 表示原需求已激活；平台还须核对有效执行确认、本地授权和数据与软件条件，才能派发 Job。

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

预算键由商业域、budgetDomainId、epoch 组成，不使用合同修订 ID。首次预留按双方已确认的固定额度建立预算；后续修订必须匹配原双方、单位、总额度和预留数量上限，不能增大上限或重置余额。整数金额全程 BigInt，判定 locked + spent + 本次封顶不超过 limit，同时限制预留数量。不同合作域不共用一个隐含钱包；这不是可转让货币，也不是执行机构报告用量后自动增发积分。

预留、预算增加、唯一映射及 READY gate 在一笔私有交易中写入。仅 VALID 表示锁额成立。相同请求重放写回原私有预留字节，继续受集合 AND 策略约束；不重复扣款，也不重置 gate。

## 激活、释放与当前边界

公开 ActivateDemand 只能由需求机构调用，要求当前 CLAIMED/version、claimId、商业域与 gate 一致。成功写入 ACTIVE 与不可变 activation；重复原激活返回原回执，不能产生第二次授权。gate 的 expiresAt 是激活窗口，执行窗口仍在私有委派 executionExpiresAt 中，执行端须独立核验。

ReleaseExecution 使用专用 commercial-release 双签正文，绑定原预留摘要及 gate 版本。只允许尚未激活的 CLAIMED 需求：同一交易减少 locked/预留计数，保留原始记录，追加释放回执，并将 gate 升版为 REVOKED。重复释放不重复退款；旧预留重放不会把 REVOKED 改回 READY。自然到期不等于已经停止执行，ACTIVE 不能沿此接口释放。

ACTIVE/STOPPING 使用下文的双方终态确认与公共关闭协议，资金结算另按双签账单办理。公共重新开放、预算扩额/跨域划拨及自动代际迁移不在当前接口范围内。新签署用途须分别进入链与 Server 信任配置；协调执行还必须经过有期限的 VALID 确认和本地当前授权。

## ACTIVE 的停止意图

`RequestExecutionStop` / Adapter `request-execution-stop` 允许原委派方或原执行方将指定激活的需求由 ACTIVE 改为 STOPPING。公开正文只有 demandId、stopId、issuerSiteId、activationId 和原 ACTIVE 版本 expectedVersion；不接受停止原因、合同、用量或价格。请求人须是具有 market 用途的实际机构身份，使用既有公共市场原生背书策略。停止意图不需要对方业务签名，也不替代任何资金操作的双方批准或私有集合背书。

每次真实 activation、每个参与机构最多保存一个不可变停止请求。双方同时申请时，以第一笔 VALID 设置 STOPPING；另一方重试后保留自己的回执，不再次改变需求版本。同一机构换 stopId 或改正文会冲突。历史原文重放只返回原回执，不能影响将来的激活。请求不受已过期的接单/执行窗口阻拦，亦不依赖商业私有数据是否可用。

expectedVersion 固定为 `activation.expectedVersion + 1`，不是随后 STOPPING 的当前版本。新增状态须随两个链码、Adapter 和 Server 读取 schema 一同升级后再启用；旧严格读取方不识别 STOPPING，会拒绝响应，不能据此把任务恢复为 ACTIVE。

停止事务写入公共需求，执行确认读取同一键。停止先提交时，之前基于 ACTIVE 背书的续期因原生 MVCC 失败；STOPPING 上新申请确认直接拒绝。已经 VALID 的旧确认不被改写，现有消费者仍执行其绝对期限；这项链操作不是即时撤销离线授权或已停止调度器进程的证明。Server 专用入口先持久保存本地停止意图；本地事务内验权与独立 Workflow 监控拒绝续期并发起取消，继续核对真正的停止回执。

STOPPING 保留原激活、认领和私有 gate，原 ReleaseExecution 仍拒绝释放它，也不能通过 CancelOpenDemand 或 ClaimDemand 重开。终态证明和结算分别沿下文的独立协议处理，关闭后不重新开放；通用市场 HTTP 提交 schema 不接受该操作，Server 通过下述专用入口创建待办。不能把 STOPPING 显示成“已停止”或“已退款”。

## 网络诊断

Commercial Adapter 的固定 proposal 接口增加 reserve-execution/release-execution，验过双方专用签署用途、相同摘要及路由绑定后，才把 transient 发给该域的两个 MSP。固定 query 接口只允许 get-execution-gate-hash，返回 hash 或明确不存在的 null；连接故障和含混错误不会变成不存在，响应不允许夹带私有字段。配置机构必须属于该域。

Market Adapter 增加 activate-demand，恢复检查点绑定规范化公开载荷与 activationId。两类操作均复用原加密检查点，不改变已有恢复用途或密钥文件。必须先保存 proposal，再保存 prepared transaction，最后才提交；提交响应丢失时继续恢复原交易，不能重新创建预留。

这些是本机私有套接字能力。CommercialClient 与持久商业待办现已接受经双签审批组装的预留/释放；公共市场的通用提交接口仍只允许发布/认领/撤回；激活须走下述商业审批专用接口，market.publish 单独不足以授权。DATA_WAITING 保留原交易并等待重试；预算不足、授权或对象冲突进入复核，原始私有错误不会返回用户。

    KQ_FABRIC_TOOLS=/path/to/verified-fabric-3.1.5 bun run test:fabric:gate

复用隔离三机构网络，新增同通道第二份链码及分开的 market/commercial 证书，不使用同一证书冒充不同角色。保留商业全机构默认策略、私有集合双方 AND、市场 MAJORITY、lifecycle ALL。测试进程有现有限额，结束清理所属资源；KQ_FABRIC_KEEP_ARTIFACTS=1 仅保留本机含测试凭据的诊断目录，KQ_FABRIC_REPORT 仅输出无私有正文的断言摘要。

检查提交验证码、原生 MVCC 读集竞态及真实区块中的 PDC 写入：缺 B 背书、释放先提交、激活先提交、并发超额、重复预留/释放及第三方不可见。A/B 应取得私有写入；C 本地查询、C 请求 A 的私有区块及 A 请求没有私有副本的 C 均不能取到正文；公共区块与服务日志也不得出现金额、合同探针或签名。该入口已接入现有 Fabric CI。

同一入口随后通过生产 Node runtime 与 Server Unix 客户端释放一个已锁定但未激活的槽位，预留新任务并激活。每一步使用新进程；提交成功后主动退出、不保存响应，再恢复并核对相同交易和区块。预留额外经历 Orderer 停机/恢复；查询验证 REVOKED/READY 哈希、明确不存在及匹配的 ACTIVE 需求。前述私有区块遍历覆盖链码竞态交易，后续 Adapter 交易验证恢复与公开查询，不能据此宣称完成 Server 数据库或 Agent 的联合运行。

## Server 双签审批与持久待办

数据库增加按本机构/组织/合同归属的不可变预留与释放审批，商业待办接受两种新操作。双方须已批准同一 ledger_coordinated 商业合同，当前真人具有该组织 agreement.approve，机构签名密钥显式具备 commercial-reservation 或 commercial-release。信任管理页面可为新密钥选择这两个用途；既有密钥记录不可变，须登记并轮换，旧合同/用量用途不会自动扩权。双方及链信任配置须分别同步，平台登记不会擅自修改链治理。

合同下的 API 前缀为 /api/federation/commercial-agreements/:revisionId：

| 路径 | 用途 |
| --- | --- |
| GET /execution-approvals | 本机构组织的审批分页 |
| POST /execution-approvals | 对完整 CommercialReservation 或 CommercialRelease 确认并签名 |
| GET /execution-approvals/:recordId | 原签名、对方签名和最近提交状态，不含恢复密文/租约 |
| POST /execution-approvals/:recordId/counterparty | 提交 approvalJws；同文双签与待办同事务落库 |
| POST /submissions/:submissionId/retry | 复核失败后重排，未知交易继续恢复原 txId |

读取要求 agreement.read（approve 包含读取），写入要求 agreement.approve；平台角色不会自动获得此权。请求必须来自真人活动组织，禁止自动化凭据；接口 no-store。双方可人工导出并附加对方原签名，也可配置商业签名自动交换；自动预留须另行设置下文机构策略。审批属于机构业务承诺，原审批人离职不删除原记录；真正运行授权另由执行方策略控制。

新增预留签名前核对合同摘要、双方、资源/模板、私有封顶与期限。源站须持有本组织已 committed 的发布，执行机构须持有本组织已 committed 的认领；同机构其他组织的公开需求/认领也不能借用。随后查询当前公共 CLAIMED/版本/claimId/商业域和资源。链不可用返回 503，非法响应返回 502，不生成签名；远程查询前后重新核对组织权限。查询只是预检，最终正确性由提交时的链码读集保证。相同 ID/内容重试返回原审批，即使需求后来激活，也不会另签或重复入队；改内容或跨组织使用原 ID 拒绝。

释放须引用同合同已双签的原预留摘要及 READY 版本；ACTIVE 的新释放审批拒绝。自然到期不自动释放。后台先等合同登记 committed，预留才能推进；释放再等对应预留 committed。发送提案前重新验双方当前密钥信任与专用签署用途；已有未知提交仍按原交易恢复，不能因撤权创建新交易。原有 90 秒租约、检查点先落库、迟到响应隔离和 INVALID 历史保留继续适用。

此审批不创建本地双边预算、不激活执行协议，也不提交 Job。公开激活、执行确认及本地执行同意分别使用下文入口。

## 源站公开激活

POST /api/federation/commercial-agreements/:revisionId/execution-approvals/:recordId/activate 只接受 {"activationId":"UUID"}，返回 202 与持久市场操作 ID；HTTP 成功表示入队，不是链已确认。请求者必须同时具备当前组织 agreement.approve 和 market.publish，且必须是需求源站；普通市场发布接口仍拒绝 activate-demand。

Server 从本组织原双签预留生成公开 gate，不接受调用者提交金额、gate、摘要或对方身份。检查本组织原发布已 committed、合同/委派期限、私有预留提交已 committed 且摘要相同，以及双方当前密钥信任；已有同预留双签释放时拒绝新的激活意图。原签名和预留不能代替最终链验证：后续并发释放或超时由同通道哈希读集裁决，不通过多次应用查询声称原子性。

同一次预留最多保存一个激活意图。同 ID 重试返回原操作，即使其后激活窗口到期也不会产生第二个意图；改 ID 重试冲突应读取原市场操作。唯一约束按预留划分，不永久锁死同一需求未来的其他认领；当前尚未实现重新开放流程。

激活复用既有 Market worker 的先持久化检查点、原交易恢复、90 秒租约与迟到响应隔离。accepted 意图是已批准的机构操作，原请求人离职不会删除后台待办；新执行仍须执行机构独立验权。最近状态与历史从 /api/federation/market/operations/:activationId 读取；复核 retry 也同时要求上述两个权限。未知提交不允许换 txId，明确 INVALID 后才可新增交易尝试，保留历史与原公开载荷。

隔离 PostgreSQL 验证权限、锁额前拒绝、私有字段不进入公开意图、并发幂等、过期后读原意图、已有释放/密钥撤销拒绝、原交易恢复、INVALID 历史与通用接口绕过拒绝。基础检查使用 Adapter 替身；追加入口已联通真实 PostgreSQL 与生产 Adapter/Fabric，仍不是数据库→Fabric→Agent 的实际执行运行。

## 数据库与真实 Fabric 联合检查

    KQ_FABRIC_TOOLS=/path/to/verified-fabric-3.1.5 \
    KQ_FABRIC_DATABASE_URL=postgres://user:password@localhost/postgres \
    bun run test:fabric:gate:integration

该入口先验证原生竞态与私有区块，再创建随机隔离 PostgreSQL 库，启动生产 Node Commercial/Market Adapter；数据库账号需要创建和删除测试库的权限。双方业务服务使用各自真实签名密钥、不同组织和显式权限，确认同文合同、原预留、释放及新预留，再通过源站激活 API 对应的生产服务入队。历史市场发布/认领由前置真实链探针创建，并以对应内容导入本机测试数据库；并非全部市场发布也经 Server 完成。

检查释放后的真实 gate 哈希，以及原私有预留、释放和新预留的提交确认。公开激活保存 prepared 检查点后停止 Orderer，保持原待办；恢复后模拟丢失 VALID 响应，新的服务实例继续使用原交易，最终数据库只有一个交易尝试，链上 ACTIVE 关联同一 activationId/预留。这里的恢复是服务实例和响应故障，不是完整 Server 进程 SIGKILL；单独的 test:fabric:gate 入口仍覆盖生产 Adapter 跨进程恢复。

测试结束清理所属 Node/Fabric 进程与临时数据库。该入口已接入 Fabric CI，报告仅含断言摘要；本机含密钥、签名和私有材料的诊断文件只保留在忽略目录。原生私有区块遍历覆盖前置竞态交易，数据库后的检查覆盖真实提交、gate 哈希和公开 ACTIVE，不额外宣称遍历了所有后续私有区块。

## 本地执行账户同意

现有 `/api/federation/agreements/approve` 与 `/:revisionId/counterparty` 支持为已商业双签的 ledger_coordinated 协议保存本地执行同意。两站分别使用当前组织的 agreement.approve；执行机构显式选择受限 executionUserId。协议正文必须与本组织商业合同嵌入的 agreement 完全相同，双方商业签名及当前用途会重新验证。

迁移 [数据库结构](../../packages/db/migrations/0079_conscious_anthem.sql) 只让协调协议的本地预算外键为空，完整预算标识仍在签署条款中；双边协议仍必须有预算。不要为协调协议人工插入本地余额。批准与安装不需要在线 Fabric，亦不证明商业合同/锁额已经上链；缺少有效链上许可时，实际接单返回 LEDGER_REQUIRED。这一步不替代公开激活、当前链上运行许可或本地派发授权。

## 有期限的链上执行确认

新增 Market `AuthorizeExecution` 与 Adapter `authorize-execution`。普通 GetDemand 查询可能来自落后 Peer，不能直接授权派发；执行确认必须经过正常背书、排序和 VALID 提交。交易同时读取公开 ACTIVE 状态、当前 activationId 和同通道商业 gate 哈希；这些实际读集参与 Fabric MVCC 校验。确认只带 authorizationId、issuerSiteId、demandId、activationId、原公开 gate 和起止时间，不包含价格、用量、合同正文或完整委派。

只有原需求方或认领执行机构可以为自己申请确认，MSP/站点属性与 issuerSiteId 必须相同；第三方不能冒名。gate 必须与已激活的原文完全一致，当前私有哈希也须匹配。期限为绝对时间，最长 5 分钟；相对于 Fabric 提案时间，issuedAt 不得在未来或早于 60 秒前，expiresAt 必须尚未到达。这里的提案时间不是可信墙钟，消费方必须用本机时钟复查绝对期限，并取原私有委派 executionExpiresAt、本地授权和 Agent 租约的最短期限；不能只看 committed。

世界状态按 `(demandId, issuerSiteId)` 只保留最新确认，两方分别保存。新确认的 issuedAt 必须递增；旧 ID 不能换内容，旧请求不能覆盖更新记录。同一确认重新背书仍核对当前 ACTIVE/gate 和期限；恢复已提交交易通过原 txId 获取结果，不重新生成 ID 或延长期限。历史交易留在区块中，当前状态覆盖不等于区块裁剪，持续续期仍会产生账本存储开销。

商业 gate.expiresAt 是原激活窗口，已成功激活的执行续期不使用它作为运行终止时间；运行截止由原私有委派控制。链故障期间不能把 prepared/pending 或过期 VALID 当作新许可，超时也不证明旧作业已停止，不自动释放锁额或重新开放需求。

生产 Node Market Adapter 和 Server Unix 客户端已支持该固定操作并复用加密检查点、原交易恢复；通用市场 HTTP 输入保持原三操作。数据库结构允许专用确认意图进入现有市场待办，绑定行 ID、申请站点和需求。Server 的 `FederationExecutionConfirmationService` 提供申请、续期与事务内验权，已接入源站发送/材料披露、执行机构接单/准备和派发。缺少服务配置时仍返回 LEDGER_REQUIRED。

人工申请入口为 `POST /api/federation/commercial-agreements/:revisionId/execution-approvals/:recordId/confirm`，请求体必须为 `{}`，返回 202 和确认 ID、状态、绝对期限。需要当前组织的 agreement.approve 权限；gate、activationId 和时间均由服务端生成。内部调用方仍须独立检查自己所执行动作的权限。申请会核对同组织的双签执行同意、商业合同、精确私有委派及已提交预留；执行机构还须有当前有效的受限执行账户。查询 ACTIVE 只用于构造意图，不能授权工作。

同一预留的并发申请复用待办；剩余期限超过一分钟时复用最近一份确认，否则生成新 ID 续期，保留旧意图与交易。续期未完成时旧 VALID 仍可用至原截止时间，不能在恢复时延长旧期限。最终消费在调用方事务内重新检查本地同意、签名信任、撤销和精确绑定，并要求持久交易检查点为 committed、validationCode=0 且存在区块号。授权截止取确认期限、私有执行期限、协议期限和相关签名密钥期限的最小值；本地暂停立即否决，即使链上确认仍有效。该服务不创建或扣减本地预算。

消费者在事务外尝试续期、最终操作事务内重新验权。短暂 Adapter 故障时只允许仍有效的原 VALID 确认继续使用，不降级为直连，不以断线证明已停止。执行机构接单回执采用原商业预留 ID，并发重试保持同一份回执；已接单回执可离线恢复，但不会恢复材料或派发权限。协调模式不创建/扣减本地余额，仍检查私有委派精确金额、资源上限和本地接单数量。源站下载凭据与执行机构派发/运行续租均取链确认的最短截止时间；现有 Agent 租约仍进一步限制有效期。

自动运行须先完成双方商业审批和执行同意，再按下述独立预授权推进市场、私有预留和公开激活。ACTIVE 停止及结算分别使用专用流程，公共需求不重新开放。Web supportedModes 只列两个双边执行协议模式；协调商业和 Workflow 使用各自入口。组件诊断与完整执行场景分别运行。

确认验证已纳入两个真实网络入口：`test:fabric:gate` 覆盖原生读集/MVCC、第三方拒绝及 Adapter 故障恢复；`test:fabric:gate:integration` 在真实数据库审批/激活之后验证服务端申请、VALID 消费、本地暂停拒绝，再运行 Adapter 确认恢复，CI 使用后者。

### 平台停止接口与本地约束

`POST /api/federation/commercial-agreements/:revisionId/execution-approvals/:recordId/stop` 仅接受空 JSON，对当前组织要求 `agreement.approve`，只允许停止本机构持有的协调执行预留。202 返回原停止 ID 与请求时间，表示本地意图已持久化，不表示链已确认或调度器已停止。重复调用返回同一 ID。停止不要求合同仍有效、签名密钥仍可续期或对方重新批准；失效授权不能阻挡本机构停止自己的任务。

数据库结构在原审批记录保存停止元数据，不修改签名正文。同一事务写入意图和审计，原最终授权持有审批共享锁，与停止写入互斥；记录停止后，即使原 VALID 尚未到期或市场提交为 pending/needs_review，本地接单、材料、派发和续期也不再获准。现有独立执行监控在准备流程临时故障时仍检查本地停止记录，调用正式 Workflow 取消流程；实际 Agent 停止和终态观察继续使用原有机制。

后台在事务外查询精确激活并生成固定公开停止载荷，再复用市场检查点提交和恢复。链不可用时保留本地停止，查询失败写入 stopLastError 并退避；未激活的预留显示 ACTIVATION_PENDING，不能借停止触发新激活或释放资金。审批详情返回 stopId、stopRequestedAt、stopLastError 和 stopSubmission；后者可进一步通过市场详情查看交易状态。已进入市场 needs_review 的请求使用原 retry 接口，要求 market.read 和 agreement.approve，不以 market.publish 替代业务批准。未知已提交交易仍恢复原交易。

源站普通委派取消在原授权事务内同步记录该停止意图，沿用 delegation.cancel 或持久 Workflow 取消授权，不额外要求用户成为商业审批人。原签名取消通道仍独立投递。机构专用停止接口不会冒充源站用户签署远端取消：执行机构本地由监控停止，另一方受 STOPPING 与既有 VALID 的绝对期限约束。没有自动把既往取消记录回填为链停止，也没有声称断链时能立即撤销另一机构已经持有的离线证明。终态证明与额度结算使用独立协议；停止操作不重新开放需求。

## 双方终态确认与公共关闭

`CommercialTerminal` 是双方对同一份终态材料的签署，不是自动证明科研计算正确，也不是账单、付款或退款。新用途 `commercial-terminal` 必须在双方业务密钥的信任配置中显式列出，旧 reservation/release 用途不会自动包含它。正文绑定原私有预留摘要、activationId、gate 版本、完成/失败/取消结果、执行证据摘要、可选结果清单摘要、观测/签署时间与随机盐；只通过 commercial transient 发送至双方集合成员并存入 PDC。观测不得早于原委派，终态确认允许在原执行窗口结束后提交。

`RecordExecutionTerminal` 核对两份同文签名、原预留和 ACTIVE/STOPPING 激活，不接受第三机构、错激活、未激活或已释放预留。它保留不可变终态正文，将原私有 gate 从 READY 升版为 TERMINAL，但不修改预算的 locked、spent 或预留数量。该 gate 写入与执行确认读取的私有哈希冲突：终态先提交，旧状态上已背书的续期必须 MVCC INVALID。旧已 VALID 证明不会被历史改写；平台还必须先持久停止本地派发并验证所有执行与清理回执，不能用双方签名替代实际调度器观测。

公共 `CloseDemand` 只携带 TERMINAL gate 的可公开原文。gate 保留原公开路由与预留摘要，仅新增 terminalId、activationId 和带盐终态正文摘要；不公开 outcome、执行证据、结果清单、签名、用量或金额。原两方任一机构可按固定 terminalId 关闭对应 ACTIVE/STOPPING；链码通过同通道 GetExecutionGateHash 验证双方终态确认已提交，随后写 CLOSED。关闭保留原激活及可选停止请求；同文重试不增版，不依赖后来 gate 的变化，且不会允许新认领或续期。

这一协议已接入链码、生产 Adapter 与 Server Unix 客户端的固定传输类型；普通市场创建接口和商业审批接口仍不接受终态正文。商业提交 worker 仅接受专用复核流程产生、具有匹配本地终态和双签的持久待办；通用商业审批接口不开放该操作。不能仅通过原审批 API 上传一个自行构造的摘要就释放资金。

CLOSED 表示双方确认的执行终态已登记，不表示已结算。预算结算须另有双方账单批准，技术更正、商务减免与支付分别记录；争议中的预留保持锁定。公共重新开放还须检查对应财务终结，旧终态/停止原文不能作用于新激活。账务操作见[独立额度结算](fabric-commercial.md#独立额度结算协议)；公共需求关闭后不重新开放。

### 执行机构终态证据与本地执行防线

数据库保存 `federation_execution_terminals`。执行机构可调用
`POST /api/federation/commercial-agreements/:revisionId/execution-approvals/:recordId/terminal`，
正文只能是 `{}`，要求当前组织的人工会话和 `agreement.approve`。同路径 GET 要求 `agreement.read`，返回本机构保存的原记录，尚未签署时为 null。接口不会接受调用者指定的 outcome、证据摘要或 Job 清单。

首次签署先查询原 ACTIVE/STOPPING 激活，校验私有预留、公开需求、双方和 gate 的精确绑定。随后在商业预留写锁下，从原入站委派和唯一 Workflow 绑定归集全部 Job 观察记录；检查签名、
执行快照、动态调用路径、执行身份、派发代次和终态。缺失 Job、证据或错误绑定拒绝签署。尚未结束的 Workflow/Job、未确认的取消与数据撤销、仍在搬运/清理的输入、未结束且没有停止确认的安装保持 `DATA_WAITING`。已到达 Agent 的作业不能仅凭平台修改状态就视为停止；需要原 Agent 终态事件或对应代次的停止回执。安装日志可能仍显示 running，此时只有确认了 installation-stop 的回执才可以作为停止依据，原日志状态照实保留。如果源方已提出取消，还必须等待原取消监控 confirmedAt，并要求已存在的输入导入处于 cancelled；不能绕过尚未完成的输入清理。输入状态和取消摘要/确认时间一起纳入证据。

已完成且合同要求结果交付的任务，必须已有源方签署的结果接收回执；校验原任务/尝试/委派、
签名及唯一清单摘要后纳入终态材料。没有配置结果交付的合同不虚构回执。失败/取消不声称结果已交付。清理检查针对尚未完成的传输/撤销操作，不意味着删除所有获准保留的数据。作业已经结束但原执行期限过期仍可签署；双方相关业务密钥仍须通过当前信任检查，执行机构必须显式配置 `commercial-terminal` 用途。

签名、完整私有证据、终态 ID 和审计在同一事务落库。原执行确认持有同一预留的共享锁；
终态落库后，旧 VALID 确认、续期、派发以及独立 Workflow 监控都拒绝再次执行。查询与写入之间会重新检查机构权限。并发请求和进程重启返回同一份原文/签名，
不重新生成终态、不重新查询链。业务记录锁冲突采用 NOWAIT 回滚，避免与派发的锁顺序互相等待。

执行机构这一步保存单方声明，不会自动获得源方终态批准，也不会触发链上终态/关闭或资金释放。证据仅向当前机构的授权审批人展示；不含脚本正文、环境变量、stdout/stderr 或安装 spec。后续源方必须结合自己的结果导入或停止确认进行复核，不能直接回签任意摘要。

### 源方复核签署与私有上链待办

执行机构 `GET /api/federation/commercial-agreements/:revisionId/execution-approvals/:recordId/terminal/proposal`
导出 `{payload, evidence, providerJws}`，要求本机构 `agreement.read`。源方对应
`POST .../terminal/countersign` 接受这份完整材料，要求本机构人工会话和 `agreement.approve`。该路径正文上限 16 MiB，其他商业接口保持原 600,000 字节限制；不接受仅一个摘要或调用者提供的源方复核记录。机构材料获取与对签回传已通过后台 mTLS 通道接通；机构业务批准仍使用专用 API，见下文。

源方重新核对 ACTIVE/STOPPING 激活和原私有预留、双方业务签名及当前密钥用途。执行机构签名必须覆盖终态原文，原文中的证据摘要必须匹配完整证据；核对每个 Job 的任务/尝试、
Workflow 快照与调用路径、终态观察，以及安装/取消/数据撤销的停止确认。执行机构的有签名声明仍不能独立证明科研结果正确。

源方不能只依据对方自报的摘要签署：还须有本机构原 accepted 委派、接单签名和已核验的同一任务终态报告。成功且要求结果交付时，本机构必须已完成对应结果导入（available）并保存签名接收回执；核对双方、
任务/尝试、结果清单 SHA-256、模板、输入清单、环境锁、完成时间、文件数及字节数。对方拿出源方曾签署的接收回执，也不能替代源方本地的匹配导入记录。源方发起过取消时，必须已有本地
stopped 回执，且其取消摘要、终态和执行机构保留的取消确认一致。缺失证据保持 DATA_WAITING，冲突拒绝签署。

数据库结构在终态表加入对方签名和源方私有复核材料，并允许专用终态提交类型。源方签署同一份原文，同事务保存本地执行防线、复核依据、审计及 record-execution-terminal 待办。保留原委派/接单/状态和结果报告的签名原文，取消还保留停止回执；源方导入 ID 和复核材料不会发给执行机构或公共链。原终态 issuedAt 不因源方签署而改写，源方实际复核时间单独保存在 sourceReview.reviewedAt 与审计中。并发和重启保持同一份签名及待办，已保存同文重试不要求链在线；换证据、换原文或换对方签名均拒绝。

商业 worker 等待原预留提交后处理终态。向 Adapter 披露前，重新核对本地终态、源方复核记录、双签、双方和 domain；
篡改或当前信任失效进入 needs_review，不发送新材料。投递复用原持久检查点，断链/重启恢复同一交易；
未知提交结果仍不得生成另一份业务终态。终态 GET 返回 submission 和最新交易 ID/阶段/区块，便于核对签署与上链状态。只有带盐终态原文和双签进入双方 PDC，完整 Job 证据及源方复核材料留在双方受控系统。

### 私有终态后的自动公共关闭

数据库结构放开内部 close-demand 待办，并按本机构/activation 唯一约束。源方商业 worker 只有在私有终态最新交易取得 committed、validationCode=0 和区块号后，才在同一事务保存确认、公共关闭待办与审计。关闭 ID 固定为 terminalId，expectedVersion 始终引用原 ACTIVE 版本（claimVersion+1），STOPPING 不改变该锚点；gate 保留原准入 expiresAt，不换成执行期限。

升级或重启后，已有 VALID 私有终态缺少关闭待办会被原商业队列补办；沿用租约和错误复核机制，不另建轮询器。已确认的历史交易不要求重新业务签署，也不因旧签署密钥到期而阻塞关闭。私有确认与入队事务失败时保留原交易检查点；重试查询原交易，不再次生成终态。公共 worker 在首次准备和未披露提案推进前，核对本地双签记录、原预留、私有 VALID 回执和完整关闭正文；已发送但结果未知的交易始终按原 ID 恢复。

终态 GET 额外返回 closure 的待办状态、错误和最新交易 ID/阶段/验证码/区块号。公共正文只含 gate 与绑定，不包含结果类型、完整执行证据、私有签名或费用。通用市场创建 API 仍不接受 close-demand，人工复核重试须具备 market.read 和 agreement.approve。

本地终态存在时，未发送的续期/停止提案进入 needs_review（EXECUTION_TERMINAL），避免无效重试；已经发送的交易仍查询原结果。尚未入队的停止意图在查询到精确原激活的 CLOSED 后结束投递，本地停止 ID 和永久执行防线保留。公共关闭不会确认账单、释放锁额、退款或重开。

目前自动关闭由源方驱动，执行机构可收到源方对签并通过公共市场查询 CLOSED。

### 终态材料自动交换与对签回传

数据库增加源方终态同步与临时分块表。商业 worker 发现本机构已接单、具有商业双签的协调预留后，使用 `/federation/v1/terminals` 查询执行机构已批准的不可变终态。缺少执行机构声明时每 60 秒重查；每次仅传 64 KiB 原始字节，整包上限 16 MiB，固定 terminalId、材料摘要、总长度及偏移，按完整 SHA-256 和执行机构业务签名核对。临时分块和游标在同一事务保存，重启从原位置续传；完成后保存完整 proposal 并删除临时分块，不重复保留两套正文。

消息使用 60 秒查询窗口、原任务/尝试/预留/合同绑定和独立用途：源方密钥配置 `terminal-query`、`terminal-delivery`，执行机构密钥配置 `terminal-chunk`、`terminal-ack`；实际终态批准仍需 `commercial-terminal`。Node mTLS 网关和签名客户端只开放这两个固定路径（第二个为 `/federation/v1/terminal-signatures`），单条 JOSE 仍限 512 KiB、签名正文仍限 256 KiB。不会因大材料而放宽通道全局限额。终态整体摘要允许 16 MiB，普通输入材料的规范编码仍默认限制 1 MiB，编码结果不变。

接收完成进入 ready；默认不自动签署、执行或结算。机构另行配置下节的终态预授权时，后台可独立复核并签署。原 `.../:recordId/terminal` 路径下新增：

- `GET /exchange`：本组织 `agreement.read` 可读取完整已接收 proposal、进度、错误及源方保存的执行机构签名回执；不输出租约 token。
- `POST /countersign-received`：仅空对象，当前人工组织会话仍须 `agreement.approve`，沿用原源方独立复核与签署服务。
- `POST /refresh`：仅空对象、须 `agreement.approve`，重排同步，不抢占有效租约，也不清除已确认回执。

源方完成批准后，后台自动回传原终态签名；执行机构只接受自身原声明的同文对签，在事务中持久保存并审计，再返回签名 ACK。网络回包丢失可重发，同一对签不重复审计或改变原终态；源方只有验证 ACK 后进入 complete。完整源方复核记录、本地用户和结果导入 ID 不随对签回传。这里的 complete 仅表示对签交付完成，私有存证和公共关闭继续分别显示，不能当作账单确认或付款。

后台使用 60 秒租约、SKIP LOCKED 和 token 复查。首次披露及响应保存前重核当前机构/密钥信任、原端点和合同绑定；证书撤销、协议冲突或错误签名进入 needs_review，网络故障退避。当前认证消息可重申历史未撤销签名，按其原签署时间核验；撤销密钥不能以历史日期绕过。失效或撤销的业务协议不抹除既有终态记录，但机构信任失效会停止交换。保留签名配置但不配置发送通道时，读取历史与被动接收仍可用，后台不发请求。

### 按协议版本预授权终态批准

数据库增加机构终态授权。默认没有授权；单纯收到材料仍不会自动批准。每个站点对每个商业协议 revision 最多保留一条未撤销授权，绑定本地组织、该版本的合同摘要、允许的 `completed` / `failed` / `cancelled` 结果及明确到期时间。它适用于该版本下已经双签的既有和后续预留，不授权新合同、接单、账单确认、额度释放或付款。双方分别配置自己的授权；一方授权不代表另一方同意。

管理入口要求当前人工组织会话及 `agreement.approve`；读取要求 `agreement.read`：

- `GET /api/federation/commercial-agreements/:revisionId/terminal-policies?limit=50&offset=0`：分页读取授权历史，包含授权人、有效期和撤销记录。
- `POST .../:revisionId/terminal-policies`：正文示例 `{"outcomes":["completed"],"validUntil":"2030-01-01T00:00:00Z"}`。时间必须晚于当前时间，结果列表不可为空、重复或包含其他结果，额外字段拒绝。实际时间由机构自行确定。
- `POST .../:revisionId/terminal-policies/:policyId/revoke`：空对象，撤销原授权；重复撤销幂等。修改范围或续期须先撤销、再创建新 ID，旧记录不可覆盖；已经到期的记录也须显式撤销后再替换。
- `POST .../:revisionId/execution-approvals/:recordId/terminal/automatic-retry`：空对象，具备当前有效授权时，人工复核后重新排队。原终态已存在时不重新签署。

授权属于机构，授权人的个人角色变化不自动撤销已经发出的机构授权；机构应在交接或撤权时明确撤销不再适用的授权。`approvedBy` 在自动记录中保存原授权人，`authorizationPolicyId` 区分预授权与交互批准，签署及后续交换审计的 actor 使用 `terminal-policy:<id>`，不伪装成一次人工会话。授权范围、签署和撤销均有事务内审计。授权人、策略 ID 和完整证据留在本机构，不加入跨站业务正文或公共链。

商业 worker 只挑选已经结束的执行机构 Workflow 或已收到完整 proposal 的源方预留；未授权、运行中、未收到材料的记录不会被自动批准。选择使用 SKIP LOCKED 和持久化的 60 秒下次处理时间，多实例/重启允许重试；最终签署仍锁定同一预留并幂等，重复后台处理不会产生第二份签名或链上意图。执行机构沿用真实 Job/停止/结果回执归集；源方沿用本地 accepted 委派、可信终态报告、实际结果导入或停止回执的独立复核。

查询链状态前、返回后和签名落库前复查授权。最终事务持有授权共享锁，撤销更新与签署串行：撤销先完成则不能签署；已经签署的记录及永久执行防线不因撤销而删除。授权到期同样阻止新的自动签署，但不撤回已批准的终态及后续交付/存证。链不可用、证据仍在等待、数据库短暂锁冲突保留 pending；权限/签名/绑定冲突进入 needs_review，原始证据不修改，换一条授权也不会偷偷解除这项复核。

原执行审批 GET 返回 `terminalAutoState`、`terminalAutoError` 和 `terminalAutoNextAt`。终态 GET 中实际签名记录存在表示批准已完成；自动待办字段仅在没有终态时有处理意义。交换 ACK、私有 VALID、公共 CLOSED 仍分别判断，均不表示账单或付款完成。

## 新任务预留的机构预授权

`reservation-policies` 与 `terminal-policies` 分开：前者允许机构在约定范围内批准新的商业预留，后者只批准已结束任务的终态。两者默认均关闭，各机构独立配置。

管理接口位于 `/api/federation/commercial-agreements/:revisionId/reservation-policies`：

- `GET ?limit=50&offset=0`：当前组织读取权限，返回历史策略及累计批准数量/金额。
- `POST`：当前人工组织的 `agreement.approve` 权限，正文如 `{"maxTaskAmount":"60","maxTotalAmount":"100","maxTasks":2,"validUntil":"2027-01-01T00:00:00Z"}`。实际日期必须处于合同有效期内，数字示例不代表系统默认授权。
- `POST /:policyId/revoke {}`：当前人工审批权限，明确撤销；重复撤销幂等。范围调整或续期须先撤销旧策略，再创建新 ID。过期策略也不自动替换。

策略固定绑定本地组织、站点、合同 revision 与原双签正文摘要。仅适用于 `ledger_coordinated` 的商业预留，不能批准新合同、释放、账单、付款或市场发布/认领；激活和首次执行确认须另行明确开启下述开关。合同的模板修订、资源上限、执行目标、输入/结果限制继续适用；任务的执行截止时间不得晚于策略截止时间。单次金额与累计批准金额分别不得超过原合同的单次金额和预算上限，无偿合同只允许零金额；零金额任务仍消耗一次任务数。

`authorizedAmount` 是该策略曾批准的 `request.maxAmount` 之和，`authorizedTasks` 是新批准的预留数量。它们属于累计签署授权，不是可用余额、不代表实际用量、并发数或付款，终态/取消/释放均不返还。人工批准不消耗该策略，也不会被追溯改成自动批准；重复处理同一原记录不再次计数。显式创建替代策略会获得新的本地签署额度，但不能重置链上资金、合同总预算或历史记录。

执行机构还必须核验源方对完全相同正文的原始业务 JWS。查询前后复查策略、机构和签名，落库事务锁定策略行，原子保存签名、累计授权消耗及审计；超额、撤销或审计失败全部回滚。源方和执行机构不能共用同一策略 ID。原授权人的个人角色变化不撤销机构授权，显式撤销阻止新签署，已保存的原签名和历史计数保留。

策略 API、内部自动审批服务和下节的新提案传输后台已接入；市场发布/认领与实际委派仍需独立批准；初次激活/执行确认可按下节单独预授。不要把配置策略视为已启用全自动任务委派。策略 ID、授权人及计数只保留在本机构数据库，不加入公共市场或原商业签名正文。

## 新任务提案自动传输与批准

新提案现已接入持久后台。双方先各自授予上节的策略，并有本机构已 committed 的发布/认领意图。源方通过 `/api/federation/commercial-agreements/:revisionId/reservation-proposals` 的 `POST` 提交 `{"policyId":"本机构策略 UUID","proposal":原 CommercialReservation 正文}`；需要当前人工组织的 `delegation.submit`，不需要把个人提升为商业审批人。源方角色只授权提交意图，实际业务签署依据机构预授权，后续不会借用提交人或授权人的个人会话。

源方 worker 核对链上 CLAIMED、原合同及策略后保存签名和授权消耗，再将原业务 JWS 发送到固定私有 mTLS 路径 `/federation/v1/reservation-proposals`。执行机构按证书与业务密钥核验源机构、接收方、合同摘要及完整正文，绑定自己当前未撤销的策略与本地接单意图，持久保存提案、源方原签名和接收证书指纹。收到提案不消耗执行机构签署额度；执行机构 worker 再查链状态并按本地策略批准。原授权范围、材料和实际执行许可仍由原路径继续检查。

执行机构返回 `reservation-proposal-receipt` 签名回执，只含双方站点、合同 revision、预留 ID、原提案摘要和落库时间。须在执行机构业务密钥的传输用途里明确允许该用途；它不进入 Fabric 的商业签署用途列表。收到回执表示提案已持久保存，不等于执行机构批准、双签交换、链 VALID 或许可执行。正文与 JOSE 上限仍为 256/512 KiB，原业务签名直接发送，不套入第二层大信封。

队列状态：

- 执行机构 `pending → approved`，分别表示已收提案、已按本机构策略批准。
- 内容/授权/信任冲突进入 `needs_review`；链或网络临时故障持久退避。新的后台实例通过租约接续处理，旧租约不能保存签名、覆盖新进度或错误。

签名、策略计数、队列批准状态及审计同事务提交；对方重复收到完全相同的原 JWS 时只返回原落库记录的回执，不重复批准。源方和执行机构保存的原签名继续交给既有商业签名交换服务补齐对签并提交私有预留。即使策略在签署后撤销，既有签署义务仍可传递；源方发送仍检查原请求截止时间、合同和当前信任。执行机构实际批准前再次检查最初接收证书，证书或签名用途被撤销时不能默默放行；人工重试不替换证书证明或原正文。

同一路径 `GET ?limit=50&offset=0` 使用组织读取权限，返回进度、时间、策略 ID 和脱敏错误，不返回原业务 JWS、证书指纹或租约 token。`POST /:reservationId/retry {}` 要求当前人工商业审批权限；不能抢占活租约或重置已完成记录，也不自动换用后来创建的策略。每个策略最多保留 128 份尚未批准的排队提案，达到后拒绝新增；这只是入口积压上限，签署额度仍以机构策略事务检查为准。

此路径已包含预留自动签署和跨站传输，初次激活与执行确认可由下述明确授权自动推进；合同批准、基础执行同意交换、市场发布/认领仍分别受原有权限控制。普通 Workflow 的协调节点使用本页下文所述独立市场授权与执行流程。

## 自动激活与首次执行确认

数据库结构为预留策略增加两个不可变开关，省略时均为 `false`：

| 字段 | 授予条件 | 自动操作 |
| --- | --- | --- |
| `allowActivation` | 源方当前人工 `agreement.approve` 和 `market.publish` | 原私有预留已确认后，入队公开市场激活；执行机构不能授予此项 |
| `allowExecutionConfirmation` | 当前人工 `agreement.approve` | 原任务已 ACTIVE 后，入队本机构首次执行确认 |

例如在原策略创建正文里加 `"allowActivation":true,"allowExecutionConfirmation":true`；执行机构只开启第二项。两项可以独立开启。只授权执行确认时等待另一条已批准路径完成激活；只授权激活时不会产生执行确认，作业仍不能据此派发。旧策略保持关闭，续签不能追溯扩大旧任务权限：只有原预留批准记录的 `authorizationPolicyId` 正好等于该策略时才适用。已有人工激活可幂等接续，但保留其人工归属，不改写为机器批准。

后台发现已有对签的提案，复用原激活/执行确认服务，检查原合同、基础执行同意、执行机构受限执行身份、停止与终态防线。激活必须取得原提交的 VALID 回执，首次执行确认同样须取得 VALID 且仍满足本地执行许可检查。未知提交保持等待；INVALID 或 `needs_review` 不自动生成替代交易。短暂链/数据库故障持久退避，租约隔离迟到操作；重新启动接续原动作 ID，不重复扣除预留签署额度。

`reservation-proposals` 的 GET 额外返回 `executionState`（`idle/pending/complete/needs_review`）、`executionError`、`executionNextAt`、`activationId`、`confirmationId`。这组状态与提案交付/批准分开；`complete` 只表示授权的初始动作已有效确认，不表示作业完成或永久拥有运行权限。后续委派、数据使用、软件准备与调度仍走原权限与有效确认检查，续期逻辑不因本开关而绕过。

异常复核入口为 `POST /api/federation/commercial-agreements/:revisionId/reservation-proposals/:reservationId/execution-retry {}`，只接受当前有审批权限的人工会话。不能抢占活租约、替换策略或重置 complete；重试也不能绕过原 INVALID 提交。新自动提交保存策略 ID、原授权人及机器审计身份，不冒充当前人工操作。机构撤销/到期阻止新的自动动作，不撤回已入队或已确认的同意；如须阻断任务执行，应使用原停止/取消入口。

这两个执行许可开关不自动批准合同、创建委派、结算或付款；发布/认领使用下节独立机构授权，基础执行协议仍须双方批准后交换。完整流程还需这些独立环节，不应将两个开关视为全自动业务托管。

## 机构授权的自动发布与认领

数据库结构为原机构预留策略增加两个不可变、默认关闭的开关：`allowMarketPublish` 只可由源机构授予，授权人须同时有 `agreement.approve` 和 `market.publish`；`allowMarketClaim` 只可由执行机构授予，授权人须同时有 `agreement.approve` 和 `market.claim`。双方仍须先独立批准商业合同、明确本地执行身份及基础执行协议。既有激活、首次执行确认开关独立配置，不因发布或认领而自动开启。

源方有 `delegation.submit` 的人工会话可以调用 `POST /api/federation/commercial-agreements/:revisionId/market-requests`，正文为 `{ "policyId": "…", "request": { "protocolVersion": 1, "kind": "market-request", "demand": {…}, "proposal": {…} } }`。`demand` 使用严格的公开市场需求 schema，`proposal` 使用原商业预留 schema。首次认领版本固定为 2；预留 ID 必须等于原委派 operationId，需求 ID、源机构、资源和到期时间必须精确匹配，防止同一任务改名新增预留。价格、额度、合同、完整脚本和个人身份不得添加到公开 demand；完整提案只保存于双方数据库并通过私有机构 mTLS 传递。

生产后台依次推进：

1. 源方复核原策略、合同和任务范围，仅把公开 demand 放入已有市场队列；等待原发布交易确实 VALID。
2. 经固定私有路径 `/federation/v1/market-requests` 发送原签名请求。对方按独立机构策略接收，保留原 JWS 和证书指纹；`received` 回执只表示持久落库。
3. 执行机构确认链上原需求仍 OPEN 或已由自己以同一请求认领，入队原 claim 并等待 VALID，复查当前 CLAIMED 后记为完成。不同认领人、正文或版本进入人工复核。
4. 源方取得绑定原请求摘要的 `claimed` 回执后，独立查询链上原 CLAIMED 状态，再在一个事务内创建既有预留提案并完成市场请求。随后沿用原自动签署、双签交换、私有预留和可选激活/执行确认。

双方业务密钥须分别明确允许传输用途 `market-request` / `market-request-receipt`；它们不属于 Fabric 商业审批用途。旧密钥不会自动扩权。对方回执不替代链查询、原策略或执行许可。协议错误、原证书撤销、端点变化、INVALID 和内容冲突不会自动换交易；临时链或网络故障持久退避，重启复用原任务，租约隔离迟到结果。

市场请求的累计权限按原策略下不可变请求行计算：每项消耗一次 `maxTasks`，原 `maxAmount` 计入 `maxTotalAmount`，单项仍受 `maxTaskAmount` 约束；同一请求重放不重复计数。另限制每个策略最多 128 项未完成请求。GET 策略返回 `marketAuthorizedTasks` / `marketAuthorizedAmount`，与原签署计数 `authorizedTasks` / `authorizedAmount` 分开：前者限制允许公开/认领的任务，后者限制预留签署，均不代表链上可用余额或实际扣款。后续签署额度被其他任务占用时仍可能拒绝，不借市场计数绕过原额度。请求失败、复核或策略撤销不退还累计权限。

`GET` 同一路径支持 limit/offset，只返回当前组织的进度与脱敏错误。`complete` 仅表示原认领及提案交接完成，不表示作业完成、结果正确或已结算。`POST /:reservationId/retry {}` 要求当前人工审批，不能抢租约、换策略或重置 complete。机构撤权阻止新的动作；已经落库的市场交易意图仍须跟踪原结局，不能假定撤权撤销了已签义务。若要停止执行，使用原停止/取消路径。

本入口面向已选定合作机构及合同的任务。普通 Workflow 通过下节协调节点调用；开放市场的自动发现与匹配不在此入口范围内。双边 direct / attested 路径不经过此市场入口，继续保留不依赖链的执行方式。

## 普通 Workflow 的协调节点

普通 `POST /api/workflows` 支持在 Federation 节点里声明市场请求。节点使用既有的 `agreementRevisionId`、模板、输入清单、环境锁、资源、金额上限与期限，额外指定：

```yaml
market:
  policyId: 11111111-1111-4111-8111-111111111111
  title: 共享计算任务
  description: ""
```

这段是明确允许公开的需求文案，不从工作流名称、脚本或私有输入自动提取。平台和架构从原不可变环境锁读取，不能在 market 内覆盖。源方策略须明确允许发布、激活和首次执行确认；对方须配置自己的认领、预留签署与执行确认权限。只有已批准的协调协议使用 market；双边 direct / attested 节点省略它，继续走原无链依赖路径。

持久执行器先固定动态调用的原操作 ID、参数/文件快照及 market 选择，继而在同一工作流租约事务中保存市场请求。原请求的 operationId 就是预留 ID；随机需求 ID 和商业 salt 只在首个成功事务分配，重启、并发和丢响应复用原值，不延长准入时间，也不换用新策略。原市场服务、签署和执行自动化负责后续推进，节点显示 `LEDGER_WAITING`；待初始许可完成，再经原准入有效回执检查创建 outbound，随后沿用 `REMOTE_WAITING`、自动结果导入及下游 File/FileBatch。队列 complete 不替代真正的链许可检查。

父工作流取消或终止后，新发布、预留签署、激活与确认会被本地持久状态阻止。即使尚无 outbound，取消回调也会为已存在的商业批准记录原停止意图；无需用户再取得商业审批权，不等待链恢复。已存在 outbound 则继续原远端停止/文件清理流程。已签或已入队的商业义务仍保留，不把父工作流取消解释为退款、结算或链上锁额已释放；这些状态独立可审计。人工原始市场/委派接口不能绕过已有工作流绑定创建另一份任务。

完整轻量联合入口增加 `KQ_FEDERATION_LAB_SCENARIO=workflow bun run test:fabric:execution`，沿用同一隔离环境启用要求。它通过普通 Workflow API 提交 Federation → NoAction，检验自动市场/许可、真实远端作业、自动结果导入与下游文件；原 success/outage/stop 场景保留。

本地资源计划只包含 Script/SoftwareUsecaseComputing 等实际本地计算节点；Federation 与控制节点不分配本地 Agent。纯远端工作流可在源机构没有计算集群时提交，后续仍需独立源端存储 Agent 完成文件回传。计划中的零本地计算成本不代表远端服务免费；远端价格、额度和用量仍由原机构合同及独立结算记录决定。

## 已确认账单的独立结算

`test:fabric:gate` 现额外使用独立预算验证 SettleBill，保持原竞态与恢复合成场景配置不变。测试明确另签结算，原预留 100、账单应付 7、归还 93；读取实际提交的 PDC 写入核对 locked=0、spent=7、预留数=0。原 TERMINAL gate 与 CLOSED 公共需求不变；缺 B 背书为 INVALID 10，两份竞争结算只有一份 VALID，另一份为 MVCC INVALID 11；第三机构不获得结算私有正文。

该样例使用签名终态/用量合成场景配置，不运行真实科研作业。结果保存在忽略的网络目录 `gate-settlement.json`；正常参数和回执不包含价格/用量。协议、升级边界见[独立额度结算](fabric-commercial.md#独立额度结算协议)。

## 执行前释放后的公共关闭

双签 `ReleaseExecution` 的本地最新尝试确认 VALID 后，源方商业 worker 同事务创建原 releaseId 对应的 `close-demand`；已提交但没有关闭待办的历史释放也会被重新发现。执行机构只保存自己的私有释放结果，不冒用源方排入公开关闭。生成与提交前均核对原预留、双方签名原字节、私有提交摘要和 VALID 检查点，已经完成的历史事实不因当前业务签名密钥到期而要求重签。

公共 `CloseDemand` 新增 REVOKED 分支：只有需求机构可以关闭仍为 CLAIMED 的原认领，要求 gate 为 version 2、绑定原 claimId/商业域/认领版本。同通道读取当前 PDC gate 哈希并匹配公开前像；第三机构可参与公共背书而无须读取价格、合同或完整委派。成功变为 CLOSED，activation 保持 null，不重新开放任务，也不产生新的执行权。原文重放返回原回执；已激活任务继续走 TERMINAL 关闭，不能借 REVOKED 分支绕过停止证据。

双方停止 worker 读取这种 CLOSED 后，逐项匹配原需求、双方、认领、gate 摘要和期限，再清除原停止交付待办。闭合记录错绑时保留重试与错误，不把其他任务的关闭当成本任务已停止。该步骤不新增计算、账单或付款，资金释放仍由原私有双签交易完成。

升级须同步更新 Market 链码、共享 schema、Adapter/Server，并先应用迁移 [数据库结构](../../packages/db/migrations/0079_conscious_anthem.sql)。原有 TERMINAL 闭合保持兼容；不让尚不理解 REVOKED 闭合的旧副本消费新记录。普通市场 HTTP 提交仍不接受 `close-demand`，后台仅从已确认的私有记录生成。

专项真实网络入口：`KQ_FABRIC_TOOLS=<Fabric 3.1.5目录> bun scripts/fabric-evidence-network.ts --gate --preexecution-closure`。它使用隔离的本机 Peer/Orderer，检查缺少 B 背书、释放/激活两种提交顺序、A/C 对公开关闭背书、关闭重放及旧激活拒绝；不启用 k3s、不运行科学计算，也不代替完整 Agent 联合运行。完整 `--gate` 仍包含原 Adapter 故障恢复矩阵。

已接入无账单执行前任务的本地收尾容量回收：执行机构要求本站私有释放 VALID，源方另要求原释放对应的公共关闭 VALID；双方均须完成关联待办，且没有正式接单、出站或账单。双签释放阻止自动发现和人工执行重试，签名交换发现与签名附加互斥，避免回收后重新排队。具体条件见[容量回收](storage-capacity.md#自动回收条件与边界)。未获双签的提案和未完成认领须有权威关闭事实才能收尾；直接合作的执行前取消使用独立双签退款，机构预授权不包含自动释放权。
