# 存储容量观测、预留与接单保护

本能力读取实际存储侧的文件系统容量，不以 Server 容器根目录的剩余空间代替数据库、Peer 或 Orderer 数据卷。采样程序只读业务卷；以独立 Ed25519 密钥签署报告，原子发布到独立报告目录。Server 按管理员配置校验报告签名、卷绑定标识、时间和容量阈值。

当前保护直接/异步双方新委派、工作流新委派绑定、人工市场发布/认领，以及自动市场意图、独立商业预留提案和人工商业预留批准。它针对新增计算意图，不是全平台文件上传或数据库写入开关。只读 observer 不操作预留；可选的独立 reserve controller 只管理专用目录内的自有预留文件。`completionHeadroomBytes` 是拒绝新接单时保留的阈值余量，**不是已经物理分配的收尾空间**；外部写入和采样间隔内的并发写入仍会消耗磁盘。物理预留及真实 PostgreSQL 满盘后的原回执恢复已有验证；跨副本持久容量记账与条件回收已接入，增长预测和完整任务收尾矩阵仍待补齐。

## 卷、身份和采样

管理员为每个监控对象分配逻辑 `volumeId` 和卷绑定 `storageId`，在其真实数据卷的探测目录放置 `.kq-storage-id`，内容为 `storageId` UUID。监控程序不会自动创建标识，找不到、标识不符、标识为符号链接或采样期间目录被替换，都生成签署的 `unavailable` 报告。

应先完成 PostgreSQL 初始化，再在数据卷写入标识；不要在空 PGDATA 中先放标识阻止 initdb。核对实际 `PGDATA`、`pg_wal` 与 tablespace 链接目标：位于独立文件系统的 WAL、tablespace 应分别配置监控对象。标识用于绑定管理员选定的卷，不自动发现数据库部署关系。示例 Compose 明确把原 `pg-data` 以只读方式挂到 observer，Server 只获得报告目录，不读取原始数据库文件。

报告包含采样时间、设备/文件系统标识、总量、普通写入者可用字节和可用 inode；数量均为整数字符串。文件系统不提供 inode 统计时保留 `null`，不显示零或猜测。业务脚本、用户身份、价格和密钥不进入报告。

在存储主机生成独立观察者密钥，例如：

```bash
umask 077
openssl genpkey -algorithm ED25519 -out observer.key
openssl pkey -in observer.key -pubout -out observer.pub
```

这不是机构业务签名密钥，也不赋予协议、账单或结算批准权。私钥与 observer 配置须归 observer UID 所有、权限 0600；Server 策略文件须归 Server UID 所有、权限 0600。报告目录由 observer 所有，不允许其他用户写入；报告按 0640 发布，Server 通过专用共享组读取并以只读方式挂载目录。Kubernetes Secret 默认的 root 所有/0444 文件不满足私有配置要求，应由 initContainer 复制到对应 UID 的私有目录。

## 配置

Observer 配置（替换示例 UUID；路径均为 observer 所在容器/主机的绝对路径）：

```json
{
  "version": 1,
  "volumeId": "11111111-1111-4111-8111-111111111111",
  "storageId": "22222222-2222-4222-8222-222222222222",
  "probeDirectory": "/observed/postgres",
  "signingKeyFile": "/run/kq-storage/observer.key",
  "reportFile": "/run/kq-storage-reports/database.json",
  "intervalSec": 5
}
```

Server 设置 `FEDERATION_STORAGE_GUARD_FILE=/run/kq-storage/policy.json`。策略示例中的 `siteId` 必须为本站身份，`publicKeyPem` 替换成 observer.pub 的完整 PEM 字符串：

```json
{
  "version": 1,
  "siteId": "33333333-3333-4333-8333-333333333333",
  "volumes": [
    {
      "volumeId": "11111111-1111-4111-8111-111111111111",
      "storageId": "22222222-2222-4222-8222-222222222222",
      "name": "联邦证据数据库",
      "component": "postgres-data",
      "modes": ["bilateral_direct", "bilateral_attested", "ledger_coordinated"],
      "reportFile": "/run/kq-storage-reports/database.json",
      "publicKeyPem": "替换为 observer.pub 的完整 PEM 字符串",
      "maxReportAgeSec": 30,
      "minAvailableBytes": "1073741824",
      "minAvailablePercent": 10,
      "completionHeadroomBytes": "536870912",
      "minAvailableInodes": "10000"
    }
  ]
}
```

可用字节小于或等于 `max(minAvailableBytes, ceil(totalBytes × minAvailablePercent / 100)) + completionHeadroomBytes` 时暂停新接单；inode 少于所设最小值也暂停。若要求 inode 下限而文件系统不提供统计，同样暂停。示例值仅展示配置，不代表按真实负载测得的容量预算。

有效期边界为 `报告年龄 >= maxReportAgeSec`；未来超过 5 秒的报告不可信。运行中的同一 Server 还拒绝倒序报告，进程重启后仍以签名和有效期限制旧报告；这不是跨副本持久反重放协议。配置和公钥在启动时加载，修改后重启 Server；报告按接单实时读取。

每种模式必须至少配置一个 `postgres-data` 策略，防止仅配置 Peer 却误以为数据库受保护。`component` 还支持 `postgres-wal`、`peer`、`orderer`、`archive`、`agent-staging`；每个条目单独指定适用模式。异步存证通常只把本地证据/数据库卷设为接单前提，Peer、Orderer 可仅阻断 `ledger_coordinated`。否则其报告过期也会按管理员配置阻断双边接单，不能称为无链依赖。

未设置环境变量表示未启用，不检查任意本机目录来制造健康状态。设置后配置、密钥或本站身份不合法会阻止启动；报告缺失、不可读、签名错误、错卷、过期或压力状态则保留服务运行，但拒绝新的联邦接单。

## 运行与部署

源码运行：

```bash
bun --no-env-file scripts/federation-storage-observer.ts /absolute/observer.json --once
bun --no-env-file scripts/federation-storage-observer.ts /absolute/observer.json
```

第一条采样一次，第二条持续按配置周期采样。采样失败会替换旧健康报告为签署的不可用状态；发布失败则进程退出，由监督服务恢复，原报告到期后 Server 停止新接单。报告采用同目录临时文件、fsync 和 rename，报告目录应位于独立控制卷，避免业务卷满时连失败状态也写不出。

[observer 镜像定义](storage-observer.Dockerfile)将源码打包为独立 Bun 入口；[Compose 配置](compose.storage.yml)叠加在基础 Compose 与联邦入口之上：

```bash
docker compose --project-directory . \
  -f deploy/compose/docker-compose.yml \
  -f deploy/federation/compose.ingress.yml \
  -f deploy/federation/compose.storage.yml config
```

部署前设置 overlay 列出的策略、密钥、报告目录、UID/GID 等环境变量。`FEDERATION_STORAGE_OBSERVER_UID` 必须能遍历 PostgreSQL 真实数据目录；报告目录归此 UID 与 `FEDERATION_STORAGE_REPORT_GID` 所有，Server 会加入共享组。不要给 observer 增加数据库卷写权限。独立 WAL、Peer、Orderer 卷应使用各自 observer 和报告，不能把本例一个 `pg-data` 条目视为全部卷已覆盖。

跨主机部署可经运维批准的受控通道原子转交**原签名报告文件**到 Server 本地报告缓存，不能由中继改采样时间或重新签署。当前只提供文件交付接口与上述同主机 Compose 配置，远程自动同步和 Kubernetes 部署接线尚待补齐；未接通时缺报告会暂停接单。

## 可选物理收尾预留

预留控制器必须与实际数据卷同机运行。它通过 Linux `fallocate` 创建非稀疏文件，核验文件大小与实际占用块并 fsync；预留字节已从 `availableBytes` 中扣除，不可再次当成可接任务的空闲容量。当前真实恢复实验使用 ext4；其他文件系统应先验证其分配、释放和故障恢复语义，压缩、去重、共享快照或底层 thin pool 不应仅凭 `st_blocks` 推断独占物理容量。预留文件不纳入数据备份/快照。

控制状态必须放在**不同文件系统上的持久控制目录**。控制器明确检查设备号，不接受把业务卷的另一个子目录当成独立控制卷。控制目录和专用预留目录均由 controller/observer UID 所有、0700；配置与状态文件为 0600。控制目录不可使用重启即丢失的容器临时层。业务卷管理员先创建预留目录并配置原卷标识，不允许控制器自动猜测或创建数据库目录。预留目录应位于 PGDATA 之外、但属于同一实际文件系统，避免 pg_basebackup 把大预留文件复制进数据库备份。

`/run/kq-storage/reserve.json` 示例：

```json
{
  "version": 1,
  "volumeId": "11111111-1111-4111-8111-111111111111",
  "storageId": "22222222-2222-4222-8222-222222222222",
  "reserveId": "44444444-4444-4444-8444-444444444444",
  "probeDirectory": "/observed/postgres",
  "reserveDirectory": "/observed/reserve",
  "stateFile": "/run/kq-storage-control/reserve-state.json",
  "bytes": "1073741824",
  "releaseBelowBytes": "1073741824",
  "minAvailableAfterArmBytes": "4294967296",
  "intervalSec": 5
}
```

这里的 1 GiB 仅为配置示例，不是按现有任务数测得的充分收尾预算。`releaseBelowBytes` 应低于 Server 暂停新接单的阈值，`minAvailableAfterArmBytes` 应高于该阈值，避免刚恢复就再释放。控制器要求后者严格大于前者；Server 策略还应单独核对字节/百分比/inode 限制。每个独立 WAL、tablespace、Peer 或 Orderer 文件系统需要自己的预留，不能用 PostgreSQL 主卷的文件代替。

Observer 配置增加：

```json
"completionReserve": {
  "reserveId": "44444444-4444-4444-8444-444444444444",
  "configFile": "/run/kq-storage/reserve.json"
}
```

Server 对应卷策略增加：

```json
"requiredCompletionReserve": {
  "reserveId": "44444444-4444-4444-8444-444444444444",
  "minAllocatedBytes": "1073741824"
}
```

必须同时配置观察与策略，防止丢失整个预留字段后被当成未启用。报告缺失该要求、reserveId 不符、预留不完整、文件替换或处于非 armed 状态均拒绝新接单。即使旧策略尚未指定最小预留，收到观察者明确声明的 released/arming/unavailable 也会阻断。旧配置未启用预留时保持原行为。

源码命令（需要 Linux `flock`、`fallocate`）：

```bash
bun --no-env-file scripts/federation-storage-reserve.ts /run/kq-storage/reserve.json provision
bun --no-env-file scripts/federation-storage-reserve.ts /run/kq-storage/reserve.json watch
bun --no-env-file scripts/federation-storage-reserve.ts /run/kq-storage/reserve.json status
```

`provision` 首次申请并核验物理空间；相同申请可恢复未完成的分配，但不能隐式恢复已释放的预留。`watch` 持续检查水位，低于或等于阈值时先在独立控制卷 fsync 持久的 released 状态，再删除日志中登记的自有文件并 fsync 预留目录。状态先写成功才能释放空间；释放中断后下次检查只继续完成释放，不重新占回空间。状态 released 表示禁止新负载的持久标记；若删除失败，不代表字节已经释放，实际空闲量仍以卷观测为准。常规轮询不逐次输出日志。

人工提前释放或恢复：

```bash
bun --no-env-file scripts/federation-storage-reserve.ts /run/kq-storage/reserve.json release
# 先排空/限制仍在写入的负载，并完成清理或扩容，再恢复。
bun --no-env-file scripts/federation-storage-reserve.ts /run/kq-storage/reserve.json restore
```

释放后，即使磁盘空闲量变多、Server/controller 重启，预留字段仍保持阻断；只有显式 `restore` 成功分配并验证新的预留文件、观察者发布新报告后才可能恢复准入。不要删除状态文件来清除标记。设备号、原 inode、权限、卷标识变化或状态损坏均失败关闭，需要管理员核对原卷后处理，不能自动认领不明文件。

每个操作使用内核 `flock`，锁冲突返回退出码 75，不判断 PID 超时、不偷取活动锁；watch 每次检查后释放锁，管理员可重试显式操作。只删除状态文件中随机 allocationId 对应的普通、自有、单链接文件；不遍历清理目录，不删除数据库文件。

Compose 增加 [reserve overlay](compose.storage-reserve.yml)。它把数据库挂载保持只读，仅把 PGDATA 以外、同一文件系统上的专用宿主预留目录挂到 `/observed/reserve` 为可写，observer 对该目录仍只读；独立控制目录另挂。按 overlay 设置三个 `FEDERATION_COMPLETION_*` 变量，在同一组 Compose 文件下先执行 `run --rm --no-deps federation-storage-reserve provision`，再启动 watcher。observer 与 controller 必须看到同一路径、同一 reserveId 和同一状态文件。镜像包含两个 Bun 入口及 util-linux；本机没有 Docker，未据此宣称镜像或 overlay 已实际启动。

这仍是按采样工作的应急缓冲，不是跨 Server 副本的任务占用账本。旧报告在有效期内、已进行中的准入，以及外部/非联邦写入仍可能竞争释放后的空间；一次预留也没有单独保证 inode 数、任意规模结果文件或无限期断链期间的需求。完整 O01 继续要求按负载预算、限制竞争写入并验证任务完成/取消/恢复矩阵。

## 接单与查询

接收方直接/异步模式的容量检查用于新 reservation，在原事务写入之前执行；超限返回 `STORAGE_PRESSURE` / HTTP 503，不对外暴露磁盘路径或容量。源站沿用既有交付重试。旧请求重放和原回执恢复绕过新接单容量检查；采样 I/O 返回后重新检查授权和签署有效期，不能延长过期请求。原任务执行、结算、取消及补交不因这项新准入检查被禁止，可选物理预留提供一次应急缓冲；不能据此保证任意已接任务、任意并发写入下都能完成。

源方直接/异步委派在出站事务创建前检查容量，之后重新校验授权和有效期；同文重放与发送 worker 不重复按新任务准入。工作流在文件快照/参数派生前预检，并在首次保存委派绑定前复检；已有绑定仍须核对运行所有者、节点和完整意图，恢复原 operationId。新节点容量不足进入 `STORAGE_WAITING`，按原工作流等待机制重试，不算计算失败。协调模式的容量检查提前到本站首次接受市场意图、预留提案或商业预留批准时；出站发送及接收执行属于既有批准的后续动作，仍须通过原来的有效确认和权限检查，不重复按新任务拦截。

人工任务市场只在新发布和新认领时检查 `ledger_coordinated` 对应存储策略。原请求重放、链交易检查点推进与撤回未认领需求继续；报告读取后按数据库实时时钟检查发布/认领期限。新增拒绝均返回不带容量明细的 HTTP 503 与 `Cache-Control: no-store`，不留下新提交或审计记录。

自动市场和预留流程通过本站已保存的批准、提案或市场意图判断是否属于已接任务。必须逐项匹配本站、机构、协议 revision、reservationId、完整提案与摘要；同 ID 改金额、模板或签名盐不能借此放行。接收端校验当前证书和签名，容量 I/O 后重新检查时效；人工商业预留批准在市场查询后、最终写入前再次检查。拒绝不消费自动审批额度，也不产生新意图。已有意图的发布、认领、提案交换、批准与执行授权继续推进；容量错误保留原待办并重试，不能因压力改成 `needs_review` 或换业务 ID。

`GET /api/admin/federation/storage` 沿用平台联邦基础设施管理权限，并返回 `Cache-Control: no-store`。返回 `enabled` 与各卷的 `healthy` / `pressure` / `stale` / `unavailable`，有效观测包含字节、inode、阈值与时间；不返回本机路径、公钥或私钥。未启用返回 `enabled: false`。专门的 Web 运维页尚未接入。

## 验证范围

`bun run test:federation:storage` 在独立 Linux mount namespace 内创建 16 MiB tmpfs，以真实写入触发 ENOSPC，验证签署报告及准入检查的健康→压力→恢复→过期过程；只清理其自行创建的填充文件、临时卷和测试密钥。需要 Linux 的 mount namespace 权限，不在普通单元测试中自动运行，不对现有数据库卷填盘。

独立数据库测试覆盖拒绝新预留、不改变预算、原回执恢复、观察 I/O 期间过期和真实私有入口 503。原文件系统实验与数据库测试分别验证各自边界；下面的联合实验进一步验证原接单回执写入，仍不是完整科研作业收尾验收。Observer 模块测试与发布测试进入普通单元测试范围。本机无 Docker 命令，已验证独立打包入口，尚未构建/启动该 Docker 镜像，也未修改正式部署。


`bun run test:federation:storage:recovery` 创建独立 mount namespace 和 512 MiB ext4 loop 文件系统，运行隔离 PostgreSQL 与项目迁移，先通过正式接单事务保存任务，在签回执前注入中断。随后实际写到 ENOSPC，并要求 PostgreSQL INSERT 返回 `53100`。仅释放 32 MiB 预留，保留填充文件，重启数据库，使用生产 `completeReceipt` 补完原编号回执；新接单继续被 released 标记拒绝且预算不变。清理自有填充文件仍不会自动放行，显式恢复预留后才允许下一笔接单。最后停止数据库、卸载并删除临时卷/状态/测试密钥。

该命令需要 root 的独立 mount/loop 权限、ext4 工具和 PostgreSQL 16；可通过 `FEDERATION_TEST_POSTGRES_BIN`、`FEDERATION_TEST_POSTGRES_SHARE`、`FEDERATION_TEST_POSTGRES_LIB` 指定已准备的工具路径。此实验不启动 Fabric/Kubernetes/科学计算软件，也不碰现有数据库卷。模块测试还覆盖稀疏/替换/硬链接/损坏状态、持久释放标记、显式恢复、原分配恢复，以及打包后 CLI 的并发互斥与活动锁保护。


## 跨副本收尾预算

平台管理员可调用 `PUT /api/admin/federation/storage/completion` 设置本地 `FEDERATION_SITE_ID` 的数据库收尾预算。请求不接受其他站点 ID；配置和审计同事务保存，所有连接同一数据库的 Server 副本读取同一份策略。该策略不修改机构的资金预算、接单授权或签名协议。

```json
{
  "reserveId": "00000000-0000-4000-8000-000000000003",
  "capacityBytes": "33554432",
  "taskBytes": "1048576",
  "marketBytes": "65536"
}
```

这些值只是格式示例，不能当作实际任务的最坏写入量。`reserveId` 必须对应本地数据库卷签名报告中的健康、已分配物理预留，预算不得超过报告中的物理字节数。每个站点必须独占自己的预留文件，不允许多个数据库/站点给同一物理预留重复分配预算。单任务预估应覆盖正常完成、取消、重试、结果元数据、结算、调整与存证积压；科研结果正文另受结果策略和存储限额约束。

- 首次配置会用游标分批读取已有出站请求、接单 inbox、工作流绑定、市场请求、提案和批准；同一完整任务请求只计一笔。已有手工市场发布/认领另计一笔；自动市场交接依附于已接任务，不重复计数。历史任务也保守计入，历史总额可超过新配置，此时拒绝新接收但保留原任务。
- 新任务占额与首次接受的业务记录同事务写入，失败一并回滚；按本地站点、协议 revision、taskId、attempt 绑定规范化完整请求摘要。不能换正文借用原任务 ID。修改单笔估算只影响后续新任务，不重算已分配字节。
- `GET /api/admin/federation/storage` 的 `completion` 返回策略、`allocatedBytes`、`obligations` 与 `overcommitted`，仅平台管理员可读。没有配置时 `completion.policy` 为 `null`，原水位保护继续生效。配置后，缺少物理报告或 guard 的副本不能新接任务。
- 分配使用数据库事务锁。新接收与配置争用时返回不带私有容量的 `STORAGE_PRESSURE`/503，调用方沿原 ID 重试；不等待另一业务锁形成死锁。已占额的相同任务继续交接，不和新任务争预算锁。首次启用也不能越过正在提交的旧接收事务。
- 后台扫描已接入已结算任务、已关闭公开市场意图和有确定释放凭证的执行前任务占额回收，具体条件见下文；没有人工强制清空接口。其他早期意图继续保守保留，达到上限后须扩容或完成业务收尾，不能靠超时、删除记录或重置账本恢复接单。

本项只对数据库收尾预算计账；增长预测、独立 WAL/Peer/归档卷的联合预算、远程观测/Kubernetes 接线和完整运维 UI 仍未完成。迁移须先于所有 Server 副本升级，不能让仍会接收新任务的旧版本与启用预算的新版本混跑。上述限制与 O01 剩余验收保持一致。


## 后续写入与占额恢复

迁移 [0147](../../packages/db/migrations/0147_icy_penance.sql) 为占额保留 `releasedAt`，并为未释放记录建立索引。查询中的 `allocatedBytes` / `obligations` 只计未释放记录，`releasedObligations` 保留历史数量；占额身份、完整请求摘要和原分配字节不会删除。普通请求重放在原业务入口返回原结果，不能借已关闭的 taskId/attempt 新建另一份执行意图。

用量技术更正、接收新的用量报告、账务调整、新账单/减免、首次创建输入/结果导入以及新的取消意图，均在业务事务内核对并锁定原任务占额。未释放任务沿用已保留的空间；已释放任务先检查健康物理预留和本站余量，再恢复原分配字节。降低新任务的估算值不能降低旧任务重新占用的字节数；容量不足时不留下业务记录、资金预留或恢复占额审计。合法的后续操作仍使用原任务身份；此操作只恢复存储预算，不重新批准计算、不改变已有签名或资金合同。

新的用量报告遇到容量不足时保留原游标，按原记录等待重试，不转成 `needs_review`。已有更正、调整、导入和取消的精确重放继续返回原记录，不重新占额。释放扫描必须锁定同一占额行并跳过正在被后续操作使用的行；不能只看一次无锁状态快照就释放。

## 自动回收条件与边界

迁移 [0148](../../packages/db/migrations/0148_yielding_raider.sql) 增加检查时间和阻塞原因。商业 worker 每轮最多检查 8 笔到期占额；单笔未满足条件时 60 秒后复查。扫描只锁占额行，跳过正在使用的行；释放及审计同事务提交，不锁业务记录、不访问链或远端服务，也不删除历史业务数据或物理预留文件。

已执行任务必须有完整请求匹配的双签账单及已应用的双签结算。提供方还要求原运行及子作业已终止、取消/数据撤销已确认，输入副本清理完成。源方要求出站结算完成、状态查询和取消交付已收尾，关联父工作流终止。双方均须没有关联的待处理调整、商业提交、接单存证、签名交换、自动结算、市场请求、执行停止或文件导入清理；结果导入可用时还须取得接收确认。协调模式另要求执行终态凭证，源方须已有市场关闭记录。公开市场发布/认领只有本地原提交及相关关闭提交均已 committed、同需求没有待办或租约时才回收；仅发布可通过已提交的未认领撤销关闭。

后来启用自动结算策略或新发起执行停止，也须在首次写入事务内恢复原占额。容量不足时不留下半成品；自动结算发现新任务失败不妨碍已有任务继续推进，精确重放不重复占额。回收与后续写入争同一任务行，避免出现新义务已落库而额度已释放的窗口。

协调模式的执行前任务可凭双签 `ReleaseExecution` 回收，无须生成虚构账单：本站最新私有提交必须为 VALID，原预留、双方签名字节、摘要和任务身份必须一致。提供方依据自己的私有释放结果回收任务及原手工认领占额；源方还须确认同一释放生成的公共 `close-demand` 已 VALID 提交。任何正式出站/接单记录、账单、活动父工作流、未完成的签名交换/商业提交/市场请求/提案、自动执行租约或停止交付，均继续阻止相应任务回收。候选释放不唯一或证据不明时保留占额。

双签释放后，自动发现、激活/确认授权及人工重试均不得重启原任务；已排队的自动执行转为待复核后才能回收。发现时逐笔记录明确授权拒绝，避免一笔失效任务阻断整轮处理；缺少账本前置凭证仍沿原请求等待。释放签署与执行授权锁定同一原预留，避免并发通过检查；签名交换发现与附加签名在事务内互斥，防止关闭后补入过时交换待办。另一个 releaseId 不能对已双签释放的原预留重复取得双签，同一释放的精确重放保留原结果。

尚无私有 gate 的认领可依据双方各自持久保存的 `unreservedClosure` 回收。核对完整公开状态与摘要、原本地发布/认领、任务请求与商业域、提案/请求/批准摘要及双方签名字节；关联队列须已关闭或完成。未广播 proposal 可保留原字节并标 abandoned，已 INVALID 的交易可结束本地提交；已形成 transaction 的检查点无论是否已发出都必须查明原结果，不能提前释放。任何已 committed 的私有预留、执行记录、账单、终态证据、活动父工作流、未收尾停止交付或活动租约继续阻止这条早期回收路径，矛盾或损坏的证据保持占额。

既有任务新增意图时对原占额取得共享行锁，回收持排他锁；同一任务的正常重复接收可以并行，回收会跳过它们。已释放身份拒绝重新接收。原始请求、签名、交易、累计预授权使用量和物理预留不删除、不重置；释放的只是本站逻辑收尾预算。新增 closed 提交状态由 [0152](../../packages/db/migrations/0152_next_quasimodo.sql) 迁移提供。

已 committed 的提交若因进程在保存 VALID 后、清理租约前退出而留下过期租约，关闭收尾会只清理租约，保留原成功状态和交易证据；未过期租约仍阻止回收。真实 Fabric 专项已验证双方独立 Adapter 观测未锁额关闭、未广播提案退役及原私有交易 MVCC INVALID 后回收；源方在结果未知期间保留占额。该实验使用同一隔离数据库中的不同站点记录和受控容量报告，不代表独立部署站点或磁盘满载验收。

直接/异步合作的执行前取消可依据已在本站应用的独立双签退款回收，不需要虚构账单。原请求、签名正文摘要和本站任务占额必须匹配；提供方须保留已确认的永久取消，原执行工作流从未创建，已接单的原预留已全额归还；取消先于接单时不要求存在预留。源方须已归还原预留额，取消回执与退款正文一致，状态轮询、派发和取消租约均已结束。退款事务同时停止无执行工作流的源方轮询，并清除其旧轮询所有权，迟到响应或错误不能重新排队；晚到的原接单回执仍保存，也不重新启动轮询。签名交换、接单存证、父工作流及文件清理继续按既有条件等待。

异步提供方另须有匹配原退款摘要的本地 record-refund 提交，最新尝试明确 VALID、带区块号且没有活动租约；只把待办状态改成 committed 不足以回收。本站退款可以先完成，收尾容量仍等存证确认。回收只改变逻辑占额，不再次退款、不删除证据、不重开任务；无新迁移。数据库检查覆盖单签等待、接单前/后取消、异步待办、租约、损坏摘要、审计回滚、并发占额锁和迟到状态响应。双 Server/独立数据库的无链与异步存证取消退款均已通过真实满盘联合验收，见下节；完整任务/结果恢复仍按各自证据判定。

没有权威关闭事实的提案、未完成认领及未完成双签退款仍保守保留；未知结果不能按年龄推断结束。该扫描尚未部署到正式环境，真实满盘运行中任务和结果恢复仍待完成。执行前释放另已通过[真实 Fabric 与隔离 PostgreSQL 联合检查](fabric-execution-gate.md#执行前释放后的公共关闭)，包含公共提交丢响应后的原交易恢复；容量观测仍为受控报告，不证明物理磁盘保障。其他数据库用例中的市场 committed 和文件生命周期状态为受控夹具，不能当作真实 Fabric 提交或文件交付的验收证据。O01 仍为部分完成。


## 双平台取消退款的真实满盘恢复

[执行实验](execution-lab.md#满盘后的取消与退款收尾) 的 `refund-auto` 支持 `KQ_FEDERATION_LAB_DISK_PRESSURE=1`。不再仅验证单个接单回执：两端实际 Server 使用签名 observer、物理预留和独立逻辑占额，源方先通过 HTTP 保存取消意图，再中断两端 Server、对专用 1 GiB ext4 写满并触发 PostgreSQL 53100。生产 reserve CLI 显式释放两站各自的 64 MiB 预留后，原数据库与 Server 重启，填充文件继续保留。

无链场景已通过：生产后台沿原取消签名取得永久回执，双边退款与各自占额回收完成；原 task identity、请求摘要、取消签名摘要、分配字节与原件保留，双方各只释放一笔 16 MiB 逻辑占额。填充文件存在和仅删除填充文件后，新委派 HTTP 均返回 503/STORAGE_PRESSURE；只有明确 restore 后，observer 才证明物理预留恢复 armed 且 guard 健康。逻辑占额回收不会自动重新建立物理文件。

异步组合故障也已通过：Orderer 在 Server 启动前停止，磁盘满/重启后仍完成本地退款，后台实际观测到 refund-ledger 并保留提供方 16 MiB 占额。两端 Server/商业 Adapter 再次中断与恢复后，原三条商业提交 VALID、两条接单证据 anchored，提供方才回收；实际区块与 PDC 检查保持 A/B 可见原件、C 不可见，不改变原额度和签名字节。

这是同一 PostgreSQL 实例中的两个独立数据库，数据与 WAL 位于同一专用实验卷；不是跨主机或独立 WAL/Peer 卷证明。数据库实际满盘错误来自隔离探针表，Server 在故障注入时已中断；本项没有逐一覆盖所有业务 SQL 的失败位置。测试只处理执行前取消，无 Workflow/Job，不代表运行中任务、结果正文满盘或科学软件恢复。显式释放由测试模拟授权运维操作，不等于自动 controller 的联合验收；O01 保持部分完成。
