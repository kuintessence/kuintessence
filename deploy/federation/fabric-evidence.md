# Fabric 证据链码与独立 Adapter

Server 通过存证 outbox 管理批次、序号和数据库恢复检查点，由独立 Node Adapter 向证据链码提交。配置私有 Adapter socket 后，后台 worker 会消费现有待办；此路径不创建联邦作业，也不修改任务额度。直接模式不创建待办、不调用 Adapter，不要求链连接。

代码位置：[证据链码](../../contracts/fabric/evidence/src/contract.ts)、[Adapter](../../packages/fabric-adapter/src/evidence.ts)、[私有进程入口](../../packages/fabric-adapter/src/runtime.ts)、[协议与集合配置](../../packages/shared/src/federation/ledger.ts)。Linux 运行环境还须安装 util-linux（flock）。Node 至少 22.12，Gateway 固定 1.13.0，fabric-shim 固定 2.5.8。Peer/Orderer 使用官方 Fabric 3.1.5；实验环境由 cryptogen 与 OpenSSL 生成证书，不部署 Fabric CA 服务。生产环境须另行配置 CA 签发、轮换和撤销流程。四节点配置与运维要求见[四节点运行](four-node-acceptance.md)。

## 信任与原生策略

每个链码代次使用一份部署时共同批准的 `trust.json`。它只有公开的机构 UUID、MSP ID、RSA 业务公钥/有效期，以及随机 domainId 到集合/两个成员机构的映射。无私钥、价格、用量或合同正文。格式为：

```json
{
  "version": 1,
  "generationId": "00000000-0000-4000-8000-000000000001",
  "organizations": [
    {
      "siteId": "00000000-0000-4000-8000-00000000000a",
      "mspId": "AMSP",
      "keys": [{"keyId": "batch-1", "publicKeyPem": "部署方提供的 RSA SPKI PEM 公钥", "validFrom": "2026-01-01T00:00:00Z", "validUntil": "2027-01-01T00:00:00Z"}]
    },
    {
      "siteId": "00000000-0000-4000-8000-00000000000b",
      "mspId": "BMSP",
      "keys": [{"keyId": "batch-1", "publicKeyPem": "部署方提供的 RSA SPKI PEM 公钥", "validFrom": "2026-01-01T00:00:00Z", "validUntil": "2027-01-01T00:00:00Z"}]
    }
  ],
  "domains": [{"domainId": "00000000-0000-4000-8000-000000000010", "collection": "evidence_AB_v1", "siteIds": ["00000000-0000-4000-8000-00000000000a", "00000000-0000-4000-8000-00000000000b"]}]
}
```

公钥须为至少 2048 位 RSA；示例文字不能直接用于部署。各 Peer 的链码使用相同规范内容；`Init` 将其固化到公共状态，每次调用重新比对。不能通过交易参数更换公钥、机构或可见范围。`fabricEvidenceCollections(trust)` 从同一配置生成 Fabric collection JSON，避免手工维护两份成员列表。

| 对象 | 必须配置的 Fabric 策略 |
| --- | --- |
| Channel 的链码生命周期治理 | 所有参与机构管理员批准；由 Channel 原生 LifecycleEndorsement/配置更新策略管理 |
| `kq-evidence` 链码默认背书 | `AND('AMSP.peer','BMSP.peer',...)`，包含本代全部参与机构；定义设置 `init-required` |
| 初始化 | `Init`、零参数、无 transient，所有机构背书相同初始化结果 |
| AB 集合读取 | `OR('AMSP.member','BMSP.member')`，`memberOnlyRead/memberOnlyWrite=true` |
| AB 集合写入背书 | 集合 endorsementPolicy 为 `AND('AMSP.peer','BMSP.peer')` |
| 机构业务公钥撤销标记 | key-level endorsement policy 只允许所属机构 Peer 背书；链码另检查所属机构管理员身份 |

每个 MSP 应启用并正确配置 NodeOUs，以区分 Peer 与 Client。集合默认 `requiredPeerCount=1,maxPeerCount=3,blockToLive=0`；需要至少一名其他可达集合成员 Peer 接收私有数据。永久保留避免未经归档就删除证据，并不代表长期容量治理已经完成。

`AnchorBatch` **只写 PDC**，不同时创建公共状态键。这样集合的双方策略可以覆盖链码默认 ALL，第三方机构不用接收 transient 或参与 AB 的存证背书。初始化和信任状态仍由原生策略保护。返回值只有随机 batchId 和带随机盐的摘要，不发事件；调用参数只有 domainId、batchId。

Fabric 仍会暴露 MSP、集合、交易时间、私有读写哈希等元数据。公开的成员配置也会暴露机构之间存在集合关系。关系本身需要保密时，必须配置独立私有 Channel，不能宣称 PDC 已隐藏交易关系。

## 业务身份与批次语义

Fabric 客户端证书同时带有 `kq.federation.site=<site UUID>` 和 `kq.federation.role=attestor` 属性。信任操作另用 `trust-admin` 角色，业务 Agent 或普通用户凭据不拥有此属性。机构 CA 必须限制属性签发权；拥有任意有效成员证书并不足以调用这些接口。

批次由既有 RSA JWS 协议签署，密钥用途为 `evidence-batch`。每批最多 100 项，限定同一合作域、协议版本、epoch 和两个机构；每条保存原证据 ID、种类、SHA-256 和连续序号。序号按 domainId＋issuerSiteId 从 1 递增，不能跳号或重复纳入证据。原始委派/回执仍须由平台保存并可核验；当前链码保存签名承诺，不证明计算实际发生或结果正确。

`confirmation=unilateral` 只允许发送方业务签名；`bilateral` 必须由双方针对相同的精确 manifest 字节签名。两个 Peer 的背书不会被显示为“两家机构已确认账单”。当前批次只支持已实现的 delegation、acceptance 证据，尚未支持用量/更正/结算证据。

相同 batchId、相同摘要重试返回原回执；同 ID 改内容、换 ID 重复纳入同一证据、跨机构提交和过期/撤销密钥均拒绝。PDC 字节缺失但仍有已提交 hash 时返回等待，不能将其当作空游标重建序号。`RevokeKey(siteId,keyId)` 只允许该机构的 trust-admin，永久撤销。链码撤销与平台信任登记是两个独立执行域，目前不会自动同步。

## 构建和进程配置

```sh
bun run --filter @kuintessence/fabric-evidence build
bun run --filter @kuintessence/fabric-adapter build
```

输出分别在对应包的 `dist/main.js`。Node 运行包仍需安装锁定的外部依赖；共享协议、jose、Zod 已被构建工具打包。链码使用 Fabric Chaincode-as-a-Service，并强制 Peer 到链码的双向 TLS。启动环境变量为：

| 变量 | 内容 |
| --- | --- |
| `KQ_EVIDENCE_TRUST_FILE` | 共同批准的公开 trust.json |
| `CHAINCODE_ID` | Fabric 生命周期批准的实际 package ID |
| `CHAINCODE_ADDRESS` | 本机构 Peer 可达的链码监听地址 |
| `CHAINCODE_TLS_KEY_FILE` | 服务端 TLS 私钥 |
| `CHAINCODE_TLS_CERT_FILE` | 服务端 TLS 证书 |
| `CHAINCODE_TLS_CLIENT_CA_FILE` | 接受的 Peer 客户端 CA |

部署方须将批准的 trust.json 与链码镜像/版本摘要一同固定，并以只读文件挂载；不能把可修改的公共配置卷当作治理审批。不要启用会输出请求或私有数据的 gRPC/Peer/shim 调试追踪。已提供[无链／有链 Compose](deployment.md) 和显式生命周期工具；Helm 安装、机构治理材料生成及通用信任代际升级仍未交付。

Adapter 由 `KQ_FABRIC_ADAPTER_CONFIG` 指向本地 JSON 文件；`KQ_FABRIC_ADAPTER_KIND` 省略或设为 evidence 均保留此通道，商业通道另起独立进程并按[商业配置](fabric-commercial.md#独立-adapter-与恢复)运行：

```text
adapter: {siteId, channel, chaincode, trust: <完整 trust.json 对象>}
peerEndpoint: 本机构成员 Peer 的 DNS:端口
peerTlsCaFile: Peer TLS CA 的绝对路径
tlsCertificateFile / tlsPrivateKeyFile: Adapter 的 gRPC 双向 TLS 客户端凭据
identityCertificateFile / identityPrivateKeyFile: Fabric 业务调用身份
recoveryKeyFile: 独立生成的 32 个原始随机字节文件，不能填十六进制文本
runDirectory: 仅同机构 Server/Adapter UID 可访问的 0700 目录
```

私钥及 recoveryKeyFile 必须归运行 UID 所有，权限不得开放给 group/other。Adapter 校验业务证书有效期及私钥匹配；SDK 连接只使用指定 Peer TLS 信任，不允许请求动态提供目标 Peer、channel、chaincode、collection 或 signer。

Adapter 仅监听 `runDirectory/evidence.sock`，权限 0600，没有 TCP API。接口如下：

| 接口 | 结果与持久化责任 |
| --- | --- |
| `GET /health` | 只报告进程已配置，不代表链可用，不探测链 |
| `POST /v1/evidence/proposal` | `{domainId,batchId,digest,envelope:{issuerJws,counterpartyJws?}}`；返回 transactionId 与加密 recovery；尚无网络背书或提交 |
| `POST /v1/evidence/advance` | `{recovery}`；proposal 先取得双方背书，返回 prepared 和新 recovery；**调用方必须先事务保存它，再次 advance 才允许 submit** |
| 再次 advance | 先查原 transactionId；未知时发送原签名交易，再查提交结果。返回 pending、anchored 或 invalid；只有 VALID 是 anchored |

加密恢复记录包含完整签名 proposal/transaction 和预先建立的 commit 查询请求，由 AES-256-GCM 保护，绑定部署策略、channel 和调用身份。Adapter 没有第二套数据库；Server 应在其已有数据库中保存该 opaque token。提交/查询超时返回 pending 并保留原交易；背书失败不会自动改选第三方机构。调用方不得把 prepared、HTTP 成功或 submit 成功显示为已上链，也不得因 invalid 自动退款或重复执行任务。

恢复密钥必须与检查点一起纳入受控备份。替换配置、业务证书或恢复密钥会使旧 token 无法恢复；当前应先处理待办再轮换，不能直接覆盖旧凭据。Linux 重启现使用与 Server 相同的私有目录/文件锁检查，仅自动清理确定没有监听者的本 UID socket；活跃监听、文件/符号链接及不确定探测均保留并拒绝启动。锁由内核在进程退出时释放，不能删除仍使用中的 evidence.sock.lock。非 Linux 仍需管理员确认无监听者后处理遗留路径。

## Server 后台补交和人工复核

Server 启用联邦并配置 `FEDERATION_ATTESTATION_SOCKET_PATH`（Adapter 的绝对 Unix socket 路径）后启动补交 worker。未配置时原证据仍保留 pending，列表可以查看未组批数量，Server 不探测链。socket 临时缺失、Adapter 不可达、背书或提交超时只影响存证状态，不进入接单同步路径。

本站签名公钥必须在平台登记 `evidence-batch` 用途，并出现在链码共同批准的 trust.json 中；用途登记不可覆盖旧 keyId，既有密钥缺用途时须按原信任登记规则新增 keyId。当前合作域采用原协议的 `budgetDomainId`，须对应预先批准的 domainId 和机构对，不自动创建/扩大集合。worker 签署的是单方批次；即使原始委派与回执各有机构签名，也不会冒充双方确认同一批次。

处理依次为：固定批次 → 签名落库 → proposal 检查点落库 → transaction 检查点落库 → 原 txId 的 VALID 确认。只有最后一步把批次、交易记录和对应 outbox 一起置为 anchored。失败至少间隔三十秒重试；身份/策略/内容不兼容及明确 INVALID 进入 needs_review，停止后续同流批次，不删除原证据或退回预算。

人类会话 API：

| 路径 | 权限与内容 |
| --- | --- |
| `GET /api/federation/agreements/:revisionId/attestation?limit=50&offset=0` | 本组织 `agreement.read`；返回是否配置 worker、未组批证据数、批次状态/摘要/数量/错误码/更新时间，不返回恢复密文、私钥或租约 token |
| `POST /api/federation/agreements/:revisionId/attestation/:batchId/retry` | 本组织 `agreement.approve`；仅恢复 needs_review，记录操作者与原错误码 |

人工重试不会修改批次内容、签名或序号。已经送交或可能送交的 transaction 必须继续核对原交易，不能因为超时另起交易。只有明确 INVALID 后才创建新交易记录，旧记录保留；从未达到可提交检查点的 proposal 可以标记 abandoned 后重新创建。平台角色名称、受限执行账号或自动化 token 不能代替人工复核权。

## 网络诊断与运行边界

Unix HTTP 测试验证路由与字段白名单和错误脱敏。

- 删掉 B 背书后重新签署的交易得到 `ENDORSEMENT_POLICY_FAILURE=10`；正常两方交易 VALID。重放原批次仍需要两方背书。
- 直接读取 Fabric block/private-data delivery：A/A、B/B 能读取正文；C/A、A/C、C/C 均无私有写入；公共区块不含私有 JWS。此检查绕过应用查询接口。
- 每个检查点由新 Node 进程推进；已确认交易恢复仍返回原 txId/区块。Orderer 真实停止时保持 pending，重启并完成 Raft 选主后原交易 VALID。
- 同序号两份已背书交易仅一份 VALID，另一份为 `MVCC_READ_CONFLICT=11`；重新提交过期序号明确拒绝。非管理员/其他机构不能撤销 A 密钥；A 自己的管理员仅经 A 背书成功撤销，已背书但未提交的旧密钥交易因读集冲突失效，后续背书拒绝。

Adapter 按以下方式分类错误：来自实际链码的明确身份、策略、内容或顺序拒绝转换为脱敏错误码，交由现有 Server worker 进入人工复核；未知/混合错误、网络故障和私有数据等待仍重试。不会返回原始 Peer 错误详情。

需要 Linux x86_64、Bun 1.4.2、Node 22.12+、Python 3、OpenSSL、tar，以及已经校验的官方 Fabric 3.1.5 解压目录。无需 Docker 或现有联盟链：

```sh
KQ_FABRIC_TOOLS=/path/to/fabric-3.1.5 \
KQ_FABRIC_REPORT=/path/to/result.json \
bun run test:fabric:network
```

测试仅监听本机动态端口；按进程句柄停止本次启动的服务。成功清理测试账本和随机凭据；失败保留 0700 临时目录以供本机排查，不能公开上传整个目录。`KQ_FABRIC_REPORT` 可选，只输出通过项目和时间；`KQ_FABRIC_KEEP_ARTIFACTS=1` 可保留成功现场，`--hold` 仅初始化网络供开发调试，不等于通过测试。

[数据库联合验证](../../scripts/fabric-evidence-database.ts)另启动生产 Node Adapter 入口和独立 Bun worker，连接实际 PostgreSQL；使用既有迁移器创建随机 `kuintessence_unit_*` 数据库，结束时只删除本次数据库。需要在隔离 PostgreSQL 上有创建数据库权限：

```sh
KQ_FABRIC_TOOLS=/path/to/fabric-3.1.5 \
KQ_FABRIC_DATABASE_URL=postgres://kq:kq@127.0.0.1:5432/postgres \
KQ_FABRIC_REPORT=/path/to/result.json \
bun run test:fabric:integration
```

1. Orderer 和 Adapter 均未运行时，直接接单成功且没有上链 outbox。
2. 存证接单产生真实证据和数据库检查点；Orderer 停机时保存 `LEDGER_PENDING` 和原 txId，同时第二个存证请求继续接单、记录待补交证据。
3. 强制结束并重启 Node Adapter，保留恢复密钥；再强制结束刚取得真实 VALID、尚未写入数据库的 worker。数据库仍保留原 transaction 检查点和租约。
4. 新后台 worker 等待真实 90 秒数据库租约到期后，自动确认原交易，再提交下一批。两批序号分别从 1、3 开始，四条 outbox 全部 anchored，只有两个交易尝试；额度不变，Job 表仍为空。

测试没有缩短租约、回写成功状态或模拟 Gateway。正常结束及收到终止信号时，由父进程清理本次 worker、Adapter、Peer/Orderer 和数据库。

[GitHub 检查](../../.github/workflows/fabric-evidence-network.yml)已加入 PostgreSQL 服务，相关 PR 改动运行相同联合入口，固定官方 Fabric 发布包 SHA-256，只上传无私有材料的断言摘要。

联合入口的检查范围限于上述后台存证与恢复路径，不包含科研作业执行、长期容量或跨主机身份管理。

## Fabric 3.1.5 排序节点追平

带双向 TLS 的四节点 SmartBFT 配置固定 `General.Cluster.ReplicationPolicy: simple`（Compose 使用 `ORDERER_GENERAL_CLUSTER_REPLICATIONPOLICY`）。3.1.5 的 `BFTSynchronizer` 创建 `BFTDeliverer` 时未设置 TLS 证书摘要，重启后的 Deliver 请求被其他排序节点以 `BAD_REQUEST: client didn’t include its TLS cert hash` 拒绝。`simple` 是 Fabric 原生同步器，发送证书摘要，并通过 `VerifyBlocksBFT` 校验区块链和共识签名；共识仍为四节点 SmartBFT。此选择不含 `consensus` 同步器的独立头部审查检测，此配置不提供恶意节点审查攻击的检测保证。

升级 Fabric 后，仅在双向 TLS 下完成落后节点追平测试后再切回 `consensus`。不得关闭 TLS、客户端证书检查或区块验证来恢复同步。管理员端口继续只在 Compose 网络内开放。
