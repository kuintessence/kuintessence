# 计算节点逐作业资源检查

新增 [`kq-sandbox-cgroup-check`](../../packages/agent/scripts/kq-sandbox-cgroup-check) 读取当前进程的内核 cgroup 及挂载信息，核对指定调度器作业的 CPU、内存边界。
它不创建限额、不验证 Server 签名、不提交任务。带签名 `executionProfile` 的受限 HPC 作业已通过 trusted wrapper 强制调用：Agent 传递已验证清单中的资源值，节点配置指定调度器，原生作业编号必须匹配当前内核分组。SelfAccount 已接入启动探测、逐作业检查及明确队列绑定，单平台真实 Slurm 启动证明与签名任务已验收，跨平台联合验收仍待完成；其他 root 路径及其启动/队列能力发布尚待接入；`AGENT_SANDBOX_CGROUPS` 配置不能据此视为已完成生产验收。

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

## 真实 Slurm v2 作业

在允许一次性特权 Pod 的本机 k3s 上，显式执行：

```bash
KQ_SLURM_CGROUP_LAB=1 PYTHONDONTWRITEBYTECODE=1 \
  python3 scripts/slurm-cgroup-lab.py
```

[运行器](../../scripts/slurm-cgroup-lab.py)使用固定 amd64 Debian 13 镜像摘要和 Slurm `24.11.5-4+deb13u1` 二进制包，不编译调度器或科学软件。需要本机 Bun、kubectl、镜像仓库及 Debian 软件源；它是在线建立实验环境的入口，不是离线安装验收。Pod 总上限为 1 CPU/1 GiB、600 秒；源码只读挂载，不挂载宿主凭据，不修改宿主 Slurm 或 systemd。

外层只在自身 Pod cgroup 下启用控制器；内层使用独立 cgroup/mount/PID namespace，并重新挂载仅可见实验子树的 cgroup2。Slurmd 使用独立 service 分组，启用 `task/cgroup`、`proctrack/cgroup`、RAM/swap/core 约束。`IgnoreSystemd` 仅供该隔离实验使用，不能单独作为宿主隔离措施。原生 sbatch 作业以 UID 24001 在 `sandbox` 队列运行产品的 SelfAccount 检查命令，核对独立 cpuset、128 MiB 内存和不可写控制路径，并在结束后确认原 `job_<id>` 分组消失。

2026-11-09 实际入口退出 0，报告 `cpusetCpus=1`、`memoryBytes=134217728`；原作业 cgroup 已删除，随机 namespace 已确认清理。Slurm 23.11 的早期实验在该 namespace 布局下回收 stepd 时出现 EBUSY，因此没有将它作为通过证据；24.11 使用独立系统分组回收且已实际通过。原始日志保存在本机 `temp/kq-slurm-cgroup-*/`，包含镜像摘要、包版本、关键二进制摘要和源码提交号。控制器在正常退出、失败、SIGINT/SIGTERM 时请求删除 namespace，Pod deadline 是控制器异常退出时的运行时限，不能代替 namespace 清理。

此项只证明真实 Slurm 内的产品资源检查与调度器分组回收。尚未覆盖完整 SelfAccount 启动证明、签名 SIF/Apptainer 执行、跨平台派发或 Slurm OOM/限流负载，不应据此宣称这些验收完成。

## SelfAccount 启动证明与签名任务执行

同一入口增加真实运行时模式；先备齐本机 `temp/federation-runtime/` 下的 Apptainer/SUID 固定摘要包与轻量 `bash.sif`，然后执行：

```bash
KQ_SLURM_CGROUP_LAB=1 KQ_SLURM_SELFACCOUNT=1 PYTHONDONTWRITEBYTECODE=1 \
  python3 scripts/slurm-cgroup-lab.py
```

运行器校验缓存安装包摘要，Bun 打包当前产品入口，在一次性 Pod 内生成 RSA 密钥签名 SIF，导出公钥后删除私钥。Debian 13 使用配套的 `squashfuse=0.5.2-0.2+b2` 及 FUSE ABI，替换缓存 Apptainer 自带的旧挂载 helper；包版本与 helper 摘要写入实验日志。所有安装和配置仅发生在临时 Pod，源码和宿主 Bun 只读挂载。

UID/GID 24001 调用真实 `attestSandboxRuntimeEnvironment`：检查 root 管理路径、SIF 签名、原生队列资源、seccomp 对照命令及网络接口，随后使用本地临时 Ed25519 密钥签名轻量任务。产品 verifier、stager 和 Slurm adapter 负责验签、一次性 nonce、输入暂存及实际提交。任务读取只读输入，核对 seccomp/no-new-privs/socket 拒绝，写入受限输出；产品输出校验读取 JSON。实验同时断言重复 nonce、错误队列和资源篡改被拒绝。该模式是 SelfAccount 普通沙箱，不启用只允许受控 root profile 的 `restrictedNoEgress`。

2026-11-09 实际入口退出 0，原生 Job 3 为 COMPLETED/0，出现 `REAL_SELFACCOUNT_SIGNED_EXECUTION_OK`；证明绑定 `sandbox` 队列和实际 `slurm` 节点，实验 namespace 已删除。此前两次环境准备/运行失败分别发现 Debian 13 的 FUSE 包名变化和旧 helper ABI 不兼容，均被拒绝，未算作通过；修正实验依赖后完成验收。

此处签名方为本地临时夹具，不包含两套 Server、联邦传输或介质交付；也未验证跨节点共享存储、主机掉电或 Slurm OOM 负载。这些仍须在对应联合实验中验收。

同一真实运行时入口现增加 root 提交非 root 探测与超时取消实验：root 持有只读探测脚本，仅把日志目录交给 UID/GID 24001，提交 CLI 用 `setpriv` 和最小环境切换账户；实际作业核对本身 UID 和 cgroup。另一作业运行轻量 sleep，5 秒观察期限到达后取消原 scheduler ID，确认终止且实际 PID 不再存在，然后才清理探测文件。

2026-11-09 该入口再次退出 0：SelfAccount 签名 Job 3 COMPLETED/0，root 发起的 Job 4 以 UID 24001 成功，原 Job 5 被取消且 PID 消失；出现 `REAL_ROOT_SUBMITTED_NONROOT_PROBE_OK` 与 `REAL_NATIVE_PROBE_CANCEL_AND_CLEANUP_OK`，临时 namespace 已删除。后续新增的并发/遗留收据阻止重投规则由单测覆盖，未因记录格式调整重复原生实验。

这只验证 root 使用原生探测入口的账户/资源与失败收尾。生产 root 能力发布尚未切换到这份证据，PBS/Torque 的适配器工厂与文件/失败规则只有单测；完整 root SIF/ECL 启动证明、跨调度器真实探测、Server 签发与续租仍需接通后验收。

该入口现追加[完整 root SIF/ECL 探测](../../scripts/federation-live/slurm-root-attestation.ts)。在同一临时 Pod 内生成 OpenPGP 密钥、签名轻量 SIF、导入全局公钥后删除临时私钥目录。生产探测函数按固定指纹离线验证全部 SIF 对象，再以明确的非 root 账户提交原生作业，验证 ECL 实际文件路径/摘要、已签名镜像成功执行、未签名镜像被 ECL 拒绝，以及原有 seccomp、网络和 cgroup 对照。主机 keyring、凭据和服务均不改动。

2026-11-09 最终入口退出 0，原 Job 6 COMPLETED/0，报告 `REAL_ROOT_SIF_ECL_ATTESTATION_OK`；返回 root 证明的 networkIsolation/cgroups/seccomp/sifSignatureVerification/ecl 均为 true，绑定 `sandbox` 队列与 `slurm` 节点，namespace 已确认删除。两次先前失败分别发现 PEM/PGP 混合验证契约不适用于 ECL，以及上游 JSON 的 KeyLocal 只表示个人 keyring、不包含全局 keyring。现使用单一 OpenPGP 签名和固定指纹，核对真实上游报告语义后通过；没有以普通失败冒充 ECL 拒绝。

PBS Pro/Torque 入口的账户切换、资源检查器原生 ID 和状态处理已有单测；本轮没有再次部署 PBS/Torque。生产 root 能力发布、全部逐作业路径、Server 队列/证明签发与续租、双平台联合验收仍未完成。

## 仍需完成的接入

现有实验 Slurm 19 使用 `task/none`，缓存的 OpenPBS 23 官方 hook 使用 v1；当前主机采用统一 v2。不能仅设置一个能力开关而宣布具备限额。
PBS 已提供显式队列的[原生 v2 hook](../schedulers/pbs/cgroup-v2.md)。trusted wrapper 已接入固定摘要、root 管理的检查器，并在用户脚本前核对已签名资源。SelfAccount 已将路径正则替换为实际检查：配置固定检查器及明确队列，启动探测申请 1 CPU/128 MiB，读取真实内核限额；证明 ID 同时绑定队列与检查器身份。每次执行再次读取已核验的同一份检查器字节并检查签名资源。队列随能力上报，首次派发、Agent 提交和联邦续租均要求匹配。后续仍须完成 SelfAccount 跨平台联合调度验证和其他 root 路径的启动/队列能力证明。
PBS 受限 root profile 的双平台联合验证已通过；现代 Slurm v2 的原生资源检查和回收也已通过上述独立实验。其余接入和真实联合验证完成前，完整资源隔离验收保持未完成。完整联盟链蓝图及 PR 预览验收范围不变。
