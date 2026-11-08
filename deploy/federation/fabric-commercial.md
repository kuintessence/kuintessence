# Fabric 私有合同与用量链码

`kq-commercial` 是独立链码，当前提供双方商业合同的不可变登记、提供方用量报告和追加更正。价格、合同字段、用量与签名仅进入两方机构 PDC；公开交易仅有随机域/记录 ID 和带盐摘要。已用 Fabric 3.1.5 的真实 Peer、Orderer、MSP、Gateway 和私有区块投递验证，**已接独立 Node Adapter、Server 类型化私有客户端与跨进程恢复；Server 商业审批、数据库待办与后台提交已接入；私有预算/gate/激活及真实协调执行、终态和关闭已接入，账单及支付仍待完成**。登记合同不是执行许可，用量报告不是计费事实或双方确认账单；协调执行仍须原激活对应的有效执行确认，商业签名本身不能放行作业。

实现：[商业协议](../../packages/shared/src/federation/commercial.ts)、[链码](../../contracts/fabric/commercial/src/contract.ts)、[Node 入口](../../contracts/fabric/commercial/src/main.ts)。构建：

```sh
bun run --filter @kuintessence/fabric-commercial build
```

输出 `contracts/fabric/commercial/dist/main.js`，使用 Node 22.12+ 和 fabric-shim 2.5.8，以 CCAAS 运行。配置与证据链码相同的 CHAINCODE_ID、CHAINCODE_ADDRESS、CHAINCODE_TLS_KEY_FILE、CHAINCODE_TLS_CERT_FILE、CHAINCODE_TLS_CLIENT_CA_FILE，私有信任文件变量改为 KQ_COMMERCIAL_TRUST_FILE。Peer 到链码强制双向 TLS。密钥与私有账本由所属机构保管，不能放入镜像、Git 或公开 CI 产物。

## 机构策略和业务签名

公开信任配置沿用[证据链码配置](fabric-evidence.md#信任与原生策略)的 version、generationId、organizations 与 domains，另需 keyPurposes，为每个已配置公钥显式指定 commercial-agreement、commercial-usage 或两者。缺项、重复、未知机构/密钥均拒绝。例如：

```json
{
  "keyPurposes": [
    {"siteId":"00000000-0000-4000-8000-00000000000a","keyId":"contract-1","kinds":["commercial-agreement"]},
    {"siteId":"00000000-0000-4000-8000-00000000000b","keyId":"contract-1","kinds":["commercial-agreement","commercial-usage"]}
  ]
}
```

这是完整配置的额外字段，不是可单独启动的 trust.json。部署时固定配置和代码摘要；Init 写入公开状态，每次调用比对，不能通过请求修改。链码初始化与默认背书为全部本代机构 AND，生命周期配置治理为 ALL。机构公钥撤销标记有所属 MSP 的 key-level policy，撤销须该机构 trust-admin 客户端；它不授权其他机构读取商业内容。

`fabricCommercialCollections(trust)` 从同一配置生成集合定义：AB 集合读取 OR(A.member,B.member)、memberOnlyRead/memberOnlyWrite=true，写入背书 AND(A.peer,B.peer)。集合成员与组织背书是两套独立配置，不能以一个机构的两台 Peer 替代两家机构。集合只写 PDC，让集合写策略覆盖链码默认 ALL；业务请求不得把私有 transient 转发给 C 或其他非成员。所需集合、链码与 channel 固定于部署配置，不能让外部请求选择任意背书目标。

业务客户端证书必须同时含 kq.federation.site 与 kq.federation.role=commercial；平台信任管理员没有该业务角色。每个合同还须源/目标机构两把获批准业务公钥对**同一份精确条款字节**签名。Peer 背书不是业务签署，不自动补签合同；商用公钥用途须分别在商业链码部署配置和平台信任登记中明确批准；平台还支持专门的预留、释放和终态用途，见[执行授权说明](fabric-execution-gate.md)，不自动扩大旧 evidence-batch 或 agreement 公钥的用途。旧 keyId 不可覆盖，须按既有轮换规则配置新 keyId。

## 接口与私有输入

除 Init、RevokeKey 外，普通 args 仅为 domainId、recordId。domainId 是私有合作域，不能和合同中的额度域预算含义混淆。敏感输入放 transient 的唯一 commercial 键，整个信封不超过 1 MiB；单个既有 RSA JWS 正文仍受 256 KiB 限制。

| 方法 | recordId / transient | 结果 |
| --- | --- | --- |
| RegisterAgreement | agreement.agreementRevisionId / sourceSiteId、targetSiteId、sourceJws、targetJws | 验证双方同文签名、机构/域、用途、有效期，保存不可改写的私有合同 |
| RecordUsage | reportId / providerJws | 只接受执行机构报告，绑定已登记合同摘要、任务/尝试、计量单位与期间；不记账或转余额 |
| GetAgreementReceipt | 协议版本 ID / 无 | 仅 recordId、digest |
| GetUsageReceipt | 用量报告 ID / 无 | 仅 recordId、digest |
| RevokeKey | siteId、keyId / 无 | 所属机构管理员永久撤销公钥，返回 revoked |

合同包含原执行协议、慈善/置换/收费方式、价格版本、按整数计量数量约定的整数单价及私有文本条款。执行协议已固定额度单位；价格、数量均为最多 38 位十进制字符串，不能通过 JS number 传递。慈善单价只能为零，指标不得重复。原执行协议的 termsDigest 继续关联链下合同材料；商业 JWS 另外承诺整份私有条款，不能混淆两个摘要。salt 应由提交方安全随机生成 32 字节，不使用固定值。

每个任务尝试只能有一份初始用量报告。更正使用新的 reportId，correctionOf 必须指向该任务当前最新报告，保留原始内容；私有头记录通过 Fabric MVCC 防止并发双写。相同 ID/相同摘要重放返回原回执并保留原私有字节，不回退头记录；相同 ID 改内容拒绝。原合同和更正依据是已提交的历史事实，原批准密钥到期不会抹掉历史；新报告仍要求提供方当前有效且用途正确的业务密钥。允许有效执行期间的迟到报告，不接受协议期间外的用量。

查询也只返回带盐承诺。即使方法名是 Get，Fabric 客户端仍可能把它 submit 为交易，因此不能把“通常使用 Evaluate”当作允许 plaintext response 的理由。私有完整内容由双方持有签名原件，并由获授权 Peer 保存 PDC；普通链码返回、事件、日志不提供正文导出接口。已提交 hash 存在而私有数据缺失/损坏时返回 DATA_WAITING，不能当作空记录重新建立合同或用量序列。

## 独立 Adapter 与恢复

复用 [Fabric Adapter 构建与连接配置](fabric-evidence.md#构建和进程配置)，另起独立 Node 进程，设置 `KQ_FABRIC_ADAPTER_KIND=commercial`、`KQ_FABRIC_ADAPTER_CONFIG=/absolute/path/commercial.json`。省略 kind 仍启动既有 evidence 模式。商业配置中的 adapter 固定 siteId、channel、chaincode=kq-commercial 及包含 keyPurposes 的完整商业 trust；Fabric 客户端身份须有 commercial 属性。为商业进程配置独立的 recoveryKeyFile；私有目录与 socket 仍分别要求 0700、0600。

进程仅监听 runDirectory/commercial.sock，不提供任意链码调用或 TCP API。Server 客户端 `UnixCommercialClient` 不依赖 Fabric SDK；Server 配置 FEDERATION_COMMERCIAL_SOCKET_PATH 后启动商业后台提交，省略该项仍可审批与保存待办。

| 接口 | 行为 |
| --- | --- |
| POST /v1/commercial/proposal | operation 为 register-agreement 或 record-usage；携带 domainId、recordId、digest 与对应签名信封。先验证身份/用途、签名、记录及摘要，才创建 SDK proposal |
| POST /v1/commercial/advance | 接收 recovery；首次取得指定两机构背书，返回 prepared 和新的加密检查点；调用方须持久保存后才可继续提交 |
| 再次 advance | 查询原交易，必要时重发原签名交易；返回 pending、committed 或 invalid。仅 VALID 可显示 committed |

私有信封只放 commercial transient，背书目标固定为合作域的两家 MSP。检查点绑定商业用途、配置代次、调用证书和恢复密钥，无法跨机构或与证据通道互换；配置/证书/密钥轮换前须处理待办并备份旧材料。提交超时或进程退出后继续使用同一交易号，不重新构造交易。committed 只表示链上记录成立，不是余额锁定、执行授权、双方确认账单或支付成功。证据通道保留旧版检查点格式及 anchored 状态，不要求迁移已有待办。

## 平台审批与后台提交

迁移 0114 建立独立商业审批、待办与提交尝试表；执行协议、作业额度与预算表不因商业审批改变。Server 沿用现有联邦签名身份，公钥须在本地信任登记及链码配置中均有 commercial-agreement 用途。平台管理员登记密钥不等于获得签署权限，人员必须有活动组织的 agreement.approve 授权；agreement.read 可查看同组织条款，普通机构/平台角色不自动获得此权限。

| 平台接口（/api 前缀） | 行为 |
| --- | --- |
| GET /federation/commercial-agreements | 组织内分页摘要，不返回正文和签名 |
| POST /federation/commercial-agreements/approve | {terms: CommercialAgreement}；核对本机构为合同一方、有效期与公钥用途后签署，不可覆盖原修订 |
| GET /federation/commercial-agreements/:revisionId | 同组织完整条款、摘要与已有签名 |
| POST /federation/commercial-agreements/:revisionId/counterparty | {approvalJws}；验证对方对同一精确条款的有效签名，事务保存双签和待办 |
| GET /federation/commercial-agreements/:revisionId/submissions | 后台状态、脱敏错误及最近交易号/区块/验证码，不返回恢复 token 或私有正文 |
| POST /federation/commercial-agreements/:revisionId/submissions/:submissionId/retry | 有批准权的人员复核 needs_review 后重试，保留历史尝试并写审计 |

这些接口只允许人类会话，受机构范围、输入大小和严格 schema 限制。签署商业条款是独立机构批准记录，不隐式安装执行协议。当前 ledger_coordinated 仍不能执行，不能将商业 committed 当作额度锁定、唯一认领或执行 gate 已满足。合同原件与签名在本地 PostgreSQL 中属受控私有记录，须纳入机构备份和访问管理；平台审计只存记录 ID、摘要、状态，不复制价格和条款正文。

双签后的处理由合同 mode 决定：bilateral_direct 不生成链待办；bilateral_attested 与 ledger_coordinated 生成 pending，但 HTTP 响应不等待链。未配置 socket、链不可达及提交结果未知不会撤销双签或影响已有双边接单。各方可登记同一不可变合同；同时提交可能产生 Fabric MVCC INVALID；首次明确的版本冲突可核对原私有回执后自动恢复一次，详见下节。不会替换商业条款。

配置 FEDERATION_COMMERCIAL_SOCKET_PATH=/private/run/commercial.sock 后，每十秒扫描、每轮至多推进八次检查点。90 秒数据库租约防止多个 Server 同时推进；网络 I/O 不持有事务，保存结果前后均验证租约。proposal 与背书后的 transaction 必须先事务保存，之后才能提交；pending 保留原 transactionId 与 recovery，至少退避 30 秒。VALID 才标记 committed；符合下述条件的首次 MVCC INVALID 暂存 MVCC_RECONCILING，其余 INVALID 或不可自动处理的错误进入 needs_review。人工重试只能放弃未提交 proposal，或在已确认 INVALID 后开始新尝试；未知的 transaction 仍须恢复原交易。

机构批准是持久签署事实，后台不以批准人员离职抹除原批准。创建新 proposal、向 Peer 披露前检查当前平台机构/签名信任与用途；已背书的交易按原检查点恢复和核对终态，不通过更换签名或重新授权掩盖未知结果。暂停/撤销合作的执行权仍由执行协议及本地策略控制，商业记录不替代它们。当前审批支持完整商业 wrapper；平台签名原始用量报告已接入；技术更正 API 已接入；计量补采与合同修订生效切换仍待接入。

## Web 操作

资源区 → 机构合作 → 商业合同，沿用当前机构和显式 agreement.read/approve 权限。可选择已有有效执行协议建立商业 wrapper，填写回报方式、私有合作域、价格和条款，也可导入完整 JSON 文件或文本。新草稿生成独立随机盐、价格版本和时间；导入保留原值。价格按执行协议约定的整数单位输入，慈善价格只能为零。核对条款后确认签署，不修改已有执行协议。

详情支持导出合同、复制本方签名、验证导入对方签名，分别展示双方签署和链上提交状态。直接模式不查询链；待提交记录每十秒更新，未知交易保持等待，已确认失败可复核重试。页面不把 committed 显示为已付款或已授权执行。切换机构/登录会清除原私有草稿，手机只读。完整执行范围仍通过既定协议或 JSON 导入，尚无全字段可视化执行协议编辑器。


商业合同详情的“用量报告”页签按当前机构展示已出具或已接收记录，支持分页、签名/证据查看及 JSON 导出。提供方可重查缺失材料、追加技术更正和重试待核对的链提交；委派方可刷新同步。更正仅针对已有报告的最新头，须核对完整数量、原因和佐证摘要；摘要对应材料由机构自行保管核验。数量保持精确整数，本地签名、待存证和链上成功分开显示，手机只读。

## 平台原始终态证据

迁移 0115 为联邦 Job 增加独立终态证据，随完成/失败/取消及数据撤销事务保存，失败时原终态和 Agent 事件一起回滚。普通计量的尽力写入、汇总和清理不删除这些证据；Job/Workflow 的删除也不能级联删除证据。这里只记录升级后的新终态，既有终态不自动补造观测。

证据保存请求资源和平台看到的状态时间，未取得调度器会计数据时明确为 unavailable；新 Agent 的有效可选计量入库后为 reported。没有开始观测或时钟倒退分别标记，不自动转换成零用量；平台取消不是远端停止证明。只有绑定 Agent 的持久事件标记 agent-status，其余状态写入不冒称 Agent 回报。正文在本机构数据库受控保存，不含命令、环境变量和输出。自动报告绑定双方约定的计量口径和价格版本，不能直接拿 CPU 请求量乘平台观测时长当实际 CPU 消耗。

Slurm/PBS Pro 新 Agent 会在原终态事件中携带可取得的运行时长、累计 CPU 时间与调度器报告核数。Slurm 汇总与步骤尚不一致时保留终态、不输出该次计量，继续按缺失处理；可用[隔离会计检查](accounting/README.md)验证真实采集，默认开发 AIO 未开启会计。Slurm 需要可查询的 sacct 及正确配置的会计采样，PBS 需要 resources_used；字段没有返回时保持缺失，不用资源申请补算。旧 Agent 消息仍可处理，但无计量；新字段通过独立 schema 校验，原事件 ID/重放/ACK 不变。计量先进入本地证据，不自动上链或扣款。取消时只得到平台终态、会计结果迟到、Torque/Kubernetes 或 GPU/内存指标暂未采集等情况，仍须报告待补采/核对，不能当作零用量结算。

## 自动用量报告

升级数据库至迁移 0116 后，配置有效的机构签名密钥及 commercial-usage 用途，后台可为已双签商业合同对应的终态 Workflow 自动生成报告。签名与工作项同事务保存，重启/并发不重复生成；不回填升级前缺失的终态证据。即使没有 FEDERATION_COMMERCIAL_SOCKET_PATH，直接合作仍本地完成报告；存证合作将待办留在数据库，合同登记 committed 后才允许提交用量。链不可用不阻塞既有双边执行。

双方须明确约定支持的 metric/quantityUnit：cpu.time/cpu-millisecond、cpu.allocated/core-millisecond 或 job.elapsed/job-millisecond。前者为累计 CPU 消耗，中者为分配核数乘运行时长，后者为逐 Job 时长和；这些数量不能互换。旧 cpu/core-second 等含糊口径不自动解释，Web 编辑器可成对选择上述三个标准口径，默认累计 CPU 时间、每 1000 毫秒计价；自定义及导入旧口径保留原值，不自动转换。已有签署合同不可编辑。

缺失计量显示 missing_data；证据冲突、数量溢出、超过 4096 个 Job 或 Workflow 覆盖窗口不在协议有效期内进入 needs_review。读取和重试 API 见[实现说明](../../docs/design/federation/implementation.md#自动签名用量报告)。重试重新检查材料并重置待复核的补采任务，不能提交数量覆盖或改写原证据；Web 用量报告页可查看缺失并重试检查。Slurm/PBS Pro 已支持经原 Agent 通道自动补采初始报告的缺失计量，须配套升级 Agent、保留派发收据与调度器历史，并应用迁移 0119。补采单独保存摘要，原报告协议及链码保持不变；已签报告只能追加技术更正。原始报告只表示提供方断言，不创建账单或付款。

## 追加技术更正

数据库迁移 0117 后，获显式 agreement.approve 的提供方人员可对已有报告追加技术更正；接口和字段见[用量技术更正](../../docs/design/federation/implementation.md#用量技术更正)。须提交全部合同指标、单位、精确数量、原因和佐证 SHA-256 摘要；客户端保存 reportId，未知响应时重试同一请求。发生并发冲突先读取最新报告再核对，不能换 ID 盲重试。

更正签名承诺提供方声明，平台不会将人工填报称为调度器新观测，也不验证摘要对应的外部文件；佐证须由本机构核验和受控保存。原报告/原观测保持可读；重试、分页读取、同一机构和密钥用途规则沿用原报告。直接模式无需链；存证更正必须等待前一报告 committed，前一记录待复核时先解决前一记录，不能跳链。此 API 不处理缺失原始报告、商务减免或账单确认，跨机构交换已支持更正声明，Web 用量报告页已支持核对后追加更正，未知响应保持原请求 ID/内容重试。

## 机构间报告交换

数据库迁移 0118 后，源站使用既有 FEDERATION_CLIENT_* mTLS 配置和固定信任端点自动读取报告，无需增加 Fabric 配置。签名用途须显式登记：源站签名密钥需 commercial-usage-query，提供方响应密钥需 commercial-usage-page，原用量报告仍需 commercial-usage。旧密钥用途不自动扩展；可登记具备所需用途的新密钥并按既有配置轮换 Server 签名身份，双方同步登记公钥。网关只放行固定 POST /federation/v1/usage。

双方需保存同文商业双签，源站需有可信接单记录，提供方需有原预留。后台自动发现并逐份读取报告/更正；直接和异步存证都走相同受控数据通道，不等待链。报告及其读取位置原子保存，连接失败每 60 秒重试，needs_review 可由本机构批准者复核后调用 refresh API。接口和隐私边界见[实现说明](../../docs/design/federation/implementation.md#机构间自动用量交换)。

关闭 FEDERATION_CLIENT_* 发送配置但保留机构签名身份时，已接收报告仍可查询/导出；页面显示通信未配置并隐藏同步按钮，refresh API 拒绝请求而不改写状态。恢复通道后按持久游标续读。此行为不涵盖删除整个机构签名身份后的离线档案读取。

首次报告缺失不会生成零账单；原合作执行撤销不自动删除历史报告的读取权，机构或密钥撤销会阻止新的网络披露。旧报告签名密钥自然到期时，当前提供方响应可重申原字节并允许按签署时点验签；旧密钥被撤销则拒绝新导入。后台轮询继续接收后续更正，不依赖原人员仍在职；人类用户仍须当前组织权限。Web 用量报告页已支持查看已接收报告、最后同步时间和人工刷新；读取历史不会自动确认账单。

## 已验证范围

```sh
KQ_FABRIC_TOOLS=/path/to/verified/fabric-3.1.5 bun run test:fabric:commercial
# 增加真实 PostgreSQL 审批/后台恢复；连接须有隔离测试库创建与删除权限
KQ_FABRIC_TOOLS=/path/to/verified/fabric-3.1.5 KQ_FABRIC_DATABASE_URL=postgres://user:password@localhost/postgres bun run test:fabric:commercial:integration
```

命令创建随机端口的隔离 A/B/C 网络、独立账本与临时证书，运行真实 Node 链码与 Gateway 后清理全部所属进程。失败材料保留在忽略的 temp/fabric-network-*，含测试私钥与私有 PDC，不公开上传。可选 KQ_FABRIC_REPORT 只写脱敏断言清单，不含探针、JWS 或 transient。

已验证双签、缺 B 背书的 INVALID 交易、合法合同/用量 VALID、并发初始报告 MVCC 冲突、非成员和信任管理员接口拒绝、A/B 私有区块可见、C 经本机构或 A Peer 均无私有区块，以及公开块和进程日志不含合同/价格/用量/签名探针。生产 Unix 客户端与每步新建的 Node Adapter 还验证了提交后未写回检查点即退出的恢复，以及 Orderer 停机时保留原检查点、重启后取得原交易 VALID；日志检查也覆盖这些子进程。真实 PostgreSQL 联合检查进一步通过：链与 Adapter 均停机时直接合同仍可双签且无待办；存证合同原子入队，Orderer 停机时保持原检查点；链已提交但进程在写回数据库前退出，经真实 90 秒租约到期后，新进程恢复原 VALID 交易且仅有一个提交尝试。CI 沿用 Fabric 网络工作流，包含商业数据库联合检查和脱敏断言产物。

本测试使用单机三个机构容器外进程及单个 Raft Orderer，不证明独立机构信任或 SmartBFT 高可用。PDC 仍暴露成员关系、MSP、时间及哈希等元数据；关系也需保密时采用私有 channel。blockToLive=0 防止未经归档删除，容量治理与快照恢复仍待完成。合同变更、新密钥/机构迁移、执行 gate 的应用接入、账单认可、争议处理和结算路径还须继续实现；当前不能发起真实有偿执行。


## 协调模式的私有额度与执行 gate

链码另已增加双签 ReserveExecution/ReleaseExecution 和仅返回哈希的 GetExecutionGateHash，见[执行许可协议与真实网络验证](fabric-execution-gate.md)。金额和完整委派只存双方 PDC，固定合作域预算不随合同修订重置；激活与释放依赖同通道跨链码读集。生产 Adapter、Server 双签审批/持久待办已支持预留和激活前释放；新密钥用途可在线登记。源站公开激活已接入独立审批入口与市场持久待办，实际执行尚未接通，详见上述执行许可说明。

## 已批准商业签名的自动交换

迁移 0132 增加按本机构、协议 revision、记录类型/ID 唯一的签名交换待办。迁移 0139 扩展同一待办以支持账单。双方先独立批准同一份商业合同、预留、释放或账单正文；后台只取得对方原签名，不调用新的批准/签名接口。已有本地同文批准是前提：对方未批准时保留等待，不生成本地或对方批准。该通道不批准新任务、激活需求或授权派发。

机构间入口固定为 `POST /federation/v1/commercial-approvals`，仅在私有 Unix/mTLS 通道注册。双方平台信任登记分别配置 `commercial-approval-query` 与 `commercial-approval-waiting` 用途；业务签名仍要求原 `commercial-agreement`、`commercial-reservation`、`commercial-release` 或 `commercial-bill` 用途。这两个传输用途不加入 Fabric 商业链码的业务签署清单，也不会扩权已有密钥；旧 keyId 不可覆盖，须按既有轮换规则登记。未配置发送通道时不发现/发送新待办，历史可读取，仍可被动响应获授权对端。

查询含双方、合同版本、私有域、记录类型/ID、精确正文摘要和最长 60 秒窗口。接收方重新检查 TLS 证书、机构与查询密钥；仅向原合同另一方返回已批准的完全同文记录。尚无批准时返回绑定原查询的签名等待回执，不包含价格、条款或业务签名。已有批准时直接返回原业务 JWS，避免嵌套签名使大合同超出限额；正文仍限 256 KiB、通道 JOSE 仍限 512 KiB。原签名可重复交付，因为必须匹配本地不可变正文、双方、类型及摘要；它不代表新批准时间。历史业务密钥仍须当前有效、未撤销且具备原用途，不能仅凭旧签署日期绕过当前信任。合同到期阻止新的合同/预留签名交换，但已批准账单仍可补齐历史对签，已批准释放按原释放条件补交，不把合作到期误当成禁止清理锁额；最终能否释放仍由链上原预留、READY gate 和未激活状态决定。

源端在披露查询前和保存响应时重查机构、原端点、密钥用途、本地原文及有效期；响应验签后，复用人工签名导入服务的原组织/合同/预留校验。补齐对签、交换完成、审计与可选链上待办在同一事务提交，失败全部回滚。签名交换审计使用 `commercial-exchange:<siteId>`，账单使用 `billing-exchange:<siteId>`，不会把自动传输伪装成一次人工批准。原批准人的角色变化不抹除该项已签业务同意，但不因此允许创建新批准。

直接合作只补齐本地签名，不生成链待办、不连接 Fabric；异步存证和协调模式交由既有商业 worker 处理原提交。交换 complete 表示本地已持久取得签名，不代表链上 VALID，也不证明对方已经收到己方签名；双方各自的交换状态独立保存。原生 MVCC 导致的链 INVALID 按原提交独立核对，符合条件可自动恢复一次；不会因为传输或查询成功认定链交易有效。

商业 worker 每轮有限发现/推进，采用 60 秒租约、SKIP LOCKED 和原记录恢复。断线及短暂数据库失败退避；错误正文、身份/用途或端点冲突进入 needs_review。迟到响应/错误不能覆盖后继 worker 或人工复核的新状态。已通过人工入口补齐签名时，后台可核对原记录后收尾，不再次提交业务意图。

当前人工组织 API：

- `GET /api/federation/commercial-agreements/:revisionId/approval-exchange?limit=50&offset=0`：需要 `agreement.read`，返回开关、各记录进度、脱敏错误和核验时间，不返回租约 token、合同或签名正文。
- `POST .../:revisionId/approval-exchange/:recordKind/:recordId/retry`：recordKind 为 agreement/reservation/release 时需要 `agreement.approve`，bill 需要独立 `billing.approve`，正文仅 `{}`。不能抢占活动租约或重置完成记录，过期租约重排时清除旧 token，保留复核审计。

这一步消除已有商业批准的人工签名搬运。长期协议下的新任务自动批准、执行同意交换、市场动作/准入自动编排，以及对应 Web/CLI 操作还需接入；不会把它当作完整无人值守商务握手。


## 相同业务意图的 MVCC 冲突恢复

配套升级商业链码、Adapter 与 Server 后，第一次提交得到明确 `INVALID`、校验码 `11`（MVCC_READ_CONFLICT）和区块号时，商业待办保留 `pending / MVCC_RECONCILING`，原尝试仍为 INVALID。没有回执查询能力的旧客户端保持人工复核；不自动接管历史 needs_review 记录，也不自动重放其他 INVALID 或结果未知的交易。

后台经原私有 Unix `/v1/commercial/query` 调用固定 `get-commercial-receipt`，只允许 agreement/usage/reservation/release/terminal 的 domainId 与 recordId；链码 `GetRecordReceipt` 在原组织角色和 PDC 成员校验之后核对私有字节与区块承诺，只返回原 recordId/digest。第三方无权读取，缺失或损坏的私有字节不会伪装成不存在；预算、价格、用量、合同正文、签名和盐均不返回。只读查询不替代机构背书或提交确认。

原 ID 和签名原文字节摘要完全一致后，后台使用原完整待办申请一次新的 proposal；重新取得原生机构背书，等待新的 VALID 才将待办完成。新检查点与 `commercial-worker:<siteId>` 审计在同一租约事务提交，保留原 INVALID 交易、区块、匹配回执和新交易 ID。查询后及检查点保存前重新核对信任与原意图；旧租约、撤销和审计失败不能留下可提交的新检查点。新交易仍执行链码的原幂等检查，不再次占用预算，也不借终态确认释放资金。

链/Adapter 暂时不可用时按原 30 秒退避继续核对，不清空原 INVALID。原记录不存在、摘要不符、信任/用途失效、接口版本不支持或第二次冲突转 `needs_review`，有权限者可沿原人工重试接口复核。一次自动恢复上限按原待办的尝试号判定，进程重启不重置；不会无限换交易重试、修改 ID 或替换原合同。本机制不处理业务争议、修订正文、重新认领或结算。

## 账单确认与商务减免

新增 `CommercialDiscount / RecordDiscount` 与 `CommercialBill / ConfirmBill`，共享计算入口为 `@kuintessence/shared/federation/billing`。已交付协议、链码、生产 Adapter、Server 人工持久审批 API、已批准账单自动对签交换和独立验收入口；Web/CLI、扣款、退款和仲裁仍未接通，不能据此宣称已完成商务结算。Server 通过生成迁移 0138 开放两个新操作，只从保存原业务批准的事务入队，详情见下文。

账单按原合同费率版本、委派、任务 attempt、原用量报告及其签名正文的原始字节摘要核算。金额使用最多 38 位的非负整数字符串；计算采用 BigInt，不经过浮点数。每个合同计费项必须有单位匹配的计量值，明确报告的零可计费，缺项不能按零处理。中间原始金额溢出会拒绝，即使封顶后金额较小也不会掩盖溢出。

账单必须明确签署 `rounding: "ceil-per-line"`：每项按 `ceil(quantity × rateAmount / perQuantity)` 算出整数金额，再合计原价；先按原委派 `maxAmount` 封顶，再应用商务减免。`grossAmount`、`capReduction`、`discountAmount`、`dueAmount` 分开保存，链码逐项重算，不接受只提交总价。旧合同没有取整规则，因此不能仅凭旧执行/终态授权自动确认新账单；双方账单签名明确同意这项规则。免费合作原价与应付都为零，不创建积分。

商务减免是提供方单独签署的不可变记录，绑定机构双方、合同域、合同版本、币种/单位、任务 attempt、用量报告摘要和唯一 billId。减免不能超过封顶后的金额，不能跨账单复用，也不能直接修改原计量。减免先进入双方 PDC；账单引用其 ID 与摘要，双方再对同一账单正文签署。已确认账单不能追加减免改变应付金额，后续变化须走尚待实现的调整/争议协议。

链码要求账单使用当前用量更正链的末条报告；同一合同下同一任务 attempt 只允许一份初始账单。并发确认/更正通过读取原用量 head、账单 head 和 Fabric MVCC 互斥。原账单重放返回原回执，后来追加用量更正不会覆盖它。协调模式还要求精确匹配的原私有预留已取得双签终态，用量期间不能晚于终态观测；账单确认不修改 budget、gate 或市场状态。执行合同过期仍可核对历史账单，但当前签署密钥必须有效且未撤销。

双方业务密钥须显式配置 `commercial-bill`，提供方减免密钥须显式配置 `commercial-discount`；平台信任目录与链上商业 trust 的 keyPurposes 分别管理，旧用途不自动扩权。链码/集合/信任变更继续走原机构级治理批准。私有写入仍要求 `AND(A,B)` 原生背书，即便减免只有提供方业务签名也不降低集合背书策略。正文、金额与签名仅通过 `commercial` transient 到指定双方 Peer，普通参数只有域与记录 ID，返回仅 ID/摘要；C 和治理身份无权读取双方明细。集合备份同样必须按原成员范围保护。

验证入口沿用 `bun run test:fabric:commercial`，新增真实减免/账单 VALID、金额复算、双签缺失拒绝、幂等重放、重复账单拒绝以及实际区块/PDC 隔离检查。它是隔离链码验收，不运行科学作业，也不代替双平台账单 UI 或真实付款验收。

## Server 账单审批

迁移 `0138` 增加本机构的不可变账单签署、独立减免记录和组织级 `billing.approve` 权限。该权限包含协议读取，允许签署账单/减免、导入提供方减免、登记账单对签和重试商务存证；不授予任务执行、合同修改、资金扣减或付款权限。原 `agreement.approve` 不自动获得账单审批权，平台管理员也必须显式被授予。签名用途仍单独要求 `commercial-bill` / `commercial-discount`，密钥用途不替代真人审批能力。

所有以下接口要求真人会话、当前组织和本站联邦签名配置，返回 `Cache-Control: no-store`，拒绝 automation 调用。路径前缀为 `/api/federation/commercial-agreements/:revisionId`：

| 接口 | 作用 |
| --- | --- |
| `POST /bills/draft` | 输入 `reportId`、调用方生成的 `billId`，可选 `discountId`；从本地原始委派和最新用量生成未签草稿 |
| `POST /bills/approve` | 提交完整 `CommercialBill`；重新核对原文和金额并记录本机构签署 |
| `POST /bills/:billId/counterparty` | 输入 `{approvalJws}`；核验对方对同一原文的签名，保存双方确认 |
| `GET /bills?limit=50&offset=0` | 本组织账单、原签名及本机存证待办状态；来源机构没有本机待办不代表链上已确认 |
| `POST /discounts/approve` | 提供方提交 `CommercialDiscount`，独立签署减免；不能在已签账单上追加改价 |
| `POST /discounts/import` | 输入 `{providerJws}`；需求方验证并保存减免原文，导入本身不批准账单 |
| `GET /discounts?limit=50&offset=0` | 读取本组织减免、签名及本机存证状态 |

草稿不持久化、不会签署；重新生成会取得新时间和盐，因此已经签署后须传递并复用原账单正文，不能以同一 billId 重新拼装。提供方从执行绑定、终态 Workflow 和用量任务取原文，需求方从已接受委派、已验证终态与收到的用量取原文；各自与用量更正串行检查。草稿和首次批准必须使用本机最新报告；协调任务还要求本机已经保存原预留的双签终态。过期执行合同仍允许核对历史事实，新的签署密钥与组织能力须有效。

建议操作顺序：提供方生成草稿；如需减免，先单独签署减免并由需求方导入，再为同一 billId 生成包含减免的最终草稿；双方分别批准同一份正文；启用机构通信后后台交换原对签，也可继续人工导入。原始用量、减免、两份账单签名及审计均保留。相同请求重放不重复签署/审计；不同 billId 不能绕过同任务 attempt 的唯一约束。金额或身份变更拒绝，审计或待办写入失败会回滚本次审批。

直接模式不创建链待办。异步和协调模式由提供方在保存对签的同一事务创建账单待办，双方的业务确认不等待 Fabric；协调模式的执行和资金门槛不因业务确认放宽。生产 worker 依次等待原合同、原用量、可选减免及协调终态的 VALID，再披露账单；披露前重新检查原批准和当前签名信任。协调终态由需求方提交，提供方在背书账单前通过生产 Adapter 查询双方 PDC 中原 terminalId 的回执并匹配原摘要；缺失保留 pending，不要求提供方另有一份本机终态提交。查询后再次检查当前签名信任，回执错误需人工复核。读接口分别保留业务签名和 pending/committed/needs_review，不能把双方确认说成链 VALID 或已付款。

技术更正不撤销已经发出的账单签名：对方可能已经接受原签名。已签账单仍可按原文补齐对签，随后更正作为独立记录保留；待存证更正会等待前一用量对应的已签账单提交，防止断链重连后顺序倒置。仅一方签署而长期无对签时，后续更正存证保留等待，原始更正已在本地保存，不影响其他任务的执行。当前尚无作废/调整/争议协议，不能删除该签名或擅自越过顺序；后续必须通过独立双方确认的解决记录解除。

目前提供管理 API、人工原签名传递与已批准账单自动交换。自动交换复用上述机构通道与查询/等待用途，账单原签名仍需 commercial-bill 用途；升级时先应用迁移 0139，再升级双方 Server，旧版对端不支持 bill 查询，待升级后由账单审批者重试。该通道不传递未批准草稿或独立减免，不代签；两端须先取得同一份正文并独立批准。自动审批策略、专用 Web/CLI、对端链状态同步、余额结算、支付回执、退款与仲裁尚待完成。数据库组件测试不等同于真实双平台 HTTP/mTLS/Fabric 联合验收。


## Kubernetes 作业运行时长

Kubernetes Agent 可报告 `kubernetes-pod` 来源的 `elapsedMilliseconds`，对应合同的 `job.elapsed / job-millisecond`。仅接受当前 Job UID 所属的单个终态 Pod、单个 KQ 工作容器、零重启、`restartPolicy: Never` 和 `backoffLimit: 0`，时长由容器 `terminated.startedAt / finishedAt` 相减取得；不含排队、拉镜像、等待下游和结果传输时间。合法的零时长保留为零，缺失或不完整观测保留未知。

不从 CPU requests/limits 推算实际 CPU 时间或已分配核数；`kubernetes-pod` 带这两项会被协议拒绝。Server 核对来源与原调度器类型，终态证据及其摘要不可覆盖，商业汇总按每个原 Job 计数一次。多 Pod、容器重启、Pod 被清理或时间无效时不能生成完整初始用量；现有迟到计量补采仍只支持 Slurm/PBS，不宣称 Kubernetes 补采已实现。

此扩展不修改 protobuf 字段或数据库结构，但旧 Server 不识别新来源；启用前先升级双方 Server，再升级 Kubernetes Agent。来源方和执行方均需配置用量查询/分页及账单用途，实际权限继续由各自机构明确授予。


## 数据库时间约定

数据库连接统一设置会话 `TimeZone=UTC`，使旧的无时区 timestamp 列使用的 SQL 默认时间与应用写入/解码的 UTC 时间一致。原服务器或数据库采用上海等非 UTC 时区时，不再把新的 Workflow 创建时间错移八小时；带时区的联邦记录仍保存同一时间点。无需改动数据库全局时区或表结构。

已有历史记录不批量改写。如果旧任务已因时间混用进入 `REPORTING_INTERVAL_INVALID`，应保留原证据并核对原始时间来源，不能直接把缺失/矛盾区间改成零用量或仅改时区后声称历史计量已修复。


## Web 账单核对

商业合同详情的“账单”页签按本机构分页显示已批准原文。提供方可从最新用量报告进入“生成账单”，也可填写报告编号计算草稿；生成不签署。导出完整账单 JSON 后，需求方在同一合同下导入、核对金额并分别批准。两端必须批准同一账单编号和正文，不能各自独立生成不同草稿后期待自动合并。

页面分别显示原价、封顶扣减、独立减免与应付，以及原报告、任务和关联记录。金额保持整数字符串，明确逐项向上取整；确认弹窗说明批准不执行付款或释放预留。批准、手工附签及账单存证重试均要求独立 `billing.approve`，`agreement.approve` 不授予这些操作。手机仅查看；机构或登录身份切换清除未提交草稿，未确认请求保留同一原文以供重试。

双方确认与存证分开显示。直接模式显示“不要求存证”；源方没有本地链待办时明确显示“由提供方存证，状态尚未同步”，不推断成功。已批准签名仍由原后台自动交换，手动导入用于已有原签名；本页尚未提供交换故障专用复核入口。页面复用合同刷新，不因切回标签页清空内容。

本页支持无减免草稿生成和已完整准备的账单导入；独立减免的创建、批准及导入仍使用上述 API，不自动产生或忽略减免。自动账单批准、付款、余额结算、对端存证状态同步和 CLI 仍待补齐。页面可视验证使用受控响应夹具，不能代替真实预览站点验收。


## 独立额度结算协议

`commercial-settlement` 是双方另外批准的不可变记录，绑定原账单编号/摘要、合同、机构、单位、预留额、已用额和归还额。`reservedAmount = chargedAmount + releasedAmount`，已用额必须等于原账单应付；不允许通过另签结算改价、减免或增发额度。协调任务还绑定原预留及双方终态回执。新用途必须显式加入双方业务密钥的信任配置；账单批准、终态批准及 Peer 背书不自动授予结算业务同意。

私有链码 `SettleBill` / Adapter `settle-bill` 验证同文双签和原私有账单。协调模式要求原预留已终态、gate 为 TERMINAL：同一 PDC 事务从 locked 移除全部原预留，将账单应付追加到 spent，并减少一个未结算预留计数；可用余额仍为 limit − locked − spent，余款因此归还。保留原账单、终态及 settlement，不改动已关闭的 gate 或重开公共需求。相同结算重放不重复扣账，每份账单仅有一份有效结算；其他争议/调整必须追加新协议，不能覆盖原记录。

异步存证模式只保存双方签署的链下结算事实，不创建链上预算、不第二次扣账；直接模式不得提交该链操作。账单/结算正文与金额仅在原 PDC，正常参数只有域与记录编号，响应只有回执摘要；既有成员限定 GetRecordReceipt 可读取 settlement 回执。结算仍不代表银行付款，也不向提供方发行可跨域流通积分。

共享验证、链码、生产 Adapter 和 Server 独立结算审批已接通，见下节。商业 worker 核对本地持久结算同意、原签名与当前信任后才披露 settle-bill，不能把账单审批冒充结算批准。协调链新状态 `settled` 需随链码读取方一起升级；不可在已结算数据上直接回滚旧的严格 reservation schema。


## Server 额度结算

迁移 0140 增加独立结算记录、本地预算 spent 及原委派/预留的 settledAmount。旧数据默认 spent=0、settledAmount=null，原金额与接单回执保持不变。提供方预算守恒改为 limit=available+reserved+spent；源方以未结算预留加已消费金额计算占用，只对未结算记录计任务名额。消费不是凭证删除，也不向提供方增发余额。

| 方法与合同下路径 | 行为 |
| --- | --- |
| GET /settlements | 分页读取本组织的结算签名、本地记账时间和本站链待办 |
| POST /settlements/draft | billId、settlementId 生成草稿，要求原账单双方已确认 |
| POST /settlements/approve | 对同一份 commercial-settlement 正文独立批准 |
| POST /settlements/:settlementId/counterparty | approvalJws 登记对方原结算签名 |

完整前缀为 `/api/federation/commercial-agreements/:revisionId`。只读需要 agreement.read；批准、手工对签、结算待办/交换复核需要独立 settlement.approve，不能由 billing.approve 或平台管理员身份替代。该能力可在既有平台权限页面在线授予。机构签名密钥须显式允许 commercial-settlement；自动交换继续使用原 commercial-approval-query/waiting，用途不会自动扩大。

双方先传递同一份草稿，各自批准，后台只交换已有原签名，不生成新的商务同意。按本机构、billId 唯一；并发重复对签只记账一次。信任撤销、签名不符、不同账单/单位/金额或本地账目不一致时拒绝；账目、对签、审计和链待办在同一数据库事务内提交。读取记录和生成草稿不会扣减额度。

- 直接模式：双方分别收到对签后原子记账，不创建链待办。
- 异步存证：按直接模式记账，提供方同事务创建待办；链停机不会延迟本地结算。
- 链协调：对签只建立待办，不释放名额。双方分别持久化原结算 VALID 结果后才标记本地原任务已结算；不创建本地可支用余额。提交前查询原账单的 PDC 回执并匹配 billDigest；已有交易恢复原 checkpoint，不因断链重新签署。两端同文重放及原生 MVCC 核对沿用商业提交恢复机制。

appliedAt 只表示本站额度账目处理完成，不代表对端同步、银行付款或结果验收。专用结算 Web 入口已接通（见下节）；CLI、自动审批政策、商务调整/退款/支付/争议协议仍待完成。新增 Server 结算经过隔离数据库验证，协调模式另已通过真实独立双平台、mTLS、Agent/Kubernetes 与 Fabric 联合验收：预留 10、实际账单 1、退回 9；断链保留名额，恢复后两端原待办取得 VALID 才应用本地投影，竞争提交的 MVCC INVALID 保留并自动恢复。独立读取 A/B/C 区块确认只扣一次私有预算，第三机构无私有写入。直接/异步结算尚未补真实双平台验收，亦未新增结算专用进程崩溃测试。复现及边界见[执行验收](execution-lab.md)。先应用迁移、升级双方 Server 与商业链码/Adapter，再显式授予新权限和签名用途；旧版 Server 不兼容新结算数据，不直接回滚。


## Web 额度结算

商业合同详情新增“结算”页签，按当前机构分页显示原结算。拥有独立 settlement.approve 的用户，可从双方已确认的账单进入“生成结算”，或填写原账单编号生成草稿。双方应传递同一份导出的 JSON，分别核对原预留、已用及归还额度后批准；不能各自生成不同编号后期待自动合并。后台继续自动交换已批准的原签名，页面保留手工导入原对签和本站存证复核重试。

页面分别显示结算签署、本地额度处理时间及本站链记录。异步存证可出现“已记账、待存证”；链协调的本地处理等待本站 VALID，源方也使用自己的链待办状态。直接合作显示“不要求存证”；异步模式需求方未同步的提供方存证状态保持未知。appliedAt 不代表对方已记账或银行已付款。确认弹窗明确这项边界，不在金额表中把未处理的差额显示为已到账。

金额全程保留整数字符串，读取及导入核对机构/合同/模式及守恒关系；原账单、终态和签名的实际授权仍由 Server 事务检查。合同批准权和账单批准权均不授予结算权限。手机只读，机构/登录切换清空私有草稿，批准响应未知时保留同一正文供重试。页面没有自动批准、付款或争议入口；结算专用 CLI 仍待完成。


## 账单与结算预授权

迁移 0141 新增机构持有的 closing policy。账单和结算是两个独立 kind（bill、settlement），分别要求 billing.approve 和 settlement.approve 才能授予或撤销，合同批准权不扩权。授权固定本组织、本站、商业合同 revision/digest、允许的终态 completed/failed/cancelled、maxAmount（单笔应付/消耗上限）、maxTotalAmount（累计批准额）、maxRecords（批准次数）和 validUntil。每份合同每种 kind 仅允许一份未撤销授权，续授权先撤销旧授权；到期不会删除历史。

| 方法与合同下路径 | 行为 |
| --- | --- |
| GET /closing-policies | 本组织分页查询，需 agreement.read |
| POST /closing-policies | 显式授予一种审批权，默认不存在授权 |
| POST /closing-policies/:policyId/revoke | 撤销原授权，重复撤销返回原记录 |

前缀仍为 `/api/federation/commercial-agreements/:revisionId`。该接口要求人工会话与活动组织，机器人凭据不能自行授予政策；普通批准端点也不接受 policyId 来冒用预授权。创建正文为 kind、outcomes、maxAmount、maxTotalAmount、maxRecords、validUntil；金额均为最多 38 位的非负整数字符串，maxRecords 为 1–100000，maxAmount 不大于合同单任务上限，maxTotalAmount 不大于合同总额度。授权期限可覆盖旧执行合同到期后的收尾，但不能产生新的执行授权。

Server 内部自动批准入口在签署事务中锁定政策，检查当前机构/业务密钥信任、合同原双签、原用量或双签账单、本地终态和精确金额。账单仍要求最新合法报告；新自动账单另重验原用量签名，不能因为报告已经入库而忽略当前签名用途失效。原服务的原请求/账单/终态一致性检查继续生效，商务减免不由该授权创建。

新批准、authorizationPolicyId、approvedAmount/approvedRecords 和机器审计同事务落库，签署后再次核对有效期。并发使用同一政策串行检查累计上限；同一原批准重放不再次计数，更换政策不改写原批准的授权来源。政策计数是独立的审批上限，不是资金账户；自动批准本身不归还额度、不自动附上对方签名，也不创建双重链余额。实际记账继续等待双方原签名，协调模式还必须等待本站 VALID。

政策属于机构：原授予者后来失去个人权限不会自动撤销已有机构授权，必须显式撤销政策；机构、密钥和用途仍在每次新签署时检查。撤销与签署串行化，已经完成的批准保留原文和来源，不被撤销动作抹除。原用户标识保留在 approvedBy，实际自动操作审计使用 closing-policy:<policyId>，便于区分人工逐单审批与机构授权。

管理 API、事务内自动批准及生产后台编排均已接通；需双方各自配置政策及可信通道。后台行为和边界见下节，政策 Web 管理已接合同详情的自动审批页签（见下文），CLI 仍待完成；真实自动收尾验收范围见下节。


## 自动商务收尾

迁移 0142 新增提供方持久待办。启用既有联邦发送配置后，商业 worker 从已报告的本地用量发现账单，从已双签账单发现结算；每轮每种类型最多发现 8 项，合计最多推进 8 项。无有效政策不发现新任务，无发送配置不运行。首次生成原文、政策计数和待办 recordId 在同一事务提交，后续使用原编号和原签名。

提供方经私有 mTLS `/federation/v1/commercial-closing` 发送原 commercial-bill 或 commercial-settlement JWS，需求方使用自己的相应政策批准同一原文并返回原业务签名；没有新消息种类，也不信任请求自带的公钥。双方检查当前证书/业务密钥、机构、合同与原业务范围；后台不借用人工会话授权。旧网关未加入该路由时无法送达，部署需同时升级双方 Server 与 Gateway，并先应用迁移。

已批准原文可在政策撤销后继续交换，当前机构/密钥/证书仍须可信；撤销阻止新的批准，不删除已经给出的同意。需求方缺少原用量或终态时返回 DATA_WAITING/503，等待材料到齐；未配置政策或业务范围不符进入 needs_review，配置修正后由有权人员显式重试。断线、503、数据库锁竞争每 60 秒重试，租约有效期 60 秒；迟到响应不能覆盖新租约。响应丢失及批准后附签前崩溃均可沿原文恢复，不重复计数。

| 方法与合同下路径 | 行为 |
| --- | --- |
| GET /closing-tasks | 本组织分页查询，需 agreement.read；enabled 表示本站已配置发送通道 |
| POST /closing-tasks/:kind/:referenceId/retry | 人工显式重试；bill 需 billing.approve，settlement 需 settlement.approve；正文为 `{}` |

前缀为 `/api/federation/commercial-agreements/:revisionId`。bill 的 referenceId 是原 reservationId，settlement 为 billId；待办仅存于发起提案的提供方。未生成原文的待办可在显式重试时绑定替换后的有效政策，已经签署的原文不被重写。complete 只代表双方原签名已交换，不代表链已 VALID、双方额度均已记账或银行付款；继续分别查看原账单/结算及本站链待办。

存在已准备商务减免时，自动生成账单会停下复核，避免跳过减免按全价批准。可以由人员明确批准含减免的账单，并将原减免导入需求方，再重试自动收尾；后台复用原账单，不自行决定减免。现有签名交换仍只交换已批准记录，不授予新审批权。直接合作不创建链待办；异步存证本地记账不等待 Adapter；协调模式继续等待本站 VALID 后才应用本地额度投影。

上述生产服务已通过隔离 PostgreSQL 与受控传输验证，网关/客户端另外通过真实 TLS 通道测试。协调模式另已通过真实双平台/独立数据库、mTLS、Agent/Kubernetes 和 Fabric 3.1.5 的自动收尾验收：实际用量 1,000 毫秒，双方各自授权后自动生成和批准账单及结算；预留 10、扣用 1、归还 9。断 Orderer 期间只完成签名，恢复后本站原待办 VALID 才记账；一次 MVCC INVALID 自动核对恢复，私有预算只扣一次，第三机构无私有写入。为隔离断链检查，政策在作业结束后才启用；任务开始前的长期运行、直接/异步模式的真实联合验收仍待完成；Web 管理见下节，CLI 见[联邦财务命令](../../docs/federation-cli.md)。复现见[执行验收](execution-lab.md)。


## Web 自动审批

合同详情新增“自动审批 / Automatic approvals”页签。双方各自配置本机构授权，账单使用 billing.approve，结算使用 settlement.approve；agreement.approve 不授予这两项能力。手机只读，权限丢失会关闭草稿/确认，切换机构、登录或合同清空本页私有输入。合同尚未双签时不能授权。

创建授权显式填写单笔/累计金额、最多批准次数、允许的任务结果及本地到期时间，再核对确认。金额保持最多 38 位整数字符串，不经浮点转换；前端检查原合同限额，Server 仍执行最终授权与信任检查。授权为机构持有，撤销员工个人权限不等于撤销该机构授权；撤销按钮终止后续批准，保留旧签名和结算。每种类型的未撤销旧授权（包括已到期记录）须先撤销再授予新授权。零金额授权可批准零收费记录，不因累计金额为零而误标为次数耗尽。

授权清单分别显示金额/次数及使用情况、到期与撤销状态，历史分页保留。创建接口生成编号；响应未知或响应范围校验失败时，页面要求先刷新核对，禁止直接重发新授权。既有授权撤销和原待办重试保留原标识。读取失败不展示旧数据为当前状态，不开放新的授权操作。

提供方显示处理记录、错误原因及下次重试时间；需人工处理的记录由相应独立权限显式重试。未配置发送通道时仍可读取历史，但不显示为正在自动处理。需求方说明提案由提供方发起，原业务批准记录仍在本地账单和结算页。“双方已签署”只表示签名交换完成；记账、本站存证和付款不是同一状态。

点击“查看账单/结算”按原记录编号查询，自动进入该记录详情，返回后恢复完整列表。既有 GET `/bills` 与 `/settlements` 增加可选 UUID 参数 recordId，筛选仍要求本组织、本站和原合同；旧分页调用不变。前端拒绝不匹配筛选 ID、机构/站点/合同或不合法金额的响应。本页不添加执行授权、价格修改、付款或争议裁决功能。


## CLI 财务管理

`kq federation` 已接本机构合同查询、账单/结算原文草稿与批准/附签、有限政策授予/撤销以及原待办复核。命令要求显式 `--org`，Server 仅比较已绑定的会话机构；机构变化返回 409，不把头部当作选择器。财务权限继续独立于合同权限，机器凭据不能授予人类审批权。输入有界、导出文件 0600 且不覆盖，写入不自动重试，结果未知先查原记录。完整命令、精确金额和三状态说明见[联邦财务 CLI](../../docs/federation-cli.md)。


## 结算后的独立账务调整

新增 `commercial-adjustment` 原文、`AdjustSettlement` 私有链码与 `adjust-settlement` Adapter 操作。它将一笔已结算任务的净扣用额改为双方新认可的金额，支持调减和在原任务限额内调增；原用量、账单、结算和历史调整都不修改。它不是银行退款、实际付款、重新执行许可，也不自动认定技术更正正确。

原文固定 domainId、agreementRevisionId、双方 siteId、unit、billId/billDigest、settlementId/settlementDigest，以及 previousChargedAmount、chargedAmount、reason、可选 supportingEvidenceDigest、issuedAt 和随机 salt。第一笔 previous 为 null；后续必须引用当前最后一笔 adjustmentId/digest，并精确匹配它的 chargedAmount。无变化、自引用、负数、小数、超出 38 位或原任务金额上限、旧时间与跨机构/合同/结算引用均拒绝。支持材料摘要只绑定双方依据，不是科研正确性证明。

双方使用显式授予 `commercial-adjustment` 用途的业务密钥签同一原文；原合同、账单和结算签名用途不会自动扩权。Fabric 原生集合背书仍要求指定的两家机构，发起者与背书 Peer 权限不能代替双方业务签署。正文和签名仅通过 transient 发送到成员 Peer，保存在双方 PDC；普通参数、响应和公开区块不携带金额或原因。`GetRecordReceipt` 新增成员限定的 adjustment 类型，只返回原编号和摘要。

协调模式在原预算同一私有事务中执行 `spent = spent − previousChargedAmount + chargedAmount`，拒绝负余额及 `locked + spent > limit`。limit、locked、未结算预留数、原结算和 TERMINAL gate 不变；调增不能占用其他任务已经锁定的额度，调减只恢复本预算可用额，不增发积分。调整记录和最后一笔索引一同写入，原生 MVCC 防止并发分叉与重复余额修改；同编号同文重放返回原回执，不回退索引或重复退额。PDC 哈希存在但正文缺失时返回 DATA_WAITING，不当作首次调整。

异步存证仅记录链下已经批准的调整，不创建链预算；直接模式不提交此链操作。Server 人工审批、附签、占额和本地记账现已接通，见下一节；原签名自动交换也已接通，CLI 和 Web 调整入口已接通。调整采用独立审批权，不能套用合同权限发送；链码验收不代替完整用户流程验收。

本能力需配套更新共享协议、商业 Adapter、商业链码，并在共同批准的 trust 中显式配置新用途；既有原文和旧用途不改写。当前 Init 固化 trust，已运行链若未预置该用途，不能只改 trust 文件或重复 Init 来升级；其受治理的信任/代际迁移仍待实现，也不能新建一个复制余额的域绕过迁移。本次验证使用新建隔离网络，不证明旧链升级完成；无需降低集合背书策略，本单元没有数据库迁移。真实 `test:fabric:gate` 已验证私有 spent 的 7 → 4 → 5、缺机构背书 INVALID、同一旧记录并发 MVCC INVALID、历史重放不重复退额，以及第三机构无私有写入；具体记录见[调整验收进展](../../docs/design/federation/progress.md#结算后的私有账务调整)。


## Server 账务调整

平台已有人工草稿、独立批准、原签名附签和分页查询 API。新增 `adjustment.approve`，包含本机构 agreement.read，但原合同、账单、结算批准权都不包含调整权；机器身份不能操作。平台联邦权限管理可明确授予或撤销这项能力，中英文标签同步。双方先完成原结算的本站记账，再审查并批准同一份调整原文。

| 方法与合同下路径 | 行为 |
| --- | --- |
| GET /adjustments?limit=20&offset=0&recordId=UUID | 本机构原记录及本站存证状态；recordId 可省略 |
| POST /adjustments/draft | settlementId、adjustmentId、chargedAmount、reason、supportingEvidenceDigest（可为 null）；只生成原文 |
| POST /adjustments/approve | 完整 commercial-adjustment 原文，独立人工批准 |
| POST /adjustments/:adjustmentId/counterparty | `{approvalJws}`，导入对方同文原签名 |

路径前缀为 `/api/federation/commercial-agreements/:revisionId`。金额为合同单位的整数字符串，支持原限额内调增及调减；原结算编号不是账单编号。前一笔必须已在本站应用，才能生成下一笔；草稿期间另一笔先获批准时，旧草稿被拒绝，不能覆盖当前记录。数据库按本站/结算序号和前驱唯一索引禁止分叉，批准、占额和审计同事务；相同编号同文重试只取回原签名，不重复占额。未知响应先查原编号，不生成新编号盲目重发。

直接与异步模式的增额在**本站批准**时先占住正差额。提供方从 available 转到 reserved，需求方在原出站操作中持久保存 adjustmentHeldAmount，新的源站接单同时计算这部分占额；不额外占用计算任务并发名额。双签后，增额从 reserved 转 spent，调减则从 spent 回 available；调减在单方批准时不退额。原账单/结算正文、签名和原接单金额不修改，settledAmount 作为当前净额投影更新。审批/审计/附签失败整体回滚，重复附签只记账一次。

已签增额的占额不会因员工撤权、网络超时或签名过期自动消失；系统不能据此证明对方没有接受原签名。当前可由有权人员按同一原文收尾；尚无单方撤回或争议解除占额入口，不应手工删记录或改余额。独立争议与双方解除流程仍属未完成的整体范围。

协调模式不建立本地可花费余额或占额。双方签署后各自保存原上链待办，先验证原结算及前驱的成员私有回执，再提交调整；只有本站原待办 VALID 才修改本地净额投影。链预算不足时不应用，不能自动降为直接模式；后续有余额且授权仍有效时由具备 adjustment.approve 的人员复核原待办。原 INVALID 和恢复检查点继续保留。异步存证由提供方保存证据待办，链不可用不阻塞双方本地记账，提交确认不能重复应用已记账差额。

升级双方 Server 前停止旧版接单/商业 worker，依次应用生成迁移 `0143_solid_starjammers.sql` 与 `0144_cool_lilith.sql`，再启动新版。前者新增调整记录、源站增额占额字段与独立权限约束，旧记录占额默认 0；后者扩展待办操作约束。只迁移数据库而混跑旧版接单程序，会漏算占额，不能作为升级完成。链/Adapter 的新用途与既有 trust 升级限制仍见上一节。

上述管理、占额与记账经过 13 个新增隔离 PostgreSQL 场景验证，另有 4 个原结算/接单回归通过。协调链结果使用测试 Adapter，只证明 Server 的结果应用边界；上一单元真实 Fabric 证明链码的余额、背书和隐私，不等同新的多平台联合验收。自动签名交换现已接通（见下文），调整 CLI 已通过 HTTP/数据库联调，Web 已完成隔离页面验证，实际联合恢复仍待完成，本轮未重新运行 Fabric 或调度器。


### 已批准调整的自动交换

在双方均配置联邦发送通道、mTLS 信任和签名用途后，现有商业 worker 自动发现本站尚未附签的调整，经 `/federation/v1/commercial-approvals` 查询对方同一编号、同一摘要的原签名。它不生成新调整或替人批准；对方未批准只返回签署的 waiting，已有增额占额保留。员工撤权不撤销已经作出的机构签署，但当前机构、签名密钥/用途、目标端点或租约检查失败会阻止附签。直接/异步处理不等待 Fabric，协调模式仍需各自 VALID 才应用。

附签、应用、链待办、交换完成和审计原子提交。网络响应丢失后继续查询同一记录，租约失效的迟到响应不能记账；先手动附签后，worker 可以直接完成同步而不再次发送或记账。异常查询通过合同下 `GET /approval-exchange` 查看，`POST /approval-exchange/adjustment/:adjustmentId/retry` 复核重试需要独立 adjustment.approve；它不会重新批准，也不能解除占额。

启用前还需应用生成迁移 0145，扩展交换记录类型约束，并同步升级双方 Server。此扩展不自动授予密钥用途或人员权限。调整 CLI 已有草稿/批准/附签/查询（见[CLI](../../docs/federation-cli.md#结算后的账务调整)），页面已接通（见下节），真实跨平台恢复验收尚未完成。


### 账务调整页面与历史

商业合同详情新增“账务调整 / Adjustments”。从已记账的结算进入“查看账务调整”，页面保留 settlementId 筛选，按调整序号从新到旧分页；也可从合同下查看所有调整。原结算净额与本站当前净额由 Server 在同一原结算行的共享锁内计算，不从当前页或选中的历史记录推断。已批准但未应用的新调整仍显示前一笔净额；原结算未应用时 currentChargedAmount 为 null。汇总与历史都按本站、机构、合同和原结算查询，跨机构或不存在的结算不披露。

GET adjustments 另支持可选 settlementId，返回可选 summary：settlementId、originalChargedAmount、currentChargedAmount、pendingAdjustmentId。recordId 可与 settlementId 同时使用；翻页或查看旧记录不改变汇总所指的当前净额。无 settlementId 时 summary 为 null，原 CLI 无需改变调用。本扩展无需数据库迁移，但 UI 的按结算查询需配套新版 Server。

具备独立 adjustment.approve 的桌面用户可输入原结算、新净额、原因和可选佐证 SHA-256，生成草稿；也可导入对方完整原文。页面核对返回的身份、金额、原因与佐证，确认框展示调整前后净额和精确差额，再发送同一原文。已保存原文可导出、复制签名或手动附签，存证 needs_review 可以复核原待办。手机和只读用户仅查看；机构/会话切换重置私有状态，撤销权限清除待批准草稿和输入，撤权后的迟到草稿不恢复批准入口。

签署、本地记账、存证及记账时间分别显示；批准时占额明确标为历史记录，不能当作当前冻结余额。异步存证不妨碍本地已记账，协调未 VALID 不显示已应用，未同步的提供方存证不伪造成功。正式部署仍需完成真实跨平台调整/恢复和 PR 预览验收。
