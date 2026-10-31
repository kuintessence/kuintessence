# 当前功能与使用边界

平台管理员可在安全设置中按姓名、邮箱或组织名称查找组织成员，分页查看并添加、编辑或移除成员。
用户与组织通过名称选择；重复添加不会覆盖已有角色。移除操作需确认，仅撤销对应组织成员资格，
不删除账户或独立授权。组织角色不替代平台角色；授权服务诊断和高级操作折叠展示。
提供者成员列表优先显示姓名及平台角色，并支持翻页；切换组织或搜索时回到第一页。
历史暂停和 credit 字段默认收起，按需查看；执行账号状态直接显示已启用或已禁用，窄屏卡片限制在可用宽度内。

Web 在页面前台打开时每 15 秒重新读取当前权限，返回浏览器窗口时立即刷新。
在线授予或撤销组织、审计权限后，导航与受保护页面随最新权限更新；平台角色显示也同步服务端身份，
无需重新登录。后台仍逐请求检查授权，界面刷新间隔不构成额外的授权有效期。
切换组织时清空旧权限并重新请求，保留已挂载查询的订阅，避免停留在工作区准备界面。

新增[多算力中心互联仪表盘](../compute-interconnect.md)：提供者组织视图与平台运营视图，中心／集群／链路档案、资源去重汇总、地图聚合和个人默认视图。容量来自登记，软件与心跳来自绑定 Agent；网络指标须注明实际观测来源与时间，暂无内置跨中心探测器。

main 发布在传输镜像前向站点提交实际归档大小，要求 `prepare-space` 完成容量预算和受限旧镜像清理。
容量不足或站点尚未支持时停止；仅验收入口不触发传输或清理。契约见[部署说明](../deployment.md)。

main 新增手动 [仅重试验收](../deployment.md) Actions 入口，要求指定已部署完整 revision，
通过站点发布锁检查版本和遗留任务，在独立目录保留证据，不重传镜像或重复迁移。

Registry 启动同步上游软件目录时只投影实际变化的授权关系，重复同步或仅更新元数据不再重写全量授权；
权限撤销与恢复仍进入持久 outbox，资源更新加行锁后计算差异，防止并发更新遗漏权限变化。
空的 SpiceDB 或历史投影损坏仍须通过管理重建接口修复，目录同步不承担重建职责。


Kuintessence 当前为 pre-release。以下列出组件功能、运行要求和暂未支持的能力。

数据导入根目录需由 Agent 注册上报并与平台登记匹配；配置步骤见[软件与数据说明](../software.md#算力方本地数据导入的根目录配置)。
工作流解析接受 `schemaVersion: 2`。作业文件页区分收集到的文本与声明发布到云盘的文件。
运维页区分未启用 Sandbox 与启用后异常；组织、用户优先显示名称，自动化账户使用其配置名称，排障编号保留在详情或提示中。
Kubernetes 的 HPC 队列观测显示为不适用；Slurm、PBS Pro 和 Torque 仍执行队列故障与恢复检查。
集群文件根目录的新建与编辑表单按可用内容宽度排列字段，窄屏操作按钮可换行，避免名称和路径被挤压。

## 组件

Server 新增[自动化凭据](../automation-credentials.md)：平台管理员可创建限定组织和 scope、
有期限且可撤销的机器凭据，供部署验收调用工作流、作业、日志和文件 API。
使用独立普通用户身份，轮换保留身份及历史，不能交互登录或访问管理员接口；
现场接入需另外配置凭据源和相应资源授权，不能以单元测试代替发布验收。

正式 named refs 工作流已接入冻结用例 revision、Registry 事务权限投影和治理后的缺包安装等待。
安装复用 software operation，库存确认后重新调度；unknown/review-required 仅接受针对资产、
提供方和使用主体的有效审批，默认仍拒绝。接口及取消/恢复边界见[软件管理](../software.md#工作流缺包自动安装)。

Web 首页的快速开始提供真实示例作业和无需软件安装的两节点编排示例；提交成功后
直接打开对应运行详情。编排示例使用 `NoAction`，不表示计算软件已经安装或运行。
软件模板分页显示当前页与总页数。Web、AIO 和预览 nginx 对材料目录根路径使用
精确代理，避免自动补斜杠导致浏览器的禁止重定向请求失败；既有认证门禁保持生效。

Web 的离线导入、软件目录、工作流创建与作业详情统一使用简洁页头和分组布局，移除重复统计、
步骤说明与空态装饰占位。离线导入按文件选择、预检、导入和结果排列，摘要与逐项收据可展开，
保留预检门禁、变更提示及错误码；工作流仍保留必要的输入说明和权限阻断，作业失败诊断直接可见。
工作流状态计数合并到可点击的筛选按钮，软件结果数量随分页展示；作业名称、ID 和状态
仅在详情页头展示，预览数量采用行内分组，资源队列数量不再显示为输入框。
运行详情优先展示运行图，配置按需展开；已有作业关联的节点名称可通过点击或键盘打开作业详情。
软件搜索栏移除与分页重复的数量统计；创建编辑器与运行图均跟随平台主题，保持深色控件可辨认。
离线导入只接收当前所选清单的读取结果；更换或清空文件后忽略旧读取，重新预检失败时禁用导入，避免沿用旧的成功结果。
预检报告标题不将 `planned` 阶段误标为“可导入”，逐项显示失败和冲突。
软件发布页去除静态说明侧栏；创建和编辑字段保留可见且关联输入控件的名称，已填值不会遮掉字段含义。
模板卡片的长名称完整换行，只显示一次无效状态；平台运营首页直接呈现待办与告警，
各入口仍保留权限限制提示。
软件详情的 Spec 复制仅在剪贴板写入成功后显示成功；权限拒绝或剪贴板不可用时提示失败并允许重试。
模板详情图显示带方向的依赖连线，缩放控件跟随平台明暗主题，手机上可缩小查看依赖图；窄屏下长 YAML 在代码区内滚动，不撑宽详情布局。
权限加载时仅显示一个状态标题，失败时保留原因与重试；侧栏较长的域名称可换行。

Web 窄屏导航默认收起，桌面展开偏好独立保存。软件中心将授权、发布和材料管理收纳为可展开区域；
审批提示仍直接可见。作业列表区分首次加载、错误与空结果，并提供原地重试；作业与工作流名称
支持键盘进入详情。主要运行状态与相对时间随界面语言切换，中文字体提供无衬线回退。
标签页和管理区域展开使用短淡入，遵循系统 `prefers-reduced-motion`。
工作流草稿在窄屏截断长名称，保留删除按钮；删除需先确认，进行中禁止重复操作，失败可重试。草稿刷新失败时隐藏旧记录，
避免继续操作权限可能已经变化的数据。节点注册页对入口未提供接口的情况给出部署配置提示和重试；
有效期限制与 Server 一致（60 秒至 30 天的整数），签发、撤销和剪贴板失败均提供可见反馈。
个人账号信息在窄屏按标签和值纵向排布，长邮箱可换行。
工作流草稿加载期间不开放编辑，失败时提供重试及返回列表；首次保存不重新读取草稿，
保存响应不覆盖保存期间的新编辑，成功后失效草稿列表缓存；离开创建页后，迟到的保存响应不再改写当前地址或弹出提示。预算只接受有限的非负数，
留空表示不限预算；名称为空时禁止保存与提交。作业和工作流状态筛选向辅助技术暴露选中状态。
等待预算审批的运行显示说明并持续刷新，允许通过既有取消接口停止运行；Web 尚无调度方案审批操作界面。

Slurm/PBS Pro/Torque 的平台诊断日志包含 stdout 和带 `[stderr]` 标记的标准错误，
用例输出提取仍只读取 stdout。调度器历史清理后可通过作业 ID 读取保留日志。
Torque 队列库存使用 `qmgr -c "list queue @default"` 枚举服务器队列，避免空 active selection 被误判为没有队列。

作业日志按作业隔离缓存并串行轮询，切换主题或从读取错误恢复时重放完整日志；切换作业时
清除旧终端内容，错误可原地重试。作业与工作流的取消响应按发起操作时的 ID 更新缓存，避免导航期间
更新到其他记录；详情刷新失败时隐藏缓存名称与取消入口。作业文件使用完整分页列表验证输出，
作业状态变化时重新读取，支持手动刷新及失败重试；验证失败不显示旧输出下载链接，也不判定为未发布。
切换算力提供方组织时同时清除作业日志和文件缓存。

文件页与路径选择器按 Agent 区分集群目录缓存；当前 Agent 离线后需显式重新选择，避免将旧目录带到其他 Agent。
目录读取或 Agent 列表刷新失败时禁止确认目录和使用旧目标传输。文件与目录名称支持键盘操作及选中语义，
长云端目录可在窄屏换行或截断。删除确认会重新验证文件与权限，成功后同步刷新作业文件缓存；
临时 NetDrive 503 与未启用服务分别提示。
传输表单在云文件使用权限失效或另选的执行 Agent 离线后要求重新选择；
再次打开路径选择器保留所选 Agent 与目录，
父组件刷新不重置正在浏览的路径。工作流刷新同时更新草稿；删除确认在草稿读取失败、消失
或版本变化后禁用，需重新核对后操作。
传输列表读取失败时隐藏旧记录、计数与操作入口；筛选提供选中语义，相对时间随语言切换。
本地文件按批次串行上传，进行中阻止重复选择与拖入，显示当前文件和固定目标目录，
单文件失败后继续其余文件并刷新相关文件缓存。云盘配额申请使用共享 schema 验证，
按界面要求填写整数 GB，检查策略上限和未来有效期；历史仅显示全局云盘申请。

| 组件 | 功能 | 使用前提 |
|---|---|---|
| 平台服务（Server） | API、作业管理、放置流水线、偏好、审计、计量 | PostgreSQL、身份与权限配置 |
| 接入代理（Agent） | Slurm、PBS Pro、Torque、Kubernetes；监控与离线队列 | 调度器命令及站点运行权限 |
| Workflow | YAML 控制流 DSL、CEL、条件、循环、子工作流与 scatter-gather | 软件、数据及目标集群满足约束 |
| 软件仓库（Registry） | 软件/用例/工作流目录、OCI、Spack buildcache、Git recipe 导入与版本管理 | 发布者权限、artifact 存储及 recipe 持久卷 |
| Web | 用户工作区、React Flow 编辑器、CP Console、平台管理 | Server/Registry API |
| CLI | 远程命令、TUI、无 Server 本地调度器 GUI | 对应远程身份或本地调度器 |
| NetDrive | S3/RustFS、multipart upload、Range resume、集群传输 | 显式启用与完整存储配置 |
| SSH | PTY、窗口调整、凭据 vault、可选录屏 | 目标集群凭据、权限及网络可达 |

## Spack 完成边界

Recipe Git 存储、初始化/Web 导入、源码材料发布、生命周期与可见策略、受控上游代理、
Server-only Agent 材料下载，以及 CP 安装/库存/策略操作已有实现；
这不代表原始 Spack 目标全部完成，仍需区分以下缺口：

- Registry 已提供 buildcache 仓储 API，但当前统一材料与 managed worker 使用源码路径，
  尚无经 Server-only 交付的 buildcache 二进制受管安装闭环。
- 新增[Web 安装绑定管理](../spack-install-bindings.md)：平台默认和提供者组织的精确
  spec 映射持久化到 PostgreSQL，支持 revision 校验、替换、停用与审计。
  导入不自动绑定；启动配置仅初始化缺失默认，不覆盖 Web 设置，既有 operation
  保持固定 release。实际通过范围须核对当前提交 Actions，不代表生产站点验收。
- 已有 Hello/samtools 固定材料和工作流验收入口，以及 15 项科学工作流手动材料指南；
  尚无全部 15 项的成套目标 Linux 材料、安装和科学运行结果。
- 浏览器材料上传与 API 驱动的后续安装是不同验收范围；CP 页面点击安装、观察终态和
  库存的真实链路新增 Hello 专项入口，复用既有 Web 导入 job，回执核对后继续原有
  load/job/重启/卸载验收。当前改动需以对应 Actions 结果为证，不能以“已有按钮”
  或 mock 测试替代，也不代表完整 CP 策略编辑流程或其他软件已经验收。
  CP 概览增加 15 秒前台轮询，避免终态刷新先于库存写入后一直显示旧数据；
  不启用后台轮询。

生产站点及 Agent OS 兼容性另行验证，不扩大现有单节点 Actions 案例的结论。

## 工作流边界

工作流详情加载期间不展示默认配置，读取失败可原地重试。关联作业部分或全部读取失败时
显示提示并保留可用的持久化节点状态；可手动重试，执行中仍自动刷新，运行与已读取作业
均结束后停止轮询。取消成功后刷新运行列表缓存。作业实时状态消息触发完整详情读取，
待完成时间和诊断字段一起载入后才进入终态，避免提前停止 REST 轮询。

- 工作流采用控制流 DSL，编辑器与执行器使用共享 Schema 校验文档。
- 缺失的 ByVersion 子工作流或无效的持久化模板 YAML 在提交阶段拒绝，
  不创建 workflow run/job；此类预检失败不产生可轮询的失败 run。
- Script 节点显式声明 source/scriptRef、runtimeProfileId/runtimeContractRef 和 inputs/outputs 契约；
  source 与 runtime 各选一种引用形式。
- Web 根据持久化的 graph 显示节点与依赖；本地或尚未保存 graph 的运行显示节点状态列表。
- CLI/TUI 从节点结果读取运行详情，结果尚未产生时展示 graph 与已关联的 Job；
  本地 GUI 直接使用结构化数据。执行中的 Job 关联由 `stepJobs` 保存，
  供取消、恢复、错误诊断和 Job 链接使用。

## 运行限制

- [生产镜像 CI](../deployment.md#生产镜像) 在推送 `main` 时发布四个
  `ghcr.io/<owner>/kuintessence-*` 镜像的 `main` tag；发布 GitHub Release 时保留
  Git tag，正式 Release 同时更新 `latest`，预发布不更新。当前架构为 `linux/amd64`，
  Web 关闭预览登录。main 镜像全部成功后，runner 核对平台、来源与提交，将四镜像压缩归档
  （临时 runner 启用 BBR 与 MTU 探测，初始 MSS 1200，不修改服务器网络配置）
  和专用 Compose 通过 SSH 上传；校验 SHA-256、加载并核对平台、提交、来源与文件层摘要后，调用站点已有
  `run.sh deploy --expected-revision <commit>`。SSH 用户须能执行 Docker；Release 不触发部署。
  站点可复用镜像层缓存，但仍需基础服务镜像及注册表元数据访问。
  站点维护实际 `.env`、拉取凭据、代理与升级策略，部署脚本启动 Compose 时才执行数据库迁移。
- Server 镜像从同一提交内置 Linux x64、ARM64 glibc Agent，保存于
  `/opt/kuintessence/agent/`；公开 `/api/agent-binaries` 提供提交及 SHA-256 清单和下载。
  下载可固定 revision，升级后不匹配返回 409；源码运行无产物时返回 404。
  PR 构建及生产发布均提取镜像校验两种架构，x64 执行空配置 smoke；ARM64 仅做
  ELF 和完整性验证。获取方式见 [Agent 部署](../../deploy/systemd/README.md#获取二进制)。
- 源码运行、CI 与新构建镜像固定使用 Bun 1.4.2，最低要求为 1.4.2。
  材料上传依赖其 HTTP 拒绝连接关闭修复；升级须重新构建旧镜像与编译产物，
  不能只修改配置后继续复用旧 Bun runtime。详见[材料上传边界](../spack-material-delivery.md)。
- 自托管对象存储已统一配置为 RustFS，初始化使用 `rc` 而非 MinIO `mc` 镜像；
  alias 的联网验证与 readiness 共用有界等待预算，持续失败仍阻止 bucket/IAM 初始化。
  使用新卷/PVC，不自动迁移旧对象。升级前先阅读
  [RustFS 迁移边界](../../deploy/rustfs/README.md)，特别是固定 version ID 引用。
- Server 的事件与会话状态保存在进程内，生产部署使用单实例；Redis 尚未用于多实例协调。
- Agent 生产连接需配置 mTLS 或受信任代理，证书注册和账本管理见[身份与安全](../security.md#agent)。
- Linux 登录节点使用 [`kq-agent` systemd 部署](../../deploy/systemd/README.md)：
  安装后完成注册、配置证书与调度器权限，再手动启用服务；升级保留站点配置。
- 通用 HTTP terminal 使用服务账号执行短命令；用户交互终端使用 SSH PTY。
- 运行软件前需在目标站点安装，并取得软件及数据的使用许可。
- [Recipe 仓库](../spack-recipe-repositories.md) 支持初始化/Web 导入自包含 Git bundle、
  静态诊断、激活/回滚/停用和固定快照导出。启用本地 Git 存储时 Registry 只允许单写者；
  Registry 不执行 Python 或真实 concretize；[材料下载](../spack-material-delivery.md) 已接入 Registry
  发布、Server 授权转发、Agent 校验缓存，并在发布与安装入口检查 Spack 1.0.0 lock
  的绑定及依赖图。此预检仅为 `static-only`，不证明源码齐全或宿主兼容；
  Agent 的固定 SIF source audit 默认关闭，只用已下载材料检查 native staging。
  默认仅审计路径即使通过仍返回 `rejected`，不登记为已安装。
- Persistent installation 为默认关闭的实验性 `AGENT_SPACK_INSTALL_ENABLED` opt-in，
  要求 source audit、host backend、非 Kubernetes adapter 与固定 site profile digest。
  TypeScript 已接入隔离 build → 独立 readonly verify → `ready` 的持久化编排；
  每次新安装事务独占共享持久化 prefix，managed inventory/load/uninstall 仅面向 DAG root，
  依赖不独立管理，卸载清理整个事务 store；root-only 不指系统 root 身份。
  shared storage、compute ABI、quota、recipe trust 均需运维人工声明，不等于自动验证。
  managed install/verify/load 在 spawn 前要求 Linux `/proc/meminfo` 的 `MemTotal`、
  `MemAvailable` 均达到配置预算 + 512 MiB 宿主余量；swap 不计入。
  `AGENT_SPACK_MANAGED_MEMORY_MIB` 默认 4096，仅允许整数 1024..4096；
  同一预算用于宿主准入、Apptainer memory/memory-swap 和 Agent 私有只读输入中的 worker 期望值，
  worker 拒绝缺失/非法预算及实际 cgroup 超额，独立 source-auditor 仍固定 2 GiB。
  元数据缺失/重复/非法、读取失败、非 Linux 或取消均拒绝启动并清理暂存输入。
  此瞬时准入不检查全部祖先 cgroup、不预留全局资源；私有 cgroup namespace 不因此被拒绝，
  仍复用 worker 的实际配置预算、swap0 硬上限验证，祖先限制更小时仍可能受控失败。
  `AGENT_SPACK_INSTALL_TIMEOUT_MS` 仅用于 install，默认 6 小时、最大 24 小时、正安全整数；
  runner 准备与进程共用总 deadline，verify/load 和独立 source-auditor 保持 30 分钟。
  取消、进程组清理、namespace、禁网、镜像摘要、lock/DAG 和 mirror-only 边界保持不变。
  安装操作透传[固定内存错误](../spack-material-delivery.md)及[固定恢复错误码](../spack-install-recovery.md)，其他异常继续脱敏。
  已增加持久锁代次、真实 host boot/PID/starttime 身份与 SQLite 软件 operation 执行账本；
  启动/重连/安装前可收尾可证明已停止的执行，终态先持久化再重报，不自动重启编译。
  私有 PID/UTS 或不可信宿主身份使用进程 instance fallback，支持正常安装、释放及重启后读取已完成安装；
  不要求 hostPID/宿主目录挂载，其他未知 instance 的未释放锁与未决账本不自动恢复。
  跨 boot/PID 自动恢复仍仅限可信 native 身份，旧完整身份可读，新身份记录不支持直接降级旧 Agent。
  历史账本/outbox/重复请求终态标记 `replayed`，仅收尾 operation，不覆盖当前库存；
  库存仍由 heartbeat/installedSoftwareReport 确认，未知不报空，等待者仍要求库存就绪。
  必须先升级 Server 再升级 Agent；旧端不识别历史标记，混合版本不具备完整防回滚保证。
  同 boot 的未知 worker、其他主机及旧空锁仍 fail closed；旧锁有明确停写、确认 worker、
  留存证据后的维护步骤。锁代次和无 ACK 终态历史不在线回收，需要监控元数据容量。
  本次为本地针对性验证，目标 NFS、远端 kqagent 和真实软件安装未验收，详见[恢复边界](../spack-install-recovery.md)。
  降低额度可用于独立模拟包，但不承诺大型真实软件可用，尚未实测 1 GiB 安装；
  移除配置或设为 4096 后重启 Agent 即恢复默认预算，真实材料仍须独立验收。
  更长时限不增加内存或 tmpfs 容量，不代表完整工作流验收通过。
  Python install worker 已实现并通过模拟 native API 的 fixture 测试。
  worker 已从验证过的 native lock 恢复非 external 包的精确版本、variants、flags、arch
  及 virtual/provider 抽象约束，仍执行 solver 并严格比较完整 DAG/hash；同名多节点或
  冲突 provider 明确拒绝。新增离线 fixture 回归通过；Gmsh 4.13.1 的 48 节点 lock
  已在隔离运行时通过真实 Spack 1.0.0 求解及完整 DAG/hash 比对，到安装入口即停止，
  尚不代表实际编译安装或完整工作流验收通过。
  source audit 与 install/verify/load 的共享 Python 校验器已兼容 material v2，
  严格校验证据关联及全部附件字节，保留 v1 与原始 manifest 摘要；
  v2 正常路径及证据缺失/篡改拒绝已通过离线 fixture，尚待部署后的真实 v2 安装验收。
  提交 `c4987cf` 的 GitHub Actions 已通过真实 Linux/Spack/Apptainer/SIF
  GNU Hello 受管安装闭环：runtime 隔离、source audit、build、独立 readonly verify、
  `ready`、load、Slurm 作业、源码缺失/篡改后的库存撤回与显式恢复、
  Registry/Agent 重启后复验及再次运行、卸载和库存撤回。
  显式空库存报告与独立队列刷新已在此案例中通过验证，详见
  [受管安装验收范围](../../deploy/pr-test/README.md#实验性受管安装案例)。
  此结果仅覆盖临时单节点 Slurm 环境，不代表跨节点共享存储、compute ABI、
  生产站点或 15 个工作流验收；native 离线编译案例也不能替代受管安装验收。
  `ready` 不等于生产就绪，不能宣称平台安装功能已恢复。
  源码已有上传/发布 API 与本地材料 manifest 初始化/批量导入；recipe bootstrap
  完成后才导入材料，成功 binding 须通过 Web/API 显式绑定，或用 Server 配置初始化
  尚不存在的平台默认；不自动启用安装。
  平台与 CP 门户支持材料包 Web 上传、重试、取消和按 binding 查阅，切换身份/组织/
  发布能力时清空临时结果并中止请求；发布响应丢失保留“结果待确认”，不宣称回滚。
  已增加权限过滤的材料目录、精确仓库筛选和分页查阅；直接发现持久化 release，
  单次响应最多 200 项，扫描/字节/时间超限明确失败，不返回伪完整的截断列表。
  [受控上游导入](../spack-upstream-import.md) 新增默认关闭的 Registry 专用
  HTTP/HTTPS/SOCKS5 代理与精确 HTTPS origin 白名单，Web 提交 JSON manifest，
  校验 digest/大小后复用 recipe/material 发布，不自动激活或修改 Server binding，
  Agent 仍只从 Server 拉取内容。接线与代理用例的结果以对应提交的 Actions 为准，
  不代表生产部署验收。材料生命周期第一阶段新增 PostgreSQL 持久化引用账本：
  Server 启动登记配置绑定，签发票据和下载前固定任务 release；登记失败拒绝继续。
  旧配置绑定不自动移除，任务引用不因超时/离线删除，孤儿引用单独保留。
  此阶段尚未开放下架、恢复、可见范围变更或绑定退役；零引用计数不代表升级对账已完成。
  第二批新增[离线 Rollout 屏障](../spack-material-rollout.md)：
  DB API `SpackMaterialRollout.execute` 提供 `inspect/pause/reconcile/activate`，
  配置 `SPACK_MATERIAL_EPOCH` 同时接入 Server/Registry；Compose 默认留空，
  AIO 共享环境，Helm 使用共享 `spackMaterial.epoch`，没有默认 UUID。
  activate 要求显式 reconcile、当前 revision/epoch 和一致的外部确认；
  inventoryDigest 须同时匹配最近一次 reconcile journal 与当前 DB 库存快照，
  且无非终态安装（含未登记引用者）或孤儿引用。旧绑定及 append-only journal 保留；
  删除历史可能不安全地重置 observe，禁止以清表解除屏障。
  运维必须在外部停止并排空全部 Server/Registry（包括离线回滚副本），
  撤销/轮换旧 DB、Registry、ticket 凭据并更新访问和网络策略；
  epoch 不能隔离不检查它的旧代码，门禁不取消在途流。
  无 journal 且无 epoch 仅为 observe 兼容；paused、DB 失败或 ready 时 epoch
  缺失/不匹配拒绝 runtime。新的 pause 改变 epoch，不自动回退；
  重启前须为所有升级 Server/Registry 配置同一 epoch。
  此批尚无 rollout HTTP API 或下架、恢复、ACL、退役、GC，
  部署静态测试只覆盖配置接线与文档；测试与运行态验收仅在 GitHub Actions
  隔离环境执行，须核对对应提交结果，不能沿用旧提交的验收结果。
  第三批新增[离线绑定退役](../spack-binding-retirement.md)：暂停并对账后，
  用当前管理员、revision/epoch/digest 和显式外部隔离/配置移除确认执行 `retire`，
  要求无非终态安装或孤儿引用。追加不可逆 tombstone 并保留原绑定与任务历史，
  旧配置登记和安装引用重试拒绝复用；对账和重导入不会恢复。
  此入口只有可信离线 DB 运维可用，不开放 CP/Web 写操作，不是材料下架或恢复。
  第四批新增[材料下架与恢复](../spack-material-lifecycle.md)：Registry 管理 API
  仅在 ready epoch 下允许当前有 namespace 读写权及 recipe 读取权的维护者操作，
  在同一事务内检查有效绑定、活动/孤儿引用并追加 release revision 与审计。
  目录、直接下载、Server 引用准入统一检查下架状态；重新导入不恢复，
  恢复也不解除绑定退役。平台/CP 共用材料面板新增精确 binding 生命周期查询、
  状态写入与分页审计；下架后不依赖普通 manifest 读取来恢复。写入需要原因、
  确认和 revision，冲突须重新查询，响应丢失显示结果待确认而不自动重试。
  身份/组织/能力变化清空状态；移动端沿用高风险写入限制。
  新增维护者目录：按完整仓库名称查询 available/withdrawn 发布项，
  有界候选分页、绑定用户和筛选条件的加密游标，返回前重新检查 canonical 权限；
  下架项可进入生命周期管理，而不触发普通 manifest 下载。
  新增[材料可见策略](../spack-material-visibility.md)：独立审计和 CAS，
  用户/组织允许列表仅收紧既有 namespace/recipe 权限；管理者可查阅受限项但无下载豁免。
  策略需离线 activate-policy 启用，policy-ready/policy-paused 不允许降级，
  普通目录、manifest/blob、安装准备与旧 ticket 后续请求重新检查。
  当前提交的 Actions 结果才是验证依据，不将代码存在视作验收通过。
  受限厂商安装包/许可证授权、
  大规模材料目录索引/物理删除/跨组织分享及 15 个工作流的目标 Linux 材料、lock 和端到端安装/运行验收仍未完成。
  [科学工作流材料指南](../spack-workflow-materials.md)列出 15 项候选软件、外部输入、
  许可自审与 target/MPI 风险，并提供 macOS 获取、校验、搬运和 bootstrap/Web 导入步骤。
  [交付与验收工作表](../spack-workflow-acceptance.md)提供对应机器可读候选清单、
  target/profile 及逐软件/步骤的空白记录；不是导入或自动执行入口，默认全部未验收。
  模板一致性检查不证明材料闭包、目标兼容或科学运行成功。
  首个实现路线限定为 samtools 单软件切片：Spack 1.0.0、固定官方 recipe、
  Ubuntu 20.04 x86_64 和可销毁单节点 Slurm；请求 spec 为
  `samtools@1.19.2 ^htslib@1.19.1~libcurl~libdeflate ^ncurses+symlinks %pkgconf ^zlib@1.3.1`。
  使用官方 variant/provider 避免硬链接产物，未放宽 worker 的输出树校验。
  新增案例的实际结论以对应提交 Actions 为准，不因代码存在就认定已 concretize、
  源码闭包齐全或安装/运行通过。
  新增[固定案例手动材料导出](../spack-material-artifacts.md)：Hello/samtools 复用同次
  bundle、原生 lock 和源码生成现有导入格式，Actions 验证真实 bootstrap/Web 导入、
  逐 blob 回读及重启持久化；默认仅验证，审核确认并显式上传后才提供该 run 的 artifact。
  不因入口存在认定已生成成品，导入通过不等于这份材料已完成受管安装验收。
  PR scheduler 新增 Hello/samtools artifact-bootstrap managed 模式：
  同一 delivery 导出后由 Registry bootstrap 导入，只读 handoff 校验真实 binding，
  随后清空 bootstrap 配置、保留卷并 force-recreate Registry/Server；
  禁用 bootstrap 后的 handoff verify 回读成功才启动 scheduler，接入
  Server → Agent 的安装、作业、完整性检查、重启、卸载及引用/rollout 回归。
  后续 restart 也禁用 bootstrap 并回读，防止重导入修复掩盖持久化失败。
  PR #9 的提交 `e8b50b7b6834a2937bb1a8858cf9067f232212db` 已通过完整 CI
  `35685693358`（9 个实际 job）和 scheduler matrix `35685693281`（7 个 job），
  包括 Hello/samtools 同一 delivery 的 bootstrap 后受管安装；此记录只适用于该 SHA。
  bootstrap 后安装不等于 Web 后安装，也不代表通用 spec 或生产目标集群验收。
  本次新增 `--spack-web-hello`、`--spack-web-samtools`：在空 Registry 中通过真实
  browser 上传 recipe bundle 和 material 目录，browser 返回的 binding receipt
  必须与只读 handoff catalog 的真实 binding 精确相等。随后撤掉 host loopback
  端口与非 internal endpoint，保留卷并重建 Server/Registry，只读 verify 成功后
  才启动 scheduler；bootstrap 全程禁用，不调用旧 publish/export-lock 路径。
  Agent 仍只从 Server 拉取材料，不接触 Registry backend 或挂载 delivery，
  不修改生产协议或安装逻辑。managed matrix 共六项，旧路径和 Hello native、
  Slurm/PBS 回归保留；仅两个 Web 条目安装 host Bun 1.4.2、frozen 依赖、
  生成 protobuf 并安装 Patchright Chromium，沿用 AppArmor、timeout 与无上传门禁。
  PR #10 的提交 `1ffd2c4651353639b15bca012f1305bb14a8fabb` 已通过完整 CI
  `35691359927`（9 个实际 job）和 scheduler `35691359119`（9 个 job），
  包含 Hello/samtools 同一次 Web binding 的受管安装及三次网络隔离复核。
  此历史证据仅适用于该 SHA，不沿用为后续提交或目标站点的通过结论。
  这些入口仅在 Actions 执行，不部署 preview/production，不上传材料；
  `feat/spack-artifact-managed`、`feat/spack-web-managed`、
  `feat/spack-workflow-execution` 和 `feat/spack-file-workflow`
  调用独立导出工作流均仅允许 `publish_artifact=false`，不放宽其他分支与许可确认规则。
  当前没有通用材料生成器或全部 15 项的完整材料 artifact；每软件须独立单 root
  lock/release、每步骤隔离运行环境，不能用 macOS lock 替代目标 Linux lock，
  也不能把此切片视为完整变异检测工作流验收。
- Workflow 的 Spack facility 新增内部结构化激活交付，由 Agent 复用现有 load
  校验后再提交 scheduler 作业；缺少能力或激活失败时不能执行未激活命令。
  [Spack 工作流闭环](../../deploy/pr-test/README.md#spack-工作流闭环)新增
  Hello/samtools 的签名目录注册、材料 bootstrap、managed 安装与正式异步
  `/workflows` 两节点执行验收，包含结果依赖及重启回读/重跑。
  用例参数物化按字面值保留 `$` 替换序列，避免破坏 Bash ANSI-C 字符串等输入。
  普通 Slurm/PBS Pro/Torque 作业日志统一写入持久共享日志目录，显式 workingDir 只控制执行目录
  与相对文件路径；Sandbox 日志路径保持独立，测试继续要求重启后日志回读成功。
  工作流用例的 `resources.memoryMiB` 透传到 Job 内存申请；未声明时保留 1024 MiB 默认值。
  长时间受管验收按 Server 返回的凭据有效期提前重新认证，仅更新内存凭据；
  不改变生产 token TTL，也不自动重放认证失败的写请求。
  验收以对应提交的 Actions 结果为准，不沿用直接 `/jobs` 的通过记录。Agent/OS 兼容性后续
  独立 PR；现有隔离、OS/工具链指纹和 Server-only 材料交付约束不放宽。
- 新增 Actions 专用 samtools 文件工作流入口，复用既有 NetDrive/RustFS 生产传输：
  合成 SAM 经 `convert → sort → verify` 三节点生成 BAM、BAI 和计数报告。
  验收覆盖文件 metadata、下载摘要、独立 Job/cwd、RustFS 重启回读、再次执行、
  非法输入阻断下游与文件清理。专用 overlay 启用内部 RustFS 和完整 bucket
  bootstrap；原 Hello/samtools 两节点标量验收保持独立。此处描述实现范围，
  是否通过以当前提交的 Actions 为准，不宣称跨集群或全部科学工作流完成。
- CP 的 suspend/quota 写入口已停用，暂不支持通过这些接口暂停组织或设置并发硬限。
- 平台记录用量，外部计费系统生成账单。
- 本地 Compose 的初始化账号与固定样例口令只用于开发，不得用于公网环境。
- `full`、`watch` 与 scheduler 开发栈的 Registry 使用 Server 登录 JWT，
  保留开发模式和对外端口，供跨机器手动测试使用。
- scheduler 栈需显式设置 `KQ_DATA_MARKET_COMMITTER_SECRET_KEY`；
  手动镜像架构工作流仅在构建步骤使用配置解析占位值，不启动完整栈。
- [AIO 演示](../deployment.md#aio) 提供本机开发登录与公开测试凭据，
  自动初始化数据库和对象存储，仅绑定本机端口；不含 SSO、SpiceDB 或站点 Agent。
  Registry 的 OCI blob 和 Spack buildcache 与数据库、RustFS 数据共用持久化卷。
- 平台 Compose 入口集中在 [`deploy/compose/`](../../deploy/compose/README.md)；
  从仓库根目录使用 `bun run compose`。直接调用时指定 `--project-directory .`，
  以保留构建、挂载、根目录 `.env` 和默认项目名的路径基准。
- [GitHub 预览配置](../preview-k3s.md) 改为全部必需测试通过后构建 GHCR `kq-dev-*`
  SHA 镜像，经 SSH 隧道部署到远程 k3s；旧 runner 限时 Quick Tunnel job 已停用。
  门禁同时要求信任标签、作者写权限、同仓库当前 SHA 和全部必测组成功。
  入口改为仓库 Actions Secrets `PREVIEW_USER` / `PREVIEW_PASSWORD` 必填的固定
  Basic Auth，人工与 CI HTTPS 验收使用同一组凭据；不再为各 PR随机生成入口口令。
  内部密钥与解锁 Cookie仍按 PR隔离；入口凭据变更后重新部署会轮换 Cookie并 rollout
  gateway，保留已有数据库与应用密钥。缺失或非法配置在建立 SSH 隧道前拒绝部署。
  提供用户 Helm Chart 与 demo CI wrapper，包含持久化 Registry、RustFS、
  seed 和单容器 Slurm + Agent；不启用远端高权限 managed Spack runtime。
  预览镜像采用公开 GHCR，首次由维护者手动公开后重试失败的部署 job；
  tag 包含 PR、完整 SHA 和发布 run/attempt。本轮调整为所有 PR共用预建 `preview`
  namespace，每 PR使用 `kq-pr-<编号>` Helm release、`kq-pr-<编号>-secrets` 和
  `kq-pr-<编号>-preview-owner`。仅需 namespace 内RBAC，不查询 nodes/namespace
  对象、不创建或删除 namespace；基础设施由管理员预先配置。
  资源选择和 NetworkPolicy按 release label隔离，不因同 namespace而放通其他 PR；
  此模式不提供每 PR的 RBAC隔离或完整 egress隔离，仍只适合受信任维护者。
  cleanup先核验归属，Helm uninstall单个 PR，再清理自有 PVC、Secret和 owner marker，
  成功后才回收该 PR的 dev镜像版本；绝不删除共享 `preview` namespace或其他 PR资源。
  其他用途 tag或无法归属的 untagged版本不删除。
  HTTPS验收提供固定阶段、错误分类及合法 HTTP状态码诊断，不输出响应正文、
  header、证书、凭据或原始异常；保持 TLS校验、认证门禁、重试及失败补偿。
  手动部署可显式设置 `inspection_mode=true`：保留 Helm 成功或失败现场及镜像，
  禁用该次 atomic 回滚，延后自动 HTTPS 验收，评论提供待人工检查地址；
  不标记 HTTPS 成功，PR 撤销信任或关闭等安全清理仍然有效。默认自动部署行为不变。
  旧独立 PR namespace及数据不会自动迁移或清理。共享 namespace安全实现仍待复核，
  不宣称已上线或已通过远端验收；自动控制器须先经审核进入默认分支，
  运行状态以对应提交的 GitHub Actions和 HTTPS验收为准。
- [PR 调度器测试](../../deploy/pr-test/README.md) 已提供独立 Compose 与 Slurm/PBS
  Actions matrix，基于现有 scheduler base 构建，测试环境固定 Spack 1.0.0。
  覆盖目标为真实作业完成/日志/取消、拒绝未配置材料的安装及进程内材料回归；
  无公网端口，Agent 与 Registry 分网。实际构建与调度器结果以对应提交的
  GitHub Actions 为准；本套测试不代表离线安装验收。
- PR 测试另有 GNU Hello 单步案例：固定 recipe/source 的真实材料发布与 mTLS Agent 下载、
  手动 native 离线编译、Slurm 单步运行及重启后的持久化检查；结果以对应 Actions 为准。
  此案例不启用或替代 Apptainer/SIF managed installation，不等于自动安装或 15 个工作流验收。
- PR 测试新增独立的实验性 GNU Hello 受管安装案例，使用临时 systemd scheduler、
  非 root Agent、固定 Apptainer 1.4.3/SIF 和有容量上限的持久化安装 store；
  上述闭环已有 Actions 通过记录，后续提交仍须检查对应 Actions，不能沿用旧提交结果。
  外层 privileged 测试容器不作为生产部署方案。

## 文档与验证

- [认证与会话](../security.md#authentication)
- [Registry 权限](../security.md#registry)
- [Spack 受控上游导入](../spack-upstream-import.md)
- [Spack 材料 Rollout](../spack-material-rollout.md)
- [科学工作流 Spack 材料准备](../spack-workflow-materials.md)
- [Agent 注册和证书](../security.md#agent)
- [工作流规范](../workflow-schema/README.md)
- [系统运维](../manuals/system-operations-manual.md)
- [开发与检查命令](../../README.md#开发)

`CI` 工作流在推送 `main` 和 PR 时默认运行 Biome、文档链接、workflow 引用及轻量编排检查，
以及科学工作流交付模板的离线合同和该检查文件的类型检查。
模板检查不执行 recipe，不证明材料闭包或科学工作流成功；安装时禁用生命周期脚本。
`PR preview tests` 对同仓库非草稿 PR 自动编排完整类型检查、
基础测试及 Web 单测/build，按完整 PR 文件列表选择 Spack 与调度器重型组，
`ci.yml` 修改额外比较 merge base/head 中的 job：仅改基础检查不触发重型组，
Spack 或调度端到端 job 修改选择对应组；全局、未知结构与 job 增删保守选择两组。
读取失败或不完整会阻止范围解析；预览控制器使用同一策略独立核算。
正式 Spack 工作流矩阵默认仅 contracts 和 GNU Hello 基础案例；
手动专项或当前 HEAD 提交消息含 `[full-workflows]` 时扩展为
Hello、samtools、samtools-file。手动 PR 编排仍强制全部组。
部署控制器独立核算路径范围与工作流档位，仅允许未选组/案例跳过，
随后通过信任门禁才部署远程 k3s；基础通过不等于完整工作流已验收。
独立 Agent/CLI binary 工作流、调度器跨架构镜像验证和文档站发布由维护者手动触发；
Server 内置 Agent 的构建校验随相关 PR 和生产镜像发布自动执行；
不再托管 runner 限时预览或 main 预览。具体入口见 [GitHub Actions](../deployment.md#actions)。
手动完整 CI 使用 `test:unit` 的临时数据库和逐文件进程隔离，再单独执行
`test:integration`，避免跨测试文件累积数据库连接；不复用业务数据库。

## 离线交付与启动 seed

已支持共享合同的运行时导入和 Compose 只读启动 seed、逐项持久化收据、material v2 许可证/来源附件与签名生态材料关联。详见 [离线交付说明](../offline-delivery.md)。真实 samtools@1.23.1 离线安装与作业验收尚未执行，需材料端及获授权隔离站点补齐。

离线交付接口在 Preview、Helm 与单域名/多域名外层代理上统一采用 1800 秒响应等待、
2 MiB 请求上限和既有鉴权转发，避免大型 recipe 预检被外层默认 60 秒超时截断。
自定义站点代理需同步更新；该配置修复不代表科学工作流已经运行通过。

离线材料共享的来源/许可证附件按摘要和大小去重处理，避免同一大文件随引用次数反复读取与传输。
原始证据关联不改写，同摘要不同大小仍作为合同错误拒绝。


### 安装中断人工维护

平台管理员可通过 `/api/cp/software/operations/:operationId/close-interrupted` 收尾旧版遗留的
queued/running 软件操作。入口要求 Agent 离线、显式确认 worker 已停止和匹配的操作更新时间；
只标记控制操作失败并原子记录审计，不清锁、不改库存。详见 [安装恢复说明](../spack-install-recovery.md)。
