# 案件私有集合与存证许可

当前已实现独立案件链码、Node Adapter 和严格签名协议，并通过确定性账本／真实 SDK 提案及同机四机构 Fabric 网络检查。Server 已接入独立人员存证审批、同文附签和签名撤回；自动签名交换、持久投递和跨机构撤回通知已接通，同机三 Server/Fabric 存证与撤回流程已通过联合验收；裁决、保留删除及 PR 预览仍待完成。原有材料读取接口不会自动创建链上存证。

## 私有范围

案件链码独立部署为 `kq-cases`，使用独立信任文件和 `case_` 前缀集合。原 `kq-commercial` 的 A/B 域、集合成员和背书规则不变；案件链码不调用原商业链码，不读取原合同、用量或余额。R 只获得双方另外批准的字段及相应签名。

`FabricCaseTrustSchema` 固定每个案件域的 `domainId`、原 `commercialDomainId`、`sourceSiteId`、`targetSiteId`、`recipientSiteId` 和 `collection`。三个机构必须不同且存在于独立的 organizations 配置；案件域 ID 不得等于原商业域 ID。组织保持显式 MSP、公钥及有效期，`keyPurposes` 为每把业务密钥列出用途，不能由证书管理员身份代替双方业务签名。

`fabricCaseCollections(trust)` 生成以下原生策略：

- 成员读取／写入限制均开启，成员为 `OR(A.member,B.member,R.member)`。
- 写入背书为 `AND(A.peer,B.peer,R.peer)`；Adapter 仅向这三家发送含 transient 的提案，不向其他联盟成员发送。
- `requiredPeerCount=2`、`maxPeerCount=2`；三家需要具备相应的 Peer 可达性。
- `blockToLive=0`，不按区块自动清除未结案件。保留／legal hold／显式 purge 尚待实现，不能宣称已有自动归档或磁盘回收。

二取三原生策略仍属于完整设计目标，目前生成器和 Adapter 只支持三方共同背书；不要手改集合降级后声称完成了该配置的验收。公开信任映射、集合成员和交易时序仍可能透露合作关系，不承诺机构关系匿名。

## 存证与撤回

`case-evidence-publication` 是独立于读取许可的 A/B 同文签名。它绑定存证编号、案件域、精确案件／政策／材料／合同摘要、A/B/R、有效期和随机盐。`record-case-evidence` 必须提供六份原签名：双方存证许可、双方披露政策、双方具体字段投影。只提供原四份读取材料签名不能入链；额外字段、错机构／用途、错摘要、超期或材料生命周期不一致均拒绝。

存证许可表示在指定案件域持久保存这一份精确投影的独立决定。其 `validUntil` 限制新存证提交，不承诺已经写入的副本届时自动消失。链码不联网查询各 Server 的本地撤销状态；平台在签署前检查当前原件和批准，后台已接通独立存证／撤回队列，不能把读取许可自动转换成存证许可。

任一 A/B 可签署 `case-publication-revocation`，绑定原存证编号／摘要和撤回编号。允许在材料首次入链前保存撤回；相同材料后续提交及重放均被拒绝。R 和联盟管理员不能冒充当事方签署撤回。撤回原件与标记仅写案件集合，与存证读取同一标记形成 MVCC 依赖；相同业务编号换文拒绝，重放保留原字节。这里的“撤回”阻止后续存证，不删除已有明文，不解冻资金，也不撤销已经发生的历史事实。

`GetCaseReceipt` 仅向案件成员返回原随机编号和带盐摘要；不存在返回 `receipt:null`。它是历史存证回执，不是新的材料读取许可，也不能证明科研结果正确、金额事实真实或已经取得仲裁权。私有字节缺失／哈希不一致返回 `DATA_WAITING`，不能当作从未写入。业务密钥撤销继续使用各自组织的原生状态背书。

## 进程与配置

运行 `bun run --filter @kuintessence/fabric-commercial build` 同时生成原商业入口和 `dist/case-main.js`。案件进程使用 Node，配置 `KQ_CASE_TRUST_FILE`、`CHAINCODE_ID`、`CHAINCODE_ADDRESS` 和现有链码服务端 TLS／客户端 CA 文件变量。独立 lifecycle 定义、生成的集合配置与信任文件须一致；初始化信任和业务密钥验证参数后，不支持直接覆盖运行中的信任原件。旧链治理升级另行实现。

运行现有 Adapter 构建，再单独启动 Node Adapter，设置：

```bash
KQ_FABRIC_ADAPTER_KIND=case \
KQ_FABRIC_ADAPTER_CONFIG=/absolute/path/case-adapter.json \
node packages/fabric-adapter/dist/main.js
```

配置沿用[私有连接与文件权限](fabric-evidence.md#构建和进程配置)，其中 `adapter` 包含本站 siteId、固定 channel、固定 chaincode=`kq-cases` 和完整案件 trust。客户端 Fabric 证书须具有匹配的 `kq.federation.site` 与 `kq.federation.role=case`；初始化和密钥撤销使用独立 `trust-admin` 身份。案件进程使用独立 recoveryKeyFile 和 runDirectory，生成 `case.sock`，不开放 TCP 业务入口。

Unix 接口为 `/v1/case/proposal`、`/v1/case/advance`、`/v1/case/query`。普通链交易参数只有域 ID 和随机记录 ID，正文与六份签名只进入 transient/PDC；完整输入上限为 1 MiB。复用原加密提案／交易检查点，恢复密钥或配置不匹配不能换身份续交。`prepared/pending/committed/invalid` 沿用原语义，只有实际 VALID 才算成功，不得把创建提案当成上链。

## 已有验证与剩余工作

`bun test scripts/fabric-case-check.test.ts` 覆盖集合模板、六签／精确范围、独立存证权、密钥用途及撤销、有效期、A/B 各自撤回、撤回先于存证、不可变重放、第三机构之外的身份拒绝和私有数据缺失。真实 Gateway SDK 提案被解码核对：公开参数不含材料，transient 仅投递 A/B/R，检查点加密且不能由另一恢复密钥使用；本地 HTTP 验证固定 case 路由和错误脱敏。该入口已纳入 `test`、`test:unit`、`test:fabric` 和 Fabric 脚本类型检查。

上述确定性账本不是实际 Peer；后续四机构网络入口已独立证明原生三方背书、非成员私有数据隔离、真实 MVCC、停 Orderer／进程恢复。平台人员审批现已接通，签名自动交换已接通，持久投递和私有收据已接通（见下文），仍须接通远端撤回同步与实际三 Server/Fabric 联合入口。仲裁授权、裁决／窄执行、二取三策略、保留删除和其余蓝图仍为必做，不能把本模块验收标成 L03/L09 完成。

## 平台独立存证审批

迁移 `0188` 新增本机构存证决定表和 `case.publish` 独立权限。先按常规数据库流程应用迁移，再在启用联邦的 Server 设置 `FEDERATION_CASE_TRUST_FILE`；该文件使用上述 `FabricCaseTrustSchema`，与目标案件链码及 Adapter 的已部署公开信任配置一致。未设置时不挂载审批入口，相对路径或联邦关闭时配置该项会拒绝启动。它不包含私钥，也不能代替链上的信任治理升级。

平台信任登记支持 `case-evidence-publication` 和 `case-publication-revocation` 两个签名用途；中英文权限与信任管理选项同步可用。A/B 的批准人员须单独授予 `case.publish`，平台管理员、材料披露批准权和接收方 R 的读取权均不隐含该权限。新权限不授予原合同查看、披露、仲裁或账务操作。审批同时校验平台当前机构／密钥／用途与已配置案件链的公钥／用途；这不是对链上当前密钥状态的实时查询，真正提交仍以 Peer 验证为准。

下列路径位于现有登录 API 前缀下，均要求当前真人会话、活动组织及独立权限，并使用 `Cache-Control: no-store`：

| 方法与路径 | 内容 |
| --- | --- |
| `POST /federation/case-publications/:revisionId/draft` | 输入 `publicationId`、`caseDomainId`、`grantId`、`validUntil`；从本站双签材料生成完整同文草稿 |
| `POST /federation/case-publications/:revisionId/approve` | 接受完整 `CasePublication`，重新核对原件、双方材料／政策签名、指定 A/B/R 和期限后保存本站原签名 |
| `POST /federation/case-publications/:revisionId/:publicationId/counterparty` | 输入 `approvalJws`，只接受另一方对同一草稿的原签名 |
| `POST /federation/case-publications/:revisionId/:publicationId/revoke` | 空对象；永久撤回本站决定，生成并保留一份独立签名撤回原件 |
| `GET /federation/case-publications/:revisionId` | 本组织分页历史；支持 `caseId`、`publicationId` 筛选 |

A/B 分别审批相同草稿，再分别附加对方原签名；未批准不得由后台代签。只提供读取许可或单方材料签名不能生成存证决定。编号换文、越域／换接收机构、原件被改、当前材料或政策撤销、期限越界均拒绝。重复批准／附签保留原字节，审批、确认和签名撤回各自与审计同事务；行锁等待之后重新检查授权时效。

撤回在对方附签前也可以执行，并且不要求旧材料、旧批准或原签署密钥仍有效；新的撤回签名必须使用当前有权的业务密钥，同时存在于平台和案件信任配置中。原批准签名及摘要不覆盖，重复撤回保留同一原件。`revokedAt` 仅表示本站已经签署撤回，不等于链上确认或对方已经收到；链撤回投递与私有确认见下文，对端 Server 通知见下文跨机构撤回通知。

审批入口不移动资金或改变原争议／作业。签名交换与可选持久链投递见下文；尚无完整 Web/CLI 案件存证操作页或 Server/Fabric 联合验收，不能把 HTTP 批准成功当作已经上链。

## 批准原签名自动交换

迁移 `0189` 为现有商业批准交换队列加入 `case-publication`，沿用同一后台 worker 和生产 mTLS `/federation/v1/commercial-approvals`，不新增进程或签名用途。双方启用上述案件信任配置，并配置现有联邦出站 TLS，才能自动交换。查询使用原商业域和完整存证决定摘要，决定本身绑定独立案件域。未批准的一方返回等待；后台只返回并附加已经批准的同文原签名，不生成存证决定。

发送、返回与保存前核对本站原件、政策／材料与存证撤回、当前平台信任／签名用途、案件配置和期限；端点在传输期间改变则拒绝保存。响应丢失或服务重建继续使用原签名；人员权限撤销不抹掉已签署的机构决定，后台使用独立机构审计身份。停止该决定须由有权人员明确撤回。队列租约防止迟到 worker 覆盖新处理状态，附签、队列完成与审计同事务提交；人工已经附签时不重复请求或审计。

新增两个登录 API，均须 `case.publish`、当前真人和活动组织，不要求额外授予 `agreement.read`：

| 方法与路径 | 内容 |
| --- | --- |
| `GET /federation/case-publications/:revisionId/exchange` | 仅返回该组织、协议的存证交换状态，支持 `limit`／`offset`；不返回原签名或材料正文 |
| `POST /federation/case-publications/:revisionId/:publicationId/exchange/retry` | 空对象；重试尚未完成且无有效处理租约的交换 |

没有案件配置时不发现存证待办，也不返回已有存证签名。原人工附签入口继续可用。自动交换不表示远端撤回实时传播或链上存证成功；双签之后的持久链投递、撤回投递和私有链收据见下文；对端 Server 的主动撤回传播见下文。

## Server 持久投递与私有收据

先应用生成迁移 `0190`，再设置 `FEDERATION_CASE_SOCKET_PATH=/private/case/case.sock`，指向本机构独立 case Adapter。此项要求启用联邦并设置上述案件信任文件，目录和 socket 必须仅对运行用户开放；Server 不引入 Fabric SDK。未配置 socket 时仍可审批、交换和撤回，后台不调用链。启用后沿用商业后台 worker，每次最多推进八步，60 秒租约及 30 秒错误退避保护重启和并发。

扫描器只从已有双方原签名生成证据待办，从已有本站独立撤回签名生成撤回待办，优先处理撤回；不会自动批准或代签。配置启用前已经双签的有效存证决定也会被发现，原材料读取或单方批准不会入链。队列先保存六签原件，再保存 proposal 和背书 transaction 的加密检查点；网络调用不持有数据库事务。每份提案和后续恢复保持同一 transactionId，失联或未知提交结果不得创建替代交易。

发送边界明确区分两种情况：

- 尚未持久保存 `dispatchAuthorizedAt` 时，每次准备、背书及广播前重新核对本站原件、双签、当前信任／配置和期限。本站撤回或失效后关闭证据待办；尚未广播的检查点标记 abandoned 并保留。背书已把私有模拟材料交给授权 Peer，关闭不表示擦除。
- `dispatchAuthorizedAt` 与最后的本站授权核对在同一事务中保存；这表示该原交易已获准发送，可能已经到达 Orderer。此后即使撤回、过期或进程重启，也继续恢复原交易直到取得确定结果，独立撤回待办同时推进。恢复可能重发同一交易，最终顺序由链的验证与 MVCC 决定，不能承诺撤回早于所有在途写入。

只有本交易得到 VALID，且本机构私有查询返回相同 recordId／digest 的收据，队列才记为 committed。收据暂缺时保留 pending，不重复提案；不匹配进入 needs_review。INVALID 必须人工重试，重新检查当前授权后才创建下一次尝试，保留原失败交易；未知 transaction 重试继续用原检查点。确认、私有收据和机构审计同事务保存，失败整体回滚。旧材料失效不阻止合法的独立撤回投递，撤回签名本身仍需当前有效。

登录 API 继续要求本组织当前真人和 `case.publish`：

| 方法与路径 | 内容 |
| --- | --- |
| `GET /federation/case-publications/:revisionId/ledger` | 分页查看本组织证据／撤回待办、错误及私有收据摘要，不返回原件、签名或恢复密文 |
| `POST /federation/case-publications/:revisionId/:publicationId/ledger/:submissionId/retry` | 空对象；重试未完成且无有效租约的原待办，不能重开 closed 或覆盖 committed |

存证及撤回不改财务、争议状态或作业 gate，直接／异步计算不等待案件链。队列没有历史自动删除策略；远端 A/B/R Server 撤回通知、正式三 Server/Fabric 联合验收、仲裁及保留删除仍须完成。当前隔离数据库验证使用可控 Adapter；Unix 客户端另以真实私有 socket 验证路径、模式、严格回复和错误脱敏，不能把两者拼成实际链验收。

## 四机构真实网络入口

使用已校验的 Fabric 3.1.5 二进制目录运行：

```bash
KQ_FABRIC_TOOLS=/absolute/path/fabric-3.1.5 bun run test:fabric:cases
```

入口复用隔离网络脚本，启动同机 A/B/R/D 四个 Peer、一个 Orderer，以及独立的商业和案件链码进程；不启动 Server、数据库或科研作业。A/B 原商业集合保持两方权限，案件集合仅 A/B/R，D 为真正的非成员 Peer。各机构使用独立测试 MSP、业务密钥和角色证书，不代表真实机构信任。

检查包括逐一删除 A/B/R 原生背书后的验证拒绝、六份原签名存证和原件重放、撤回／存证两种提交顺序的 MVCC、生产 case Unix Adapter 的 Orderer 中断和提交后 SIGKILL 恢复。独立区块读取使用各成员及跨 Peer 身份核对精确私有写集，公共区块与进程日志扫描原合同／价格／签名探针。`KQ_FABRIC_REPORT` 可指定仅含检查摘要的报告路径；凭据和详细原件留在忽略的私有临时目录，不上传 CI。

Fabric 的无效交易可能仍向获授权成员提供背书阶段的私有写集，因此“INVALID”不表示数据从未交付或已经擦除。验收分别核对交易验证码、当前账本回执和私有交付权限：被拒绝的提交不能改变当前状态，非成员仍无私有正文。撤回也不追回已获授权发送给背书节点的材料。

2026-11-10：完整入口退出 0，九组检查通过。启动阶段等待本次网络的 Gateway 发现及 PDC gossip 就绪；最初将无效交易误认为没有私有写集，现改为分别核对原生状态拒绝与精确私有交付，没有放宽产品权限或链码规则。两种 MVCC 顺序、A/B 分别撤回、三种缺失背书、跨 Peer 私有过滤和原交易恢复均完成；运行进程已清理。详见[验收记录](../../docs/design/federation/acceptance.md#四机构案件私有账本真实验收)。


## 跨机构撤回通知

先应用生成迁移 `0191`。在双方及指定接收方 R 的平台信任中，为参与通知的密钥配置 `case-revocation-notice`／`case-revocation-receipt`；撤回签名还须在平台与案件信任中具备 `case-publication-revocation` 用途。三站加载同一案件域映射，配置现有联邦 mTLS 客户端与网关。新私有路径为 `/federation/v1/case-revocations`，不接受查询参数或外部伪造的身份头。

A/B 任一方签署撤回后，原后台分别向另一方和 R 投递持久通知，不依赖案件链确认或 socket 可用。通知只有存证许可原件和撤回签名，不携带原合同、价格、材料值或商业原签名。接收方即使尚无本地批准，也永久保存该编号的撤回事实；之后的批准、附签、签名交换及尚未授权发送的链待办均拒绝复活。接收与批准使用同一存证编号锁，先提交的撤回阻止并发首次批准。

原存证摘要按原 JWS payload 字节计算，不能用排序后的 JSON 摘要替代。原批准密钥过期或不再允许批准，不阻止当前合法撤回签名绑定原字节；撤回者、双方及 R、案件域、原文摘要和当前密钥用途仍须全部匹配。R 不能代替 A/B 撤回。

发送前持久保存原通知，响应丢失后重发同一原件；接收重放返回原签名回执，不重复审计。通知和回执均核对当前机构信任，发送完成前再次检查端点、签名用途及租约；异常进入重试或 `needs_review`，不误报成功。收到通知不表示链已确认撤回，也不删除历史/PDC、不撤销独立材料读取权、不授予财务或仲裁权。已授权发送但结果未知的链交易仍恢复原 transactionId，独立撤回继续推进。

本组织真人 `case.publish` 可使用：

- `GET /api/federation/case-publications/:revisionId/:publicationId/revocations`：查看发送和接收状态。
- `POST /api/federation/case-publications/:revisionId/:publicationId/revocations/:receivingSiteId/retry`：以空对象请求重试；已确认或仍有有效租约时拒绝。

18 项不同隔离 PostgreSQL／生产人员及 Ingress 检查、3 项受影响原审批并发／锁等待回归通过；另有 10 项协议／真实 Node mTLS 网关／出站检查和 11 项信任界面检查通过。测试覆盖响应丢失、服务对象重建、审计回滚、端点／用途变化、迟到租约、提前撤回、并发首次批准及 worker 接线。这些检查尚不构成三独立 Server/Fabric 联合验收。

## 三站与真实案件链联合验收

在已准备[隔离执行实验](execution-lab.md)的本地 k3s 节点上，设置 `KQ_FEDERATION_EXECUTION_LAB=1`、`KQ_FABRIC_TOOLS` 和该文档中的 PostgreSQL 工具路径，然后运行：

```bash
bun scripts/fabric-evidence-network.ts --cases-live
```

此入口复用原三站材料交付和轻量 Kubernetes 作业，连接同一 A/B/R 案件信任配置的四 Peer 网络；不重新运行旧四 Peer 的全部隔离／背书矩阵。三平台分别使用自己的数据库、业务密钥和生产 mTLS 网关，R 不加入原商业集合。实际作业结果回传形成账单，再通过真人 HTTP 分别批准精确字段披露及独立存证，后台自动交换原签名。

新增断言覆盖停 Orderer 时持久保存两端原交易、两 Server 和三案件 Adapter 的 SIGKILL／新进程恢复、A/B/R 各自查询私有回执，以及停链期间撤回通知仍送达 B/R、阻止后续批准且不改变独立材料读取权。双端同时写同一事实可能产生真实 MVCC 冲突；仅对明确 INVALID 的冲突执行人员重试，保留原交易历史，不放弃未知交易。链恢复后独立确认撤回，历史存证仍保留。

入口只操作自己创建的临时进程／数据库／k3s namespace，凭据和详细原件存于忽略的 `temp/`。三站数据库位于同一隔离 PostgreSQL，人员会话使用仅监听 loopback 的开发登录；这是生产协议与进程组合验收，不是正式多主机身份、科学软件完整矩阵或 PR 预览验收。实际运行结果记录在[验收清单](../../docs/design/federation/acceptance.md)。

2026-11-10：上述完整联合入口退出 0。两端已授权未知交易经实际 Server/Adapter SIGKILL 后恢复原编号；本次 A 的原交易 VALID，B 的原交易发生 MVCC 冲突，人员重试追加一次 VALID 尝试，旧尝试保留。三家私有回执一致；停链时 B/R 已确认撤回通知，B 拒绝再批准，R 仍可依据独立有效许可读取字段。链恢复后撤回回执确认，原存证保留。同轮材料撤销、原账务对比和资源清理全部通过，结果见验收记录。
