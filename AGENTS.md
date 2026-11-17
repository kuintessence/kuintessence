# Kuintessence 开发约定

## 项目

TypeScript/Bun monorepo，包含 Server、Agent、Registry、Web、CLI、共享 schema、
数据库、protobuf 和文档站。Server 使用 Hono/PostgreSQL；Agent 使用 SQLite，
适配 Slurm、PBS Pro、Torque 和 Kubernetes。

## 工作原则

- 默认使用中文沟通和编写项目文档，保留技术名词、API、配置键和代码标识符的英文。
- 先阅读相关代码，沿用现有组件边界和模式，不回退其他人的修改。
- 修改功能或用法时同步更新文档；功能状态见 `docs/status/current-state.md`。
- 不擅自启动服务、容器、真实集群任务或执行远端发布。
- 遵守用户指定的验证范围。用户禁止测试时，不运行测试、smoke 或触发测试的包装命令。
- 不通过推送、安装脚本或 commit hook 间接绕过用户的执行限制。

## 代码与验证

- TypeScript strict mode，2 空格缩进、双引号、分号，遵循根 `biome.json`。
- 使用 `import type`、Zod 推导类型和包内配置模块，不使用 `any` 或静默吞错。
- 只为不明显的约束写注释；应用日志使用 pino，不记录密码、token、私钥或 cookie。
- 不手改 `packages/proto/src/generated/`、`packages/web/src/routeTree.gen.ts`、
  `packages/db/migrations/`、`dist/`、`node_modules/` 或 `bun.lock`。
- 不用 lint/type suppressions 掩盖问题。
- TypeScript、JSON 或 CSS 修改后运行 `bun run lint` 和 `bun run typecheck`。
  仅允许静态检查时可直接调用各 package 的 TypeScript `--noEmit`，并注明没有运行 protobuf 生成。
- 行为修改通常需要对应测试；报告实际执行的检查及结果。
- 文档链接与 workflow 引用检查应为离线静态检查。
- 不跳过 Git hooks；不未经授权 commit、改写历史或 push。

## 交付流程

- 完成变更并通过本地验证后，默认提交到功能分支、推送并创建 PR；必要的 CI 检查通过后，通过 PR 合并到 `main`，无需再次询问是否提交、推送或合并。
- 不直接向 `main` 推送，不跳过 Git hooks、必要检查或仓库的合并保护。
- PR 合并到 `main` 后，立即启动部署监听命令（例如 `gh run watch <run-id> --exit-status`），持续监听对应合并提交的生产部署，直到完成；不能用旧提交的部署成功或仅镜像构建成功代替本次部署成功。
- 部署成功后，报告对应 PR／提交、部署结果及访问入口，明确通知用户开始人工测试。部署失败时说明失败环节与原因，不宣称可以开始人工测试；部署仍在进行时，不以“尚未核验”结束交付。
- 用户明确要求仅审查、不提交、不推送或限制验证范围时，以用户当次要求为准，不借交付流程绕过限制。

## 公开资料

凭据、数据库、内部主机清单和过程记录不纳入版本控制。
示例使用通用名称与虚构数据；第三方受限输入由使用者自行取得，不随仓库分发。
