# 存储容量观测与新接单保护

本能力读取实际存储侧的文件系统容量，不以 Server 容器根目录的剩余空间代替数据库、Peer 或 Orderer 数据卷。采样程序只读业务卷；以独立 Ed25519 密钥签署报告，原子发布到独立报告目录。Server 按管理员配置校验报告签名、卷绑定标识、时间和容量阈值。

当前在接收委派入口实现观测与新接单保护；源方新提交、市场认领等其他新增写入的接线仍待补齐，不是全平台写入开关。它不创建或释放实际磁盘预留文件。`completionHeadroomBytes` 是拒绝新接单时保留的阈值余量，**不是已经物理分配的收尾空间**；外部写入和采样间隔内的并发写入仍会消耗磁盘。完整 O01 的收尾/取消/恢复预留、增长预测、跨副本持久容量记账和写满恢复仍待补齐。

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

## 接单与查询

容量检查只用于新 reservation，在原事务写入之前执行；超限返回 `STORAGE_PRESSURE` / HTTP 503，不对外暴露磁盘路径或容量。源站沿用既有交付重试。旧请求重放和原回执恢复绕过新接单容量检查；采样 I/O 返回后重新检查授权和签署有效期，不能延长过期请求。原任务执行、结算、取消及补交不因这项新准入检查被禁止，但当前尚无物理缓冲保证它们在磁盘真满时仍能写入。

`GET /api/admin/federation/storage` 沿用平台联邦基础设施管理权限，并返回 `Cache-Control: no-store`。返回 `enabled` 与各卷的 `healthy` / `pressure` / `stale` / `unavailable`，有效观测包含字节、inode、阈值与时间；不返回本机路径、公钥或私钥。未启用返回 `enabled: false`。专门的 Web 运维页尚未接入。

## 验证范围

`bun run test:federation:storage` 在独立 Linux mount namespace 内创建 16 MiB tmpfs，以真实写入触发 ENOSPC，验证签署报告及准入检查的健康→压力→恢复→过期过程；只清理其自行创建的填充文件、临时卷和测试密钥。需要 Linux 的 mount namespace 权限，不在普通单元测试中自动运行，不对现有数据库卷填盘。

独立数据库测试覆盖拒绝新预留、不改变预算、原回执恢复、观察 I/O 期间过期和真实私有入口 503。文件系统实验与数据库测试分别验证各自边界；它们不是“实际 PostgreSQL 被写满后仍完成任务”的联合验收。Observer 模块测试与发布测试进入普通单元测试范围。本机无 Docker 命令，已验证独立打包入口，尚未构建/启动该 Docker 镜像，也未修改正式部署。
