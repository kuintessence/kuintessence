# E2E 冒烟测试

这些测试通过 HTTP 访问 Server，并读写测试数据库。

## 前置条件

1. 启动基础设施：

   ```bash
   bun run infra:up
   ```

2. 执行数据库迁移：

   ```bash
   bun run db:migrate
   ```

3. 启动 Server：

   ```bash
   DATABASE_URL=postgres://kq:kq@localhost:5432/kuintessence \
   REDIS_URL=redis://localhost:6379 \
   JWT_SECRET=dev-secret-at-least-32-chars-long-aaa \
   bun packages/server/src/index.ts &
   ```

Server 启动时会校验 `REDIS_URL`，但暂不连接 Redis。自动化 stack fixture 使用占位 URL，不启动 Redis。

## 运行

```bash
bun run test:e2e
```

## 覆盖 Server URL

```bash
SERVER_URL=http://localhost:3097 bun run test:e2e
```

## 覆盖 Database URL

```bash
DATABASE_URL=postgres://user:pass@host:5432/dbname bun run test:e2e
```

## 覆盖范围

| 步骤 | 检查内容 |
|---|---|
| 1 | `GET /api/health` 返回 `{ status: "ok" }` |
| 2 | `POST /api/auth/login` 返回带 `expiresIn: 900` 的 JWT |
| 3 | 受保护路由在无 Authorization header 时返回 401 |
| 4 | `POST /api/jobs` 提交作业，返回 `status: pending` |
| 5 | `GET /api/jobs/:id` 按 ID 获取作业 |
| 6 | `GET /api/jobs` 列表包含已提交作业 |
| 7 | `GET /api/agents` 返回数组（可为空，不要求 Agent） |
| 8 | `POST /api/jobs/:id/cancel` 将作业转为 `cancelled` |
| 9 | 查询未知 UUID 的 `GET /api/jobs/:id` 返回 404 |
| 10 | 非法 email 登录返回 400 |
| 11 | 非法 role 登录返回 400 |

## 说明

- 测试通过 `afterAll` 清理创建的 jobs 和 user 记录。
- 上述 smoke 流程可在没有 Agent 的环境运行；未配置 dispatcher 时，作业可能保持 pending。
- Agent 与调度器交互由全栈 fixture 和集成测试覆盖。CLI → Server → Agent → scheduler → results 全链路需使用 Slurm 容器 fixture 或测试集群。
- `bun run test` 不包含 E2E，使用 `bun run test:e2e` 单独运行。
