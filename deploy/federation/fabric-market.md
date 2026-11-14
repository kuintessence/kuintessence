# 公共任务市场链码

当前 `kq-market` 已实现公开需求发布、唯一认领、未认领需求撤回及公开状态读取。机构身份来自 Fabric MSP 证书的 `kq.federation.site` 与 `kq.federation.role=market`，并核对部署信任清单；`commercial` 身份仅可读取公开需求，供同通道商业链码检查。

价格、用量、完整合同、脚本、输入数据和个人身份不属于公开协议。接口严格拒绝额外字段；标题与说明是发布方明确选择公开的文本，平台接入时必须让发布方核对这些文本，schema 不能自动识别混入自由文本的敏感内容。商业字段仍只属于指定机构 PDC，不能通过放进市场说明字段规避隐私要求。

## 状态与接口

单条读写调用只有一个公开参数 `demandId`；分页读取使用 limit/bookmark 两个参数。写入载荷通过唯一 transient 键 `market` 传入，最多 32 KiB。**transient 只是传输方式，这些市场载荷会写入公开状态，绝非私有记录。**

| 方法 | 操作者与效果 |
| --- | --- |
| PublishDemand | 需求机构发布公开资源需求、平台/架构、标题与说明、有效期；保存不可变摘要，初始 OPEN/version=1 |
| ClaimDemand | 另一机构按 expectedVersion 认领，保存唯一 claimId/执行机构/截止时间，状态 CLAIMED/version=2 |
| CancelOpenDemand | 仅需求机构可按 expectedVersion 撤回 OPEN 需求，状态 CANCELLED |
| ActivateDemand | 需求机构按当前认领版本及私有 gate 的当前哈希激活为 ACTIVE；见执行许可说明 |
| GetDemand | 登记机构读取完整公开状态；允许 market/commercial 角色 |
| ListDemands | 相同读取角色，使用 Fabric 原生书签按需求键分页；每页 1–50 项，仅读取不提交 |

相同发布/认领/撤回原请求可重试，不能用同一标识覆盖内容或重置当前状态。认领期限必须处于需求有效期内；已认领需求不因超时自动开放，也不能调用“撤回未认领需求”释放。这避免后续私有锁额存在时另一机构取得第二份认领。链码已增加受私有锁额 gate 约束的 ActivateDemand，以及商业链码的激活前释放；详见[执行许可](fabric-execution-gate.md)。认领后不自动重新开放；执行许可与结算分别沿商业协议处理。认领不是执行许可，也不是已锁定资金的证明。

## 部署与机构背书

代码见[链码](../../contracts/fabric/market/src/contract.ts)和[共享协议](../../packages/shared/src/federation/market.ts)。使用 Node 22.12+ 和既有 fabric-shim 2.5.8，启动参数与证据/商业 CCAAS 相同，信任文件变量为 `KQ_MARKET_TRUST_FILE`。内容为 version=1、generationId 和 organizations 数组，每项只含 siteId、mspId。信任配置与初始化状态必须完全一致；变更成员须按治理升级处理，不能只修改容器文件绕过已提交配置。

公开任务使用通道 `/Channel/Application/Endorsement` 的 `MAJORITY Endorsement`，链码定义引用该通道策略；lifecycle 升级由 `ALL Endorsement` 管理。初始化的信任配置键另设全机构背书。多数派规则由 Fabric 原生策略表达，不由应用自行统计“几个机构同意”。认领对同一个需求键读写，Fabric 提交验证 MVCC，两个并发背书不代表两份认领都已成立。

## Market Adapter 与本机客户端

独立 [Market Adapter](../../packages/fabric-adapter/src/market.ts)，启动已有 Node Adapter 入口时设置 `KQ_FABRIC_ADAPTER_KIND=market`、`KQ_FABRIC_ADAPTER_CONFIG=/absolute/path/market-adapter.json`。配置格式复用[商业 Adapter](fabric-commercial.md)，其中 adapter 包含本机构 siteId、固定 channel、固定 chaincode 和上述公开 trust；连接证书、身份密钥、恢复密钥及私有 runDirectory 使用原权限检查。生成 `market.sock`，目录/套接字仅本用户可读写，启动锁阻止同目录双进程；不开放 TCP API。

本机协议接受 `POST /v1/market/proposal`、`/v1/market/advance` 和 `/v1/market/query`。前者为严格联合结构：publish-demand + demand、claim-demand + claim 或 cancel-open-demand + cancellation，详情见共享 schema；advance 仅接受 recovery；query 严格限定 list-demands + limit/bookmark 或 get-demand + demandId。不能由调用方选择其他通道、链码或机构密钥。Server 的 [UnixMarketClient](../../packages/server/src/federation/market-client.ts) 已提供类型化客户端，持久待办与机构范围 API 已按下节接通。

准备提案保存加密检查点；背书后返回 prepared，尚未提交。后续提交须取得原交易 VALID 才返回 committed；未知结果保持 pending 并沿同一 transactionId 恢复。调用方必须在每次推进前持久保存原输入及检查点，不能丢失待办后创建新请求。恢复密钥、机构证书、channel/chaincode、信任 generation 或 Adapter 用途改变均拒绝旧检查点，需按原配置恢复并核对，不能静默丢弃。

市场数据均为公开内容，Adapter 让 Gateway 根据通道原生策略发现多数背书节点；不套用私有商业域的两机构发送范围。价格/合同等仍不得通过本接口传输。校验机构身份和载荷后，链码继续核对当前发布者/认领者、版本及状态。committed 仅表示该市场操作有效，不代表资金已锁定或允许执行。

## Server 持久提交与权限

运行当前版本的常规数据库迁移，配置机构签名身份和 `FEDERATION_MARKET_SOCKET_PATH=/private/run/market.sock` 后，已有商业 worker 每 10 秒推进最多八次市场检查点。没有市场 socket 时仍能保存请求、查看历史，响应 enabled=false，待办保持 pending；直接合作和异步存证不增加市场依赖。

请求经真人登录、当前活动组织与独立 capability 检查后，在同一事务保存不可变输入、摘要及审计。`market.publish` 允许发布、撤回本组织已成功发布但尚未认领的需求及对应重试；`market.claim` 允许认领与对应重试；两者都包含 `market.read`。平台管理员等角色不自动获得这些权限。中英文权限管理列表已包含新能力。撤回须有本组织已 committed 的原发布，最终 OPEN 状态由链码核验。

| 接口 | 用途 |
| --- | --- |
| GET /api/federation/market/demands | 公共需求目录，limit（默认 20、最多 50）及不透明 bookmark 分页 |
| GET /api/federation/market/demands/:id | 公共单条需求，明确不存在返回 404 |
| POST /api/federation/market/operations | 接受 MarketProposalInput，返回 202 和本地待办 ID；不表示已上链 |
| GET /api/federation/market/operations | 本组织操作列表，limit/offset 分页 |
| GET /api/federation/market/operations/:id | 本组织操作与交易尝试；limit/offset 分页交易历史 |
| POST /api/federation/market/operations/:id/retry | 仅空对象；复核原操作，不能修改内容或伪造 committed |

同一业务标识/相同内容并发入队只保存一次；不同内容或其他组织复用标识拒绝。所有响应 no-store，列表/详情只投影业务字段，不包含租约 token、恢复密文或内部领取状态。分页 hasMore 明确还有历史。审计只含操作、摘要及标识，不复制公开说明正文。

后台使用 90 秒数据库租约、SKIP LOCKED 领取与保存前后的租约核验；网络调用不持锁。提案与背书后 transaction 先持久保存，下一次才提交；断线/未知结果至少间隔 30 秒恢复原交易。INVALID 和需人工处理的错误进入 needs_review，重试只可放弃未提交 proposal 或已确认 INVALID 的尝试；未知 transaction 不换 ID。提交结果和业务状态在同一事务写入，失败回滚后继续原检查点。历史尝试保留。

入队表示机构已经受理该公开操作。人员权限撤销禁止后续新请求、读取与人工重试，不自动撤销已受理的后台操作；已提交结果未知时也不能通过撤销人员权限假定链上操作未发生。当前不提供撤销本地尚未提交待办的接口；撤回公开需求是独立链上操作，受前述状态限制。

operations 列表是本组织提交记录；demands 是当前机构 Fabric 身份可读的联盟公开目录，二者分开。公共目录仅调用 Gateway evaluate，不提交交易，也不写本地待办。返回 observedAt 是本次成功读取时间，不是区块时间或多机构共识新鲜度保证；Peer 可能暂时落后，后续写入仍由链上版本/MVCC 核验。书签只是翻页位置，跨页不保证同一时点快照；不对需求总量作精确统计承诺。

目录读取在网络前后均复核 market.read 和当前组织，网络期间不持有数据库锁。未配置 Adapter 或断线返回 503，不把故障当作空列表；无效响应返回 502。Adapter 核对严格 schema、需求 ID/摘要及页大小，不提供任意链码查询。价格、用量和合同不得出现在自由文本中。

## 网络诊断

```sh
KQ_FABRIC_TOOLS=/path/to/verified-fabric-3.1.5 \
bun run test:fabric:market
```

沿用[隔离 Fabric 网络](fabric-evidence.md)的三机构/三 Peer、独立 Orderer、随机本机端口、mTLS 与资源限制，不接入现有链或数据库。可用 `KQ_FABRIC_REPORT` 保存不含凭据的断言摘要；完整测试目录默认清理，`KQ_FABRIC_KEEP_ARTIFACTS=1` 仅用于本机诊断，目录包含测试凭据，不公开上传。

测试已接入现有 Fabric CI。追加检查使用真实 Node Market Adapter、私有 Unix socket 和 Server 客户端，先持久保存提案/背书检查点，停止 Orderer 得到 pending，再恢复 Orderer；提交 VALID 后让进程退出而不保存响应，新进程仍从原检查点取得同一 transactionId/blockNumber。每次调用是新进程，未以同一内存对象代替恢复；此故障恢复样例是发布需求操作。

已认领的需求仍须经过私有预留、公开激活和有效执行确认，才能接入作业派发；这些门禁见[执行许可](fabric-execution-gate.md)。市场链码诊断只检查市场状态与交易恢复，不运行计算作业。

## 关闭未锁额认领

`close-unreserved-demand` 适用于已认领、但尚未在私有商业域建立执行 gate 的需求。发起者可以是原发布机构或当前认领机构。关闭会保留原认领、写入 `unreservedClosure` 并将公开状态置为 CLOSED；不重新开放，不生成资金退款，也不撤销已经建立的私有预留。已有 READY、REVOKED 或 TERMINAL gate 均拒绝此入口，分别沿原释放/终态流程处理。

Market 链码调用同通道 Commercial 的 `GetExecutionGatePresence`，仅已配置商业域内的缺失键返回明确的 `hash:null`。未知域、调用失败、无响应和不合法数据均不能冒充没有 gate。缺失哈希读与公开需求写进入同一个 Fabric MVCC 集合：关闭与私有预留并发时，先提交者 VALID，另一笔 INVALID。此规则无需公开价格、合同、用量或完整委派。

通过既有 `POST /api/federation/market/operations` 提交，正文为：

```json
{
  "operation": "close-unreserved-demand",
  "closure": {
    "demandId": "10000000-0000-4000-8000-000000000001",
    "closureId": "10000000-0000-4000-8000-000000000002",
    "claimId": "10000000-0000-4000-8000-000000000003",
    "commercialDomainId": "10000000-0000-4000-8000-000000000004",
    "issuerSiteId": "10000000-0000-4000-8000-000000000005",
    "expectedVersion": 2
  }
}
```

示例标识不能直接执行。`demandId`、`claimId`、商业域和版本取自原公开认领，`issuerSiteId` 必须为本站；只有首次创建 `closureId`，未知结果继续原 ID。源方要求本组织已 committed 的发布记录与 `market.publish`，执行机构要求本组织已 committed 的原认领与 `market.claim`，重试保持相同权限；平台管理员身份本身不代替这些授权。无商业域的旧认领不通过此接口推测归属。

入队仍返回 202/pending，只有原交易 VALID 才标 committed。同一原发布/认领的并发关闭串行去重；改用另一 closureId 拒绝。已有未认领撤回因认领竞争失败，不妨碍发起本关闭。新待办锁定原市场占额，已释放占额不能被新 ID 重新使用；精确重放返回原记录。本地提案与签名交换的停止方式见下文；公共 CLOSED 仍不等同于所有本地义务已结束，也不直接回收任务占额。

升级须应用 Drizzle 生成的 [数据库结构](../../packages/db/migrations/0079_conscious_anthem.sql)，同步部署共享 schema、Commercial/Market 链码、Adapter 和 Server，再启用该入口。先让 Commercial 支持存在性查询；旧 Market 客户端无法解析新增 CLOSED 记录，不应与新写入混用。入口用于关闭认领，后续本地待办由下节所述后台流程收尾。

真实并发专项：

```sh
KQ_FABRIC_TOOLS=/path/to/verified-fabric-3.1.5 \
bun scripts/fabric-evidence-network.ts --gate --unreserved-closure
```

## 关闭尚未锁额的认领

### 关闭后的本地待办

Server 商业 worker 每轮选择一笔到期的原发布或认领，通过本站受信任的 Market Adapter 查询最终状态；同一原意图至少间隔 60 秒，跨副本跳过已锁定记录。任意一方发起的 `unreservedClosure` 均可被双方各自确认。网络请求不持有数据库事务；缺失、超时、格式错误、错绑认领或摘要不符均不作为关闭事实。

确认结果与原本地意图绑定，保存完整公开状态、摘要、观测时间和审计。写入前重验原意图，并与同一站点/需求的本地业务写入互斥。保存后不因网络故障或重启重新开放。已关闭需求不能再创建预留批准、附加另一方签名、申请激活/执行确认或恢复提案和签名交换重试；直接合作与异步存证不使用这项市场检查。

无活动租约的提案、自动执行待办及尚未完成的市场请求/预留/释放签名交换按批转为 `closed`，保留原请求、签名、回执与累计授权使用量。已有完成的请求/签名交换保留原完成状态；未完成操作的 `MARKET_CLOSED` 表示关闭原因，不表示执行成功。仍有租约的操作先完成其原有校验，过期 worker 不能覆盖已关闭状态。原停止交付在核对相同需求、认领、双方及商业域后也可结束，不再等待一个不存在的激活。

已经准备为交易、可能提交但结果未知的市场/商业检查点继续使用原交易 ID 恢复，不能用新提案取代。尚未广播的 proposal 在无活动租约时标为 abandoned，未提交或已 INVALID 的意图转为 closed 并记录审计，保留原检查点；不能把 closed 当成 committed。原交易结果未知时仍占额，确认收尾后按[存储回收条件](storage-capacity.md#自动回收条件与边界)释放本地收尾占额，不退款、不恢复累计预授权额度。原始签名、交易和授权消耗仍保留供历史查询。

应用 Drizzle 生成的 [数据库结构](../../packages/db/migrations/0079_conscious_anthem.sql) 后部署新版 Server。新增表仅保存公开市场状态，不复制价格、合同或用量私有字段。

迁移 [数据库结构](../../packages/db/migrations/0079_conscious_anthem.sql) 为市场/商业提交增加 closed 状态。保存关闭事实后拒绝新建撤回/关闭意图；精确重放仍返回原记录，恢复未知交易仍沿原检查点。
