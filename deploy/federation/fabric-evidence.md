# Fabric 证据链码与独立 Adapter

当前交付的是可构建的链码、官方 Gateway 接口与本地恢复协议。**Server 的批次组装、数据库检查点 worker 和真实 Fabric 网络验收尚未接入**；启动这些进程不会自动消费现有存证 outbox，也不会创建联邦作业。直接模式不导入 Gateway SDK、不启动 Adapter。

代码位置：[证据链码](../../contracts/fabric/evidence/src/contract.ts)、[Adapter](../../packages/fabric-adapter/src/evidence.ts)、[私有进程入口](../../packages/fabric-adapter/src/runtime.ts)、[协议与集合配置](../../packages/shared/src/federation/ledger.ts)。Node 至少 22.12，Gateway 固定 1.13.0，fabric-shim 固定 2.5.8。Fabric Peer/Orderer/CA 版本仍需与真实网络联合验证，不能以依赖安装成功代替兼容性验收。

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

相同 batchId、相同摘要重试返回原回执；同 ID 改内容、换 ID 重复纳入同一证据、跨机构提交和过期/撤销密钥均拒绝。PDC 字节缺失但仍有已提交 hash 时返回等待，不能将其当作空游标重建序号。`RevokeKey(siteId,keyId)` 只允许该机构的 trust-admin，永久撤销。可以在本代部署时预置后续有效期的轮换公钥；新机构、新集合及未预置密钥的代次迁移尚待实现。链码撤销与平台信任登记是两个独立执行域，目前不会自动同步。

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

部署方须将批准的 trust.json 与链码镜像/版本摘要一同固定，并以只读文件挂载；不能把可修改的公共配置卷当作治理审批。不要启用会输出请求或私有数据的 gRPC/Peer/shim 调试追踪。当前尚无本链码的 Compose/Helm 安装器或通用升级命令。

Adapter 由 `KQ_FABRIC_ADAPTER_CONFIG` 指向本地 JSON 文件：

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

恢复密钥必须与检查点一起纳入受控备份。替换配置、业务证书或恢复密钥会使旧 token 无法恢复；当前应先处理待办再轮换，不能直接覆盖旧凭据。重启不自动删除已有 Unix socket，以免误删另一进程；异常退出留下的 socket 须先确认进程不存在再清理。数据库 worker、凭据轮换恢复及批次终态核对仍待接通。

## 已执行检查与真实网络验收边界

本地测试覆盖链码的机构边界、签名、序号、重复提交、密钥撤销；Gateway 测试使用真实 SDK 编码/签名/恢复方法和受控 RPC 返回，覆盖精确两方 transient 路由、提交回执丢失、VALID/INVALID 区分、加密 token 篡改以及重启恢复。Unix HTTP 测试验证路由与字段白名单和错误脱敏。

这些测试没有模拟出真实的 Fabric 共识、私有数据分发或 MVCC 验证。仍须在独立 A/B/C Peer 网络证明：C 无法取得 AB 私有数据、缺少 B 背书不能提交、并发序号与撤销产生正确验证结果、链离线期间平台作业仍运行、重启后 outbox 自动补交。当前不把此模块视为完整存证验收通过。
