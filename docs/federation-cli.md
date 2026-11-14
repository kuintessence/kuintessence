# 联邦财务 CLI

`kq federation` 通过所属平台的 HTTP API 管理商业合同读取、账单、结算、账务调整、执行前退款和自动审批授权；使用已登录的人类会话及当前机构能力，不持有链密钥，也不直接连接 Fabric。Server 是权限、信任和业务验证的最终执行方。

## 选择机构

```sh
kq login
kq federation organizations
kq federation use "$ORG_ID"
kq federation --org "$ORG_ID" capabilities
kq federation --org "$ORG_ID" contracts list
```

`organizations` 中星号表示当前会话机构。`use` 显式调用现有会话切换接口，需要可切换的登录会话；没有 sessionId 的开发 token 不能用它切换。切换会影响共用该会话的其他客户端。

其余联邦命令要求 `--org UUID`。它发送 `X-KQ-Active-Organization`，仅断言当前会话机构，不能选择机构或获得权限。Server 在主 `/api/federation/*` 路由比较已经绑定的 principal：不合法 UUID 返回 400，机构变化返回 409 `ORGANIZATION_CONTEXT_CHANGED`，两者都不继续业务处理。旧客户端不发送该头时沿用原逻辑；Web 已发送的机构头也会得到这一保护。管理路由和私有 mTLS 协议入口不使用这套会话断言。

默认输出中文，`--lang en` 使用英文状态，`--json` 输出经过 schema 和作用域核对的原记录。JSON 可能包含私有合同、金额和业务签名，应按机构私有材料保管。使用现有 `KQ_CONFIG_FILE` 可选择独立 CLI 登录配置，不需要改动默认配置文件。

## 自动审批与待办

双方分别授予本机构的有限政策。bill 需要 `billing.approve`，settlement 需要 `settlement.approve`，合同批准能力不包含这两项权限。查看需要既有 `agreement.read`；自动化凭据不能代替人员授予或撤销政策。

审查以下 JSON，按实际合同修改金额、次数和到期时间后保存为 `bill-policy.json`。金额使用合同单位的整数字符串，不是浮点数；示例并不默认授权任何机构。

```json
{
  "kind": "bill",
  "outcomes": ["completed"],
  "maxAmount": "10",
  "maxTotalAmount": "100",
  "maxRecords": 10,
  "validUntil": "2030-01-01T00:00:00Z"
}
```

```sh
kq federation --org "$ORG_ID" closing policies grant "$REVISION_ID" bill-policy.json
kq federation --org "$ORG_ID" closing policies list "$REVISION_ID" --limit 20 --offset 0
kq federation --org "$ORG_ID" closing policies revoke "$REVISION_ID" "$POLICY_ID"
kq federation --org "$ORG_ID" closing tasks list "$REVISION_ID"
kq federation --org "$ORG_ID" closing tasks retry "$REVISION_ID" bill "$RESERVATION_ID"
kq federation --org "$ORG_ID" closing tasks retry "$REVISION_ID" settlement "$BILL_ID"
```

结算授权使用另一个 `kind: "settlement"` 文件独立授予。`grant` 是实际操作，不是预览；CLI 不额外询问确认。每种类型先撤销旧的未撤销政策，再授予新政策；撤销停止新的批准，保留原签名。列表显示单笔上限、允许结果、累计金额、次数与到期状态，零金额政策仍可批准零收费记录。

待办仅在提供方产生。bill 待办的 reference 是原 reservationId，settlement 待办的 reference 是原 billId；它们不是账单草稿的 reportId。retry 只请求处理原记录，需要对应独立能力；完成状态只表示双方签署，继续查询原账单/结算核对记账和存证。

## 原文草稿、批准与附签

```sh
kq federation --org "$ORG_ID" contracts show "$REVISION_ID"
kq federation --org "$ORG_ID" contracts export "$REVISION_ID" contract.json
kq federation --org "$ORG_ID" bills draft "$REVISION_ID" "$REPORT_ID" bill.json --id "$BILL_ID"
kq federation --org "$ORG_ID" bills approve "$REVISION_ID" bill.json
kq federation --org "$ORG_ID" bills attach "$REVISION_ID" "$BILL_ID" peer-bill.jws
kq federation --org "$ORG_ID" bills list "$REVISION_ID" --record "$BILL_ID"
kq federation --org "$ORG_ID" settlements draft "$REVISION_ID" "$BILL_ID" settlement.json --id "$SETTLEMENT_ID"
kq federation --org "$ORG_ID" settlements approve "$REVISION_ID" settlement.json
kq federation --org "$ORG_ID" settlements attach "$REVISION_ID" "$SETTLEMENT_ID" peer-settlement.jws
kq federation --org "$ORG_ID" settlements list "$REVISION_ID" --record "$SETTLEMENT_ID"
```

草稿只生成原文，不批准。`--id` 可以指定原 UUID，省略时生成新 UUID；双方必须审查和批准同一份原文，不分别重新生成。`attach` 读取对方原 JWS 文件，由 Server 校验签名和当前信任。已有自动签名交换可继续使用，无需手工重复附签。批准响应会核对正文及外层记录编号。

导出使用仅所有者可读写的新文件（0600），不覆盖已有路径；输入文件上限 600000 字节。列表支持 `--limit 1..100` 和 `--offset`，账单/结算可用 `--record UUID` 精确查询。金额始终保留整数精度，结算分别标明预留、扣用、归还，不把签名、本站记账和本站存证混成一个成功状态：

| 模式 | 本站记账与链状态 |
| --- | --- |
| bilateral_direct | 不要求链存证，独立读取实际记账状态 |
| bilateral_attested | 本站可以已记账但存证仍待处理，缺失对端状态不推断已上链 |
| ledger_coordinated | 双方签署不等于本站已记账，须等待原待办 VALID |

CLI 不自动重试写入，联邦请求拒绝重定向并限时 30 秒。写入超时、连接中断或成功响应损坏时，结果可能已经生效：先查询原政策或原业务编号，核对后再处理，不能重新生成或盲目重复授权。`use` 响应异常时同样先用 `organizations` 核对当前会话。批准及记账均不表示银行付款。

## 结算后的账务调整

```sh
kq federation --org "$ORG_ID" adjustments draft "$REVISION_ID" "$SETTLEMENT_ID" adjustment.json \
  --id "$ADJUSTMENT_ID" --amount 40 --reason '双方确认的账务更正'
kq federation --org "$ORG_ID" adjustments approve "$REVISION_ID" adjustment.json
kq federation --org "$ORG_ID" adjustments attach "$REVISION_ID" "$ADJUSTMENT_ID" peer-adjustment.jws
kq federation --org "$ORG_ID" adjustments list "$REVISION_ID" --record "$ADJUSTMENT_ID"
```

`--amount` 是调整后的**完整净扣用额**，不是差额；`--reason` 必填，`--evidence sha256:…` 可选，填写机构保管的佐证摘要。草稿从原 settlementId 生成，保留原账单/结算摘要、前一笔调整和调整前金额。双方审查同一原文后分别批准，需独立 adjustment.approve；账单/结算政策不会自动批准调整。服务端检查原结算已应用、前驱、原任务及预算上限。

直接/异步模式的调增在本站批准时占住正差额，双签后记账；调减在双签前不退额。列表显示调整前后净额、**批准时占额**、双方签署、本站记账和本站存证；批准时占额是这笔签署的历史记录，已记账后不会变成 0，不能把它当成当前仍冻结的余额。精确金额保持整数字符串，列表分页和 `--json` 与账单命令一致。前一笔未应用时不能创建下一笔；旧记录不覆盖。

已有后台签名交换会传递已批准原文，手动 attach 作为同文收尾入口。已签占额不因员工撤权或网络故障自动消失，当前没有单方撤销/解除占额命令；签署和记账不表示银行付款或退款。写入未知时先按原 adjustmentId 查询，再决定是否重试，不能更换编号再次批准。

## 执行前取消的额度退款

源机构确认原委派已永久取消、从未创建执行工作流后生成草稿。双方审查同一文件，再分别批准；需要 `settlement.approve` 和明确的 `commercial-refund` 业务密钥用途。该退款只归还原合作预留额度，不执行银行退款。

```sh
kq federation --org "$ORG_ID" refunds draft "$REVISION_ID" "$OPERATION_ID" refund.json \
  --id "$REFUND_ID" --reason '双方确认执行前取消'
kq federation --org "$ORG_ID" refunds approve "$REVISION_ID" refund.json
kq federation --org "$ORG_ID" refunds attach "$REVISION_ID" "$REFUND_ID" peer-refund.jws
kq federation --org "$ORG_ID" refunds list "$REVISION_ID" --record "$REFUND_ID"
```

`OPERATION_ID` 是原委派编号，不是 taskId 或 reservationId。`--reason` 必填；源方生成的完整原文包含提供方签名取消回执，不应手工拼装或为同一委派换编号。提供方导入源方原文后独立批准。后台交换已批准签名，`attach` 是手动收尾入口；草稿文件以 0600 新建，不覆盖已有文件。

直接模式双签后归还本站额度，不依赖链；异步模式提供方同事务保存退款及私有存证待办，列表将本站记账与存证分开显示。源方没有本站链待办时明确显示未同步，不推断对端已经上链。链协调任务使用原释放/终态结算，不允许通过本入口绕过锁额。

`list` 支持分页、原编号筛选和 `--json`，金额保持整数字符串；原文及响应会核对机构、合同、任务和编号。结果未知时先查原退款，不重新生成。CLI 本轮提供草稿、批准、附签和查询；存证重试可通过合同退款页面或现有商业提交 API 操作。

## 外部付款凭证

付款命令记录双方认可的外部付款事实，不发起转账、不结算合作额度。合同须为 paid，审批人员须具有独立 `payment.approve`，业务密钥须具有 `commercial-payment` 用途。首次记录和更正均由双方审查同一份原文，再各自批准；后台交换已经存在的签名。

```sh
kq federation --org "$ORG_ID" payments draft "$REVISION_ID" "$BILL_ID" payment.json \
  --id "$RECEIPT_ID" --payment "$PAYMENT_ID" --amount 40 \
  --occurred-at '2026-11-09T08:00:00Z' --evidence "$EVIDENCE_DIGEST" --reason '双方确认收到付款'
kq federation --org "$ORG_ID" payments approve "$REVISION_ID" payment.json
kq federation --org "$ORG_ID" payments attach "$REVISION_ID" "$RECEIPT_ID" peer-payment.jws
kq federation --org "$ORG_ID" payments list "$REVISION_ID" --bill "$BILL_ID" --payment "$PAYMENT_ID"
kq federation --org "$ORG_ID" payments list "$REVISION_ID" --record "$RECEIPT_ID" --json
```

`PAYMENT_ID` 标识一笔外部付款，`RECEIPT_ID` 标识一次不可变声明；首次可省略 `--payment` 和 `--id` 生成新 UUID。更正时必须保留原 `--payment`，使用新的 `--id`；Server 补齐当前前驱和原账单摘要。`--amount` 是更正后的**完整金额**，不是差额，允许更正为 0；初始付款不得为 0。一次更正不会执行银行退款。不同真实分笔付款使用不同 paymentId。

`--occurred-at` 为外部发生时间，须为 ISO UTC 时间；不能晚于签署时间。`--evidence` 为双方受控材料的 SHA-256 摘要，CLI 不上传银行流水文件。金额始终为整数字符串，单位沿用合同。草稿只生成 0600 新文件，禁止覆盖；它不批准付款，也不能代替对方批准。

列表支持原账单、付款及单次凭证三个筛选条件，分别标明“待双方确认／当前确认／历史更正前值”、签署与本站存证。历史更正前金额不能与当前值相加。三种模式都在双方确认后保存付款事实；direct 不存证，attested/coordinated 异步存证，链故障不撤销付款声明。源机构没有本站链待办时显示“未同步”，不推断对端已完成上链。

写入超时、响应损坏或成功响应的机构／编号／正文不一致时，提示结果未确认，不自动重试。先用原 receiptId 查询，不能更换编号再次审批。签署只说明双方认可声明，平台不验证银行入账真实性。待签记录目前没有单方撤销或替换正文的命令。

付款扩展已有 60 项 CLI 命令文件测试通过（包含原财务、介质入口），以及实际 CLI 子进程 → loopback HTTP → 生产路由 → 隔离 PostgreSQL 验证：草稿不批准、机构切换／机器身份／独立权限拒绝、双签字节保留、按原编号查询、追加零额更正、旧附签重放不回退且预算不变。对端批准使用生产服务，身份由测试中间件注入，不等同正式登录或真实双平台付款运行检查。

## 范围与验证

财务入口覆盖上述操作；介质交付命令见下文，执行、市场、独立减免和争议命令仍待补齐。原生背书与私有数据规则继续由现有链码和 Adapter 实施。完整业务边界见[商业协议部署说明](../deploy/federation/fabric-commercial.md)。

25 项 HTTP 夹具和中间件测试覆盖机构断言、精确金额、三模式状态、原文/编号、独立权限、文件安全、重定向和未知响应；另通过实际 CLI 子进程、真实 loopback HTTP、生产商业路由与隔离 PostgreSQL 的联合测试，验证机构改变拒绝、独立审批权、人类身份限制以及政策创建/读取/撤销和原结算读取。联调身份由测试中间件注入，不代替正式登录链路或 PR 预览运行检查。本轮不重复 Fabric 或调度器运行检查。

调整扩展新增 8 项 CLI 场景，原附签测试同步覆盖调整；整个 CLI 命令测试文件 27 项通过，覆盖精确净额、三模式状态、草稿字段变化、机构/原文身份和原签名附加。新增实际 CLI 子进程 → loopback HTTP → 生产调整路由 → 隔离 PostgreSQL 验证：草稿 53 → 60，独立权限/机构与机器身份拒绝、单方批准占额 7、双签后 spent 60、重复附签不重扣。测试身份仍由夹具注入，不等同正式登录或 PR 预览运行检查。

退款扩展的 CLI 命令文件共 32 项通过，另有实际 CLI 子进程 → loopback HTTP → 生产路由 → 隔离 PostgreSQL 验证：生成不批准、原文/签名字节保留、全额归还、筛选缺失编号、重复附签不记账，以及机构切换/撤销权限拒绝。对端批准调用生产服务，取消事实来自签名数据库夹具；不等同真实多站点取消运行检查。


## 机构退款预授权

双方分别使用具有本机构 `settlement.approve` 的会话，复用 `federation closing policies grant <revision> <file>`。文件示例（到期时间须按实际授权填写）：

```json
{
  "kind": "refund",
  "outcomes": ["cancelled"],
  "maxAmount": "100",
  "maxTotalAmount": "1000",
  "maxRecords": 10,
  "validUntil": "2027-01-01T00:00:00Z"
}
```

本政策仅允许直接/异步合作中“永久取消且从未创建执行工作流”的完整额度归还；原账单/结算授权不包含退款。Server 自动生成和交换原退款，无须调用 `refunds draft/approve/attach`。双方必须各自授予；旧版本须先应用迁移 0155 并升级，见[机构预授权](../deploy/federation/fabric-commercial.md#执行前退款的机构预授权)。

`federation closing tasks list <revision>` 查看源方退款处理记录；修正权限或信任后，通过 `federation closing tasks retry <revision> refund <operationId>` 重试未完成原任务。列表中的 recordId 是 refundId，可交给 `federation refunds list <revision> --record <refundId>` 查询。撤销通过原 `closing policies revoke`；撤销不使已签原件失效，也不再次退额。`--json` 保留授权编号和精确金额。

## 加密介质导出与接收

`federation media exports` 管理本站来源包，`federation media imports` 管理本站收到的包。继续使用 `--org` 固定当前会话机构、`--lang zh|en` 和 `--json`；不要求运输台账的 `media.logistics` 权限。查看需要 `asset.read`，来源批准/运行需要 `media.export`，接收批准/运行需要 `media.import`；服务端仍检查原任务所有人、Agent 归属、签名信任、当前授权和期限。

任务输入或结果的 `export.json` 使用原委派 operationId，不能填 taskId、任意路径、对象 URL 或自定义文件清单：

```json
{
  "packageId": "11111111-1111-4111-8111-111111111111",
  "agreementRevisionId": "22222222-2222-4222-8222-222222222222",
  "recipientSiteId": "33333333-3333-4333-8333-333333333333",
  "kind": "task-input",
  "operationId": "44444444-4444-4444-8444-444444444444",
  "agentId": "local-storage-node",
  "expiresAt": "2026-12-01T00:05:00.000Z"
}
```

结果使用 `task-result`；共享数据集使用相同批准命令，正文改为原 `versionId`、`locationId`，省略 kind/operationId/agentId。示例编号与期限必须替换为实际值。批准只保存许可，运行才请求 Agent 生成密文：

```sh
kq federation --org "$ORG_ID" media exports approve export.json
kq federation --org "$ORG_ID" media exports run "$PACKAGE_ID"
kq federation --org "$ORG_ID" media exports status "$PACKAGE_ID"
kq federation --org "$ORG_ID" media exports manifest "$PACKAGE_ID" registration.json
```

`manifest` 将原签名和 senderSiteId 保存为接收端可用的登记 JSON，以 0600 新建并拒绝覆盖；不导出包密钥、对象键或下载地址。Agent 生成的密文仍按[介质部署约定](../deploy/federation/README.md)搬运到接收方 inbox，登记 JSON 本身不包含文件内容。

在接收方登录后操作：

```sh
kq federation --org "$ORG_ID" media imports register registration.json
kq federation --org "$ORG_ID" media imports approve "$PACKAGE_ID" import.json
kq federation --org "$ORG_ID" media imports run "$PACKAGE_ID" "$AUTHORIZATION_ID"
kq federation --org "$ORG_ID" media imports status "$PACKAGE_ID" "$AUTHORIZATION_ID"
kq federation --org "$ORG_ID" media imports receipt "$PACKAGE_ID" "$AUTHORIZATION_ID"
```

`import.json` 包含 authorizationId、agentId、managedRootId、maxBytes、expiresAt；必须使用接收机构的受管根和足够的字节上限。登记不会自动批准，批准不会自动启动。`status` 文本中的 `verified-private` 仅表示私有解密与文件校验完成，JSON 保留原 API 状态 `verified`；不能当作任务发布或作业完成。任务包之后由后台沿原 import 上传、独立验证并发布；共享数据集仍须独立使用授权和发布。

来源可用 `exports receipts <packageId>` 查看对方私有导入的原签名和本站确认，支持 `--limit`、`--offset`。

`exports list` / `imports list` 支持 `--limit`、`--offset`；`show <packageId>` 查看详细记录，接收方 `show` 另支持 `--authorization-offset`，以免遗漏超过一页的批准。撤销使用包含必填 `reason` 的 JSON：

```sh
kq federation --org "$ORG_ID" media exports revoke "$PACKAGE_ID" reason.json
kq federation --org "$ORG_ID" media imports revoke "$PACKAGE_ID" reason.json
kq federation --org "$ORG_ID" media imports revoke-authorization "$PACKAGE_ID" "$AUTHORIZATION_ID" reason.json
kq federation --org "$ORG_ID" media imports retry-receipt "$PACKAGE_ID" "$AUTHORIZATION_ID"
```

回执重试只投递原私有导入证明，不批准数据使用，也不重新导入文件。所有写操作均不自动重试；响应未知时先查询原包、批准和操作，不更换编号。完整实际 CLI/双平台运行检查沿用[私有任务介质实验](../deploy/federation/execution-lab.md#私有任务文件的双向介质交付)。
