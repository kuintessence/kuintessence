# 公共任务市场链码

当前 `kq-market` 已实现公开需求发布、唯一认领、未认领需求撤回及公开状态读取。机构身份来自 Fabric MSP 证书的 `kq.federation.site` 与 `kq.federation.role=market`，并核对部署信任清单；`commercial` 身份仅可读取公开需求，供后续同通道商业链码检查。

价格、用量、完整合同、脚本、输入数据和个人身份不属于公开协议。接口严格拒绝额外字段；标题与说明是发布方明确选择公开的文本，平台接入时必须让发布方核对这些文本，schema 不能自动识别混入自由文本的敏感内容。商业字段仍只属于指定机构 PDC，不能通过放进市场说明字段规避隐私要求。

## 状态与接口

每个调用只有一个公开参数 `demandId`；写入载荷通过唯一 transient 键 `market` 传入，最多 32 KiB。**transient 只是传输方式，这些市场载荷会写入公开状态，绝非私有记录。**

| 方法 | 操作者与效果 |
| --- | --- |
| PublishDemand | 需求机构发布公开资源需求、平台/架构、标题与说明、有效期；保存不可变摘要，初始 OPEN/version=1 |
| ClaimDemand | 另一机构按 expectedVersion 认领，保存唯一 claimId/执行机构/截止时间，状态 CLAIMED/version=2 |
| CancelOpenDemand | 仅需求机构可按 expectedVersion 撤回 OPEN 需求，状态 CANCELLED |
| GetDemand | 登记机构读取完整公开状态；允许 market/commercial 角色 |

相同发布/认领/撤回原请求可重试，不能用同一标识覆盖内容或重置当前状态。认领期限必须处于需求有效期内；已认领需求不因超时自动开放，也不能调用“撤回未认领需求”释放。这避免后续私有锁额存在时另一机构取得第二份认领。当前没有激活、资金释放、重新开放或结算接口；Server 的 ledger_coordinated 拒绝门槛保持不变。认领不是执行许可，也不是已锁定资金的证明。

## 部署与机构背书

代码见[链码](../../contracts/fabric/market/src/contract.ts)和[共享协议](../../packages/shared/src/federation/market.ts)。使用 Node 22.12+ 和既有 fabric-shim 2.5.8，启动参数与证据/商业 CCAAS 相同，信任文件变量为 `KQ_MARKET_TRUST_FILE`。内容为 version=1、generationId 和 organizations 数组，每项只含 siteId、mspId。信任配置与初始化状态必须完全一致；变更成员须按治理升级处理，不能只修改容器文件绕过已提交配置。

公开任务使用通道 `/Channel/Application/Endorsement` 的 `MAJORITY Endorsement`，链码定义引用该通道策略；lifecycle 升级由 `ALL Endorsement` 管理。初始化的信任配置键另设全机构背书。多数派规则由 Fabric 原生策略表达，不由应用自行统计“几个机构同意”。认领对同一个需求键读写，Fabric 提交验证 MVCC，两个并发背书不代表两份认领都已成立。

## Market Adapter 与本机客户端

新增独立 [Market Adapter](../../packages/fabric-adapter/src/market.ts)，启动已有 Node Adapter 入口时设置 `KQ_FABRIC_ADAPTER_KIND=market`、`KQ_FABRIC_ADAPTER_CONFIG=/absolute/path/market-adapter.json`。配置格式复用[商业 Adapter](fabric-commercial.md)，其中 adapter 包含本机构 siteId、固定 channel、固定 chaincode 和上述公开 trust；连接证书、身份密钥、恢复密钥及私有 runDirectory 使用原权限检查。生成 `market.sock`，目录/套接字仅本用户可读写，启动锁阻止同目录双进程；不开放 TCP API。

本机协议仅接受 `POST /v1/market/proposal` 和 `/v1/market/advance`。前者为严格联合结构：publish-demand + demand、claim-demand + claim 或 cancel-open-demand + cancellation，详情见共享 schema；后者仅接受 recovery。不能由调用方选择其他通道、链码或机构密钥。Server 的 [UnixMarketClient](../../packages/server/src/federation/market-client.ts) 已提供类型化客户端；尚未装配公开 API/后台待办。

准备提案保存加密检查点；背书后返回 prepared，尚未提交。后续提交须取得原交易 VALID 才返回 committed；未知结果保持 pending 并沿同一 transactionId 恢复。调用方必须在每次推进前持久保存原输入及检查点，不能丢失待办后创建新请求。恢复密钥、机构证书、channel/chaincode、信任 generation 或 Adapter 用途改变均拒绝旧检查点，需按原配置恢复并核对，不能静默丢弃。

市场数据均为公开内容，Adapter 让 Gateway 根据通道原生策略发现多数背书节点；不套用私有商业域的两机构发送范围。价格/合同等仍不得通过本接口传输。校验机构身份和载荷后，链码继续核对当前发布者/认领者、版本及状态。committed 仅表示该市场操作有效，不代表资金已锁定或允许执行。

## 真实网络验证

```sh
KQ_FABRIC_TOOLS=/path/to/verified-fabric-3.1.5 \
bun run test:fabric:market
```

沿用[隔离 Fabric 网络](fabric-evidence.md)的三机构/三 Peer、独立 Orderer、随机本机端口、mTLS 与资源限制，不接入现有链或数据库。可用 `KQ_FABRIC_REPORT` 保存不含凭据的断言摘要；完整测试目录默认清理，`KQ_FABRIC_KEEP_ARTIFACTS=1` 仅用于本机诊断，目录包含测试凭据，不公开上传。

已验证单机构背书提交为 ENDORSEMENT_POLICY_FAILURE，两机构发布 VALID；B/C 同时认领时只有一个 VALID，另一个 MVCC_READ_CONFLICT；原请求重试不重置认领，竞争方不能覆盖，未认领撤回接口不能作用于认领后状态，未实现的激活接口拒绝调用。测试已接入现有 Fabric CI。追加检查使用真实 Node Market Adapter、私有 Unix socket 和 Server 客户端，先持久保存提案/背书检查点，停止 Orderer 得到 pending，再恢复 Orderer；提交 VALID 后让进程退出而不保存响应，新进程仍从原检查点取得同一 transactionId/blockNumber。每次调用是新进程，未以同一内存对象代替恢复；此故障恢复样例是发布需求操作。

Market Adapter 与本机客户端已接通，尚缺 Server/Web 入口、PDC 报价与额度锁定、跨链码 executionGate 读集、激活/终态/释放及结算。这些完成前不允许把“已认领”接入作业派发，当前检查不代表市场到真实计算的端到端交付。
