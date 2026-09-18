# 部署与开发环境

本页列出本地开发、调度器 smoke、文档站构建和生产部署的命令与注意事项。

## 本地开发

启动或关闭开发栈：

```bash
bun run dev:compose
bun run dev:compose:build
bun run dev:compose:down
```

这些命令通过 `scripts/compose.ts` 调用 Docker Compose。

## 真实调度器开发环境

需要 Slurm、PBS、K3s 三类调度器时，使用 scheduler compose stack：

```bash
bun run dev:scheduler:compose
bun run dev:scheduler:compose:build
bun run dev:scheduler:compose:down
```

也可以直接调用 compose 文件：

```bash
docker compose --project-directory . -p kq-schedulers --env-file deploy/schedulers/ports-alt.env \
  -f deploy/compose/docker-compose.schedulers.yml up
```

默认 project 为 `kq-schedulers`，高位端口来自 `deploy/schedulers/ports-alt.env`。Web 开发入口通常是：

```text
http://localhost:15173
```

Server 与 Registry 默认映射：

```text
Server: http://localhost:13000
Server gRPC: http://localhost:13001
Registry: http://localhost:13100
```

## 验证调度器识别

```bash
bash deploy/schedulers/verify-recognition.sh deploy/compose/docker-compose.schedulers.yml deploy/schedulers/ports-alt.env
```

识别成功时应看到：

- `scheduler-slurm` online，类型为 `slurm`。
- `scheduler-pbs` online，类型为 `pbs-pro`。
- `scheduler-k3s` online，类型为 `kubernetes`。

## Scheduler 深度验收

调度器栈启动后，可按风险从低到高执行：

```bash
bash deploy/schedulers/job-smoke.sh deploy/compose/docker-compose.schedulers.yml deploy/schedulers/ports-alt.env
bash deploy/schedulers/cluster-file-roots-smoke.sh deploy/compose/docker-compose.schedulers.yml deploy/schedulers/ports-alt.env
bash deploy/schedulers/file-transfer-cancel-smoke.sh deploy/compose/docker-compose.schedulers.yml deploy/schedulers/ports-alt.env
bash deploy/schedulers/db-pool-diagnostic.sh deploy/compose/docker-compose.schedulers.yml deploy/schedulers/ports-alt.env
bash deploy/schedulers/file-transfer-restart-smoke.sh deploy/compose/docker-compose.schedulers.yml deploy/schedulers/ports-alt.env
```

这些脚本复用已运行的 `kq-schedulers` 栈，不会启动新服务。`job-smoke.sh` 默认验证 Slurm/PBS 的 submit、status、stdout logs 与 cancel，设置 `KQ_JOB_SMOKE_INCLUDE_K3S=true` 后追加 K3s 检查。`file-transfer-cancel-smoke.sh` 在 multipart 上传出现进度后取消传输，并确认 NetDrive 未发布目标对象。`db-pool-diagnostic.sh` 不连接 PostgreSQL，通过 postgres 进程和 Docker 网络映射定位连接来源；`file-transfer-restart-smoke.sh` 默认只验证 API filter，不重启 Server。

需要在同一环境检查 DB pool 配置、migration、Cluster File Roots live check 和 file transfer restart reconciliation 时，先运行不重启服务的模式：

```bash
bash deploy/schedulers/interruptible-validation.sh deploy/compose/docker-compose.schedulers.yml deploy/schedulers/ports-alt.env
```

只有在允许中断服务的维护窗口内，才执行 opt-in 模式：

```bash
KQ_SCHEDULER_INTERRUPTIBLE_VALIDATION_RESTART=true \
  bash deploy/schedulers/interruptible-validation.sh deploy/compose/docker-compose.schedulers.yml deploy/schedulers/ports-alt.env
```

opt-in 模式会重启现有 `spicedb`、`server`、`registry`，执行 scheduler stack DB migration，再运行 Cluster File Roots smoke 与 file transfer restart reconciliation smoke。

## 文档站

文档站位于 `packages/docs-site`，使用 VitePress。

```bash
bun run docs:dev
bun run docs:build
bun run docs:preview
```

GitHub Pages project site 需要 base path。CI 会设置：

```bash
DOCS_BASE="/${GITHUB_REPOSITORY#*/}/"
```

本地如需模拟：

```bash
DOCS_BASE="/kuintessence/" bun run docs:build
```

## 生产部署提示

生产部署前检查：

- Server、Web、Registry 的外部 URL 和反向代理路径。
- Postgres、RustFS、Redis 的持久化卷和备份。
- Helm 每个 revision 的数据库 migration Job 成功，Server/Registry initContainer 未绕过该门禁；升级前已完成数据库快照，且理解 schema 为 forward-only。
- `REGISTRY_AUTH_MODE=jwt` 及 issuer/audience；OCI blob 使用持久卷，禁止生产回退到 `InMemoryBlobStore`。
- Server 与 Registry 保持单副本；共享 event bus、Agent session ownership、cron leader election 和共享 upload session 尚未实现，不得启用 HPA。
- OIDC/SSO 与 cookie/CSRF 策略。
- Agent-Server mTLS 或 trusted-proxy 边界。
- NetDrive、SSH recording、Metering webhook 的 feature flags。
- 在“平台管理 → 平台审计”确认文件传输审计的两类保留期与下载证据模式。生产保持 `controlled_gateway`；`direct_authorization_only` 只记录授权，不能证明下载已完成。
- Metering webhook 每次投递都执行 DNS 公网地址校验、逐跳重定向复核和总超时；运维不得以代理绕过该出站门禁。
- 先通过 Settings 配置并 live-check Cluster File Roots；production 保持 `CLUSTER_FILE_STATIC_ROOTS` 为空。该变量仅用于开发 bootstrap，非空时必须是逗号分隔的绝对非 `/` 路径。
- Helm values 或 Compose override 与当前文档一致。

## 不应在日常任务中随意启动的内容

验证本地页面时，优先复用已运行的 `http://localhost:15173`，避免重复启动 dev server 或基础设施。重启 stack 前，先确认 compose project、端口映射及是否允许中断服务。
