# 科学工作流目标环境与材料

每个工作流按目标环境准备独立材料记录。工作表见[候选软件清单](examples/spack-workflows/inventory.yaml)与[目标环境记录](examples/spack-workflows/acceptance-record.yaml)。这些文件用于维护需求，不是平台导入清单，也不授予安装或执行权限。

## Target 先决条件

| 字段 | 必须确认的内容 |
|---|---|
| `id` | 私有站点 profile 的稳定标识和修订，不写访问凭据 |
| `os`、`architecture` | 目标 Linux 发行版/版本、CPU 架构及实际 Spack target |
| `spack_version`、`compiler` | 精确 Spack、compiler 版本及 runtime 匹配关系 |
| `externals` | 每个 external 的 spec、目标可用性和 ABI 审查；无 external 时明确记录审查结论 |
| `mpi` | provider、版本、ABI 和 launcher；不需要 MPI 时明确写 `not-required` 并说明依据 |
| `scheduler` | Slurm/PBS 类型、版本及单节点/跨节点范围 |
| `runtime_digest`、`site_profile_digest` | 实际可信 runtime/SIF 和 site profile 的固定摘要，不填镜像浮动 tag |
| `storage_layout_review` | 安装、缓存、scratch、共享挂载、UID/GID 和跨节点可见性 |
| `resource_budget_review` | 每项构建/作业的 CPU、内存、PID、磁盘和 walltime 预算 |
| `network_policy_review` | 准备阶段可访问上游的边界；安装阶段仅 Server 交付及隔离验证 |

固定案例的 Ubuntu 20.04 x86_64 环境只是参考。不能以“同为 Linux”推断 compiler、
glibc、MPI、共享存储或 SIF 兼容，也不能将参考 lock 的 target 字段改成站点 target。
profile 变化后须复核受影响的 lock、source audit、安装和运行证据。

## 准备与使用

1. 固定工作流输入、软件版本与 variants，确认需要同进程使用的 Python bindings 和 MPI provider。
2. 保留完整 recipe tree、repo.yaml、patch、辅助模块和许可，制作自包含 Git bundle，分别记录上游与快照 commit。
3. 在目标 Linux 配置中原生生成单 root lock。收集该 DAG 所需 source、resource、下载 patch 和可信 checksum；compiler 与 externals 必须匹配目标 profile。
4. 逐项记录输入的不可变版本、SHA-256、大小与许可。合成数据同时记录生成器修订及随机种子；受限数据独立取得授权。
5. 通过 recipe 和材料导入接口发布，保存精确 `{repositoryId, manifestDigest}` binding，并配置运行环境。导入不执行软件，也不补齐缺失材料。
6. 任务运行前确认安装树与 receipt 有效，使用 managed load 返回的精确环境。各步骤分别绑定环境，通过明确格式的文件交换结果。

重复软件只有在 recipe、lock、target/profile 和 binding 一致时才能复用材料。大型天气、地震和粒子输运计算需要额外模型、数据、内存或 MPI 资源，不能仅按目录中存在软件判断可运行。

## 记录和异常处理

运维记录保存软件 binding、目标 profile、输入摘要、资源预算、Job ID 和结果文件摘要。科学结果按预先确定的数值、收敛或真值条件判断。只完成某个软件步骤时，记录实际处理范围。

按 recipe/求解、缺件/checksum、授权、ABI、构建、资源、隔离、调度、科学结果及网络分类处理异常。网络问题保留 DNS、TLS、HTTP 或超时分类；原始凭据、cookie、token 和预签名地址不进入公开记录。变更材料或 target 后重新确认受影响的依赖与输入。

完整获取和搬运步骤见[材料准备](spack-workflow-materials.md)，发布与运行配置见[材料交付](spack-material-delivery.md)。
