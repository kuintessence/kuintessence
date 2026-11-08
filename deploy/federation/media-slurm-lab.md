# 导入数据的真实 Slurm / PBS / Apptainer 验证

此实验验证 Agent 端的真实 age 导入、签名 Sandbox 准备、映射 Unix 账号执行和独立 watchdog 停机。使用 256 KiB 合成数据及 Bash，不安装科学计算软件。

| 场景 | 判据 |
| --- | --- |
| 正常完成 | age 解密导入 → 签名清单校验 → 本地来源复制 → Slurm/PBS 提交 → Apptainer 读取全部输入，禁止改写，容器无默认网络路由 → 成功终态/0 |
| 持久停止决定 | 脚本实际读取输入并进入 sleep；将原运行收据置为 stopping；独立 watchdog 按原 Job UUID、派发代次及映射账号定位作业；Slurm CANCELLED 或 PBS 非零退出终态，且持久停机证明存在 |
| Agent 强制退出 | 脚本实际读取输入并进入 sleep；暂停 supervisor 自动重启、SIGKILL Agent 主进程，保留独立 watchdog；原 15 秒运行租约自然到期；Slurm CANCELLED 或 PBS 非零退出终态，且持久停机证明存在 |

停止决定在本实验直接写入生产收据服务，**没有调用跨站来源撤权 API**。清单由临时平台密钥签署；SIF 用另一把临时密钥实际签署及验签，随后绑定文件 SHA-256 和生产 trusted wrapper。这个探针直接进入 Agent 生产组件，不经过完整 AgentStream、Server/Data Market 发布、DATA_WAITING 恢复或生产启动时的整套安全能力证明。它不是完整端到端联邦验收，也不验证实际跨主机传输、主机掉电、生产 cgroup 强制限额或离线科学软件安装。

## 运行条件

- 单节点、可销毁实验资源的本机 Kubernetes；`kubectl`、Python 3、已安装依赖的 Bun checkout。
- 节点已缓存脚本固定的 amd64 KQ Slurm 镜像；不会构建或拉取新镜像。
- `KQ_MEDIA_RUNTIME_DIR` 中有 `apptainer.deb`、`apptainer-suid.deb` 和 `bash.sif`。前两项分别为官方 `v1.4.3` 的 `apptainer_1.4.3_amd64.deb`、`apptainer-suid_1.4.3_amd64.deb`，运行器按官方 SHA-256 校验。SIF 至少包含 `/bin/bash`、`/usr/bin/cat`、`/bin/sleep` 及对应动态库、`/proc` 挂载点；实验只修改 Pod 中的副本。
- `KQ_MEDIA_AGE_BIN` 指向官方 age 1.3.2 的 `age`、`age-keygen` 目录，沿用生产 MediaAge 的固定摘要校验。
- Pod 内安装小型 `liblzo2-2` / `libfuse3-3` 依赖，因此**实验准备需要软件源访问**；不能据此声明离线部署已通过。

```bash
KQ_MEDIA_HPC_LAB=1 \
KQ_MEDIA_RUNTIME_DIR=/absolute/path/to/runtime \
KQ_MEDIA_AGE_BIN=/absolute/path/to/age \
python3 scripts/federation-media-hpc.py
```

仅复查失败场景可增加 `KQ_MEDIA_HPC_CASE=complete`、`stop` 或 `agent-crash`；默认执行三项。强制退出场景结束时恢复 supervisor，避免把 Agent 自动重启后的停止当成独立 watchdog 的证明。

[运行器](../../scripts/federation-media-hpc.py)创建独立随机 namespace，Slurm 使用 1 CPU / 1 GiB、PBS 使用 2 CPU / 2 GiB Pod 上限，自动注册、Spack、SSH 均关闭，不加载已有平台凭据或连接部署 Server。为嵌套 Apptainer 的挂载与命名空间使用临时 privileged Pod；这是实验配置，不应作为生产安全配置。宿主 checkout、runtime 和 age 只读挂载，不修改宿主安全策略。Apptainer setuid 包用于适配本机限制非特权 user namespace 的内核，不通过放开宿主 sysctl 绕过限制。

[探针](../../scripts/federation-media-hpc-probe.ts)只输出场景、调度器 ID、输入字节数和结果。临时签名私钥在 Pod 内生成；SIF 签署后即删除私钥文件，其他密钥留在进程内存。正常结束、异常及终止信号均请求清理自有 namespace；Pod 另有 20 分钟运行上限（首次 PBS 编译为 60 分钟）。日志保留在 `temp/kq-media-{slurm,pbs-pro}-*/`，不纳入 Git。

## 实际结果

2026-11-09：上述三项通过，Slurm 19.05.5、Apptainer 1.4.3。首次真实执行暴露并修复两类产品问题：

- root 所有的准备目录不可被映射账号穿过，且调度器无权创建日志。现在共享 Sandbox 根仅开放穿过权限，不开放目录列表；作业目录按映射组只读可进入；嵌套输入父目录可穿过，文件和脚本保持只读；日志放在执行账号所有的 `.scheduler-logs` 中。Slurm/PBS/Torque 渲染均沿用该目录。
- Slurm 恢复原先默认查询 Agent 自己的 UID，遗漏映射账号提交的作业。现在 Agent 恢复和独立 watchdog 都携带已验证的执行账号；Slurm 活动/历史查询及保留作业核对使用该 UID，仍匹配 UUID、代次名和配置的 account；PBS/Torque 同时核对 Job_Owner。PBS 后续真实验证见下文；Torque 只有适配器回归，未完成真实调度验收。

部署须将 `AGENT_SANDBOX_ROOT` 配为专用目录，确保其外部父目录可被映射账号穿过；程序不会修改该根以外的目录权限。旧工作目录不在原地迁移；已提交作业仍由调度器保存的原日志路径读取，新准备作业使用新目录布局。受限数据不会作为可写输出挂载，普通无持续授权的作业仍不能消费导入副本。


## PBS 运行与结果

使用 `KQ_MEDIA_SCHEDULER=pbs-pro` 和 `KQ_MEDIA_PBS_DIR=/absolute/path/to/pbs`。该目录必须包含 `openpbs.tar.gz`：OpenPBS 23.06.06，源码提交 `be361a18ef37652bece0811ec709f0fe4fc52710`，从 `https://codeload.github.com/openpbs/openpbs/tar.gz/be361a18ef37652bece0811ec709f0fe4fc52710` 取得，SHA-256 为 `297ea4d5933e867b51366b213184a5251a41261f16079ffde86511e0bbc6606c`。许可证与版权声明保留在原源码中。

没有缓存时，运行器在自有 Pod 内调用[构建脚本](build-pbs-lab.sh)，以 `make -j2` 构建 `/opt/pbs`；随后将未初始化的安装目录打包为 `pbs-install.tar.gz`，连同源码和 `pbs-install.json` 保存到实验记录目录。后续可把该目录用作 `KQ_MEDIA_PBS_DIR`，运行器检查源码摘要、版本、基础镜像及缓存归档摘要，并核对实际 qsub 版本。缓存是本地构建产物，JSON 是本地来源记录，不是发布方签名，也不能认证来自不可信方的二进制。

PBS 准备阶段需要软件源安装 PostgreSQL 和运行库，首次编译还需要开发工具；均仅写入临时 Pod，不安装到宿主机。实际运行使用生产 PBS entrypoint：默认 Agent 仍为 `kq`；只有明确 `AGENT_SANDBOX_ROOT_IMPERSONATION=true`，且执行模式为 `root-impersonation` 或兼容旧配置的 `disabled`，才启用 root Agent，由签名 Sandbox 映射到非 root 执行账号。冲突模式启动失败。此模式验证的是映射作业，不代表 root Agent 能直接提交普通未映射 PBS 作业；部署不得据此允许 PBS root 作业。

2026-11-09：OpenPBS 23.06.06 的正常执行、持久停止决定、Agent SIGKILL 后独立 watchdog 停止均通过，最终用新建 Pod 和校验后的缓存完整复跑三项。PBS 默认在结束后复制日志；运行中探针仅从 MOM spool 确认脚本已读取数据，最终通过生产 `getJobLogs()` 核验输出，没有修改生产日志模式。运行器通用化后还通过了一次 Slurm 正常场景回归。首次源码编译成功；公开构建脚本与该构建命令一致并通过语法检查，但其无缓存自动分支未再单独重编译。

真实测试发现 PBS 反复 `qdel` 会重置 MOM 的 TERM→KILL 截止时间，导致已撤权任务持续运行。现在带联邦派发代次的 R/S/U 作业先通过调度器 `qsig -s KILL` 终止，再删除；E 状态等待退出，不重复删除，F 状态直接进入终态核验。排队任务仍通过 qdel 取消，普通作业保持原取消方式。Agent 嵌入执行器和独立 watchdog 都传递原代次；成功发送命令仍不算停机，必须取得原作业的正向停止证明，才能清理受限输入。首次失败任务曾人工发送 KILL 用于诊断，不计入通过结果。
