# 普通 Slurm 作业的提交对账

Agent 在执行 `sbatch` 前保存稳定 job UUID、scheduler name、命令、环境和输出绑定。提交 intent 是独占记录；已有 intent 或已确认的执行不能被第二次提交覆盖。确认 scheduler ID 只允许 pending→确定 ID，或相同 ID 的幂等重试；不同输入、不同 scheduler ID 均保留原账并要求对账。

`sbatch` 最长等待 30 秒，控制查询、取消及日志读取最长等待 10 秒。超时只表示本地没有得到确定响应，不能证明 controller 没有接受作业。`sbatch` 自身 exit 1 也可能是响应通信失败；只有空 stdout 加整行匹配的已知 controller 拒绝会直接判定提交失败，其余非零结果保持未知。

对账使用完整 `KQ_JOB_ID=UUID` comment 和稳定 scheduler name，而非短名称单独匹配。默认恢复请求会查询当前用户/指定 account 的 `squeue` 与提交日期范围内的 `sacct`。已配置 `scontrol` 终态后端的站点，改为合并 `squeue` 与 controller 保留的作业记录；严格验证完整 comment、稳定名称、account（未指定 account 时验证当前 UID）和唯一 ID，歧义仍拒绝确认：

- 同一个 allocation ID 同时出现于队列和记账，只确认一次。
- 同 UUID/name 出现不同 allocation ID，或返回非法 ID，明确标记无法唯一确认。
- 已配置的记账后端暂时不可用、结果暂缺或命令超时，不触发新 `sbatch`，也不把未知执行当作已停止。

未启用 accounting 时，controller 的 `MinJobAge` 必须覆盖预期恢复窗口。原作业已从 controller 清除且没有可信完成快照时，不能从共享输出猜测终态；未知 intent 会继续保留。延长保留时间是站点管理员配置，普通用户初始化不会擅自修改。

恢复沿用持久化的原命令和输出绑定；迟到的确认不能重新建立已经完成或取消的 intent。Agent 的周期恢复会继续查询未知提交，稳定控制流连接期间也会处理。若长时间无法唯一确认，现场操作者应核对 UUID/comment、scheduler name、account 与原始提交时间，保留 Agent 数据库和 scheduler 证据，不删除 intent 或手动重提同一 UUID。

取消请求成功不等于 worker 已退出；只有明确终态确认后才能清理执行记录或报告取消完成。此文档描述普通作业；Spack store writer 的显式恢复另见 [Spack Slurm 恢复](offline-slurm-recovery.md)。

## 计算完成后的输出采集

普通作业的主机输出读取或路径验证遇到带明确 errno 的暂态 I/O 故障（例如 `EIO`、`ESTALE`、
`ETIMEDOUT`）时，不发布缺项结果、不把计算改报失败，也不释放 scheduler 记录或本地恢复账本。
Agent 按原轮询间隔重新采集；退出或重启后仍接管原 scheduler ID，不执行第二次 `sbatch`。
已收集的部分 descriptor 不单独上报为完整结果。Sandbox 保留原有输出验证与可选文件读取语义。

这不是对任意异常无限重试：缺失文件、权限拒绝、符号链接、路径越界及材料保护校验不属于暂态 errno 白名单，
沿用既有拒绝或跳过行为。stdout 只有底层 reader 保留上述错误码时才适用；Slurm `tail` 的普通非零退出
目前没有可靠的 errno，仍按既有日志捕获失败处理，不能把注入 errno 的单元测试当作真实 NFS 日志验收。

旧记录或未配置持久 completion hook 的嵌入式调用没有“已计算完成、待采集”快照；这类记录重启后的自动采集仍依赖 scheduler/accounting 能查到原作业真实终态。
若历史已清除，保留账本及共享输出供人工核对；不会猜测完成状态或自动重新计算。工作流文件的上传与发布恢复另见
[传输恢复](offline-slurm-multipart-recovery.md)。

### 持久计算终态快照

配置持久 ActiveRemoteJobs 账本的 Agent 对普通非 Sandbox 作业收到调度器真实 `completed` 后，先在已有 SQLite `active_remote_jobs.spec` JSON 中保存 `completionSnapshot`，再读取输出。快照格式 `format: 1` 包含原 scheduler ID、真实结果（exitCode、node 等）与原 spec/expectedOutputs 的 SHA-256 执行绑定；工作目录、受限输出策略、保护路径及清理绑定都参与校验。写入使用原 scheduler ID 与原 spec 的比较更新，记录缺失、变化、写失败或结果冲突时不采集、不上报完成、不释放现场。

重启后，恢复链重新验证原账本身份、快照版本及执行绑定，直接使用真实完成快照采集输出，不再依赖 `sacct` 历史仍存在，也不调用提交或依赖调度器元数据的 prepareResume。输出暂态读取失败继续重试同一完成执行。快照不包含已采集文件正文；必须保留原输出工作目录。缺少快照的旧记录仍按原调度器查询路径恢复，不能从 stdout、缺失历史或任意用户声明合成 completed。

完成快照同时保存可获取的调度器用量，按共享 schema 校验并绑定原 scheduler ID；重启后沿用原观测时间与用量，不重新查询或生成数值。此路径也覆盖 PBS 返回用量的完成结果；缺少用量的历史快照仍可恢复。

Sandbox 不写入或使用此普通作业快照；restrictedNoEgress 的快照保留原策略并继续禁止输出和日志采集。恢复前仍检查撤销墓碑及 cleanup intent，用户取消不会被快照覆盖。尚未收到真实完成结果或完成快照未写入成功的崩溃窗口，仍需要调度器记账证明。

此功能复用现有 spec JSON，无 SQLite SQL migration，但改变了持久状态语义。发布必须升级发行 `stateFormat`（例如由 `slurm-site-v3` 升为 `slurm-site-v4`），禁止带有快照账本时切回不识别它的旧 Agent；不能把无 SQL migration 当作可跨版本回滚的证明。读取遇到未知快照版本、错误 scheduler ID 或 spec/输出绑定变化时保留账本并拒绝自动恢复。
