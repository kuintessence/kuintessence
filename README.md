# Kuintessence

Kuintessence 是统一算力服务与科学计算工作流平台，将 Slurm、PBS、Torque 和 Kubernetes
接入同一套作业管理、工作流编排、软件治理与文件服务。
提供 Web 界面、CLI、TUI 及本地 GUI。

项目目前为 pre-release，已实现的功能和部署要求见[当前状态](docs/status/current-state.md)。

## 架构

| 组件 | 职责 |
|---|---|
| 平台服务（Server） | Hono API、全局调度、工作流引擎、身份与权限、审计、NetDrive |
| 接入代理（Agent） | 调度器适配、资源监控、软件环境、文件传输、离线队列和 SSH relay |
| 软件仓库（Registry） | 软件与工作流模板、OCI artifact、Spack buildcache |
| Web | 用户工作区、CP Console、平台管理与工作流编辑 |
| CLI | `kq` 远程命令、本地调度器 TUI 与 GUI |

Server 使用 PostgreSQL；Agent 使用 SQLite。Server 与 Agent 通过 connectRPC 通信。
文件服务使用 S3/RustFS。Redis 在部署配置中预留，当前 Server 事件总线仍在进程内。
Web 中的“软件中心”提供软件、用例和模板入口；Registry 是支撑这些功能的软件仓库服务。

## 快速开始

需要 Bun 1.3 或更高版本，以及 Docker Compose。固定的 Bun 版本见 `packageManager`。

```bash
git clone https://github.com/kuintessence/kuintessence.git
cd kuintessence
bun install --frozen-lockfile
bun run compose -- full up --build --attach
```

| 服务 | 本地地址 |
|---|---|
| Web | `http://localhost:5173` |
| Server HTTP | `http://localhost:3000` |
| Server connectRPC | `localhost:3001` |
| Registry | `http://localhost:3100` |
| RustFS console | `http://localhost:9001` |

这套配置用于本地开发和演示。生产部署需更换示例账号与口令，通过 Secret 注入凭据。
Agent 需单独部署在能访问调度器命令的主机上。

停止服务使用 `bun run compose -- full down`；加上 `-v` 会同时删除持久化卷中的数据。

## 使用与部署

- 科研计算用户：[用户手册](docs/manuals/user-manual.md)、[工作流规范](docs/workflow-schema/README.md)。
- 算力提供方：[CP 手册](docs/manuals/compute-provider-manual.md)、[Agent systemd 部署](deploy/systemd/README.md)。
- 平台运营：[运营手册](docs/manuals/platform-operator-manual.md)、[系统运维手册](docs/manuals/system-operations-manual.md)。
- 本地调度器：[TUI](docs/clients.md#tui)、[GUI](docs/clients.md#gui)。
- 平台部署：[Helm](deploy/helm/kq-platform/README.md)、[反向代理](docs/deployment.md#proxy)、
  [认证与会话](docs/security.md#authentication)、[NetDrive](docs/storage.md#transfers)。
- 示例：[工作流与 Compose 示例](examples/README.md)。

科学软件和受限数据由使用者取得授权后自行配置。仓库中的 mock fixture 使用文本占位文件，
供编排和文件传输测试使用。

## 开发

```bash
bun run --filter @kuintessence/proto generate
bun run dev:compose:build
```

日常容器内热更新使用 `bun run dev:compose`，停止使用 `bun run dev:compose:down`。
更多配置见[本地调度器指南](docs/deployment.md#compose)。

平台 Compose 文件统一位于 [`deploy/compose/`](deploy/compose/README.md)，
由 `bun run compose` 选择配置。直接调用 Docker Compose 时须从仓库根目录执行，
并加 `--project-directory .`。

| 命令 | 范围 |
|---|---|
| `bun run lint` | Biome 静态检查 |
| `bun run typecheck` | protobuf 生成与 TypeScript 检查 |
| `bun run check:workflow-uses` | GitHub Actions 引用静态检查 |
| `bun scripts/check-doc-links.ts` | 本地文档链接静态检查，无网络请求 |
| `bun run test:unit` | 单元测试 |
| `bun run test:integration` | Agent 集成测试 |
| `bun run test:web` | Web 浏览器测试 |
| `bun run test:e2e` | 全栈测试 |

运行集成和全栈测试前，配置独立的测试数据库、容器与调度环境，
核对 `SERVER_URL` 和 `DATABASE_URL`，避免写入或删除生产数据。

## 仓库结构

```text
packages/
  shared/         Zod schema、类型与共享逻辑
  proto/          connectRPC 协议
  db/             Drizzle schema 与 migrations
  server/         平台服务
  agent/          站点 Agent
  registry/       软件仓库
  cli/            kq CLI、TUI、本地 GUI API
  web/            React SPA
  docs-site/      VitePress 文档站
docs/             使用说明、操作指南与工作流规范
deploy/           通用部署模板
  compose/        平台 Compose 入口与覆盖层
examples/         示例
test/             全栈测试
gui/              可选 Tauri 桌面外壳
```

## 文档站

```bash
bun run docs:dev
DOCS_BASE="/kuintessence/" bun run docs:build
```

完整入口见[文档索引](docs/README.md)。推送 `main` 和提交 PR 默认只运行 CI 静态检查；
测试、Agent/CLI 构建、调度器镜像验证和文档站发布均须手动触发。
可信同仓库 PR 的限时预览独立运行，main 预览须手动启停。
触发条件和操作入口见[GitHub Actions](docs/deployment.md#actions)。

## License

除另有说明的第三方材料外，本项目的代码与文档采用
[GNU Affero General Public License v3.0](LICENSE)，SPDX 标识为 `AGPL-3.0-only`。
第三方依赖、软件目录元数据及外部科学软件适用各自的许可证。
