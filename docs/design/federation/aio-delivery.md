# 新增三机 AIO 的实施与验收

采用用户确认的布置：三台新增 2核4GiB 主机分别承载独立 A/B/C KQ、Fabric 和 Docker 测试集群；A/B 用 Slurm，C 用 PBS，R 按需在 A 主机使用独立项目。原集群角色不变，现有主平台只新增第四个 Orderer。四个 SmartBFT 节点位于四台主机，同一 VPC 不等于跨地域容灾。

东京 `kq-k3s` 是 containerd 本机构建机，使用独立 namespace 的 nerdctl/BuildKit 构建和导出；目标使用 Docker 加载。机构独立持有业务身份和授权，仍须明确共同托管的宿主机管理员边界。

## 已实现与待执行

[离线工具](../../../deploy/federation/aio/README.md)已提供固定提交串行构建、镜像/文件摘要、续传、加载、显式启动及按需 Fabric 管理入口。AIO 沿用生产 Compose 和机构入口，保留正式 SSO/enforce 权限；区分无链、有链、R 和第四 Orderer。Agent 预编译、使用正式文件令牌注册，未知结果持久保留；调度资源按 cgroup 申报。链管理复用原初始化脚本，只使用交付镜像，不拉取、不构建、不连带启动依赖；R 和第四节点不能扩大操作范围，沿用原部署锁与身份。

未启动 AIO 平台／测试集群、真实作业或远端发布，未合并。nerdctl 2.4.2 与 BuildKit 0.34.2 已下载校验，二进制及许可证已保存；已使用独立 BuildKit／containerd worker 开展本机构建。完整构建仍需干净固定提交、经批准的 Casdoor digest和足够空间；构建前按当次可用空间核算默认 40 GiB 保守预算，不将旧空间快照作为当前构建结论。工具检查不等于镜像归档、SmartBFT、4 GiB 实机或科研验收通过。

| 顺序 | 工作 | 状态 |
| --- | --- | --- |
| 1 | 完整镜像构建导出、nerdctl→Docker 加载，配套材料及目标锁 | b54743b 的 21 镜像 build／export／verify 及两类正式 target／runtime CLI 均通过；真实加载、目标锁及签名未完成 |
| 2 | 单机完整 AIO 登录/存储/Peer/Agent 与容量实测，再复制三机构 | 已完成主机只读预检；容量及部署待确认 |
| 3 | 四节点 SmartBFT、机构治理批准、PDC/背书、实际交易 | 待初始化，不以容器健康替代 |
| 4 | 政策、市场、Workflow 联邦节点、R 取证裁决与恢复 UI | 已补预约/终态自动授权、公开/私有市场请求、仲裁/披露政策、单次披露、案件存证授权、Workflow 配置与 R 取证裁决/恢复；研发候选已接线，真实登录联合验收待执行 |
| 5 | 固定候选版本真实 API/UI、软件、调度与故障验收 | 在新增环境执行，继续保持 PR 未合并 |
| 6 | 合作机构各自审批与操作，修复后定向复验并签收 | 待合作机构管理人员参与 |
| 7 | 用户批准合并后交付正式版本；原 main 沿原发布流程 | 尚未授权合并或发布 |

研发接续补齐：调度器 Agent 封装核对原 manifest/revision/二进制摘要；OpenPBS 默认串行编译；导出中源版本或镜像变化时不发布最终清单，压缩失败回收导出进程。AIO 为 Slurm controller/worker/Munge 与 PBS 数据库配置独立持久卷，两类调度器保留 24 小时查询窗口；PBS 不因新容器缺少 pbs.conf 而重置已有数据库，历史配置失败阻止注册。新增禁网、只读、非 root 的最终镜像目标观察命令，绑定镜像 ID 和工具摘要，供后续 profile/native lock 制作使用。详见[目标信息](../../../deploy/federation/aio/README.md#最终镜像的目标信息)。研发检查结果见本页下文，真实镜像和调度器恢复仍未验收。

### 交付来源与操作材料

本轮补齐 Casdoor 的源镜像绑定：`build` 和 `export` 均要求经确认的 `--casdoor-image <仓库>@sha256:<摘要>`，导出核对该源镜像与交付别名的实际 ID；manifest 保存 `casdoor.source` 和 `casdoor.id`，验证拒绝缺失、不规范或与别名不符的记录。AIO README、平台／联邦／AIO 三份公开 `env.example` 及联邦部署契约纳入交付文件摘要，目标端可离线查阅；机构实际密码、证书、私钥和政策配置仍独立交付。

调度器基础构建增加 Bun、Spack 和 OpenPBS 的归档 SHA-256 校验，先校验再解包；内置已知版本摘要，其他版本须显式提供 `BUN_SHA256`、`SPACK_SHA256` 或 `OPENPBS_SHA256`。Bun 摘要核对官方发布清单及发布 API；Spack／OpenPBS 摘要固定官方 tag 的 HTTPS 归档字节，不冒充上游签名证明。APT 包和基础镜像尚未全部固定，该约束加强下载完整性，不代表二进制可重复构建。科研 recipe、源码、许可证、provenance 和最终 native lock 仍由兼容材料交付另行提供。

本次交付增量检查通过离线工具 38 项、SchedulerDownloadTests 下载夹具 3 项；全仓 lint 为 0 errors（保留既有 47 warnings／1 info），离线文档 102 文件／1194 目标、workflow 引用及 diff 检查通过。本轮没有 TypeScript 改动，沿用上一轮类型与业务检查，不重复运行。

固定代码候选 `b54743b2320bd6c678e9492df81fe3e153e640c1` 的全部 21 镜像已真实 build／export，约 2.6 GiB 归档及 verify 通过；21 个标签、ConfigID、linux/amd64 和 OCI layout 已核对。正式 CLI 的 Slurm／PBS target 各一次成功，两类 runtime 均通过 create／cp 和源／目标字节数、SHA-256 校验，仍标记 unsigned／softwareInstallationAccepted=false。本轮仅复验受影响范围及真实构建／提取，没有重复业务矩阵；后续文档记录提交不改变镜像来源。原 `8531c2c` 截断 SIF 与证据保留，不得使用。真实 Docker load、目标 profile／native lock、机构签名、三机容量与 38 项现场验收尚未完成，不推送、合并或部署；构建机 CPU 观察不能替代三台目标机器的 CPU 信息。 构建工具继续要求干净工作树及匹配的完整 SHA，构建期间不改候选源码；最终目标 profile／lock、真实 Docker load 及三机容量仍待验证。 导出继续按实际镜像大小检查空间，空间不足时不能认定交付完成。

### 仍须完成的研发

本轮补齐显式 `config --managed` 的研发候选：Ubuntu 24.04/Apptainer/systemd 公共运行时、可提取的未签名 SIF、root 保护的私有配置、非 root Agent、私有 cgroup namespace 和独立限额 ext4 store；PBS 注册前部署逐作业 hook。SelfAccount 的能力证明、签名派发、Agent 校验与联邦续期共同支持 PBS Pro，仍要求精确账号映射、有效队列/节点证明及签名资源检查；Torque 不增加 SelfAccount。普通模式、R 和独立 Orderer 不自动获得这些权限。

尚须完成目标运行时部署及原生运行、各机构批准的签名 SIF/profile/最终 native lock、systemd/cgroup 和 Slurm/PBS 原生作业、安装/取消/恢复验收。公共 SIF 不预装科学软件，启动脚本不制造站点确认、签名或业务批准。生产准入和受限数据 root profile 继续保留，`AGENT_SPACK_ENABLED` 探测或 Agent 注册仍不能代替 W06/科研验收。具体材料与操作见[托管运行时](../../../deploy/federation/aio/README.md#托管安装与联邦任务运行时)。

托管 Slurm 已增加 MariaDB 持久服务和镜像内 slurmdbd/MySQL 插件，原生用量继续使用既有 sacct 路径。数据库健康、私有文件密码、固定技术账号关联在 Agent 注册前核对；故障不降级为估算用量。普通 AIO Slurm 仍以 scontrol 查询保留终态，不提供 sacct 用量。实际镜像/数据库、作业用量与财务证据的联合验收尚未执行，不能把接线当成原生计费通过。配置与恢复边界见[原生用量](../../../deploy/federation/aio/README.md#托管-slurm-的原生用量)。

本轮已补三模式通用／协调和解及[晚到存证历史恢复](history-recovery.md)研发候选，含 Server、商业链／Adapter、权限及页面接线；原 v1 退出后和解保持兼容。协调财务须先取得链授权、独立完成原双签财务，再以 VALID 结案；历史恢复仅作当前双签归档，未知交易不得重签。商业链同代际信任追加使用全组织原生背书，不改成员／PDC／代际。上述新增范围已完成本轮行为检查，静态收尾见下文；真实环境验收仍待执行，不据此关闭完整蓝图。目标镜像与原生锁均需固定提交后真实生成；源码工作区未提交时不能声称交付包已经完成。

## 完成标准

保留[38 项验收契约](acceptance.md)：A01–A10 为模式/准入/权限/预算，W01–W13 为 Workflow/软件/数据/取消，L01–L09 为证据/商业/隐私/背书/仲裁，O01–O06 为容量/快照/归档/代际/操作/部署。已有专项引用[原证据](progress.md)，不重复测试；跨主机、正式身份、目标容器和当前候选版本的缺口必须补测。

新增条件是限制国外出口后，目标加载、初始化、登录、任务和软件准备均不下载国外依赖。记录提交、镜像、材料 SHA-256、Job ID、交易状态、财务结果和 UI 截图。真实冷安装小软件与真实 BWA 科研小样例分别记录，不混称 BWA 冷安装；模拟保持独立前缀和恢复路径。实际介质交接、私有恢复和四节点故障保留真实证据，未执行不标通过。

默认限额只是安全起点；预算或峰值超过 4 GiB 时提出扩容，不超售或删必要组件。native lock 根据最终容器系统/架构/编译器/Spack 生成，不套用旧宿主锁。通知继续暂停。

## 当前检查结果

此前通用和解与历史恢复的集中检查：shared 和解／历史恢复、商业链及 Adapter 合计 102 个唯一用例通过，Web 93 个唯一用例及离线工具 35 项通过。PostgreSQL 专项与受影响回归共 353 个测试实例已按批覆盖；修正旧夹具后仅定向复验失败场景，不重复累加检查数量，生产安全校验未放宽。5 张合成 API 浏览器截图已实际审阅，无页面错误、横向溢出或未确认的写调用；记录位于忽略目录 `temp/federation-gaps-ui-review/`。全仓 lint 通过，保留既有 47 warnings／1 info；根类型范围、shared 定向检查与 fabric-tests 类型检查通过，最新 PostgreSQL 测试夹具的 Server 最终类型检查通过。Shell／Python 语法、workflow 引用和离线文档检查通过（102 文件、1189 目标）。这些结果不替代真实 Fabric、正式登录或跨主机验收。

前一轮集中通过离线入口 34 项、托管运行时夹具 18 项，以及真实 PostgreSQL 的 Sandbox 授权专项 62 项（含 PBS SelfAccount 续期 8 项）。离线入口使用 Compose CLI 渲染及命令夹具，不连接 daemon；覆盖记账未就绪时不注册、正常启动顺序及子进程回收。托管夹具覆盖私有密码、重复启动复用关联、仅创建缺失关联及错误身份拒绝。PostgreSQL 使用一次性本机实例和隔离库，运行正式迁移后验证，结束已停止并删除所属实例和文件，没有连接部署数据库。

此前受影响 TS 单测 128 项（执行/验签/探测 77，Agent 配置 51）、完整根类型及受影响包最终类型通过；该轮无正式 TypeScript 改动，沿用当时结果；本轮新增范围以上文为准。收尾全仓 lint 通过（既有 47 warnings、1 info），Python/Shell 语法、workflow 引用、1180 个离线文档目标及 diff 检查通过。未重复未受影响的 Web、财务或 Fabric/科研矩阵。CI 配置检查已加入托管夹具及两类调度器 Shell 语法；现有镜像作业仅构建四类 Fabric/Gateway 镜像，不等于完整 AIO 调度器/SIF 已在 CI 构建通过。真实镜像、原生调度/安装和现场验收仍待执行。

此前离线工具 22 项检查通过，包含损坏包、镜像身份、目标磁盘不足时不执行加载、私有配置、Compose 插值、cgroup、模式/角色裁剪、链管理角色限制与部署状态不变；未连接容器 daemon。已运行容器的声明限额计入宿主总预算，可用内存检查不重复分配这部分声明限额。注册 CLI 9 项测试（33 断言）、注册入口实际编译、原 Compose 两项回归、全仓类型检查及 lint 均通过。lint 仍有既有 47 warnings／1 info，无新增错误。文档链接与 workflow 引用使用离线检查；未重复历史业务验收。

本次交付收尾集中运行同一离线入口，共 30 项通过（含原 22 项，不累加为 52 项），新增覆盖 Agent 原清单与二进制绑定、目标观察的镜像/隔离/未知结果、压缩失败回收、源及镜像漂移拒绝，以及 PBS 容器配置丢失后保留原数据库、历史设置失败不注册。使用原 Compose CLI 只渲染 direct/fabric、R、第四 Orderer 和 PBS 覆盖，未连接 daemon；PBS 启动使用命令夹具，无真实调度器进程。全仓 lint 通过，仍为 47 warnings／1 info；Python/Shell 语法、workflow 引用、文档及 diff 检查通过。未修改 TypeScript，本次沿用此前类型检查；未重复页面、商业链路或科研/Fabric 运行矩阵。目标观察命令的真实容器路径、Dockerfile 构建、实际重建恢复及隔离运行时仍待验收，不把夹具结果当作现场通过。

真实 Compose 渲染的静态预算如下，已含 512 MiB 系统余量，尚未计入同机其他项目，不能代替驻留占用和峰值实测：

| 配置 | 预算 |
| --- | ---: |
| direct 机构 | 3232 MiB |
| fabric 机构 | 5024 MiB |
| direct 机构，`--managed`，Slurm | 5792 MiB |
| fabric 机构，`--managed`，Slurm | 7584 MiB |
| direct 机构，`--managed`，PBS | 5408 MiB |
| fabric 机构，`--managed`，PBS | 7200 MiB |
| fabric 仲裁 R | 3488 MiB |
| 独立 Orderer | 896 MiB |

因此默认完整 Fabric 配置无法通过 4 GiB 主机预算检查，托管模式的 direct 也超出该预算。A 与 R 同时运行时，共享一份系统余量，普通合计 8000 MiB、托管 Slurm 合计 10560 MiB；不能只看仲裁进程或软件作业的内存。若保留当前限额，B/C 可按 8 GiB、A 按 12 GiB 作为扩容候选，最终规格由单机实测确定；目前不改机器规格，也不降低必要组件限额以绕过检查。

三台目标主机已通过 SSH 只读预检：均为 Ubuntu 24.04、x86_64、2 核，系统可见内存约 3.64 GiB。前两台未安装 Docker/containerd；第三台已有 Docker/Compose，并运行 Runner 和 DinD，须保留原有职责且将其预算另计。根分区剩余约 44–50 GiB，仅为预检快照，不代表完整镜像和软件材料加载后仍有足够余量。主机清单与过程记录不纳入仓库。

前两台的离线运行时材料已在本机准备，四个 deb 共 88,072,538 字节，保留原仓库摘要/路径/元数据和 copyright。两台 dpkg 状态摘要一致，只执行一次空 APT 列表的纯离线依赖求解：四项新增、零升级、零卸载，无缺失依赖。未安装包、未启动服务、未向目标传输；实际安装及重启恢复仍待部署授权和单机验收。当前工具不自动安装运行时。


### 联邦 Web 操作补齐（研发候选，未部署）

补充商业合同的仲裁／披露政策、单次披露和案件存证授权；R 案件登记、限定字段读取、材料复核、裁决签署及送达／存证恢复；Workflow 画布联邦节点及市场／仲裁配置。复用现有双边签署、授权及队列，不新增迁移或后台执行通道。具体操作和权限见 [Web 操作说明](web-operations.md)。本轮组件及静态浏览器检查见 [Web 操作说明](web-operations.md#本轮验证边界)；真实三机构验收、不可变候选提交及正式镜像交付仍待执行，不合并、不部署。
