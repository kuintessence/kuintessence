# 真实 Slurm 会计采集检查

默认开发 Slurm AIO 关闭会计存储和采样，不能证明真实累计 CPU 用量。本检查在独立容器内启用 MariaDB、slurmdbd 和 jobacct_gather/linux，通过生产 SlurmAdapter 提交一个短任务、读取终态计量与输出，并保存原始 sacct 行。

## 运行

需要与源码目录同机的单节点 Kubernetes、kubectl、Bun 和已安装的工作区依赖。当前 kube context 必须指向该开发集群；脚本只创建、删除自己随机命名的 namespace。容器只读挂载当前 checkout，不挂载部署凭据、宿主数据库或 Docker socket；会计数据库和随机口令仅在临时容器内。

```sh
KQ_ACCOUNTING_LAB=1 \
KQ_ACCOUNTING_IMAGE=ghcr.io/kuintessence/kq-dev-scheduler@sha256:9436d1c2a6875f53f42e8adc7c3a13068a4903a99920c06ff1201af0fd759e0d \
bun scripts/federation-slurm-accounting.ts
```

上述镜像为已验证的 Ubuntu 20.04 / Slurm 19.05.5 KQ 开发运行时，包含 Bun、Python 和原 Slurm 配置模板。替换镜像时须保持这些工具与路径兼容，并指定 SHA-256 digest。脚本在临时容器中安装 slurmdbd/MariaDB，因此需要包源网络；这不是离线软件安装验收。安装日志保留实际包版本。

容器上限 1 CPU、1200 MiB，20 分钟自动截止；作业申请 1 CPU、64 MiB、60 秒，Python 执行约 2 个 CPU 秒后输出固定标记。MariaDB 只使用容器内 Unix socket，64 MiB buffer pool 用于小型验收，不是生产配置建议。不会启动 Agent、Server 或修改现有集群。

## 结果和边界

输出写入忽略的 `temp/kq-accounting-<随机值>/`：

- `observation.json`：真实 schedulerJobId、每次状态/计量观测、原始 sacct 汇总/步骤行及输出校验结果。
- `checkout.json`：镜像 digest、独立 namespace 和基础配置模板。
- `install.log`、`setup.log`、`scheduler.log`：安装和运行诊断；失败时增加 `failure.log`。

正常或检查失败后请求删除所属 namespace；外部强制终止脚本时可按输出目录中的 namespace 定位残留，Pod 的 activeDeadlineSeconds 仍限制运行时间。保留完整私有输出用于核对，不公开上传运行环境日志。

真实 Slurm 可能先给出终态，再补齐汇总计量：已观测到汇总 ElapsedRaw=0 而 batch=2，之后汇总修正为 2。适配器发现同任务步骤仍运行、状态未知，或步骤时长/CPU 用量超过汇总时，保留终态但不提供本次 accounting。不会把步骤累加成第二份用量，也不会用申请资源补算；合法零值仍可保留。后续明确查询可取得一致记录。

本检查证明真实 Slurm、sacct 和生产适配器的组合；不证明 Agent 持久消息、两台 Server、自动签名报告、PBS、Fabric 或完整科研工作流已经联合通过。探针后续查询不是生产迟到计量补采功能；当前终态后若未取得一致计量，仍须显示缺失。自动补采应以追加观测实现，不覆盖原始终态证据，也不能将本检查的重复查询描述为已经完成该能力。
