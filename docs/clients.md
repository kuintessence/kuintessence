# CLI、TUI 与本地 GUI

`kq` 支持连接远程 Server，也可在登录节点直接驱动 Slurm、PBS Pro、Torque 或 Kubernetes。
本地模式无需 Server，使用当前 shell 用户的权限。Kubernetes 需要已有 kubeconfig
和目标 namespace 的 Job 权限，不会自动扩大 RBAC。

- [TUI](#tui)：模式选择、面板、键位、日志和外部 Agent。
- [GUI](#gui)：浏览器、内嵌 SPA 与 Tauri 桌面壳。
- [本地工作流](#local-workflows)：数据目录、控制流示例、暂存与输出限制。

远程作业的 JSON spec 与提交流程见[用户手册](manuals/user-manual.md#cli)，能力边界见[当前实现状态](status/current-state.md)。

<a id="tui"></a>

## TUI 终端界面

`kq tui` 使用 `@opentui/react` 渲染终端界面，提供 Jobs、Workflows、Agents、Metrics 和 Software 面板。

### 启动与模式选择

```bash
kq login --server https://platform.example.com
kq tui
```

远程模式复用 `~/.kq/config.json` 中的登录态，文件权限应为 `0600`。
鉴权、RBAC、脱敏和 owner 范围由 Server 检查，TUI 展示后端返回值。

在 HPC 登录节点直接使用本地调度器：

```bash
kq tui --local
kq tui --local --scheduler slurm --pane metrics --interval 5
```

模式按以下优先级选择：

1. `--agent-url` 指定外部 Agent。
2. 未指定外部 Agent 时，`--local` 或 `KQ_TUI_LOCAL=1` 强制本地，`KQ_TUI_LOCAL=0` 强制远程。
   环境变量也接受 `true`/`false`。
3. 未显式选择时，已登录用户默认连接远程 Server；没有 token 时先探测本地调度器，探测失败再回退远程。

| 参数 | 含义 |
|---|---|
| `--local` | 强制本地调度器模式 |
| `--scheduler <type>` | 本地强制类型：`slurm`、`pbs-pro`、`torque`、`kubernetes` |
| `--pane <id>` | 首屏面板：`jobs`、`workflows`、`agents`、`metrics`、`software`；不可用时回退首个可用面板 |
| `--interval <seconds>` | 轮询间隔，默认 2 秒，范围 1–3600 秒 |
| `--db <path>` | 指定本地作业 SQLite 路径，支持 `~` |
| `--no-db` | 关闭本地作业历史持久化，不影响工作流运行库 |
| `--agent-url <url>` | 连接无 Server 的外部 Agent |
| `--agent-token <token>` | 外部 Agent token，默认读取 `KQ_AGENT_TOKEN` |

TUI 当前未注册 `--data-dir` 参数；迁移整个本地数据目录应使用 `KUINTESSENCE_HOME`，只改作业库位置使用 `--db`。

### 非交互本地命令

```bash
kq list --local
kq status <scheduler-job-id> --local
kq submit spec.json --local --scheduler slurm
kq cancel <scheduler-job-id> --local
kq logs <scheduler-job-id> --local --lines 200
kq dsl validate wf.yaml
```

作业生命周期命令均支持 `--local` 和可选 `--scheduler`。
提交调用调度器的 `sbatch`/`qsub`/`kubectl apply`，取消调用 `scancel`/`qdel`/`kubectl delete`。

本地 spec 使用顶层 `cpus`、`memoryMb`；远程 Job API 则将资源放在 `resources` 内，两种结构不能混用：

```json
{
  "name": "local-example",
  "command": "hostname",
  "cpus": 1,
  "memoryMb": 1024,
  "wallTimeSec": 60,
  "workingDir": "/path/to/shared/work"
}
```

`name`、`command`、`cpus`、`memoryMb` 必填；`gpus`、`wallTimeSec`、`workingDir`、`envVars` 可选。路径与软件必须在执行节点可用。
探测失败、spec 非法或调度器 CLI 不可用时返回可读错误并以非零码退出。

`kq logs --follow` 需要 Server；本地持续查看日志使用 TUI 的 `f`。
`kq dsl validate` 离线检查工作流 Schema 与静态语义，有效返回 0，否则列出错误并返回 1。
软件、文件和调度器的可用性需在目标环境中另行检查。

### 面板与状态

| 面板 | 远程 Server | 本地 |
|---|---|---|
| Jobs | 列表、详情、提交、取消、日志和状态订阅 | 当前调度器队列与 kq 历史作业，详情和可用日志 |
| Workflows | 运行列表、节点树、提交和状态订阅 | 数据目录中的工作流 spec、终态回看；提交接口限制见[本地工作流](#local-workflows) |
| Agents | 心跳、详情、Server 网关 SSH | 不启用，无 Agent 注册表 |
| Metrics | Server `agent_metrics` 中各 Agent 的指标 | 当前登录节点的 CPU、内存、队列深度、磁盘和可用 GPU 指标，不汇总整个集群 |
| Software | Registry Spack catalog、服务端搜索与分页 | 已安装软件只读目录，无平台治理生命周期 |

列表支持虚拟化，刷新后按 ID 保持选中项。Jobs、Workflows、Agents 显示状态汇总；
Software 显示服务端总数和页码。

`updated Xs ago` 表示上次成功加载距今时间，页面数据可能已过时。
远程 Agents/Metrics 的 `SEEN`、`Last seen` 或 `seen X` 显示距上次心跳的时间。

Jobs 详情按生命周期展示状态、待运行原因、位置、提交时间、排队时长、分配节点、
开始/运行/完成时间和退出码；缺失字段隐藏。
本地持久记录还可补充名称、`Requested` 资源、`Time limit` 与 `Command`。
Workflows 的 `Steps` 汇总各节点状态。

| 详情字段 | Slurm | PBS Pro | Torque | Kubernetes |
|---|---|---|---|---|
| `Node` | 支持 | 支持 | 支持 | 支持 |
| `Started` / `Elapsed` | 支持 | 不读取无时区起始字段 | 不读取无时区起始字段 | 支持 |
| `Reason` | 支持 | 支持 | 支持 | 未纳入 Pod 条件原因 |

`Queued` 由提交与开始时间计算。远程 `Node`/`Reason` 仅在 Server 返回对应字段时显示。

### 日志与软件目录

远程日志由 Server `GET /api/jobs/:id/logs?lines=N` 定位 Agent 与 scheduler job id，再调用 adapter。
单次最多 5000 行/1 MiB；TUI 用轮询 tail 跟随，
非交互 `kq logs --follow` 使用 `/api/jobs/:id/logs/stream` SSE。

| 返回状态 | 含义 |
|---|---|
| `409 JOB_LOG_UNAVAILABLE` | 确认日志尚未产生 |
| `410 JOB_LOG_UNAVAILABLE` | 终态作业日志文件缺失 |
| `502` | adapter 读取故障 |
| `503` / `504` | Agent 离线或超时 |

KQ 管理的 Slurm 作业在 `scontrol` 的 `StdOut` 路径失效后，可按 KQ Job UUID 尝试读取共享保留日志。
本地 Slurm/Kubernetes 支持运行中日志，PBS/Torque 通常在完成后读取。
读取失败时需先排查错误，再确认日志内容是否为空。

远程 Software 从 Registry catalog 读取目录，不使用 Server software policy route。
单域名 path mode 从 Server URL 派生 `/software/api/spack/catalog`；
独立域名用 `KQ_REGISTRY_URL=https://software.example.com` 指定，与 `kq software list` 共用。
登录 token 随请求发送，只能配置受信 origin；非 loopback origin 必须使用 HTTPS。

远程目录展示 `SOURCE/NAME/VERSIONS/LIFECYCLE`，`/` 后按 `enter` 提交服务端 `q`，`[`/`]` 翻页。

本地探测到 Spack 或 Environment Modules 时启用 Software；两者都没有时禁用。
当前枚举使用 `spack find --json`，仅有 Modules 的节点可能面板可见但列表为空。

### 键位

| 键 | 作用 |
|---|---|
| `↑`/`↓` 或 `j`/`k` | 移动选择 |
| `g` / `G` | 列表顶部 / 底部 |
| `PgUp`/`PgDn` 或 `Ctrl+u`/`Ctrl+d` | 按可视行数翻页 |
| `tab` | 在已启用面板间循环 |
| `1`–`5` | Jobs、Workflows、Agents、Metrics、Software；忽略未启用面板 |
| `enter` | 打开详情；提交表单内为确认，不是列表行直接提交 |
| `/` | 不区分大小写过滤；Software 远程搜索按 `enter` 提交 |
| `esc` | 清除过滤，或退出详情/日志/表单 |
| `[` / `]` | Software catalog 上一页 / 下一页 |
| `o` | 排序：default、name、status |
| `r` | 刷新；日志视图内重新拉取 |
| `s` | 打开文件提交表单：Jobs 为 JSON，远程 Workflows 为 YAML |
| `space` | 标记/取消标记作业；汇总显示 `N marked` |
| `x` | 取消标记作业或当前作业，`y` 确认、`n` 取消 |
| `l` / `f` | 查看 Jobs 日志 / 切换跟随 |
| 日志内 `j`/`k`、`g`/`G`、翻页键 | 滚动已加载缓冲区；向上回看暂停跟随，恢复跟随回到底部 |
| 日志内 `/` | 过滤已加载日志，显示匹配/总数；`esc` 清除 |
| `c` | Agents 面板打开 Server 网关 SSH |
| `?` | 键位帮助；`?`、`esc` 或 `q` 关闭帮助 |
| `q` | 退出 TUI |

SSH 开始前销毁 OpenTUI renderer 并归还 terminal，结束后重建界面，避免 raw mode 与 shell 争用 stdin。

### 外部 Agent

登录节点侧提供本地后端 HTTP API，客户端无需 Server：

```bash
# 在受控环境中设置 KQ_AGENT_TOKEN，再分别运行服务端和客户端
kq agent serve --host 127.0.0.1 --port 17650 --scheduler slurm
kq tui --agent-url http://127.0.0.1:17650
```

服务端支持 `--port`（默认 8787，范围 1–65535）、`--host`、`--token`、`--scheduler`、
`--data-dir` 和 `--no-db`，token 也可由 `KQ_AGENT_TOKEN` 提供。
配置 token 后，除 `/healthz` 外都要求 Bearer。

API 提供 jobs、提交、状态、取消、日志、软件、工作流、agents 与 `/capabilities`。
客户端按 capability 启用面板；不提供 Server SSH，metrics 仅显示登录节点指标。

默认只绑定 loopback。跨主机优先通过 SSH tunnel，禁止将调度器服务直接公开到网络。
`0.0.0.0` 且无 token 会告警；任务结束后关闭服务和 tunnel。

<a id="gui"></a>

## GUI 图形界面

`kq gui serve` 将本地后端转换为 Server 格式的 `/api/*` JSON，供 SPA 在无 Server 环境中使用。
可选磁盘 SPA、内嵌 SPA 的单二进制或 Tauri 原生桌面壳。
Tauri 位于顶层 `gui/`，不属于 `packages/*` Bun workspace。

### 服务参数

```bash
kq gui serve --host 127.0.0.1 --port 8799 \
  --scheduler slurm --web-dir packages/web/dist --open
```

| 参数 | 含义 |
|---|---|
| `--port <n>` | 默认 8799，范围 1–65535 |
| `--host <host>` | 默认 `127.0.0.1` |
| `--token <token>` | 可选 Bearer token，也可用 `KQ_GUI_TOKEN` |
| `--scheduler <type>` | `slurm`、`pbs-pro`、`torque`、`kubernetes`；默认探测 |
| `--data-dir <path>` | 指定本地作业库目录，库文件 `local.db`；工作流目录使用 `KUINTESSENCE_HOME` |
| `--no-db` | 不持久化本地作业，工作流仍依赖运行库 |
| `--web-dir <path>` | 托管已经构建的 SPA，磁盘目录优先于内嵌 SPA |
| `--open` | 尝试用默认浏览器打开服务地址，headless 节点可手动访问 |

启动时打印监听地址、调度器和 auth 状态；没有 SPA 时打印 `GUI API`，仅提供 API，未知路由返回 404。

### SPA 托管与本地会话

磁盘 SPA 和内嵌 SPA 共用路由规则：优先处理 `/api/*`，静态资源按 Content-Type 返回，
其他客户端路由回落到注入后的 `index.html`。静态路径必须位于 `webDir` 内。

页面注入：

```js
window.__KQ_LOCAL__ = { baseUrl: "/api", token: "<本地会话 token>" };
```

注入后 SPA 直接进入本地会话，请求使用指定 baseUrl/Bearer；没有注入时仍是标准 Server 客户端。
独立托管 SPA 时需自行注入本地 API 的绝对地址，例如 `http://127.0.0.1:8799/api`，
并确保浏览器能访问该地址。

本地 GUI 不提供多用户安全隔离。配置 token 后，受保护 API 要求 Bearer，
但 `/api/auth/login` 会返回本地 token，公开首页也会注入该 token；
`/api/auth/oidc/config-public` 返回 `enabled:false`。

`auth: on` 只表示 API 启用了 Bearer 检查，服务仍须绑定 loopback、
使用受控 SSH tunnel 或外围访问控制。共享主机还需限制其他本地用户的访问。
未设 token 时 API 不强制 Bearer，`local-dev` 仅用作 SPA 会话标识。

### 可用范围与限制

- SPA 按 capability 展示 jobs、workflows、软件、个人设置和 dashboard 等可用子集；没有完整 Agent 注册表，Agents 页面可能为空。
- 隐藏算力提供方、平台管理、Terminal 与 Files；dashboard 不请求 audit-log，不显示 SSO。
- NetDrive/文件浏览、Web PTY、CP 控制台与审计等 Server-only 路由返回 404 `not available in local mode`。
- 本地 Job API 仅执行 `name`、`command`、`resources`、`workingDir`、`envVars`；携带 `inputStaging`、software/data/usecase 和 placement 等 Server-only 字段时返回 501。
- Job 详情保留 scheduler 提供的执行节点、失败原因、exit code 和日志，活跃作业可确认后取消。
- 不提供 Server 的 8 阶段 placement 轨迹和实时 Agent 遥测；缺失字段为 `null` 或省略，表示数据不可用，而非资源为零。
- 无 Server RBAC、多租户或脱敏治理。工作流内的本地文件拷贝与上述 Job API 限制是不同路径，见[本地工作流](#local-workflows)。

### 分发与构建入口

开发/源码运行要求 Bun `>=1.3.0`；编译后的 `kq` 无外部 Bun 运行时依赖，但仍需要目标调度器 CLI。

| 工件 | 仓库根目录命令 | 产物或前提 |
|---|---|---|
| 当前平台 CLI/TUI | `bun run --filter @kuintessence/cli build` | `packages/cli/dist/kq`，常规构建不含 SPA |
| Linux x64 CLI/TUI | `bun run --filter @kuintessence/cli build:linux` | `packages/cli/dist/kq-linux-x64`；在 Linux x64 构建以嵌入匹配的 OpenTUI native package |
| 磁盘 SPA | `bun run --filter @kuintessence/web build` | `packages/web/dist`，交给 `--web-dir` |
| 内嵌 SPA 单二进制 | `bun run gui:single-binary` | `packages/cli/dist/kq`，可直接 `kq gui serve --open` |
| Tauri 桌面 App | `bun run gui:bundle` | `gui/src-tauri/target/release/bundle/`；macOS 为 App/DMG |

`gui:single-binary` 构建 SPA，将资源编码到 `packages/cli/src/gui-serve/embedded-spa.ts` 后编译 CLI，
再恢复该模块。恢复动作会覆盖该模块的工作区修改，执行前必须确认没有需要保留的未提交编辑。
磁盘和内嵌 SPA 都不存在时，`kq gui serve --open` 仅启动 API 服务，无可用界面。

Tauri 构建需要 Rust/cargo 与 Tauri CLI。`gui:bundle` 准备 `kq-<target-triple>` sidecar、
构建 SPA，并在 `gui/` 安装依赖后打包。

桌面壳选择空闲端口和随机 token，启动 `kq gui serve` sidecar，在加载 SPA 前注入本地变量，
退出时结束子进程。图标来源为 `gui/src-tauri/icon-source.svg`，
可在 `gui/` 用 `bunx @tauri-apps/cli icon src-tauri/icon-source.svg` 重新生成。

常规 workspace 命令不进入 `gui/`，无需 Rust；桌面构建是显式入口，生成目录按仓库 ignore 规则处理。

<a id="local-workflows"></a>

## 本地工作流

本地控制流复用 `@kuintessence/shared` 的 `runWorkflow` 与 `createUsecaseExecutor`，从本地软件包目录解析能力包，经 `LocalWorkflowRunner` 和 `ExecutorPool` 驱动调度器。

### 数据目录与持久化

| 内容 | 默认位置 |
|---|---|
| 作业与工作流运行库 | `~/.kuintessence/local.db` |
| 软件包目录 | `~/.kuintessence/packages.yaml` |
| 工作流 spec | `~/.kuintessence/workflows/*.{yml,yaml}` |
| 软件目录缓存 | 本地数据目录 |
| 远程 Server 登录态 | `~/.kq/config.json`，不随本地目录迁移 |

通过 `KUINTESSENCE_HOME` 覆盖本地数据目录。TUI `--db`、GUI/外部 Agent `--data-dir` 仅重定位作业库，不能代替工作流目录配置。

本地 Jobs 列表合并调度器实时队列与已离队的 kq 历史作业，重启后保留最后状态和提交资源。
调度器接受取消后，本地 `cancelled` 不被粗粒度 terminal 状态覆盖；
保留可用 exit code，不展示因资源删除而失效的查询消息。

作业库打不开时降级为实时查询，`--no-db` 也只关闭作业历史。
工作流运行库不可用时，工作流能力会禁用。

首次发现旧 `~/.kq/local.db` 且新目录没有库时自动复制，保留旧文件。显式迁移：

```bash
kq config migrate --from <旧目录> --to <新目录>
```

迁移只复制 `local.db`，不搬 `config.json`/token、不删除旧目录。
显式迁移会覆盖已有目标库，重复执行前须确认目标没有新增记录。
迁移前先停止相关进程并备份数据库，避免覆盖或复制正在写入的 SQLite。

### 软件包与面板条件

Workflows 面板列出数据目录中可解析的工作流 YAML。
至少有一个可解析 spec，且运行库和工作流支持初始化成功后，面板才启用。
没有 `packages.yaml` 时面板仍可启用，但 usecase 节点执行时找不到包会报
`no local package for usecase …`；软件包目录存在但格式无效也会使初始化失败。

`packages.yaml` 为 `usecaseVersionId → UsecasePackage` 映射，由 shared `UsecasePackageSchema` 校验，结构与 Server 存储一致。

### 示例准备与执行入口

示例文件保留在 [packages.yaml](examples/all-in-one/packages.yaml) 与
[hello.yaml](examples/all-in-one/workflows/hello.yaml)。在仓库根目录执行以下准备命令前，先备份数据目录中已有同名文件，不覆盖自己的包目录：

```bash
mkdir -p ~/.kuintessence/workflows
cp -i docs/examples/all-in-one/packages.yaml ~/.kuintessence/packages.yaml
cp -i docs/examples/all-in-one/workflows/hello.yaml ~/.kuintessence/workflows/
kq tui --local --pane workflows
```

列表显示名称 `hello`，spec ID 为 `hello.yaml`。`enter` 打开详情：
尚未运行时预览 pending 节点，已有记录时显示同名 spec 的最近运行。
也可按运行 ID 读取终态记录。

GUI 详情直接传递运行的 `result`、`graph` 和 `stepJobs`，不从 TUI 展示文字还原 Job ID。
预览使用 spec 的 graph 和 `Pending` 节点状态；SQLite 终态记录未保存 graph 时只显示节点状态列表。
Job 查询失败的节点仍保留，缺少状态时显示 `unknown`；没有有效 Job ID 时不提供 Job 详情入口。

本地 TUI 的 `s` 表单读取文件后传入 YAML 正文，而本地后端要求工作流目录下的文件名，
因此目前无法通过该表单提交本地工作流。

GUI 的本地工作流 API 将请求中的 `yaml` 字符串直接传给后端，该字段应填 spec 文件名，
而非 YAML 正文。准备好工作流目录并启动受控本地 GUI API 后，可这样提交：

```bash
curl -fsS http://127.0.0.1:8799/api/workflows \
  -H "Authorization: Bearer ${KQ_GUI_TOKEN}" \
  -H "Content-Type: application/json" \
  --data '{"yaml":"hello.yaml"}'
```

后端等待执行结束并保存记录后才返回 `runId`，响应中的 `submitted` 标签不随执行进度更新。
运行记录保存在 `local.db` 的 `local_workflow_runs`；详情用于终态回看，不提供实时逐步骤流。

示例解析为 Bare 软件包，使用执行节点已有 `bash`，不要求 Spack 或容器，但需要可用调度器和可读写的工作目录：

```bash
bash -c 'echo 42 > result.txt; echo sum=99'
```

`result.txt` 作为 `filesomeOutputs` 的 `result` 被读取，通过 `valueOutputs` 正则提取 `nodes.hello.values.answer = 42`；成功捕获 stdout 时提取 `nodes.hello.values.sum = 99`。这覆盖命令物化、文件采集与值提取，不演示输入文件暂存。

### 输入暂存与输出限制

- 工作流物化的 `inputStaging` 支持本地文件拷贝，`fileMetadataId` 填当前主机源文件路径，不填 Server 文件对象 ID。
  绝对路径原样使用，相对路径默认以服务进程的当前工作目录解析；设置 `LocalFileStager.base` 后以该目录解析。
- 目标 `stagePath` 在 launcher 工作目录内解析，自动创建父目录；拒绝越出工作目录的路径，源不存在或不可读会报错。
  当前工作流 launcher 共用数据目录，不按作业隔离；需避免同名输出和并发覆盖。
- 这是本机文件系统拷贝，不含 NetDrive、跨站点传输或自动挂载。调度器执行节点必须能访问暂存目标与输出路径；Kubernetes 等环境需要自行确保目录可见。
- 文件型输出按 `filesomeOutputs` 采集，`valueOutputs` 提取结果供下游使用；批量输出 glob 跳过。
- `from.collectedOutDescriptor: "stdout"` 从 adapter 日志获取标准输出用于值提取，尽力而为，捕获失败不把已完成作业改成失败；同名文件输出优先，不被 stdout 覆盖。
- 本地 Workflow 运行记录保留叶子作业的 message/exit code，仅供终态回看，不提供实时逐节点监控。
- GUI 直接提交 Job 时拒绝 `inputStaging` 等 Server-only 字段；文件暂存仅在工作流 launcher 路径中可用。
