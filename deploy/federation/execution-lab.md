# 真实链与双平台执行验收

`bun run test:fabric:execution` 在同一台专用 k3s 测试节点上启动三个 Fabric 机构、四个生产 Adapter、两个独立 Server/PostgreSQL 数据库、两个 Agent 及两份独立对象存储。它禁用 `.env` 自动读取，不使用部署环境的账号、数据库或存储配置；测试开发登录的 HTTP 入口只监听 loopback，Agent 使用单独的 mTLS 入口。机构、合同、模板映射及受限执行账号由夹具预先批准；商业合同和预留的对方签名由生产 worker 经 mTLS 自动取得，夹具不复制这两类对签；双边重复商业提交若发生 MVCC 冲突，夹具只在另一方精确同文意图已有 VALID 区块回执时执行一次授权复核，保留 INVALID 历史，其他错误直接失败；市场操作和确认由生产 Server worker 提交，跨平台委派与材料交换走真实 mTLS 通道。

这是一台机器上的机构模拟，不是独立机构信任验收。脚本执行真实的 Bash 文件计算，不安装 Spack 软件；不覆盖 Slurm/PBS、自动商务握手、普通源站 Workflow 动态调用、科研结果正确性验收或银行付款。成功/Workflow 场景追加真实 Kubernetes 运行时长、签名用量传输、账单与结算的独立机构预授权、自动生成/批准/对签和断链恢复验收。原生链码背书/PDC 隔离与竞态另见 [gate 检查](fabric-execution-gate.md)。

## 运行条件

- 专用 Linux x86_64 单节点 k3s，root，当前 kubectl context 指向本节点；InternalIP 必须能在本机绑定，Pod IP 可从本机访问。使用现有 `local-path` StorageClass。
- 已安装本仓库依赖，提供 Bun、Node、Python 3、OpenSSL、runuser、kubectl、k3s；不使用 Docker。
- 已验证的 Fabric 3.1.5 release 目录；PostgreSQL 16 的 `initdb`、`pg_ctl`、`createdb` 以及对应库/共享文件。
- 预先缓存脚本中固定摘要的 scheduler、Bash OCI runtime、RustFS 和 rc 镜像（`imagePullPolicy: Never`），不在运行中下载或改变镜像。
- Agent 和存储 Pod 有 CPU/内存上限，计算节点只请求 1 CPU、128 MiB；成功场景生产者额外 `sleep 1`，使 Kubernetes 秒级时间戳能记录非零时长；故障场景使用 `sleep`，不跑编译或计算密集任务。仍须预留两份 Server、PostgreSQL 与三个 Fabric Peer 的内存。
- 不与全仓编译或类型检查并行运行。脚本在业务提交前等待连续三次 Agent CPU 低于 80%；此检查不改变生产调度器负载保护，后续负载再次升高仍可能拒绝派发。

```bash
export KQ_FEDERATION_EXECUTION_LAB=1
export KQ_FABRIC_TOOLS=/opt/test-tools/fabric-3.1.5
export KQ_FEDERATION_PG_BIN=/usr/lib/postgresql/16/bin
# 标准系统安装通常不需要以下两项；提取安装时指定对应路径。
export KQ_FEDERATION_PG_SHARE=/usr/share/postgresql/16
export KQ_FEDERATION_PG_LIB=/opt/test-tools/postgresql/lib
export KQ_FABRIC_KEEP_ARTIFACTS=1
bun run test:fabric:execution
```

默认依次执行成功及断链场景；主动停止场景单独选择 `stop`。只复验某一项可设置 `KQ_FEDERATION_LAB_SCENARIO=success`、`outage` 或 `stop`。此入口显式 opt-in，不加入普通单元测试或未配置 k3s 的 GitHub runner。它只停止自己创建的 Orderer，不按进程名称终止系统服务。

## 断言与证据

| 场景 | 实际检查 |
| --- | --- |
| 成功 | 商业合同与预留签名自动交换完成（每站各两项），双方合同与私有预留 committed，源站发布/提供方认领/激活及双方执行确认均有 VALID 交易；重复 HTTP 委派只生成一份预留、一个 Workflow、两个 Job |
| 材料与执行 | 提供方初始没有输入或环境清单，按签名摘要取回；两个真实 Kubernetes Script 节点输出 `42` → `verified:42`；非 root、seccomp、NoNewPrivs 与禁网执行 |
| 返回 | Persistent 结果经独立源站 Agent 复制并实读校验，登记为带版本云盘文件；下载得到准确的 12 字节/SHA-256，取得对端签名回执；Checkpoint 不披露，重复导入不新增文件 |
| 断链 | 读取 Pod 中实际 sleep 进程后停 Orderer（沙箱 stdout 在任务结束后才发布）；等待原 VALID 确认的真实期限，不篡改时间或签名；到期 10 秒内观察到 Job 删除请求，经过 Pod 声明的终止宽限期（最多 30 秒）及额外 30 秒状态回收时间后确认 Job/Pod 停止，下游不派发、不产出文件 |
| 主动停止 | 确认真实 sleep 正在运行且原 VALID 余期超过 120 秒，停 Orderer 后两次调用提供方停止 HTTP；请求幂等，20 秒内发起调度器停止，经过真实终止宽限后在原 VALID 到期前确认 Job/Pod 停止，本地授权返回 CANCELLATION_REQUESTED；恢复 Orderer 后原停止意图取得 VALID、需求变为 STOPPING，私有 gate 不变、旧作业不重启 |
| 终态关闭（成功场景） | 作业提交前双方通过 API 分别预授权仅 completed 结果；提供方后台从真实 Job 自动归集并签署终态，源方后台经 mTLS 分块取得材料，以本地结果导入及签名回执独立复核并自动签署，随后后台自动回传对签并核验提供方签名 ACK；生产 worker 自动提交私有终态和公共关闭，两端分别查询 CLOSED 与一致的 TERMINAL gate 哈希；两边终态关联各自授权 ID，本地重新执行被拒绝 |
| 账单（成功/Workflow 场景） | 独立读取真实 Pod 容器起止时间核对 job.elapsed；提供方自动签署用量并经 mTLS 传给需求方。停 Orderer 后双方通过 HTTP 各自配置仅 completed、单笔/累计不超过原预留且仅一次的账单政策，生产后台生成唯一原文、分别批准并交换原签名，链待办保持 pending；恢复 Orderer 后原待办取得唯一 VALID 回执。两边授权来源/批准次数/金额与同文签名一致，终态 gate 与资金余额不因确认账单而改变 |
| 独立额度结算（成功/Workflow 场景） | 停 Orderer 后双方另授独立结算政策，后台生成绑定原账单/终态的同一结算并自动批准；mTLS 原签名交换完成时两端 appliedAt 仍为空、名额未释放。恢复后原待办均取得 VALID 才处理本地名额；原预留金额不变，没有本地链预算，终态 gate 与 CLOSED 需求及 Job 不变。另用 Node Gateway 读取实际私有 block events，核验双方所记交易确为 VALID、原预算只扣用一次、同文重放不再改预算、第三机构无私有结算内容 |
| 结算后调整（成功/Workflow 场景） | 原净额 → 0 → 原净额，两次独立人工批准同文草稿，后台经 mTLS 自动交换原签名。停 Orderer 等双方持久保存已背书交易后，首次调整强制结束两边 Server 与商业 Adapter，使用原数据库和密钥重启；原提交编号、交易 ID 和恢复检查点不变。恢复 Orderer 后双方各自 VALID 才应用净额；重复批准不再次记账，第二次调整绑定第一笔回执。独立私有区块检查预算和调整索引各更新一次，同文重放只保留原记录，原账单/结算/预留/gate 不改写，C 无私有正文 |
| 锁额 | 两边数据库都不生成本地预算；断链/期限到达不改变 ACTIVE 需求与原私有 gate 哈希；恢复 Orderer 不重启终态作业 |

运行打印私有证据目录 `temp/federation-execution-{success,outage,stop}-*`。成功场景另保存 `approval-exchange.json`（双方合同及预留签名交换进度）、`terminal-evidence.json`（双方签名、源方复核、自动交换回执及两次链上交易回执）；`terminal-policies.json` 保存提交作业前的两份机构预授权；终态阶段不调用人工批准/对签 API，归集、独立复核、双签和回传全部由生产后台完成。合同、预留与执行准入仍由夹具显式批准，尚不是完整无人值守商务握手。`billing-offline-evidence.json` 保存原 Pod 观测、用量及两端账单/交换状态，`billing-committed-evidence.json` 保存恢复后的原提交与 VALID 回执；`bill-automatic-policies.json` 保存双方独立政策、各一次的批准计数和提供方完成待办；不调用账单草稿、批准或手工附签 API。`settlement-offline-evidence.json` 与双方 `settlement-offline` 状态保存断链期间的结算同意和未释放名额，`settlement-committed-evidence.json` 保存原待办、双方 VALID 尝试及本地处理状态；`settlement-private-ledger.json` 由独立 Node Gateway 读取真实区块生成，证明预算单次扣用及机构隔离。`settlement-automatic-policies.json` 同样核对独立政策授权；不调用结算草稿、批准或手工附签 API。为隔离断链检查，本场景在作业结束后才启用账单与结算政策，验证历史待办自动发现和收尾，不覆盖任务开始前配置政策的完整长期运行。`appliedAt` 不代表付款。`source/provider-before/after.json` 保存公开意图、交易 ID、验证码、区块号、预留和作业关联；`result-delivery-evidence.json` 保存结果摘要与版本；`running-process.txt` 与 `provider-running.json` 保存断链前的进程和确认，`outage-evidence.json` 保存停止请求时间、终止宽限期及实际 Job/Pod/Workflow 状态。主动停止另保存 `stop-api.json`、`stop-evidence.json` 与双方 `stop-recovery.json`；该场景与自然到期断链场景分别验收。不存在的场景文件不代表通过；以进程退出码和该场景全部断言为准。

目录权限为 0700、文件默认 0600；完整 Server/Agent 日志与本机 Fabric 的测试身份仅供本地排查，不上传 CI artifact 或纳入 Git。导出证据必须另行筛除内部路径、测试签名与存储信息。

每个场景在 `finally` 关闭自建进程、停止自建 PostgreSQL、删除随机 namespace/RBAC/seccomp 文件及私钥。清理失败会报错并保留私有目录；SIGKILL 或主机断电无法保证 finally，须根据保留日志中的随机资源名人工清理。测试未完成前不要移除这些目录，也不要把已清理的测试链视为结算成功。

## 调整进程恢复证据

成功与 Workflow 场景新增 `adjustment-1/2-offline-evidence.json`、`adjustment-1/2-committed-evidence.json` 和双方同名前缀的数据库快照。首次调整另有 `adjustment-crash-recovery.json`，保存本次自建进程的退出状态、新旧 PID 和恢复检查点摘要，不导出可恢复签名交易的原始密文。检查点摘要仅用于比较字节是否改变，不作为业务签名或安全凭证。

`adjustment-1/2-private-ledger.json` 与原结算的证明一样，直接读取 A/B/C 实际区块及私有写集，核验 Server 持久化的交易 ID、VALID 验证码和区块号。两站同时提交同文记录可能先出现 MVCC 冲突；生产 worker 只有核对原不可变回执后才继续，不由测试清租约、改时间或新建提交绕过。进程恢复使用原 `live-recovery.key`；密钥丢失不是本用例所覆盖的可恢复条件。

此处的费用调整是账面净额变更，不是银行付款或退款。调整须经双方独立人员批准；本用例不将原签名自动交换称为自动商务批准。只有整条命令成功、上述证据均存在且断言通过，才能记为该场景通过；仍不代表长期无人值守、Slurm/PBS、旧链升级或完整 PR 预览已验收。

## 链协调付款恢复证据

协调模式 success／workflow 财务验收使用 paid 合同，在真实执行终态、原账单／结算和账务调整之后追加付款与零额更正。每次付款前停止 Orderer，两端独立审批及原签名交换后，确认时间和 current 必须已保存，只有提供方创建待存证记录；付款不等待链，也不代表另一次额度结算。

每条付款待办需保存已背书的 transaction 检查点。第一笔再 SIGKILL 两端 Server 和商业 Adapter，以原状态恢复，确认原付款事实、待办编号、交易 ID、检查点摘要及执行 gate 不变。恢复 Orderer 后等待原提供方记录 VALID，然后才进入下一条更正；客户端不手工附签、换业务编号或清租约。

两端 `payment-1/2-offline.json`、`payment-1/2-committed.json` 与 `payment-crash-recovery.json` 保存恢复核对；`payment-1/2-committed-evidence.json`、`payment-1/2-private-ledger.json` 保存原付款和独立区块检查。每笔付款只有一笔提供方 VALID，A/B 只能出现对应 receipt/head 写入，预算、原账单、结算、预留和 gate 不得改变；C 不得收到私有正文。整体声明原件保存在 `coordinated-payments.json`，仍使用合成外部证明，不执行银行转账。只有完整入口及 Node Gateway 私有写集断言均通过，才能记为本场景验收完成。

## 无链双边合作验收

设置本页的 `KQ_FEDERATION_EXECUTION_LAB` 与 PostgreSQL 工具路径后，运行：

```bash
bun run test:federation:direct
```

此入口生成两家机构的临时业务身份，启动独立 Server/数据库、真实 Kubernetes Agent 和对象存储，复用轻量文件工作流；不需要 Fabric 工具目录，不启动 Peer、Orderer 或 Adapter。启动子进程前移除继承的链配置，Server 仅获得普通联邦 mTLS 配置，没有商业、市场或存证 Adapter socket。运行前仍需确认本机 k3s 可用于隔离实验，且没有并行全仓编译。

双方独立批准执行协议与商业合同，原签名由生产后台自动交换；账单和结算政策通过 HTTP 在提交任务前分别授予，固定合同、结果、单笔/累计上限和次数。重复委派仍只执行一份工作流，真实材料与结果传输沿用成功场景的 SHA-256/版本/回执检查。后台签署用量并自动生成、双签账单及结算，核对 Pod 实测时长、政策批准次数和本地额度守恒。随后两次独立人工调整验证减额、增额占额、同文交换和历史重放，不把调整称为自动商务批准。

所有检查点要求市场/商业提交、链交易尝试、存证 outbox 和证据批次为空；提供方本地预算 `available + reserved + spent` 恒等于原限额，需求方不复制提供方可花费余额。结算后重复批准不再次改账；调减和调增不改写原账单/结算或重复执行作业。

直接模式成功路径还会用原已确认账单生成两份付款声明：首次确认和零额更正。双方通过生产 HTTP 独立批准，原签名由后台经 mTLS 自动交换，不手工搬运对签；单方批准保持未确认。更正后重放首次声明不得回退当前记录，付款前后分别比较预算、原账单、结算、调整和实际 Job 身份／状态，确认均未改变。测试使用明确标注的合成外部凭据及其 SHA-256，不执行银行转账；此处尚不覆盖异步／链协调付款。

私有目录为 `temp/federation-execution-direct-*`，新增 `preauthorized-closing.json` 保存提交前政策，`bilateral-settlement.json`、`bilateral-adjustment-1/2.json` 保存同文账务记录，双方对应快照保存实际额度和空链待办；`bilateral-payments.json`、`payment-evidence.txt` 和双方 `payment-before/after.json` 保存付款更正与不改账证据。仍保留原文件工作流证据，脚本退出时清理自建服务、namespace、数据库和临时身份。只有命令退出 0 且完整断言通过才算本场景验收成功；它不证明异步存证恢复、跨 Slurm/PBS 全矩阵、真实软件离线安装或 PR 预览已完成。

## 三站证据字段交付验收

在相同专用 k3s／PostgreSQL 条件下运行：

```bash
KQ_FEDERATION_LAB_DISCLOSURE=1 bun run test:federation:direct
```

此选项沿用轻量文件作业、真实结果回传及自动账单／结算，跳过付款和账务调整实验。随后启动第三个完整 Server R，使用独立数据库、业务密钥、mTLS 客户端证书与开发登录会话；R 不启动 Agent，也不配置 Fabric。三个数据库属于同一临时 PostgreSQL 实例，各 Server 的 `DATABASE_URL` 不同。机构信任和人员权限由夹具初始化，案件、政策、材料批准、接收与撤销全部走生产 HTTP；双方原签名通过生产 worker 自动交换，夹具不搬运业务签名。

A 发起实际账单争议，A/B 分别批准只含 `dueAmount` 的披露，R 经真实 mTLS 获取双边当前许可和四份原 JWS。断言包括单方批准拒绝、精确字段值、重复导入不重复保存、R 强制退出后的原状态恢复、B 网关离线时不得返回缓存、A/B 分别撤销后拒绝读取和重新导入。独立读取三库，比较收到的原件与源端批准原件；R 不得得到原合同／账单或作业，A/B 的资金和执行状态不得因材料交付改变。

私有证据新增 `three-server-disclosure.json`、`recipient-disclosure-originals.json` 和双方 `disclosure-before/after.json`。只有命令退出 0、全部断言完成且清理成功才算通过。这是同机三 Server／三数据库的生产协议验证，不是正式多机构身份、A/B/R 私有集合、主动撤权推送或仲裁验收；远端撤销仍受短期许可观察窗口约束，不能追回已交付明文。

## 异步存证断链验收

使用本页真实 Fabric/PostgreSQL 工具配置，通过以下模式运行：

```bash
KQ_FEDERATION_LAB_MODE=bilateral_attested \
KQ_FEDERATION_LAB_SCENARIO=success \
bun run test:fabric:execution
```

该场景部署商业与证据链码及相应 Adapter，不部署市场链码，不签发链协调执行许可。两种私有集合各自限制 A/B 成员访问并要求 A/B 原生背书，C 保留为非成员观测者。商业域与接单证据域在夹具中显式对齐；一般部署仍应按双方认可的域配置，不临时扩大集合。

Orderer 在启动 Server 前停止。双方此时完成执行/商业协议交换、提交前账单和结算预授权，再运行真实轻量文件工作流、返回结果、交换用量、自动账单/结算、两笔人工调整及付款／零额更正。成功财务场景显式使用 paid 合同，其他场景仍默认 exchange。工作和本地额度不得等待链，商业待办和接单证据必须保持 pending，不能伪造 anchored。检查实际本地金额及原不可变签名，不调用复核重试 API、不清租约或改数据库时间。

付款双签完成后，在排序服务仍停止时强制终止两端 Server 和商业 Adapter，以原数据库、配置与恢复密钥启动。恢复 Orderer 后核对原九条商业提交（双方合同、提供方用量/账单/结算/两次调整/付款及更正）及两条接单凭证。待办编号、已保存的交易检查点、所有本地账务及已完成 Job 均保持；批次序号连续、重复记录不能入链两次。独立 Node Gateway 再检查 A/B/C 的实际区块与 PDC：原记录正文/签名对应、交易 VALID、C 无私有内容，商业链上没有预算、预留或执行 gate 写入，避免把异步存证变成第二套可花费余额。

证据目录为 `temp/federation-execution-attested-*`。`attested-offline-api.json` 与双方 `attested-offline.json` 保存链停止期间状态；`attested-recovered-api.json` 与双方 `attested-recovered.json` 保存恢复结果；`attested-private-ledger.json` 保存独立区块检查摘要；`bilateral-payments.json` 保存付款原件，`payment-crash-recovery.json` 保存自建进程的恢复证据。付款交易仅能写入对应的 payment／payment-head，不得修改其他私有业务记录。签名和内部日志仍只放受限忽略目录，不能上传公共 CI artifact。只有整条命令退出 0 且所有断言通过才记为此场景完成；其他中断、容量、归档与正式预览仍按各自验收项检查。

## 执行前取消与退款验收

沿用本页工具与隔离环境配置，选择 `refund`：

```bash
KQ_FEDERATION_LAB_SCENARIO=refund bun run test:federation:direct

KQ_FEDERATION_LAB_MODE=bilateral_attested \
KQ_FEDERATION_LAB_SCENARIO=refund \
bun run test:fabric:execution
```

两端使用独立 Server/数据库和真实 mTLS，先完成执行协议与商业合同交换。协议交换后暂停源方自建 mTLS 入口，使材料暂时不可达；源方仍持有提交所需的完整材料，提供方真实接单占额后进入 `DATA_WAITING`；通过源方 HTTP 请求永久取消，等待提供方签名停止回执，再恢复源方入口。双方再分别通过 HTTP 批准同一退款，后台自动交换原签名。测试不调用附签来完成首次退款；完成后才重放批准/附签，检查仍为原记录，换退款编号遭拒。核对提供方预算全额归还、源方原占额净额为零、无第二套可花费余额，以及两边没有创建执行 Workflow、Job、用量账单或结算。

异步模式从 Server 启动前停 Orderer，本地退款完成时原存证待办仍为 pending。合同及接单存证保存已背书检查点后，强制结束并重启两端自建 Server 与商业 Adapter，沿用原数据库和密钥。恢复 Orderer 后核对双方原合同及提供方原退款共三条商业提交取得 VALID，两条接单证据按原序列上链；恢复不得改变退款签名、已应用时间或本地额度。独立 Gateway 读取真实 A/B/C 区块，检查私有退款原文及两个唯一索引，A/B 可见、C 不可见，公共区块不含原文，链上没有预算、预留或执行许可写入。

证据保存在上述 direct/attested 私有目录，新增 `refund-waiting.json`、`refund-evidence.json` 及双方 `refund-reserved`、`refund-applied` 快照。异步场景继续生成 `attested-offline`、`attested-recovered` 和 `attested-private-ledger.json`，另有 `refund-crash-recovery.json` 保存本轮自建进程退出码和新旧 PID。只有命令退出 0 且全部断言通过才算完成；本项不运行计算作业，不证明科研软件、满盘容量回收、自动退款批准政策、跨主机机构信任或正式 PR 登录验收。


## 机构自动退款验收

在本页既有隔离工具环境中选择 `KQ_FEDERATION_LAB_SCENARIO=refund-auto`，分别运行 `bun run test:federation:direct`，以及带 `KQ_FEDERATION_LAB_MODE=bilateral_attested` 的 `bun run test:fabric:execution`。

此变体保留原 `refund` 手工批准场景，复用真实材料等待、HTTP 取消和永久停止回执。提交委派前，两站通过 HTTP 分别配置有限退款政策；此后不调用退款草稿、批准或附签接口。生产后台自动发现取消、生成原件并双签归还，检查各政策只批准一次、记录保留正确授权编号、源方处理任务指向原 operationId/refundId。完成后撤销政策并检查已完成任务拒绝重试、金额与原件不变。新增私有证据 `refund-automatic-policies.json`，不上传 CI artifact。

异步变体继续验证 Orderer 停机期间本地完成，强制中断两站 Server 与商业 Adapter 后以原数据库/密钥恢复，并通过独立 Gateway 核对原交易/PDC 和非成员隔离。此场景不执行科研软件，不证明真实银行退款或正式 PR 预览；整条命令和完整断言通过后才可登记验收结果。


## 满盘后的取消与退款收尾

在 `refund-auto` 上设置 `KQ_FEDERATION_LAB_DISK_PRESSURE=1`：

```bash
KQ_FEDERATION_LAB_SCENARIO=refund-auto \
KQ_FEDERATION_LAB_DISK_PRESSURE=1 \
bun run test:federation:direct
```

异步存证使用同样两个变量，加 `KQ_FEDERATION_LAB_MODE=bilateral_attested` 运行 `bun run test:fabric:execution`。沿用本页显式隔离实验 opt-in 和 PostgreSQL/Fabric 工具配置，不读取部署凭据。

测试在私有 mount namespace 中挂载独立 1 GiB ext4 文件系统。两站独立数据库在同一测试 PostgreSQL 实例内，数据与 WAL 共用该实验文件系统；两站各拥有一份 64 MiB 物理预留与独立的逻辑收尾政策，每任务占额 16 MiB。控制文件、签名报告和日志在文件系统外。配置调用生产服务，周期性 observer 发布真实文件系统签名报告，实际 Server 加载 storage guard 并运行容量回收 worker。

在原委派已接单、等待材料时暂停提供方网关，源方通过 HTTP 持久保存取消意图；随后强制结束两端 Server。只对自建文件系统写入有大小上限的填充文件，要求实际 ENOSPC 和 PostgreSQL SQLSTATE 53100。测试通过生产 reserve CLI 显式释放两份预留，立即停止并重启原 PostgreSQL，再启动原 Server 和网关；不删除填充文件、不清队列租约、不改原记录或加快后台时间。此处模拟有权运维人员释放缓冲，不声称自动 reserve controller 已完成联合验证。

后台须恢复原取消签名、接收永久停止回执、自动双签退款、各自一次性释放逻辑占额。异步提供方须等原退款 VALID 与接单证据上链后才能回收；两种模式都检查原占额身份/摘要/分配字节及取消签名摘要不变。填充文件在整个业务收尾期间保留。此时新委派 HTTP 应返回 503/STORAGE_PRESSURE；仅删除填充文件仍不能恢复接收，明确 restore 物理预留后 storage guard 才能恢复健康。

新增 `storage-crash-recovery.json`、`storage-cancellation-intent.json` 和双方 `storage-before/closed/restored.json` 私有证据。最终清理包括停止 observer、卸载自建磁盘及删除镜像；清理无法确认时保留诊断，不删除可能仍使用的镜像。只有完整入口退出 0 才算该场景通过。它不覆盖运行中的科学任务、结果正文满盘、独立 WAL/Peer 卷、跨主机数据库、全负载容量估算或完整 O01。


## 双平台介质交付与来源撤权

沿用本页独立 PostgreSQL 和本机 k3s 配置，增加官方固定摘要的 age 1.3.2 工具目录：

```bash
KQ_FEDERATION_LAB_SCENARIO=media \
KQ_MEDIA_AGE_BIN=/absolute/path/to/age \
PYTHONDONTWRITEBYTECODE=1 \
bun run test:federation:direct
```

该入口复用两个独立生产 Server、数据库、mTLS 网关与分别注册的 Agent，不连接已部署平台，也不启动 Fabric。初始数据集、元数据、披露许可与操作人员能力为显式实验夹具；导出批准、排队、导入批准、发布、来源使用审批和撤权走实际 HTTP，Agent 通过真实信道获取短期授权，密钥通过机构间 mTLS 独立交付。每个 Server 使用独立临时密钥加密配置，每个 Agent 使用独立介质和数据根。

实验仅传输 4 字节合成内容。密文从来源 Agent 经运行器复制到接收 Agent inbox，模拟人工搬运加密包，不称为真实硬盘邮寄；不把明文复制到接收站替代解密。断言导出/导入、双端密文摘要、实际明文字节、独立签名回执、导入不自动发布、发布幂等、接收版本的 SHA-256/许可证/provenance，以及来源撤权后后台续租不再允许使用。撤权保留已导入文件和历史回执，删除生命周期另行验收。

结果保存为私有 `media-evidence.json`，必须整条命令退出 0 且全部断言通过才记为通过。本场景没有提交计算任务，不证明 DATA_WAITING 恢复、持续运行停止、真实多主机或物理物流；现有 Kubernetes 文件工作流夹具不能代替受限数据要求的签名生态脚本和 SIF 执行配置。相关 Slurm/PBS 组件实验见[导入数据执行](media-slurm-lab.md)。

2026-11-09：该场景真实通过。首次联调发现并修复来源协议关联错误；修复后的单次完整运行通过，源端无计算预算，双方原预算不变、无计算及账务任务。来源撤权在原短期许可到期后生效，当前续租失败显示 RENEWAL_FAILED，不冒充即时签名撤权。


### 介质交付后的真实 Slurm 执行

当前 trusted wrapper 已强制核对逐作业限额；旧 Slurm 19 缓存未启用 cgroup，必须完成现代 Slurm v2 配置后才可复验。以下历史结果不证明新入口已通过。

在上述 `media` 场景增加 `KQ_MEDIA_EXECUTION=slurm` 和 `KQ_MEDIA_RUNTIME_DIR=/absolute/path/to/runtime`。
运行目录需包含[组件实验](media-slurm-lab.md)相同的 Apptainer 1.4.3 主包、setuid 包及 Bash SIF。
运行器核验安装包固定摘要，在自建目录生成临时密钥、签署 SIF、离线验证并删除私钥；
接收节点导入公钥并实际检查签名镜像可运行、未签名镜像被 ECL 拒绝。
仅在一次性 privileged Pod 内安装运行库和 setuid 工具，限制 1 CPU/1 GiB；该限制不是生产逐作业 cgroup 证明。

脚本通过真实 Ecosystem Release 签名导入，在两个独立数据库激活。
先提交缺少接收副本的委派，断言 DATA_WAITING 且没有 Job；完成加密交付、来源使用批准及显式发布后，
设置本地 `use` 权限夹具，并通过映射 API 关联接收版本。
本地操作员及服务身份的授权是显式测试夹具，不代表已完成服务身份的数据授权管理界面。
生产后台自动启动映射账号下的 Slurm 作业，读取只读导入数据，检查 seccomp、no-new-privs 和创建 socket 被拒绝，随后 sleep。
通过来源 HTTP 撤销使用政策，等待短期来源许可失效，再核验原调度器 Job 为 CANCELLED、进程消失，且 Agent 保存正向停止证明。
不注入停止收据、不直接改任务状态，也不把命令发送成功算作停止。

私有证据增加 `media-data-waiting.json`、`media-running.json` 和 `media-stopped.json`。
这条联合实验不证明 PBS 联合链路、真实科学软件安装/结果、物理邮寄、掉电或跨主机恢复；
未通过完整命令之前不得将其登记为验收通过。


2026-11-09：此 Slurm 联合场景完整通过。真实读取与隔离检查后，经来源政策 HTTP 撤销，
接收方记录 RENEWAL_FAILED，原许可到期后同一 Slurm Job 为 CANCELLED、映射进程退出、Agent 持久停止证明为 true。
观测遇到 55P03 行锁冲突仅返回未知，继续限时重读，未知不视为撤权成功；其他观测错误仍使验收失败。
完整命令退出 0，独立两端账本守恒且无链待办，所有隔离资源清理；未用本轮结果替代 PBS 或完整生产隔离验收。


### 介质交付后的真实 PBS 执行

同一 media 联合实验支持 `KQ_MEDIA_EXECUTION=pbs-pro`，另提供 `KQ_MEDIA_PBS_DIR=/absolute/path/to/pbs-cache`。
其余 PostgreSQL、age、SIF 配置和显式隔离 opt-in 与 Slurm 变体一致。
PBS 目录使用[组件实验](media-slurm-lab.md)产出的 `openpbs.tar.gz`、`pbs-install.tar.gz` 和 `pbs-install.json`；
启动前检查固定源码提交/摘要、23.06.06 版本、基础镜像及归档摘要，Pod 内恢复安装并校验真实 qsub 版本，不触发源码编译。
缓存是本地验收构建，不声明为上游认证的二进制发布。

PBS 变体现会在自有 Pod 的受限子树安装[原生 cgroup v2 hook](../schedulers/pbs/cgroup-v2.md)，仅作用于实验 `workq`。trusted wrapper 在用户脚本启动前强制核对原生 Job ID、签名 CPU/内存及实际内核限额；检查失败不会运行脚本。

接收端通过实际注册接入 `pbs-pro`，等待 `workq` 清单可用，为映射账号显式授权该队列。
使用相同的 DATA_WAITING、签名脚本/SIF、加密交付、独立授权和实际来源撤权步骤。
运行探针读取生产 PBS Adapter 及原 qstat 历史记录；停止要求原 Job 为 F 且非零退出、映射进程消失，
同时存在该 jobId/dispatchEpoch/schedulerJobId 的持久正向停止证明。
不能把发出 qdel、进程暂未出现、普通完成或历史记录缺失视为通过。
Pod 总限额仍为 1 CPU/1 GiB；生产逐作业 cgroup、掉电、多主机、真实科学软件及完整调度矩阵另行验收。


2026-11-09：此 PBS 联合场景完整命令一次通过并退出 0。实际读取/隔离检查后，来源政策 HTTP 撤销，
原短期许可失效，同一原生 PBS Job 从 R 进入 F、退出码 265、映射进程消失、Agent 停止证明为 true。
两端账本守恒，直接模式无链待办，所有隔离资源清理。没有重新编译 PBS 或科学软件，未注入停止决定。

2026-11-09：强制资源检查接入后，PBS 联合流程再次通过。原作业进入用户脚本前经过 pinned checker，运行中额外内核快照为 1 CPU/128 MiB、swap=0；随后来源 HTTP 撤权、原许可到期、同一作业 F/Exit 265、Agent 停止证明为 true。该次验证未重复 Slurm 或内存压力实验，不代替其他 root 路径、SelfAccount、队列能力发布和掉电恢复验收。


## SelfAccount 双平台执行与进程恢复

新增普通用户 Slurm 场景，复用无链双边的两套 Server/数据库、自动协议交换、材料/依赖锁传输、文件工作流、结果回传及账务验收。使用已缓存的 Apptainer/SUID 固定摘要包和 `bash.sif`；同页 PostgreSQL 工具路径仍必需：

```bash
KQ_FEDERATION_EXECUTION_LAB=1 KQ_FEDERATION_SELFACCOUNT=1 \
KQ_MEDIA_RUNTIME_DIR="$PWD/temp/federation-runtime" \
PYTHONDONTWRITEBYTECODE=1 bun run test:federation:direct
```

只接受 direct 模式的 success 场景。提供方为一次性 Debian 13 / Slurm 24.11.5 Pod，1 CPU/1 GiB，部署真实 cgroup v2、slurmdbd 与小缓存 MariaDB；只在该 Pod 安装软件，不修改宿主调度器。普通账号 UID/GID 24001 运行生产 Agent/supervisor/watchdog；Server 显式启用 SelfAccount，关闭账号 impersonation，映射身份须精确匹配。临时签名 SIF、固定检查器与 seccomp、明确 sandbox 队列用于真实启动证明。

第一步实际运行后强制结束提供方 Server 进程组及 Agent，保留原数据库、SQLite、凭据与原生作业。supervisor 重启 Agent，Server 从原状态恢复；检查原 UUID、Slurm 作业号和派发轮次不变，每个 UUID 只有一个原生作业。随后完成下游文件读取、独立源站 Agent 回传及真实下载，文件摘要应与固定预期一致。用量必须与真实 sacct ElapsedRaw 一致，账单/结算继续走双方独立政策与签名，不把容器时长当作 Slurm 作业时长。

额外证据为 `selfaccount-restart.json`、每个原生作业的 `*-slurm.json` 和日志、账单证据中的 `slurm` 观测。此场景只验证普通 SelfAccount，不启用需要 root 受限 profile 的私有数据交付，也不证明科学软件、跨主机共享存储或整机掉电。2026-11-09 完整入口已退出 0：原 Job 2 在 Agent/提供方 Server SIGKILL 后保持运行，恢复仍为原 UUID/原生编号/派发轮次；下游 Job 4 完成，最终 12 字节结果实际返回独立源站存储。真实 sacct 时长 61 + 1 秒，与双方签名用量一致；账单封顶、独立自动结算及两次调整/重放通过。临时 namespace 已确认删除。


独立 watchdog 与 Agent 同时启动时，watchdog 会等待 Agent 初始化 inbox 表，之后才巡检；自身不执行数据库迁移。等待中支持 SIGTERM 正常退出，日志区分等待和就绪。损坏数据库或巡检错误继续报错并由 supervisor 重启，不伪装成空库。首次启动和已有任务恢复使用同一份私有 SQLite 文件。

HPC 普通 Sandbox 的输出按签名容器路径暂存到本作业 outputs 目录，并将该目录挂载至 `/kq/outputs`；可选文件允许在脚本运行前及结束后不存在，不能用空占位文件代替。输入仍逐项只读挂载，产物收集只接受声明项。此验收保留一个未生成的可选输出，以覆盖实际 Apptainer 启动和产物缺省语义。

中断时机以结果文件中的临时标记及原生 RUNNING 状态共同确定；限长日志管道可能缓冲短输出，不用 stdout 刷新判断脚本是否已经开始。脚本最终必须覆盖该文件为 `42\n`，下游输出为 `verified:42\n`，最终按精确 SHA-256 验收。

## 私有任务文件的双向介质交付

使用同页 PostgreSQL 工具配置和已缓存的 age 目录，运行独立场景：

```bash
KQ_FEDERATION_EXECUTION_LAB=1 KQ_FEDERATION_LAB_SCENARIO=task-media \
KQ_MEDIA_AGE_BIN=/path/to/age-bin \
PYTHONDONTWRITEBYTECODE=1 bun run test:federation:direct
```

场景建立两个独立 Server/数据库、mTLS Agent 和版本化对象存储。来源通过普通云盘 API 上传 `6\n`，通过普通 Workflow API 提交带 File 输入的 Federation 节点，输入和结果均声明 `media`。提供方必须先处于 DATA_WAITING，且没有 Job、目标文件或网络复制尝试。

两次介质交付均由实际 CLI 子进程调用生产 API 批准、Agent 使用真实 age 导出。CLI 配置保存于实验私有临时目录，使用真实测试登录会话和当前机构断言，清理时一并删除。测试人员搬运密文至对方 inbox，然后通过 CLI 调用登记、批准和运行 API；自动上传、固定版本独立校验、整包发布及作业恢复全部由生产后台执行。提供方运行两个轻量 Kubernetes Job，得到 `42\n` 中间文件和 `verified:42\n` 持久结果；结果经反向介质交付后，原 Workflow 下游 File 节点继续运行。

`task-media-evidence.json` 保存原 operation/领取/导入关系、版本化校验证据、文件 SHA-256、密文摘要和最终状态。断言原输入/结果各只有一个介质尝试、配额预留归零、回执被确认、私有文件未进入共享数据集目录；最后通过来源云盘实际下载并逐字节核对结果。临时密钥、对象 URL 和 commit token 不写入该证据。

这个场景验证私有任务介质链路，使用真实轻量脚本；不代表科学软件离线安装、真实硬盘物流或 Slurm/PBS 矩阵。授权和回执控制面保持在线，跨站输入/结果网络复制源配置为空。共享数据集场景仍为 `media`，两者验收口径分开。


## 原生争议冻结的独立平台恢复

在上述运行条件下，专门验证协调模式冻结：

```bash
KQ_FEDERATION_LAB_SCENARIO=success KQ_FEDERATION_LAB_DISPUTE=1 bun run test:fabric:execution
```

此选项只允许协调模式 success／workflow；完成原轻量文件作业、实际用量、账单及结算后，跳过本次无关的调整／付款实验。需求方通过真实登录会话调用生产开案 API，双方 Server 通过原 mTLS 通道自动投递案件与交换冻结签名；原件和冻结待办由生产服务生成，不直接写测试冻结状态。

停 Orderer 后等待双方 ledger_pending 与原已背书交易检查点，确认案件仍 FREEZE_PENDING。强制结束两端 Server 与商业 Adapter，再用原数据库和密钥启动；原证明与交易恢复记录必须保持不变。恢复 Orderer 后，两端须各自查询到匹配私有收据才进入 DISPUTED；新财务批准必须被拒绝，原预算／账单／结算／作业／执行 gate 不变。重复开案返回原签名，不创建第二笔冻结待办。

`freeze-offline/restarted/committed` 的两站快照、`freeze-crash-recovery.json` 与 `freeze-recovery-evidence.json` 保存在私有证据目录。独立 `freeze-proof.ts` 用真实 Gateway 读取 A/B/C 的公共区块与私有写集，核验原 transactionId 的 VALID、公共区块无原签名／案件标记、A/B 原文对应且 C 无正文；冻结事务只能写案件原件和任务冻结标记，不写资金或作业许可。结果保存到 `freeze-private-ledger.json`。

必须整条命令退出 0、上述所有断言和独立私有区块核验通过才记为完成。本项仍是同机模拟机构；轻量脚本不等于 Spack 科学软件，开发登录不代表正式身份或 PR 预览验收，也不覆盖解除冻结和仲裁。


2026-11-09 完整入口已退出 0：两端真实文件作业及 12 字节结果回传、账单／结算、停链双签、Server／Adapter SIGKILL、原交易 VALID 和两端独立私有收据确认全部通过。独立 A/B/C PDC 检查通过，原财务／Job/gate 不变；重复开案不重签，新调整批准被拒绝。首轮发现 Node 网关缺失两个争议路径，修复后完整复验成功；需双方同步升级 Server 与 Gateway。隔离服务和 namespace 已清理，证据仅存本机忽略目录。
