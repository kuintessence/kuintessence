# 离线 Slurm 交付与现场验收清单

先完成平台准备，再初始化普通用户站点，最后按下表顺序验收。这里区分源码能力与现场证据；本地 fixture 通过不填写为真实站点通过。真实地址只填现场 `site.env`，SSH Host 默认为 `kq-service`，分区为 `cn`。

## 实施覆盖

| 计划任务 | 实现与入口 | 完成现场验收所需证据 |
| --- | --- | --- |
| 两种网络模式 | 显式 SSH-forward、HTTP CONNECT，原始 Host/SNI/签名 URL；同端口 SNI 网关 | 两种模式的 doctor 全通道通过，错误代理不可旁路 |
| 零 Spack 初始化 | 两文件 bootstrap，签名发行、断点下载、普通用户配置、注册身份复用 | 空 HOME 数据目录完成 install，重复执行仍是同一 Agent |
| 普通用户运行时 | single-user 信任、只读固定 SIF、共享材料与独立本地 SQLite | 计算节点 namespace/cgroup/配额与可信路径实际验证 |
| 离线材料闭包 | 固定 manifest、票据、审计、镜像强制下载、隔离 build/verify | 空缓存指定 spec 安装、独立 verify 与科学用例通过；无第三方上游访问 |
| Slurm 分发 | 输入先就绪到共享盘，普通作业稳定提交标识、Spack worker hold/release 与 no-requeue | 日志、KQ job 与 Slurm ID 一致，计算节点不访问登录节点 localhost |
| 提交中断恢复 | pending intent、squeue/sacct 对账、撤销墓碑与取消终态确认 | sbatch 回包丢失及 Agent 强杀后无重复提交 |
| 完成后采集恢复 | 持久计算终态快照、暂态 I/O 重试、固定执行绑定 | 已落快照后清除记账历史仍采集原输出；缺快照不猜测终态 |
| 输出发布恢复 | 提交事务中的 publication intent、持久逐文件 outbox、租约、释放 outbox | Server 在终态与发布之间退出，恢复同 transfer/file ID，全部提交后才清目录 |
| 材料与输入续传 | 摘要绑定部分文件、Range、票据续期、整件校验和原子发布 | 中断与票据过期后续传，损坏文件不进入可用缓存 |
| 分片输出恢复 | Agent checkpoint、持久 uploadId/completion、关联 URL 响应、幂等提交 | 分片中断、完成回复丢失、Server 重启均复用原会话及文件 ID |
| 自动更新 | 六小时检查、随机延迟、签名验证、只暂存、维护激活、状态格式约束 | 损坏与不兼容版本被拒绝，旧版可用，在途软件 release 固定 |
| 运维体验 | Agent 卡片独立通道状态、脱敏 doctor、publication 查询与恢复命令 | 失败通道可定位，未测试与过期观测不显示为成功 |

## 1. 平台准备

1. 从现场 modules 小作业取得脱敏 `result.json` 和 SHA-256。异构分区对每个实际目标节点类型分别取样；登录节点与计算节点的 ABI 都需兼容。
2. 按[发行准备](site-release-preparation.md)准备 CLI/Agent，Spack 发行还需可信 SIF、可执行入口与本站 profile。可使用 `computeInventory` 核对观测兼容性，`requireSpack` 拒绝不完整发行；这些静态检查不产生安装或隔离证明。
3. 为本站原生求解 lock，导入并绑定 recipe、source、resource、patch、bootstrap 和编译依赖。参考 Ubuntu lock 不能直接当作本站 lock，`module avail` 也不是 external 已验证的证据。
4. 审核并签名发行，按[站点部署](offline-slurm-site.md)配置 SNI、反代、对象 origin、CONNECT 代理及发行接口。先备份并按现有流程应用仓库迁移，再部署 Server，最后升级 Agent；不通过本清单自动迁移或远端发布。
5. 注册 Agent 后，通过队列管理入口为其创建并启用实际分区队列，同时明确设置允许提交的组织（`visibleOrgIds`）及本站 account/QoS。队列默认不向组织开放；仅完成 Agent 注册和 queue inventory 不授予作业提交权限，缺少可见组织时提交返回 403。
6. 在隔离数据库执行[PostgreSQL 验收](offline-slurm-pg-acceptance.md)。该验收只操作自动创建的临时测试库，不连接生产库；它也不验证真实对象存储。

## 2. 普通用户初始化与真实作业

只上传工具包中的 `bootstrap.sh` 和 `site.env.example`，复制为私密 `site.env`，填写云端域名、端口、共享目录、持久本地盘、信任公钥与 Slurm 参数。先执行 `check` 完成本地只读预检；平台发行、文件根及队列授权准备完成后，依[站点初始化](offline-slurm-site.md)及工具包 SSH 操作手册执行 `install → services`。`install` 已包含 `doctor`，需要复查时可单独执行 `doctor`。初次保持 `KQ_ENABLE_SPACK=0`。

初始化或重启后，先等待 Agent online、控制通道在线及 queue inventory available，再通过 `GET /platform/api/agents/:agentId` 确认 `computeHealthStatus=ready`、`computeHealthObservedAt` 距当前不足 60 秒且 `computeHealthOperationalNodeCount>0`，然后提交 KQ 作业。首次心跳在线或 `doctor` 通过不代表 compute health 已就绪；初始状态可能仍为 unknown，此时立即提交会被调度器以 `No eligible agent` 拒绝。未就绪时继续观察，不要通过重复提交试探。

先提交 modules 小作业，核对 `COMPLETED/0:0`、日志、`result.json` 和 scheduler ID；再经 KQ 派发同类作业。平台准备好完整 Spack 发行后，在维护窗口启用 `KQ_ENABLE_SPACK=1` 并重新安装配置。缺少 runtime/profile/入口或绑定不一致时应在消费注册 token 和切换配置之前失败。

只在 source audit、Slurm install、独立 verify、真实软件任务均成功后记录离线安装通过。没有真实目标 OS、已验证 external、namespace 或持久本地盘时，该项保留待办，不猜测参数或关闭约束。

## 3. 集中故障验收

在专用测试作业和测试文件上依次执行，上一项恢复并留证后再开始下一项：

1. SSH 退出与重建：运行中的 Slurm ID 不变，控制和数据通道重新连通。
2. Agent 进程强杀：恢复原执行；提交结果未知时只对账，不再次 sbatch。
3. 已完成输出采集遇到共享盘暂态故障：保留完成快照；故障解除后采集，同一 scheduler ID。已有快照与旧记录分别验收。
4. 材料及对象下载中断、票据过期：偏移继续、整件 digest 一致；拒绝未授权 origin 和跳转。
5. 输出上传和 Server 中断：核对[文件传输恢复](offline-slurm-multipart-recovery.md)与[输出发布恢复](workflow-output-recovery.md)，检查固定 transferId/uploadId/file ID、最终内容与工作目录释放顺序。
6. 撤销或取消：恢复不得绕过授权；提交对象已开始时取消应返回冲突，不得同时声称取消成功。
7. 更新损坏、旧序号、格式不兼容与回滚：旧版本仍可用；有 writer/构建或状态不明时不能激活。当前发行使用 `stateFormat=slurm-site-v5`，包含完成快照与失败安装依赖复用记录；v4 与 v5 之间不得原地激活或普通回滚。

科学计算进度只在应用自身提供 checkpoint 时恢复。Spack 构建重试可复用已验证的材料缓存；失败/中断 release 不作为可用库存。旧 worker 已确认停止且 spec、root hash、manifest 与 site profile 匹配时，显式重试可复用同一 record/prefix，但必须先通过 `verify-partial` 验证依赖，再仅复用受验证的完整依赖；未完成的包重新构建，不承诺从任意编译指令继续。详见[安装恢复](spack-install-recovery.md)。Workflow 输出补传也不会自动续跑已失败的 DAG。

## 4. 留存验收结果

每项记录 `pending/passed/failed/not-tested`、时间、平台和 Agent revision、发行 digest、软件 manifest/profile digest、KQ/Slurm job ID、传输与文件 ID、文件摘要及脱敏失败码。原始日志保留在现场私密目录；不把 `site.env`、token、证书私钥、预签名 URL 或站点主机清单放进公开报告。

只有全部必需项得到真实证据后才记录本站验收完成。本地自动化检查、数据库隔离验收和真实站点验收是三个独立结果；本清单不预填任何现场通过状态。
