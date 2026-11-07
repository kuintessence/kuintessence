# Fabric 私有合同与用量链码

`kq-commercial` 是独立链码，当前提供双方商业合同的不可变登记、提供方用量报告和追加更正。价格、合同字段、用量与签名仅进入两方机构 PDC；公开交易仅有随机域/记录 ID 和带盐摘要。已用 Fabric 3.1.5 的真实 Peer、Orderer、MSP、Gateway 和私有区块投递验证，**已接独立 Node Adapter、Server 类型化私有客户端与跨进程恢复；Server 商业审批、数据库待办与后台提交已接入；市场激活、余额、账单及支付仍待完成**。登记合同不是执行许可，用量报告不是计费事实或双方确认账单；Server 对 ledger_coordinated 的执行拒绝继续有效。

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

业务客户端证书必须同时含 kq.federation.site 与 kq.federation.role=commercial；平台信任管理员没有该业务角色。每个合同还须源/目标机构两把获批准业务公钥对**同一份精确条款字节**签名。Peer 背书不是业务签署，不自动补签合同；商用公钥用途须分别在商业链码部署配置和平台信任登记中明确批准；平台现接受 commercial-agreement、commercial-usage 两种用途，不自动扩大旧 evidence-batch 或 agreement 公钥的用途。旧 keyId 不可覆盖，须按既有轮换规则配置新 keyId。

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

双签后的处理由合同 mode 决定：bilateral_direct 不生成链待办；bilateral_attested 与 ledger_coordinated 生成 pending，但 HTTP 响应不等待链。未配置 socket、链不可达及提交结果未知不会撤销双签或影响已有双边接单。各方可登记同一不可变合同；同时提交可能产生 Fabric MVCC INVALID，进入人工复核后可重试原内容，不自动替换商业条款。

配置 FEDERATION_COMMERCIAL_SOCKET_PATH=/private/run/commercial.sock 后，每十秒扫描、每轮至多推进八次检查点。90 秒数据库租约防止多个 Server 同时推进；网络 I/O 不持有事务，保存结果前后均验证租约。proposal 与背书后的 transaction 必须先事务保存，之后才能提交；pending 保留原 transactionId 与 recovery，至少退避 30 秒。VALID 才标记 committed，INVALID 或不可自动处理的错误进入 needs_review。人工重试只能放弃未提交 proposal，或在已确认 INVALID 后开始新尝试；未知的 transaction 仍须恢复原交易。

机构批准是持久签署事实，后台不以批准人员离职抹除原批准。创建新 proposal、向 Peer 披露前检查当前平台机构/签名信任与用途；已背书的交易按原检查点恢复和核对终态，不通过更换签名或重新授权掩盖未知结果。暂停/撤销合作的执行权仍由执行协议及本地策略控制，商业记录不替代它们。当前审批支持完整商业 wrapper；平台用量自动采集/报告、合同修订生效切换仍待接入。

## Web 操作

资源区 → 机构合作 → 商业合同，沿用当前机构和显式 agreement.read/approve 权限。可选择已有有效执行协议建立商业 wrapper，填写回报方式、私有合作域、价格和条款，也可导入完整 JSON 文件或文本。新草稿生成独立随机盐、价格版本和时间；导入保留原值。价格按执行协议约定的整数单位输入，慈善价格只能为零。核对条款后确认签署，不修改已有执行协议。

详情支持导出合同、复制本方签名、验证导入对方签名，分别展示双方签署和链上提交状态。直接模式不查询链；待提交记录每十秒更新，未知交易保持等待，已确认失败可复核重试。页面不把 committed 显示为已付款或已授权执行。切换机构/登录会清除原私有草稿，手机只读。完整执行范围仍通过既定协议或 JSON 导入，尚无全字段可视化执行协议编辑器。


## 已验证范围

```sh
KQ_FABRIC_TOOLS=/path/to/verified/fabric-3.1.5 bun run test:fabric:commercial
# 增加真实 PostgreSQL 审批/后台恢复；连接须有隔离测试库创建与删除权限
KQ_FABRIC_TOOLS=/path/to/verified/fabric-3.1.5 KQ_FABRIC_DATABASE_URL=postgres://user:password@localhost/postgres bun run test:fabric:commercial:integration
```

命令创建随机端口的隔离 A/B/C 网络、独立账本与临时证书，运行真实 Node 链码与 Gateway 后清理全部所属进程。失败材料保留在忽略的 temp/fabric-network-*，含测试私钥与私有 PDC，不公开上传。可选 KQ_FABRIC_REPORT 只写脱敏断言清单，不含探针、JWS 或 transient。

已验证双签、缺 B 背书的 INVALID 交易、合法合同/用量 VALID、并发初始报告 MVCC 冲突、非成员和信任管理员接口拒绝、A/B 私有区块可见、C 经本机构或 A Peer 均无私有区块，以及公开块和进程日志不含合同/价格/用量/签名探针。生产 Unix 客户端与每步新建的 Node Adapter 还验证了提交后未写回检查点即退出的恢复，以及 Orderer 停机时保留原检查点、重启后取得原交易 VALID；日志检查也覆盖这些子进程。真实 PostgreSQL 联合检查进一步通过：链与 Adapter 均停机时直接合同仍可双签且无待办；存证合同原子入队，Orderer 停机时保持原检查点；链已提交但进程在写回数据库前退出，经真实 90 秒租约到期后，新进程恢复原 VALID 交易且仅有一个提交尝试。CI 沿用 Fabric 网络工作流，包含商业数据库联合检查和脱敏断言产物。

本测试使用单机三个机构容器外进程及单个 Raft Orderer，不证明独立机构信任或 SmartBFT 高可用。PDC 仍暴露成员关系、MSP、时间及哈希等元数据；关系也需保密时采用私有 channel。blockToLive=0 防止未经归档删除，容量治理与快照恢复仍待完成。合同变更、新密钥/机构迁移、执行 gate、账单认可、争议处理和结算路径还须继续实现；当前不能发起真实有偿执行。
