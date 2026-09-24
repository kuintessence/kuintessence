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

- 源码运行、CI 与新构建镜像固定使用 Bun 1.4.2，最低要求为 1.4.2。
  材料上传依赖其 HTTP 拒绝连接关闭修复；升级须重新构建旧镜像与编译产物，
  不能只修改配置后继续复用旧 Bun runtime。详见[材料上传边界](../spack-material-delivery.md)。
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
  新 Web 链路尚待新 HEAD 的 Actions 验证，不沿用 PR #9 的通过结论。
  这些入口仅在 Actions 执行，不部署 preview/production，不上传材料；
  `feat/spack-artifact-managed` 和 `feat/spack-web-managed` 调用独立导出工作流
  均仅允许 `publish_artifact=false`，不放宽其他分支与许可确认规则。
  当前没有通用材料生成器或全部 15 项的完整材料 artifact；每软件须独立单 root
  lock/release、每步骤隔离运行环境，不能用 macOS lock 替代目标 Linux lock，
  也不能把此切片视为完整变异检测工作流验收。
- Workflow 的 Spack facility 新增内部结构化激活交付，由 Agent 复用现有 load
  校验后再提交 scheduler 作业；缺少能力或激活失败时不能执行未激活命令。
  [Spack 工作流闭环](../../deploy/pr-test/README.md#spack-工作流闭环)新增
  Hello/samtools 的签名目录注册、材料 bootstrap、managed 安装与正式异步
  `/workflows` 两节点执行验收，包含结果依赖及重启回读/重跑。
  验收以对应提交的 Actions 结果为准，不沿用直接 `/jobs` 的通过记录。Agent/OS 兼容性后续
  独立 PR；现有隔离、OS/工具链指纹和 Server-only 材料交付约束不放宽。
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
- [Spack 受控上游导入](../spack-upstream-import.md)
- [Spack 材料 Rollout](../spack-material-rollout.md)
- [科学工作流 Spack 材料准备](../spack-workflow-materials.md)
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
