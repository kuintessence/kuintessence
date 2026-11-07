# 真实链与双平台执行验收

`bun run test:fabric:execution` 在同一台专用 k3s 测试节点上启动三个 Fabric 机构、四个生产 Adapter、两个独立 Server/PostgreSQL 数据库、两个 Agent 及两份独立对象存储。它禁用 `.env` 自动读取，不使用部署环境的账号、数据库或存储配置；测试开发登录的 HTTP 入口只监听 loopback，Agent 使用单独的 mTLS 入口。机构、合同、模板映射及受限执行账号由夹具预先批准；双边重复商业提交若发生 MVCC 冲突，夹具只在另一方精确同文意图已有 VALID 区块回执时执行一次授权复核，保留 INVALID 历史，其他错误直接失败；市场操作和确认由生产 Server worker 提交，跨平台委派与材料交换走真实 mTLS 通道。

这是一台机器上的机构模拟，不是独立机构信任验收。脚本执行真实的 Bash 文件计算，不安装 Spack 软件；不覆盖 Slurm/PBS、自动商务握手、普通源站 Workflow 动态调用、科研结果验收、账单或结算。原生链码背书/PDC 隔离与竞态另见 [gate 检查](fabric-execution-gate.md)。

## 运行条件

- 专用 Linux x86_64 单节点 k3s，root，当前 kubectl context 指向本节点；InternalIP 必须能在本机绑定，Pod IP 可从本机访问。使用现有 `local-path` StorageClass。
- 已安装本仓库依赖，提供 Bun、Node、Python 3、OpenSSL、runuser、kubectl、k3s；不使用 Docker。
- 已验证的 Fabric 3.1.5 release 目录；PostgreSQL 16 的 `initdb`、`pg_ctl`、`createdb` 以及对应库/共享文件。
- 预先缓存脚本中固定摘要的 scheduler、Bash OCI runtime、RustFS 和 rc 镜像（`imagePullPolicy: Never`），不在运行中下载或改变镜像。
- Agent 和存储 Pod 有 CPU/内存上限，计算节点只请求 1 CPU、128 MiB；故障场景使用 `sleep`，不跑编译或计算密集任务。仍须预留两份 Server、PostgreSQL 与三个 Fabric Peer 的内存。
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
| 成功 | 双方合同与私有预留 committed，源站发布/提供方认领/激活及双方执行确认均有 VALID 交易；重复 HTTP 委派只生成一份预留、一个 Workflow、两个 Job |
| 材料与执行 | 提供方初始没有输入或环境清单，按签名摘要取回；两个真实 Kubernetes Script 节点输出 `42` → `verified:42`；非 root、seccomp、NoNewPrivs 与禁网执行 |
| 返回 | Persistent 结果经独立源站 Agent 复制并实读校验，登记为带版本云盘文件；下载得到准确的 12 字节/SHA-256，取得对端签名回执；Checkpoint 不披露，重复导入不新增文件 |
| 断链 | 读取 Pod 中实际 sleep 进程后停 Orderer（沙箱 stdout 在任务结束后才发布）；等待原 VALID 确认的真实期限，不篡改时间或签名；到期 10 秒内观察到 Job 删除请求，经过 Pod 声明的终止宽限期（最多 30 秒）及额外 30 秒状态回收时间后确认 Job/Pod 停止，下游不派发、不产出文件 |
| 主动停止 | 确认真实 sleep 正在运行且原 VALID 余期超过 120 秒，停 Orderer 后两次调用提供方停止 HTTP；请求幂等，20 秒内发起调度器停止，经过真实终止宽限后在原 VALID 到期前确认 Job/Pod 停止，本地授权返回 CANCELLATION_REQUESTED；恢复 Orderer 后原停止意图取得 VALID、需求变为 STOPPING，私有 gate 不变、旧作业不重启 |
| 终态关闭（成功场景） | 作业提交前双方通过 API 分别预授权仅 completed 结果；提供方后台从真实 Job 自动归集并签署终态，源方后台经 mTLS 分块取得材料，以本地结果导入及签名回执独立复核并自动签署，随后后台自动回传对签并核验提供方签名 ACK；生产 worker 自动提交私有终态和公共关闭，两端分别查询 CLOSED 与一致的 TERMINAL gate 哈希；两边终态关联各自授权 ID，本地重新执行被拒绝 |
| 锁额 | 两边数据库都不生成本地预算；断链/期限到达不改变 ACTIVE 需求与原私有 gate 哈希；恢复 Orderer 不重启终态作业 |

运行打印私有证据目录 `temp/federation-execution-{success,outage,stop}-*`。成功场景另保存 `terminal-evidence.json`（双方签名、源方复核、自动交换回执及两次链上交易回执）；`terminal-policies.json` 保存提交作业前的两份机构预授权；终态阶段不调用人工批准/对签 API，归集、独立复核、双签和回传全部由生产后台完成。合同、预留与执行准入仍由夹具显式批准，尚不是完整无人值守商务握手。`source/provider-before/after.json` 保存公开意图、交易 ID、验证码、区块号、预留和作业关联；`result-delivery-evidence.json` 保存结果摘要与版本；`running-process.txt` 与 `provider-running.json` 保存断链前的进程和确认，`outage-evidence.json` 保存停止请求时间、终止宽限期及实际 Job/Pod/Workflow 状态。主动停止另保存 `stop-api.json`、`stop-evidence.json` 与双方 `stop-recovery.json`；该场景与自然到期断链场景分别验收。不存在的场景文件不代表通过；以进程退出码和该场景全部断言为准。

目录权限为 0700、文件默认 0600；完整 Server/Agent 日志与本机 Fabric 的测试身份仅供本地排查，不上传 CI artifact 或纳入 Git。导出证据必须另行筛除内部路径、测试签名与存储信息。

每个场景在 `finally` 关闭自建进程、停止自建 PostgreSQL、删除随机 namespace/RBAC/seccomp 文件及私钥。清理失败会报错并保留私有目录；SIGKILL 或主机断电无法保证 finally，须根据保留日志中的随机资源名人工清理。测试未完成前不要移除这些目录，也不要把已清理的测试链视为结算成功。
