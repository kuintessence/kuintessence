# 离线 Slurm 站点能力与大型软件预算

现场命令在[站点工具包](../examples/slurm-user-site/README.md)目录执行，配置与两种网络模式见[初始化手册](../examples/slurm-user-site/SSH-TUNNEL.md)。

先完成基础 modules 测试，再开启受管安装。登录节点的 `module show`、`module avail`、Apptainer版本或分区UP，都不能证明计算节点可以运行受管安装。

## 登录节点

`bootstrap.sh site.env check` 只读检查本地盘挂载、分区和持久进程条件；`preflight.sh`提供原始诊断。`KQ_LOCAL`必须是用户独占、可写的本地持久盘，不能使用HOME、共享盘、临时目录。文件系统类型检查无法证明清理策略，确认站点保留策略后才设置 `KQ_LOCAL_RETENTION_CONFIRMED=1`。长期运行需要可用的user-systemd和linger，或站点已批准的监督器（`KQ_APPROVED_SUPERVISOR_CONFIRMED=1`）。工具不会启用linger、修改管理员策略或启动探测服务。

登录检查还只读采集 `scontrol show config` 的 `MinJobAge`、`AccountingStorageType`，并在配置accounting时用有界`sacct`查询探测可读性。`KQ_RECOVERY_WINDOW_SEC`表示希望恢复的离线窗口，默认86400秒。无accounting且controller保留窗口不足时报告degraded及实际秒数；sacct成功仅报告conditional，不能证明数据库保留时间、可用性或无限期恢复。未知作业身份应保留待人工核对，不能据此重复提交。

## 计算节点 inventory

基础阶段保持 `KQ_ENABLE_SPACK=0`，通过站点已有Slurm/KQ渠道在独立共享工作目录执行 `modules-smoke.sh /绝对路径/site.env`。它不会自行提交任务；输出沿用 `kq-compute-inventory` 的 `result.json`，增加可选 `managedCapabilities`。只加载用户指定的编译器/MPI，缺失探测记为not-tested。

首次没有受信任runtime时，隔离项保留not-tested；基础inventory可用于平台生成签名发行。平台准备好含runtime的发行后，在登录节点执行：

```bash
bash -l bootstrap.sh "$PWD/site.env" prepare-capabilities
source "$KQ_LOCAL/capability.env"
```

此入口校验签名并把runtime复制到共享release，不注册、不激活Agent、不启用Spack。把输出的 `KQ_CAPABILITY_SIF_PATH` 写入私密site.env；计算节点不读取登录节点的本地状态盘。设置计算节点已有的可写 `KQ_COMPUTE_SCRATCH`、`KQ_SPACK_SCRATCH_MIN_MIB`，再运行同一modules脚本，使用新的共享工作目录。能力作业应按待验证的预算申请资源：2 CPU、`max(2048,预算)+512 MiB`、5分钟时限；account/QoS沿用现场真实配置，申请须不超过 `KQ_SLURM_MEMORY_LIMIT_MIB`。首轮512MiB基础inventory作业只用于采集基础信息。

探测会实际调用Apptainer，检查独立PID/network namespace、无有效capabilities、no-new-privileges、cgroup v2内存/禁用swap/PID上限及user-manager，失败不会降级隔离。scratch写入和空闲容量检查不会改变受管worker的目录配置，应选择实际供构建使用的文件系统；默认最低20GiB仅为示例，复杂软件须按实际峰值调大。

将新报告绝对路径填入 `KQ_COMPUTE_INVENTORY_FILE`。启用Spack的注册/配置激活要求报告24小时内、分区相同、SIF摘要相同、内存预算相同，ABI/user-manager/scratch/isolation全部passed。failed、not-tested、缺字段、过期或预算变化都会阻止启用新配置。自动暂存仍核对签名、摘要和profile绑定，但不因旧能力报告过期而停止拉取；暂存不会执行软件或切换运行版本。基础modules测试不受此门槛影响。报告是本站用户的运行证据，不替代发行签名或每次worker对隔离边界的检查；多个异构节点组须分别采集，站点profile还须确认兼容计算节点。

## 内存预算

`KQ_SPACK_MANAGED_MEMORY_MIB`贯通Agent配置、Slurm申请、Apptainer和worker私有预算文件；默认4096MiB，允许1024..1048576MiB（1TiB）。上界确保字节和KiB换算远低于JavaScript安全整数范围；整数之外、溢出和超界均拒绝。cgroup内存硬限制、禁用swap、namespace和其他隔离条件保持不变。

Slurm申请 `max(2048,预算)+512 MiB`，其中2GiB覆盖审计worker，512MiB是额外预留。本站必须设置经核实的 `KQ_SLURM_MEMORY_LIMIT_MIB`，使申请不超过partition/account/QoS允许的单作业内存；例如32GiB构建预算需要至少33280MiB调度额度。Agent接受对应 `AGENT_SPACK_SLURM_MEMORY_LIMIT_MIB` 并在提交前检查；全局安全上界是1049088MiB。集群的RealMemory、可用资源和实际调度结果仍以Slurm为准。本地执行则要求MemTotal和MemAvailable均能容纳预算+512MiB，不计swap。

预算只表示内存允许值，不能保证某个大型软件足够。还要按发行的软件、编译并行度、scratch/共享盘空间和分区时限确定预算；改变预算后重新采集能力报告。

## Agent磁盘容量门禁

内存额度不代表有足够的磁盘。Agent的本地文件下载、材料cache写入、sandbox输入和上传spool使用统一挂载余量检查：`AGENT_STORAGE_RESERVE_MIB`默认保留1024MiB，允许0..1048576；`AGENT_STORAGE_RESERVE_INODES`默认保留128个inode，允许0..1000000000。预计新增字节和inode数必须为非负安全整数。检查使用可用块数而非包含root预留的总空闲块数，BigInt换算避免溢出；目录尚未创建时检查最近存在的上级挂载。计数不可读或无效时拒绝写入，错误只返回`STORAGE_CAPACITY_INVALID`、`STORAGE_CAPACITY_UNAVAILABLE`、`STORAGE_CAPACITY_BYTES`、`STORAGE_CAPACITY_INODES`或实际quota拒绝时的`STORAGE_CAPACITY_QUOTA`，不附带URL或路径。

已知大小的本地下载在网络请求前检查剩余字节，并在写入时复查。原地续传不会再次把磁盘上已有prefix算作新增；服务端忽略Range改返200时，截断后重新检查完整大小。材料cache为了保持并发writer安全，会把已有prefix复制到自己的临时文件；复制阶段必须容纳这份额外数据，复制完再检查尚未下载的剩余部分。因此材料恢复仍有prefix复制开销，不能宣称只需网络余量。

上传本地文件可先检查已知预计大小；大小未知的流在每次写入前检查下一批数据及尚未flush的缓冲，保留固定余量。检查是观测，不是文件系统预分配或跨进程空间锁；并发写入和用户quota仍可能导致后续写失败。`statfs`不能证明用户/项目quota有余额，站点仍须独立确认quota。旧式curl-shell下载直接写容器文件系统时，Agent本地statfs不能代表目标挂载，应与受管本地下载能力区分。

## 自动维护的Agent drain许可

自动清理不能仅凭SQLite和`squeue`为空就停止Agent，文件传输、异步incoming handler和软件任务可能只存在于进程内。Agent在`dirname(AGENT_DB_PATH)/maintenance.sock`提供维护许可：父目录须为当前UID独占、无symlink且权限不向group/other开放，socket权限0600。条件不满足时不提供维护许可，Agent继续运行并记录固定警告；维护客户端不能回退为直接停止服务。

每个连接发送一行JSON，只允许两个字段：`{"action":"drain","lease":"32位小写随机hex"}`或`{"action":"resume","lease":"相同lease"}`。响应一行JSON：`{"ok":true,"lease":"原lease","reason":"MAINTENANCE_DRAINED"}`表示获准；resume成功reason为`MAINTENANCE_RESUMED`。拒绝原因是`MAINTENANCE_BUSY`、`MAINTENANCE_INVALID`、`MAINTENANCE_LEASE_MISMATCH`、`MAINTENANCE_UNAVAILABLE`或`MAINTENANCE_EXPIRED`；不能据此停止服务。客户端必须同时验证ok、回显lease和成功reason。请求最多1KiB，单连接5秒超时，同时最多16连接。

Agent先原子封住新的incoming handler和重连/恢复轮询，检查已有handler、传输、执行池、软件/准备/cleanup任务、SSH及SQLite执行/交付ledger。busy时恢复接单，不中断已有任务。只有确认idle后才关闭控制流连接，等待本次连接收尾，再检查一次内存和ledger后授予许可；Agent进程仍运行。Python客户端随后可以stop用户服务，持双锁再次检查SQLite和Slurm，再执行GC。失败、取消或放弃时必须在finally使用同一个lease请求resume；没有获得许可不允许stop。

租期从drain请求开始最多120秒，重复相同drain不续期；到期自动解除gate并允许重新连接。旧lease不能解除其他lease的gate。连接丢失不立即取消许可，以便客户端收到许可后执行stop；客户端请求超时应立即尝试同lease的resume，最迟租期到期自动恢复。Agent停止会关闭socket并释放本实例gate；重启实例不会继承旧许可，旧resume不能解除新实例的其他gate。GC仍必须持Agent锁，防止过期后恢复接单或服务启动与删除并发。
