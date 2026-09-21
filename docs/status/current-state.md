# 当前功能与使用边界

Kuintessence 当前为 pre-release。以下列出组件功能、运行要求和暂未支持的能力。

## 组件

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

## 工作流边界

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

- 自托管对象存储已统一配置为 RustFS，初始化使用 `rc` 而非 MinIO `mc` 镜像；
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
  Python install worker 已实现并通过模拟 native API 的 fixture 测试。
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
  完成后才导入材料，成功 binding 仍须运维显式配置到 Server，不自动启用安装。
  平台与 CP 门户支持材料包 Web 上传、重试、取消和按 binding 查阅，切换身份/组织/
  发布能力时清空临时结果并中止请求；发布响应丢失保留“结果待确认”，不宣称回滚。
  已增加权限过滤的材料目录、精确仓库筛选和分页查阅；直接发现持久化 release，
  单次响应最多 200 项，扫描/字节/时间超限明确失败，不返回伪完整的截断列表。
  受限厂商安装包/许可证授权、HTTP/SOCKS 上游代理、
  大规模材料目录索引/删除/可见范围变更及 15 个工作流的目标 Linux 材料、lock 和端到端安装/运行验收仍未完成。
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
- [GitHub 预览配置](../deployment.md#preview) 支持可信同仓库 PR 自动部署与 main 手动启停，
  使用带认证的限时 Quick Tunnel 和独立临时数据库；不包含真实调度器、SSO 或对象存储。
  预览配置尚待 GitHub Actions 运行验证。
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
- [Agent 注册和证书](../security.md#agent)
- [工作流规范](../workflow-schema/README.md)
- [系统运维](../manuals/system-operations-manual.md)
- [开发与检查命令](../../README.md#开发)

`CI` 工作流在推送 `main` 和 PR 时默认只运行 Biome、文档链接及 workflow 引用静态检查，
安装时禁用生命周期脚本。完整类型检查/全套测试、binary 构建与 smoke、跨架构镜像验证、
文档站发布仍由维护者手动触发；可信同仓库非草稿 PR 的 Slurm/PBS 测试和限时预览
分别自动运行，main 预览仍手动启停。具体入口见 [GitHub Actions](../deployment.md#actions)。
手动完整 CI 使用 `test:unit` 的临时数据库和逐文件进程隔离，再单独执行
`test:integration`，避免跨测试文件累积数据库连接；不复用业务数据库。
