# 计算节点逐作业资源检查

新增 [`kq-sandbox-cgroup-check`](../../packages/agent/scripts/kq-sandbox-cgroup-check) 读取当前进程的内核 cgroup 及挂载信息，核对指定调度器作业的 CPU、内存边界。
它不创建限额、不验证 Server 签名、不提交任务。目前尚未接入 trusted wrapper、SelfAccount 启动证明或 Agent 能力发布；现有 `AGENT_SANDBOX_CGROUPS` 配置不能据此视为已完成生产验收。

## 检查口径

- 按 `/proc/self/cgroup` 与 `/proc/self/mountinfo` 定位实际 cgroup，拒绝普通文件系统、歧义挂载、路径越界和隐藏作业根的挂载。
- Slurm 对应 `job_<jobId>`；PBS 对应 `jobid/<jobId>`；Torque 对应 `torque/<jobId>`。当前进程必须属于该作业或其子 cgroup，不能以父 Pod 或整个节点限额替代。
- 作业根的 CPU quota/period 不超过声明 CPU 数，或者作业根显式配置的 cpuset 不超过声明 CPU 数。只继承父容器的有效 cpuset 不计为逐作业分配。
- 作业根内存上限不超过声明 MiB；cgroup v2 禁用作业 swap，v1 要求层级内存计数且在启用 swap 时核对 memory+swap 合计上限。
- 检查作业到根的目录所有权及权限、进程/线程迁移入口、控制器开关与实际限额文件；非 root 所有、组/其他用户可写、符号链接或数据缺失均拒绝。

可在已配置原生 cgroup 的 Slurm 作业中手工诊断：

```bash
/usr/bin/python3 /usr/libexec/kuintessence/kq-sandbox-cgroup-check \
  --scheduler slurm --job-id "$SLURM_JOB_ID" --cpus 1 --memory-mb 128
```

成功输出 JSON，检查失败退出 126。该命令的参数由操作者提供，仅作为诊断；产品接入时必须由已验证签名中的资源值及实际调度器 Job ID 构造参数，不能把任意 CLI 参数当成授权。
节点须具备 Python 3.8+ 和对应内核控制器；不同厂商调度器使用不同 cgroup 布局时会拒绝，不自行猜测其他作业路径。

## 可重复验证

离线边界夹具已进入 Bun 测试入口，无需 root 或实际调度器：

```bash
bun test packages/agent/src/sandbox/cgroup-check.test.ts
```

真实内核实验需在允许创建临时 systemd 服务的 Linux/cgroup v2 主机上以 root 显式运行：

```bash
KQ_TEST_CGROUP_LIMITS=1 PYTHONDONTWRITEBYTECODE=1 \
  python3 scripts/sandbox-cgroup-kernel-lab.py
```

[运行器](../../scripts/sandbox-cgroup-kernel-lab.py)仅创建随机命名的临时 systemd 单元，外层上限为 1 CPU、256 MiB、32 个任务、45 秒，禁用 swap。
在该单元内建立隔离的作业 cgroup，以非 root 进程读取检查器，验证父容器限额不被误认、错误作业 ID、超限、继承 cpuset、可写控制文件和逃逸尝试均被拒绝。
随后使用两个短时循环观察作业 `cpu.stat` 中的实际限流；在 64 MiB 作业内申请 128 MiB，核对 SIGKILL 与 `memory.events.oom_kill` 增长。结束后删除自建目录并停止临时单元。

2026-11-09 实际命令退出 0：CPU 限流计数增加、作业内存超限进程被终止、外层控制进程正常完成，临时服务清理成功。Slurm/PBS/Torque 名称在此仅用于验证内核路径布局，**没有启动这些调度器**；v1 只有离线夹具覆盖。
本实验不替代真实调度器逐作业配置、计算节点执行前强制调用、启动能力证明及联合撤权验收。

## 仍需完成的接入

现有实验 Slurm 19 使用 `task/none`，缓存的 OpenPBS 23 官方 hook 使用 v1；当前主机采用统一 v2。不能仅设置一个能力开关而宣布具备限额。
后续须配置实际支持的调度器 cgroup 路径，将检查器作为固定摘要、root 管理的节点执行依赖，并让执行入口在启动用户脚本前核对已签名资源；SelfAccount 的路径正则检查也须替换。
这些接入和 Slurm/PBS 真实联合验证完成前，完整资源隔离验收保持未完成。完整联盟链蓝图及 PR 预览验收范围不变。
