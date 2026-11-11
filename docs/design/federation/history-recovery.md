# 晚到商业存证的历史恢复

本轮为研发候选，尚未在真实多机构／Fabric 部署验收。适用 `bilateral_attested` 已发生且本站有可核对业务事实、原存证尚未成功的记录。直接合作不新增链依赖；协调交易必须恢复原交易，不能改走本协议。

## 当前双签确认历史事实

普通存证继续检查当前业务信任。原签名密钥退休、有效期结束或原政策后来撤销时，不放宽原入口；A/B 另用当前有效且具有 `commercial-history-recovery` 用途的密钥，分别批准同一 `commercial-history-recovery` 正文。正文绑定恢复编号、原合同／域、双方、原操作、原记录编号、原正文摘要和完整原提交的规范化 SHA-256，并明确断言 `acknowledge-original-record`。

原 JWS 和提交原件保留。历史公钥只用于验证原签名的数学完整性和各原件的关联，不重新激活退休密钥，也不证明当时的真实计算或科研结论。新归档的授权来自当前双方明确批准；旧合同、原任务或被撤销政策不会因新签名获得执行权。

支持原合同、用量、减免、账单、结算、调整、退款、付款、双边冻结证明、双边和解和仲裁执行原件。各类型按原 schema 验签及校验编号、摘要、双方、合同和相关引用；不能将任意附件标成已发生的业务。Server 还要求本站存在匹配事实，例如结算／调整已经应用、付款已确认或和解已完成。

## 原交易与新归档分开

| 对象 | 行为 |
| --- | --- |
| 原业务提交 | 原编号、签名和历史尝试保留；不改写为另一笔业务成功 |
| 当前双签归档 | 新 `recoveryId`，操作 `record-historical-commercial`，链方法 `RecordHistoricalCommercial` |
| 链私有存储 | 仅 `historical-commercial` 与 `historical-commercial-original` 归档键，仍在原 A/B PDC |
| 业务状态 | 不写预算、结算／调整 head、任务冻结或执行 gate，不产生新作业或再次入账 |
| 查询收据 | 新 `historical-commercial` 收据仅证明归档提交，不能满足原业务收据查询 |

存在有效租约、原提案仍在途、交易结果未知或已成功提交时，拒绝切换恢复协议。先使用原 Adapter 配置、恢复密钥和 transactionId 完成原交易核对；只有确定 INVALID／abandoned 或尚未发送且无在途尝试，才允许批准历史归档。后台不会用重签消除未知交易。

## 页面与跨站交接

商业合同的存证明细提供历史恢复草稿、独立确认、原件导出、对方签名关联及恢复状态；合同存证入口可导入对方恢复文件。文件包含恢复正文、已批准的机构 JWS 和完整原提交，含商业敏感信息，应仅交给原对方。页面核对合同、域、A/B、摘要和原编号，手机只读，机构／身份切换关闭写入确认，未知响应保留原意图。

接收方在自己的活动机构中导入并独立批准。它必须已经持有匹配业务事实，不能靠上传文件创建账务。若本站原本没有对应存证队列，导入只建立 `closed/HISTORY_ARCHIVE_ONLY` 原件；不完整批准仍仅留下归档。业务状态查询、重试与后台处理排除该标记，不能将它复活成可执行原业务。

人员接口前缀 `/api/federation/commercial-agreements/:revisionId`：

| 接口 | 用途 |
| --- | --- |
| `GET /submissions/:submissionId/history-recovery` | 查询恢复正文、批准与独立归档交易状态 |
| `POST /submissions/:submissionId/history-recovery/draft` | 用固定恢复编号和理由生成草稿 |
| `POST /submissions/:submissionId/history-recovery` | 本站人员批准同文正文 |
| `POST /submissions/:submissionId/history-recovery/counterparty` | 核验并关联对方当前原签名 |
| `POST /history-recovery/import` | 核对对方文件、本站事实并建立本站恢复记录 |
| `POST /submissions/:submissionId/history-recovery/reauthorize` | 当前密钥重新批准原恢复正文，严格空对象 |

需要真人会话、活动机构和独立 `attestation.recover`；一般合同批准或平台角色不隐含此权。查看原商业合同继续受其读取边界限制，所有响应 `no-store`。两端需明确授予机构密钥新用途，链端也必须登记；只配 Server 不代表 Peer 已信任。

## 密钥轮换后的重新批准

归档本身尚未成功且签名后来失效时，可显式重新批准同一恢复正文。旧批准、对方原签名、批准人员、时间及关联交易编号追加到批准历史，清除当前对方批准，再取得对方对同一正文的当前有效签名。保留原恢复编号和摘要，不覆盖原业务或已有交易尝试。

归档已提交、租约有效或归档 transactionId 仍未知时拒绝重新批准；确定旧尝试无效后才能恢复原队列。页面仅在服务端返回 `canReauthorize` 时提供确认。重新批准不是自动轮换，也不替对方签署；对方暂不可达时继续等待。

## 同代际信任追加与升级边界

商业链新增显式 `UpdateTrust(previousDigest,nextDigest)`，允许同一代际追加业务公钥或签署用途。必须保留旧 key 的 PEM／有效期、已有用途、机构 site/MSP 映射及 domain/PDC；已撤销 key 不重新激活。交易由前配置中的 trust-admin 提交，原 ConfigKey 的全组织原生背书策略约束整笔更新，并保存旧配置与前后摘要的不可变回执。精确重放只返回原回执，不回滚后续配置。

升级前先用原配置完成未知交易恢复；之后各机构单独审查 Server 信任、商业 CCAAS 配置及显式链更新。Adapter 检查点继续绑定整份配置，不能通过更换恢复密钥跳过旧交易。离线管理工具核对经批准 next 文件的 SHA-256 和原 package ID，固定 constructor，不代批准。命令和标准字节生成见[商业链同代际信任追加](../../../deploy/federation/deployment.md#商业链同代际信任追加)。

这不是成员／PDC 迁移或跨代际历史重建入口，也不解决宿主存储容量、隐私删除或旧公钥已经丢失的问题。生成迁移 0204／0205 后再启用服务，保留原配置、公钥、恢复密钥、检查点和证据备份。真实多 Peer 背书、密钥轮换、断链及跨站导入仍须现场验收；单元、命令夹具或数据库验证不替代这些证据。
