# Fabric 私有合同与用量链码

`kq-commercial` 是独立链码，当前提供双方商业合同的不可变登记、提供方用量报告和追加更正。价格、合同字段、用量与签名仅进入两方机构 PDC；公开交易仅有随机域/记录 ID 和带盐摘要。已用 Fabric 3.1.5 的真实 Peer、Orderer、MSP、Gateway 和私有区块投递验证，**尚未接入 Server 商业审批/Adapter 恢复、市场激活、余额、账单及支付**。登记合同不是执行许可，用量报告不是计费事实或双方确认账单；Server 对 ledger_coordinated 的执行拒绝继续有效。

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

业务客户端证书必须同时含 kq.federation.site 与 kq.federation.role=commercial；平台信任管理员没有该业务角色。每个合同还须源/目标机构两把获批准业务公钥对**同一份精确条款字节**签名。Peer 背书不是业务签署，不自动补签合同；商用公钥用途目前独立由商业链码的部署配置管理，不自动扩大平台信任登记或旧 evidence-batch 公钥的用途。

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

## 已验证范围

```sh
KQ_FABRIC_TOOLS=/path/to/verified/fabric-3.1.5 bun run test:fabric:commercial
```

命令创建随机端口的隔离 A/B/C 网络、独立账本与临时证书，运行真实 Node 链码与 Gateway 后清理全部所属进程。失败材料保留在忽略的 temp/fabric-network-*，含测试私钥与私有 PDC，不公开上传。可选 KQ_FABRIC_REPORT 只写脱敏断言清单，不含探针、JWS 或 transient。

已验证双签、缺 B 背书的 INVALID 交易、合法合同/用量 VALID、并发初始报告 MVCC 冲突、非成员和信任管理员接口拒绝、A/B 私有区块可见、C 经本机构或 A Peer 均无私有区块，以及公开块和进程日志不含合同/价格/用量/签名探针。CI 沿用 Fabric 网络工作流并新增商业检查和脱敏断言产物。

本测试使用单机三个机构容器外进程及单个 Raft Orderer，不证明独立机构信任或 SmartBFT 高可用。PDC 仍暴露成员关系、MSP、时间及哈希等元数据；关系也需保密时采用私有 channel。blockToLive=0 防止未经归档删除，容量治理与快照恢复仍待完成。合同变更、新密钥/机构迁移、执行 gate、账单认可、争议处理和结算路径还须继续实现；当前不能发起真实有偿执行。
