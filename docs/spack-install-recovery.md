# Spack 安装中断与写锁恢复

此机制适用于启用 persistent managed installation 的 Agent，不自动重新编译软件。
本地测试通过不代表共享 NFS、Apptainer 或远端安装流程已验收。

## 身份与互斥

正常写入不要求可信宿主机身份。每个 Agent 进程生成稳定的随机 instance UUID，每次执行
另有独占 token；容器私有 PID/UTS namespace、无法读取身份或身份验证失败时，
host/boot/start 明确保存为 null，PID 仅用于本 instance 内识别，不能作为宿主 PID 使用。
这种 fallback 可以取得全新或已正常释放的锁、保持同一进程互斥并正常释放；
已完成安装可在重启后继续读取、load 和卸载，不要求增加容器权限、hostPID 或宿主目录挂载。
其他 instance 的未释放锁和未决账本始终视为 unknown，不因容器重启、PID 不存在或时间经过接管。

跨进程自动恢复仍要求 Linux 初始 PID/UTS namespace 标识
`pid:[4026531836]` / `uts:[4026531838]`、真实 procfs 的
`/proc/sys/kernel/random/boot_id`、PID 和 `/proc/<pid>/stat` starttime。
只有新旧双方都有可信 native 身份时，才允许使用原有跨 boot/PID 恢复判定。
稳定主机身份使用 machine-id 与主机名的组合摘要：读取 root 所有、非组/其他用户可写的
普通 `/etc/machine-id` 和 `/etc/hostname`，校验 `/etc` 的 root 权限，并要求 hostname
文件内容与初始 UTS namespace 的内核主机名相同。不需要 root Agent 或读取 DMI。
克隆部署可能有相同 machine-id，不能单独用它区分主机，更不能用不同 boot ID 替代主机身份。
共享 store 的所有节点必须具有唯一、稳定的 **machine-id + hostname 组合**；站点启用前
需核对这个前提，不能只检查 machine-id 文件存在。root 克隆配置导致组合完全相同的主机
无法在本协议内区分，未经去重的站点不得启用自动恢复。主机改名或 machine-id 变更后，
旧身份不能自动恢复，须按维护步骤处理。身份字段与独占执行 token 只用于本地证据，不写应用日志。

新版持续占据 `.writer-lock`，其中 `format.json` 标识版本 2，阻止旧版 Agent 的
`mkdir .writer-lock` 成功。原有空目录、损坏格式、未知文件身份不自动迁移或删除。
所有 install/load/uninstall、已有安装校验和 invalid-site 撤销都经过同一锁入口。

锁代次位于 `.writer-lock/generations/`。每个代次通过原子 `mkdir` 独占取得，
在调用业务代码前 fsync 所有者元数据与目录；正常结束持久化 `released.json`。
代次永不复用或在线删除，因此延迟恢复者无法误删新锁，恢复竞争只有一个写入者。
若在创建代次与写完身份之间再次崩溃，保留 `recovery required`，不能猜测清理。
有完整身份的恢复者在收尾期间再次崩溃，后续可重新执行幂等收尾。

这里不使用 NFS `flock`，也不把心跳、锁年龄或租约超时作为证据。
协议依赖同一文件系统命名空间内原子 `mkdir`、已存在目录不能重复创建、
rename 和 fsync 的服务端持久化语义；过期目录缓存最多导致拒绝，不会复用旧代次。
本地测试不能证明目标 NFS 满足这些条件。站点启用前应使用两个真实挂载客户端、
独立空测试 store，验证同时创建同一代次仅一方成功，以及客户端崩溃/重挂载后
已确认持久化的代次不丢失；不得以本机 `flock` 测试代替。多主 split-brain、
不可靠持久化或绕过协议的写入者不在安全保证内，这类站点不得启用自动安装。

代次扫描使用有界内存，没有 10,000 次后停用的阈值，但目录和扫描 I/O 随操作数增长。
监控 store 元数据容量；需要归档时只能在所有写入者停止后按下述维护步骤进行，
不能在线截断历史。未来高频场景应在有明确存储保证后再更换协议。

## worker 与恢复判定

锁元数据关联 operationId、主机/boot/PID/starttime、执行 token；新安装记录保存
operationId 与相同执行身份。真实 runner 在 spawn 前 fsync `worker.json`，将执行
与 release record 绑定，因此即使在 spawn 与进程通知之间崩溃，也不会被当作未启动。
runner 准备、内存准入及命令校验失败时尚未置位；系统明确报告未创建子进程时解除置位。
进程传输正常完成后才能按正常业务结果释放。异常退出、超时或取消后若无法证明
全部 worker 已停止，保留文件与锁；不会在 `finally` 无条件解锁。

现有 Apptainer 使用 `--containall` 的 PID namespace，worker 还校验 namespace 与
cgroup 限额；现有进程传输仍是 detached process group，并没有启动前可持久绑定、
可查询全体后代的命名 systemd unit。不能把 Agent PID 消失、进程组 kill 成功、
某个 Apptainer 启动进程退出或本机查不到远端 PID 当作全部后代已退出的证据。
本实现没有新增 supervisor/cgroup 管理系统，采用以下保守判定：

- 同一主机、不同真实 boot ID：旧 Agent 及其所有本机 worker 已停止，可恢复。
- 同一 boot、Agent PID/starttime 已失效，且从未标记 worker 启动：可恢复。
- 同一 boot、worker 曾启动而没有正常释放标记：保持待维护，即使看不到 Agent PID。
- fallback 的同一 instance：视为活执行；其他 instance（包括可信 native 与未知身份混用）：不自动恢复。
- 活 Agent、其他主机、权限不足、空锁或损坏身份：不抢锁。

恢复持锁后把遗留 `building`/`verifying` 记录变为 `failed`，保留部分文件作证据；
继续已授权的 `removing` 清理并保存 `removed`。不删除 ready 软件，不自动重启编译，
不根据磁盘上似乎完整的 prefix 推断 succeeded。verify/load 在启动 worker 前先把
ready 撤销为 unavailable，成功校验后才恢复，避免进程崩溃留下可用库存声明。

## operation 账本与结果

Agent SQLite 的 `software_executions` 在接收 managed 请求、排队执行之前保存
operationId、action、spec 和身份；接触 store 前保存 storeRoot，安装记录和 worker
由同一执行身份连接。SQLite 使用 WAL 和 `synchronous=FULL`，数据库应位于可靠本地磁盘。
材料 ticket、凭据、私钥和 cookie 不进入执行账本。

启动、重连及安装前检查恢复状态；重连时活任务继续运行，不重启也不强制失败。
确认中断后保存 FAILED + `SPACK_INTERRUPTED`；仍需维护的执行保存
FAILED + `SPACK_RECOVERY_REQUIRED`，表示控制操作已失败、底层 worker/锁仍待恢复，
不表示已证明 worker 停止。已有等待者通过原 Server 状态机退出。
其他主机或未知 instance 的未完成账本保持未决，不伪造终态；对相应未释放 store
的新写入返回 recovery required。新 managed 请求可在全新或正常释放的 store 上执行。
原有不含 instance 的完整 native 身份仍可读取并按原规则恢复；缺损身份不能升级成 fallback。
旧版严格 schema 不认识带 instance/null 的新记录，写入新格式后不可直接降级旧 Agent。

终态先持久化，再通过既有软件结果上报。在线发送队列丢失仍可重报，重复 operationId
不会再次执行。Agent 与 Server 均保留第一个终态，晚到 failed 不能覆盖 succeeded。
历史账本、持久 outbox 和重复请求返回的已存终态都携带 `SoftwareOperationResult.replayed=true`。
Server 仍幂等收尾 operation，但不使用历史结果中的 `installed` 快照覆盖当前库存；
例如安装 A 成功消息丢失、随后卸载 B 成功，补报 A 不会把已卸载软件重新登记。
当前库存由既有 heartbeat（非空）和 `installedSoftwareReport`（含已知空列表）更新；
本机库存未知时不发送空报告，不从历史结果推测库存，也不依赖 operationId 的排序代表时间。
安装等待者仍须同时看到 operation 成功及当前库存就绪，库存未确认时继续等待或超时，
不会仅凭历史成功补报派发作业。

升级顺序必须先 Server 后 Agent。新增 proto bool 默认 false，live 结果和旧 Agent
保持原行为；新 Server 能读取旧消息，但无法识别旧 Agent 的历史结果。旧 Server 会忽略
新字段，因此新 Agent 配旧 Server 仍有库存回滚风险。完整保证要求两端均升级；升级本身
不会自动纠正已有错误库存，须等当前权威库存上报确认。生成代码仅通过标准 proto 工具生成。
非 managed legacy 操作不新增 Linux 身份前置条件；其终态也会持久保存，但未开始记录的
旧执行没有自动协调保证。

当前协议没有软件结果接收 ACK：账本终态不会因交给传输层就删除，每次重连按 100 条
分页重报，不将全部历史一次载入内存。已连接期间不周期重报所有历史；服务端接收失败
需后续重连重报。历史仍占磁盘且重连传输量随历史增长，暂无自动保留期/压缩；需要可靠
ACK 后才能安全回收。不要直接删除账本，尤其不要将“已经发送”当成“服务端已经确认”。

固定脱敏诊断如下，记录尚未创建时不会提示 inspect installation record：

| 错误码 | 固定含义 |
| --- | --- |
| `SPACK_LOCK_HELD` | store writer lock held |
| `SPACK_RECOVERY_REQUIRED` | store writer recovery required |
| `SPACK_INTERRUPTED` | software operation interrupted |
| `SPACK_OPERATION_FAILED` | managed software operation failed |

## 旧锁或未知 worker 的受控维护

以下是维护步骤，不是自动恢复命令。特别是旧版真实 operation 没有本地执行账本时，
本修复不会直接改 Server 数据库、伪造其终态或宣称远端已恢复。

1. 暂停向共享 store 提交新的软件操作，并停止所有主机上的相关 Agent、旧版 Agent、
   手工安装写入者及可能自动重启它们的服务。只停当前节点或只取消 workflow 不够。
2. 在每个相关主机确认没有安装 worker、Apptainer PID namespace 内的进程和编译子进程。
   对无法确定来源/后代范围的主机，采用经维护批准的主机重启或可靠 cgroup 整组清理后
   再确认；无法确认的远端主机必须继续阻塞恢复。
3. 留存锁完整目录、records、相关 SQLite 备份与服务端只读状态证据，记录身份与检查结果。
   备份包含安装输出，按站点权限保存；不要纳入版本控制或公开日志。
4. 在所有写入者仍停止且不会自动重启时，将**整个** `.writer-lock` 原子改名到同一父目录
   下唯一的维护证据名称。不要逐个删除代次，不要清空 records、releases 或 ready prefix。
   这也适用于旧空锁。确认只恢复新版受管写入者后，新的请求会建立版本 2 锁。
5. 未完成安装只能由维护者明确选择卸载失败/部分 release 或进行受管重新校验；
   已发布软件优先通过 `import_preinstalled` 重新验证。旧真实 operation 无可验证的执行
   关联时仍需人工处理其调用方，不在数据库中直接补写 succeeded/failed。

验证仅使用临时 store、SQLite、轻量进程及 stub。普通用户身份读取、真实 Agent
子进程 SIGKILL、活孤儿 worker 不可抢、模拟 boot 变化/PID 复用、克隆 machine-id 不同主机名、并发恢复、恢复中
再次崩溃、在线结果丢失重报、等待者退出均有针对性检查；没有实际重启主机、运行
科学软件、验证目标 NFS 或执行远端 kqagent 验收。
