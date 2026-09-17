# 命令速查

## Workspace

```bash
bun install
bun run lint
bun run typecheck
bun run build
bun run test:unit
bun run test:integration
bun run test:web
bun run test:e2e
```

## Docker Compose

```bash
bun run compose -- list
bun run dev:compose
bun run dev:compose:build
bun run dev:compose:down
bun run dev:scheduler:compose
bun run dev:scheduler:compose:build
bun run dev:scheduler:compose:down
```

## Scheduler Smoke

```bash
bun run dev:scheduler:compose
bun run dev:scheduler:compose:build
bash deploy/schedulers/smoke.sh
bash deploy/schedulers/verify-recognition.sh deploy/compose/docker-compose.schedulers.yml deploy/schedulers/ports-alt.env
bash deploy/schedulers/job-smoke.sh deploy/compose/docker-compose.schedulers.yml deploy/schedulers/ports-alt.env
bash deploy/schedulers/cluster-file-roots-smoke.sh deploy/compose/docker-compose.schedulers.yml deploy/schedulers/ports-alt.env
bash deploy/schedulers/db-pool-diagnostic.sh deploy/compose/docker-compose.schedulers.yml deploy/schedulers/ports-alt.env
bash deploy/schedulers/file-transfer-restart-smoke.sh deploy/compose/docker-compose.schedulers.yml deploy/schedulers/ports-alt.env
bash deploy/schedulers/interruptible-validation.sh deploy/compose/docker-compose.schedulers.yml deploy/schedulers/ports-alt.env
KQ_SCHEDULER_INTERRUPTIBLE_VALIDATION_RESTART=true \
  bash deploy/schedulers/interruptible-validation.sh deploy/compose/docker-compose.schedulers.yml deploy/schedulers/ports-alt.env
```

`interruptible-validation.sh` 默认只做 DB pool diagnostic 和 file-transfer API filter smoke，不重启服务。设置 `KQ_SCHEDULER_INTERRUPTIBLE_VALIDATION_RESTART=true` 后会重启现有 `spicedb`、`server`、`registry`，执行 scheduler DB migration，再运行 Cluster File Roots 与 transfer restart smoke。此模式只能在允许中断服务的维护窗口内使用。

## 文档站

```bash
bun run docs:dev
bun run docs:build
bun run docs:preview
DOCS_BASE="/kuintessence/" bun run docs:build
```

## 数据库

```bash
bun run db:generate
bun run db:migrate
bun run db:studio
```

## CLI

```bash
kq login --server https://<平台地址>
kq submit docs/manuals/examples/job-smoke.json
kq list
kq status <job-id>
kq logs <job-id>
kq workflow cancel <run-id>
kq ssh <agent-id>
kq metering query
```

远程 `kq submit` 接收 JSON spec 文件，不支持 `--agent` 和 `--command` 选项。提交成功后，用输出的 Job ID 调用 `kq status` 和 `kq logs`。字段示例见[最小 smoke spec](https://github.com/kuintessence/kuintessence/blob/main/docs/manuals/examples/job-smoke.json)。

## 常用 API Smoke

```bash
curl -i http://localhost:15173/api/health
curl -i http://localhost:15173/api/auth/oidc/config-public
curl -i http://localhost:15173/software/api/spack/catalog?page=1&pageSize=5
curl -i http://localhost:15173/api/cp/software/overview
```
