# 离线 Slurm Spack worker 恢复

Agent 失联不会取消仍在运行的构建。不要删除 `.writer-lock`、修改 owner、伪造报告或直接重试旧 staging 的 `sbatch`。Slurm 提交使用 held job：先记录 worker 身份，后 release。提交响应丢失时用持久 job name 查询；零条结果可能是 Slurm 记账延迟，不能据此认定没有作业。

## 现场恢复

1. 在原 login 主机停止旧 Agent；先确认没有旧 Agent 进程还在控制构建。
2. 找到 store 的 `.writer-lock/generations/` 最大序号目录。`owner.json` 的 `operationId` 是原操作 UUID，`worker.json` 的 `recordId` 是 release UUID，`stagingPath` 指向保留的执行证据。仅升级后的 Slurm worker 会写入 `stagingPath`。
3. 使用 `stagingPath/slurm.json` 中的 `jobId`、`name` 查询旧作业：`squeue --name NAME` 和 `scontrol show job -o JOB_ID`；controller 已清除时再查 `sacct -X --name NAME --format=JobIDRaw,JobName,State,ExitCode`。held、running 等非终态需要等待；确需中止时，现场操作者核对 ID/name 后自行执行 `scancel JOB_ID`，等待记账显示终态。不要按猜测的 ID 取消。
4. 执行已编译 CLI：

```sh
kq site recover-spack \
  --store-root /shared/site/spack-store \
  --cache-dir /shared/user/kq-cache \
  --record-id RELEASE_UUID \
  --operation-id ORIGINAL_OPERATION_UUID
```

Slurm 不在 `/usr/bin` 时增加 `--slurm-bin-dir /site/slurm/bin`。开发环境也可用 `bun run packages/agent/src/spack/recover-slurm-worker.ts STORE_ROOT CACHE_DIR RELEASE_UUID ORIGINAL_OPERATION_UUID [SLURM_BIN_DIR]`。

恢复同时检查原 owner 确实停止、operation/release/staging/request 的绑定、同名队列已空，以及 controller 中存在精确 JobId/JobName、明确终态、ExitCode 和 Requeue=0 的唯一作业，或 controller 明确清除后 accounting 中存在唯一且 ID 一致的终态作业。任一查询失败、缺失、重复、活锁或无法证明原 host/process 身份时，保留锁并拒绝恢复。记账延迟后可再次执行同一恢复命令，不会新建 Slurm 作业。无法证明原 owner 的环境应由站点管理员调查，工具不提供强制解锁选项。

恢复追加一代锁历史，把中断的 building/verifying release 标为 failed，保留原 staging 和部分安装文件作为证据。它不会信任 stdout 报告或发布 ready，也不会复用已完成但未验证的构建。随后重新执行正常安装操作；新 release 完成独立 build 与 verify 后才会 ready。旧作业只有在已确认终止后才允许这一新构建。

此恢复工具只访问本机共享目录和本机 Slurm 控制命令，不访问云端，不要求 root。它要求旧 Agent 的原 login 主机与可信原生进程身份可用；跨主机、容器身份不明、旧版缺少 staging 记录的锁仍安全拒绝自动恢复。

Spack worker 固定以 `sbatch --no-requeue` 提交，避免站点默认重排队或抢占策略重复执行同一安装脚本；该策略纳入执行绑定并写入 `slurm.json`。即使 accounting 显示 `PREEMPTED` 等终态，正常执行路径也必须再次确认 `squeue` 中没有该 worker 才允许返回和后续清理。查询失败或仍在队列时保留 staging 与恢复锁。

旧版 journal 没有此策略证明，不能直接续跑。显式恢复除原有队列为空、唯一终态 accounting 证明外，还要求 `scontrol show job` 返回精确 JobId、终态和 `Requeue=0`；无法查询已清除的旧 job 或仍允许重排队时保留锁，需要站点管理员核实并处理，不能仅凭旧 `PREEMPTED` 记录清理。管理员显式执行 `scontrol requeue` 或修改 job 的重排队策略可以覆盖提交约束，不属于自动恢复保证；恢复和清理期间不得对这些 worker 执行此类操作。
