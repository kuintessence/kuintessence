# PBS Sandbox 队列的 cgroup v2 hook

[`kq-cgroup-v2.py`](./kq-cgroup-v2.py) 为显式配置的 PBS 队列建立逐作业 CPU/内存限额，适用于 KQ 当前 `select=1` 的单 vnode CPU Sandbox 作业。
OpenPBS 23 缓存及核对时的上游官方 cgroups hook 仍使用 v1；此 hook 使用 PBS 原生 MOM 事件接入统一 v2。
不依赖 Fabric，不改动机构授权或结算协议。

## 节点配置

要求 Linux cgroup v2、`cgroup.kill`（Linux 5.14+）、CPU/memory 控制器及 Python 3.8+。
CP 管理员预先提供一个专用、由 root 管理的 cgroup 子树，在其 `jobid` 目录开启 `cpu memory` 控制器；
该子树须由 systemd 或节点容器运行时正确委派，父级保留节点总上限。不要复用其他工作负载的分组。
MOM 及其控制进程留在作业分组之外；任务启动 hook 只迁移 PBS 原生 launch parent 或 attach PID。

安装 `/etc/kuintessence/pbs-cgroup-v2.json`（root 所有、不可被组或其他用户写入），例如：

```json
{"cgroupRoot":"/sys/fs/cgroup/kq-pbs.service/jobid","queues":["sandbox"]}
```

路径中的服务仅为示例，须替换成实际已委派的子树；整个父目录链也必须安全。创建 root 所有的 `/run/kuintessence` 目录（0755）。
`queues` 为需要这套约束的既有队列，建议使用独立 Sandbox 队列；未配置队列且无既有分组的作业不会被此 hook 迁移或设限。
配置错误会使 hook 拒绝执行，须先核对节点配置再开放该队列。

在 PBS Server 导入 root 管理的 hook 文件：

```text
create hook kq_sandbox_cgroup_v2
set hook kq_sandbox_cgroup_v2 event="execjob_begin,execjob_launch,execjob_attach,execjob_end"
set hook kq_sandbox_cgroup_v2 alarm=10
import hook kq_sandbox_cgroup_v2 application/x-python default /opt/kq/hooks/kq-cgroup-v2.py
set hook kq_sandbox_cgroup_v2 enabled=true
```

这些是 `qmgr` 命令。配置文件须在每台 MOM 本地部署，hook 须完成向目标 MOM 的分发后再提交验收任务。
平台的队列映射和本地账号授权须指向配置中的队列；当前尚未增加自动读取此配置的 Agent 能力发布或平台队列能力标记。

## 执行与恢复边界

- `execjob_begin` 读取实际 `exec_vnode` 的 CPU 与内存分配，设置 `cpu.max`、`memory.max` 和 `memory.swap.max=0`。
- `execjob_launch` 再核对原分组限额，并按 PBS 官方 hook 的 launch-parent 规则迁入启动进程；`execjob_attach` 核对后迁入 PBS 指定 PID。子进程继承限额。
- 多 vnode、GPU 或其他未支持的 vnode 资源字段拒绝执行，不把整体资源重复应用到多个节点。
- `execjob_end` 只对当前 Job ID 的原 root-owned cgroup 执行 `cgroup.kill`，确认 `populated=0` 后删除分组。
- 同一 Job ID 留有进程时，拒绝重新初始化；不以清空目录或覆盖配置掩盖旧任务仍在运行。
- MOM/主机中断后的孤儿分组、控制器不可用与停止无法确认仍需要独立恢复流程。此 hook 不自动按一次失踪清单删除未知作业，也不证明掉电恢复已经完成。更新配置或撤去 hook 前先排空目标队列。

此 hook 保证已配置队列中的实际分配有内核限额；[签名资源检查器](../../federation/sandbox-cgroup-lab.md)负责核对这些限额与已验证的 Server 资源声明。
带签名 `executionProfile` 的受限 HPC 作业已由 trusted wrapper 强制调用检查器；其他 root 路径、SelfAccount 和启动/队列能力证明仍待补齐，不能仅凭启用 hook 发布全面可用能力。

## 验证

```bash
bun test packages/agent/src/sandbox/cgroup-check.test.ts

KQ_MEDIA_HPC_LAB=1 KQ_MEDIA_HPC_CASE=cgroup KQ_MEDIA_SCHEDULER=pbs-pro \
KQ_MEDIA_PBS_DIR=/absolute/path/to/pbs-cache \
KQ_MEDIA_RUNTIME_DIR=/absolute/path/to/runtime-cache \
KQ_MEDIA_AGE_BIN=/absolute/path/to/age-directory \
PYTHONDONTWRITEBYTECODE=1 python3 scripts/federation-media-hpc.py
```

缓存版本、来源和摘要要求沿用[真实调度器实验](../../federation/media-slurm-lab.md)。
`cgroup` 分支复用一次性 PBS Pod，运行[内核作业脚本](../../../scripts/pbs-cgroup-lab.sh)，不运行科学编译或介质导入。
实验只调整该临时 Pod 内的 cgroup 子树，结束后删除 namespace。

2026-11-09 的真实 OpenPBS 23 作业通过：申请 1 CPU/64 MiB，非 root 检查器读到相同内核上限，
两个短循环使本作业 CPU 限流计数增加 19；128 MiB 分配被内核杀死，`oom_kill=1`；尝试迁出分组被拒绝。
PBS 历史记录退出 0，结束 hook 清理原 cgroup，实验 namespace 已删除。
这次命令先在既有运行器的临时副本中执行，随后整理为公开 `cgroup` 分支；公开入口做了静态检查，没有为改入口重复部署。
初次接入时核对并修正 PBS hook 的 `builtins` 加载入口，同时补充作业/MOM 诊断采集。
未据此认定 Slurm、Torque、完整签名 Sandbox 或跨站撤权链路已通过资源限额联合验收。
