# 科学工作流材料交付与目标验收

## 范围

本文把[15 工作流材料指南](spack-workflow-materials.md)中的候选盘点落实为运维记录。
材料指南仍是 recipe、source mirror、macOS 搬运和 bootstrap/Web 导入的操作说明；
本文负责记录“为哪个 target 准备了什么材料、在哪一步通过或受阻”。

- [候选清单](examples/spack-workflows/inventory.yaml)：15 项工作流及软件、科学输入。
  包名没有版本或 variant，不能作为已经 concretize 的 spec 或完整依赖闭包。
- [空白验收记录](examples/spack-workflows/acceptance-record.yaml)：每个工作流、
  每个 target 各使用一份；同一工作流换 target 必须重新建记录。

这两个 YAML 是**离线工作表，不是平台导入 manifest、Spack 配置或执行器输入**。
平台和 CI 不读取填好的记录来授权安装；记录不能绕过现有 schema、摘要、权限、
lifecycle、visibility、rollout 或 managed worker 检查。仓库 CI 仅验证模板完整性
及候选清单与文档一致，不能据此把任何工作流标成通过。

所有工作流默认未验收。Hello/samtools 的固定 CI 案例仅证明相应提交、材料和参考
环境上的切片，不代表 15 项材料已生成或真实站点可用。

## 建立私有记录

在运维管理的私有目录保存工作表，例如仓库已忽略的 `temp/workflow-handoff/`；
正式交付记录应备份到组织管理的私有存储，不能仅依赖临时目录。
不要把填好的记录、材料、站点路径或内部地址提交到公开 Git。

1. 从候选清单选择工作流 ID，复制空白记录，填写 `workflow_id`。
2. 先补齐 `target_profile`，未确认的值保持 `null`，整体 `status` 保持 `pending`。
3. 为每个实际单 root release 复制一个 `software` 项，不能只为工作流写一条
   混合 spec。`packages` 是需求盘点，不强制每个候选都成为独立安装 root：
   Python bindings 与底层库如须同进程使用，先确认它们能处于一致 DAG；
   在 `satisfies_candidates` 中记录此 release 满足的候选，在 `steps` 中引用其
   精确 binding，不能静默删掉候选。
4. 为每份科学输入及每个实际运行步骤补齐 `inputs` 和 `steps`。
5. 逐 gate 保存证据，失败或缺件保留记录，不填虚假的 digest、binding 或完成状态。

重复软件可复用同一份材料的前提是完整 recipe、lock、target/profile 和 binding
一致，不能只按包名或版本去重。复用材料也不等于复用运行验收结论。

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

## 电脑端手动交付顺序

1. **先定目标与需求**：从候选清单取包名和输入，确定 target、版本、variant 与
   同进程依赖组合。未 concretize 前没有完整下载清单，也不估报已齐备的源码体积。
2. **获取 recipe**：依[macOS 获取与搬运](spack-workflow-materials.md#macos-获取与搬运)
   固定上游 tree，保留完整 recipe、patch、辅助模块及许可，制作自包含 bundle。
   分别记录 upstream commit 与实际 snapshot commit，不混用两者。
3. **取得 Linux 求解材料**：由授权的 GitHub Actions 准备任务消费同一 recipe
   和 target/profile，产生原生单 root lock 及完整 source mirror。
   现有[固定案例导出入口](spack-material-artifacts.md)只支持 Hello/samtools；
   其他候选尚无通用准备入口，必须先补对应准备/验收，不能把候选 YAML 直接上传。
4. **接收完整同批次材料**：bundle、lock、sources、manifest 必须来自匹配的准备
   记录。逐文件核对可信 SHA-256/大小；保存 source 清单摘要、文件数和字节数。
   文件数/字节数只是搬运核对，不是依赖闭包证明。不要自行替换同名源码。
5. **独立准备科学输入**：每项记录稳定来源/对象版本、摘要、大小、使用与再分发
   审查。合成输入记录 generator 修订、随机种子和生成文件摘要；
   账号受限数据、力场、赝势、基组及模型不默认进入公开 artifact。
6. **搬运并导入**：依[材料发布与导入](spack-material-delivery.md)的实际 schema
   使用 bootstrap 或 Web，保存逐 release 返回的精确 binding，再完成下表验收。
   初始化导入不替代后续 Web 维护；批量部分成功不能记为整批成功。

当前没有 15 项可直接一键下载的材料成品。本轮不下载或发布第三方材料，
也不替发布者确认 `redistribution: "unrestricted"`。

## Gate 与证据

状态使用 `pending`、`passed`、`failed`、`blocked`。没有执行就是 `pending`；
已确定先决条件缺失可记 `blocked` 并填写阻塞原因，不能用 `passed` 表示“不适用”。
如工作流不需要 MPI，这是 target 范围，不是跳过 source audit 或 scheduler 的理由。

每条 evidence 至少记录：测试代码完整 commit SHA、Actions run/job ID、
材料 binding、target/profile 摘要、执行时间、检查项与结论。
材料/target 不适用的人工审查项应明确说明范围，并记录审查者和私有审查记录编号；
人工审查不虚构 Actions ID。仅有测试文件、绿色历史 run 或一个链接不构成当前证据。

| 层级 / Gate | 通过条件 |
|---|---|
| 工作流 `target_review` | 上表先决条件明确，可信 runtime/site profile 审查完成 |
| 软件 `recipe_review` | bundle 摘要/tree/HEAD/roots 核对，可信性与静态诊断已审查 |
| 软件 `linux_lock` | 同 recipe、目标配置原生 concretize，单 root/DAG 与发布信息一致 |
| 软件 `source_closure` | lock 的 source/resource/下载 patch 全部有可信 checksum 材料，未遗漏依赖 |
| 软件 `import_readback` | 按实际导入路径成功，binding 精确一致，manifest/blob 回读校验成功 |
| 软件 `source_audit` | 目标隔离 runtime 的源码审计成功，不以静态 manifest 校验替代 |
| 软件 `offline_build` | 受管安装成功；Agent 仅从 Server 获取，未临时出网补材料 |
| 软件 `readonly_verify` | 独立只读校验实际安装树/receipt，失败不自动修复 |
| 软件 `managed_load` | 使用 Server managed load 校验后的精确 release 环境 |
| 软件 `restart_verify` | 保留持久卷且禁用 bootstrap，重启后材料与安装状态复验 |
| 工作流 `input_review` | 数据/脚本的来源、摘要、版本、种子和使用范围均有记录 |
| 工作流 `scheduler_run` | 在所声明 scheduler/节点范围完成真实作业，版本和 executable 路径一致 |
| 工作流 `interface_checks` | 逐步骤文件 schema、单位、维度、上下游绑定及 MPI/Python ABI 一致 |
| 工作流 `scientific_checks` | 执行前固定数值验收标准；结果、收敛或 truth 检查通过 |
| 工作流 `reproducibility` | 相同材料/输入/profile 的独立重跑满足预先确定的容差 |
| 软件及工作流 `cleanup` | 按验收范围卸载/清理、核对引用及卷状态，保留应持久化的材料 |

整体 `status: passed` 只可在所有需求均映射到实际 release/步骤、全部软件与工作流
gate 通过后由审核者记录。若只完成 samtools 的 SAM→BAM 切片，应单独记录切片范围，
不得把工作流 `10` 整体标成通过。表格不是自动验收器，平台不会信任这个状态字段。

## 失败与下一次执行

`blockers` 逐项记录所属软件/步骤/gate、分类、脱敏依据和处理动作。
分类包括 recipe/求解、缺件/checksum、授权、ABI、构建、资源预算、隔离、调度器、
科学结果和网络。网络失败须有 DNS/TLS/HTTP/超时等具体分类；不要把编译报错当作
网络问题。更换测试包属于改变覆盖范围，必须新建或修订记录，旧失败不能抹去。

证据仅保留固定安全 markers、计数、摘要及审核结论，不收集原始环境变量、
cookie、token、带认证参数的下载地址或整份服务日志。
私有完整记录和可公开结果摘要分开保存；公开前再次审查材料及数据的分发范围。

优先完成工作流 10 的现有 samtools 材料交接，再逐 root 推进其余软件并验证文件接口。
同进程 Python/MPI 组合与大型外部输入需要单独准备，不由此顺序保证成功。
真实站点执行必须另行授权；本阶段所有可执行验证仍仅在 GitHub Actions。
