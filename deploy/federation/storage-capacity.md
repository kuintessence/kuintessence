# 存储容量观测、预留与接单保护

本能力读取实际存储侧的文件系统容量，不以 Server 容器根目录的剩余空间代替数据库、Peer 或 Orderer 数据卷。采样程序只读业务卷；以独立 Ed25519 密钥签署报告，原子发布到独立报告目录。Server 按管理员配置校验报告签名、卷绑定标识、时间和容量阈值。

当前保护直接/异步双方新委派、工作流新委派绑定、人工市场发布/认领，以及自动市场意图、独立商业预留提案和人工商业预留批准。它针对新增计算意图，不是全平台文件上传或数据库写入开关。只读 observer 不操作预留；可选的独立 reserve controller 只管理专用目录内的自有预留文件。`completionHeadroomBytes` 是拒绝新接单时保留的阈值余量，**不是已经物理分配的收尾空间**；外部写入和采样间隔内的并发写入仍会消耗磁盘。物理预留及真实 PostgreSQL 满盘后的原回执恢复已有验证；跨副本持久容量记账、增长预测和完整任务收尾矩阵仍待补齐。

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
- 当前**没有自动释放占额，也没有人工强制清空接口**。作业结束、收到回执、市场交接完成或到期均不能证明结算、存证及文件清理已全部结束；因此当前保留占额，达到上限后需要扩容并提高策略额度，不能删账本恢复接单。自动回收须补齐业务完成判据后另行验收；在此之前不作为长期无人值守的完整容量管理方案上线。

本项只对数据库收尾预算计账；增长预测、独立 WAL/Peer/归档卷的联合预算、远程观测/Kubernetes 接线和完整运维 UI 仍未完成。迁移须先于所有 Server 副本升级，不能让仍会接收新任务的旧版本与启用预算的新版本混跑。上述限制与 O01 剩余验收保持一致。
