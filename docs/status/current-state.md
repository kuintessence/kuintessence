# 当前功能与使用边界

Kuintessence 当前为 pre-release。以下列出组件功能、运行要求和暂未支持的能力。

## 组件

| 组件 | 功能 | 使用前提 |
|---|---|---|
| 平台服务（Server） | API、作业管理、放置流水线、偏好、审计、计量 | PostgreSQL、身份与权限配置 |
| 接入代理（Agent） | Slurm、PBS Pro、Torque、Kubernetes；监控与离线队列 | 调度器命令及站点运行权限 |
| Workflow | YAML 控制流 DSL、CEL、条件、循环、子工作流与 scatter-gather | 软件、数据及目标集群满足约束 |
| 软件仓库（Registry） | 软件/用例/工作流目录、OCI、Spack buildcache | 发布者权限及 artifact 存储 |
| Web | 用户工作区、React Flow 编辑器、CP Console、平台管理 | Server/Registry API |
| CLI | 远程命令、TUI、无 Server 本地调度器 GUI | 对应远程身份或本地调度器 |
| NetDrive | S3/MinIO、multipart upload、Range resume、集群传输 | 显式启用与完整存储配置 |
| SSH | PTY、窗口调整、凭据 vault、可选录屏 | 目标集群凭据、权限及网络可达 |

## 工作流边界

- 工作流采用控制流 DSL，编辑器与执行器使用共享 Schema 校验文档。
- Script 节点显式声明 source/scriptRef、runtimeProfileId/runtimeContractRef 和 inputs/outputs 契约；
  source 与 runtime 各选一种引用形式。
- Web 根据持久化的 graph 显示节点与依赖；本地或尚未保存 graph 的运行显示节点状态列表。
- CLI/TUI 从节点结果读取运行详情，结果尚未产生时展示 graph 与已关联的 Job；
  本地 GUI 直接使用结构化数据。执行中的 Job 关联由 `stepJobs` 保存，
  供取消、恢复、错误诊断和 Job 链接使用。

## 运行限制

- Server 的事件与会话状态保存在进程内，生产部署使用单实例；Redis 尚未用于多实例协调。
- Agent 生产连接需配置 mTLS 或受信任代理，证书注册和账本管理见[身份与安全](../security.md#agent)。
- Linux 登录节点使用 [`kq-agent` systemd 部署](../../deploy/systemd/README.md)：
  安装后完成注册、配置证书与调度器权限，再手动启用服务；升级保留站点配置。
- 通用 HTTP terminal 使用服务账号执行短命令；用户交互终端使用 SSH PTY。
- 运行软件前需在目标站点安装，并取得软件及数据的使用许可。
- CP 的 suspend/quota 写入口已停用，暂不支持通过这些接口暂停组织或设置并发硬限。
- 平台记录用量，外部计费系统生成账单。
- 本地 Compose 的初始化账号与固定样例口令只用于开发，不得用于公网环境。
- `full`、`watch` 与 scheduler 开发栈的 Registry 使用 Server 登录 JWT，
  保留开发模式和对外端口，供跨机器手动测试使用。
- scheduler 栈需显式设置 `KQ_DATA_MARKET_COMMITTER_SECRET_KEY`；
  手动镜像架构工作流仅在构建步骤使用配置解析占位值，不启动完整栈。
- [AIO 演示](../deployment.md#aio) 提供本机开发登录与公开测试凭据，
  自动初始化数据库和对象存储，仅绑定本机端口；不含 SSO、SpiceDB 或站点 Agent。
  Registry 的 OCI blob 和 Spack buildcache 与数据库、MinIO 数据共用持久化卷。
- 平台 Compose 入口集中在 [`deploy/compose/`](../../deploy/compose/README.md)；
  从仓库根目录使用 `bun run compose`。直接调用时指定 `--project-directory .`，
  以保留构建、挂载、根目录 `.env` 和默认项目名的路径基准。
- [GitHub 预览配置](../deployment.md#preview) 支持可信同仓库 PR 自动部署与 main 手动启停，
  使用带认证的限时 Quick Tunnel 和独立临时数据库；不包含真实调度器、SSO 或对象存储。
  预览配置尚待 GitHub Actions 运行验证。

## 文档与验证

- [认证与会话](../security.md#authentication)
- [Registry 权限](../security.md#registry)
- [Agent 注册和证书](../security.md#agent)
- [工作流规范](../workflow-schema/README.md)
- [系统运维](../manuals/system-operations-manual.md)
- [开发与检查命令](../../README.md#开发)

推送 `main` 和 PR 的 CI 默认只运行 Biome、文档链接及 workflow 引用静态检查，
安装时禁用生命周期脚本。完整类型检查、测试、binary 构建与 smoke、调度器镜像验证、
文档站发布均由维护者手动触发；可信同仓库 PR 限时预览保持独立自动运行，
main 预览仍手动启停。具体入口见 [GitHub Actions](../deployment.md#actions)。
