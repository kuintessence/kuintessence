# 计算节点逐作业资源检查

新增 [`kq-sandbox-cgroup-check`](../../packages/agent/scripts/kq-sandbox-cgroup-check) 读取当前进程的内核 cgroup 及挂载信息，核对指定调度器作业的 CPU、内存边界。
它不创建限额、不验证 Server 签名、不提交任务。带签名 `executionProfile` 的受限 HPC 作业已通过 trusted wrapper 强制调用：Agent 传递已验证清单中的资源值，节点配置指定调度器，原生作业编号必须匹配当前内核分组。SelfAccount 已接入启动探测、逐作业检查及明确队列绑定，真实 Slurm 验收仍待完成；其他 root 路径及其启动/队列能力发布尚待接入；`AGENT_SANDBOX_CGROUPS` 配置不能据此视为已完成生产验收。

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
trusted wrapper 使用固定 `/usr/bin/python3 -I`，忽略用户 Python 路径及 site hooks。节点 profile 须配置 `KQ_CGROUP_CHECK_PATH`、`KQ_CGROUP_CHECK_SHA256` 和 `KQ_SCHEDULER`（`slurm`、`pbs-pro` 或 `torque`）；路径、摘要、root 所有权与全部父目录权限均在执行前核对，环境变量不能补全遗漏的本地配置。
`--check-profile` 只验证节点依赖；真正的逐作业核验在调度作业内部运行，失败退出 126，用户脚本不会启动。

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
PBS 已提供显式队列的[原生 v2 hook](../schedulers/pbs/cgroup-v2.md)。trusted wrapper 已接入固定摘要、root 管理的检查器，并在用户脚本前核对已签名资源。SelfAccount 已将路径正则替换为实际检查：配置固定检查器及明确队列，启动探测申请 1 CPU/128 MiB，读取真实内核限额；证明 ID 同时绑定队列与检查器身份。每次执行再次读取已核验的同一份检查器字节并检查签名资源。队列随能力上报，首次派发、Agent 提交和联邦续租均要求匹配。后续仍须配置 Slurm 实际 v2 路径，完成 SelfAccount 真实调度验证和其他 root 路径的启动/队列能力证明。
PBS 受限 root profile 的双平台联合验证已通过；其余接入、Slurm 配置及真实联合验证完成前，完整资源隔离验收保持未完成。完整联盟链蓝图及 PR 预览验收范围不变。
