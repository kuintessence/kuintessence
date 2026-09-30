# Deployment seed

镜像入口：`bun run deploy/seed/index.ts`。Dockerfile 为
`deploy/seed/Dockerfile`，build context 必须是仓库根目录，沿用 DB migration
镜像的 Bun 与 frozen workspace dependency 安装方式。
PR 镜像名：`ghcr.io/<owner>/kq-dev-seed:sha-fullSHA`。
使用支持 Dockerfile 专属 ignore 文件的 BuildKit；同目录
`Dockerfile.dockerignore` 的 allowlist 用于覆盖根 `.dockerignore` 对 `deploy`
的排除，不把凭据、node_modules 或构建产物送入 build context。

## 环境与模式

| 环境变量 | 契约 |
| --- | --- |
| `DATABASE_URL` | 必填，使用 Secret 注入 PostgreSQL 连接串，不输出到日志 |
| `SEED_MODE` | `minimal`（默认）或 `demo`，其他值失败退出 |

- `minimal` 只初始化 `Kuintessence` 机构。不创建用户、密码、session、token，
  不修改 SSO、认证配置或现有策略默认值。当前 users schema 没有密码认证字段，
  生产首个用户及权限应由既有 SSO onboarding 配置建立。
- `demo` 包含 minimal，并增加 `Development Compute Provider`、以下演示身份
  及对应 membership，以及两个 NoAction workflow templates。模板无需真实软件、
  队列或 Agent，不伪造执行记录。模板写入现有 workflow template catalog，
  不创建软件资产、签名 package 或 ecosystem release。

| 演示邮箱 | 初始 role | Provider membership |
| --- | --- | --- |
| `demo-user@kuintessence.test` | `user` | `member` |
| `demo-provider@kuintessence.test` | `org_admin` | `admin` |
| `scheduler-compose-seed@kuintessence.test` | `org_admin` | `admin` |

这些邮箱是虚构身份，不是凭据。seed 不启用 dev 登录，也不配置公网入口。
demo 门户登录使用上述邮箱及匹配 role，通过受保护 gateway 的现有 dev login；
Server 的既有登录流程负责 authz projection。seed 本身不写权限引擎 tuples。
重新登录时的 user/membership 更新属于现有 dev login 行为，不属于 seed。

## Chart 集成

1. 独立 migration Job 成功后运行 seed Job；seed 不执行 schema migration。
2. seed 成功后再开放 Server/scheduler。scheduler 注册默认邮箱和 provider 名
   必须与上表一致。首次部署时不要让登录请求与 seed 同时创建默认机构。
3. minimal 部署必须使用生产认证配置，不能启用 dev 登录。demo 只允许显式
   preview：dev auth 只能经已认证 cookie gateway，Server 保持内部服务，
   不能由 ingress、NodePort 或其他直达路径绕过认证。
4. seed Job 无需公网 egress，只需访问 PostgreSQL；可使用 read-only rootfs
   和非 root 用户。运行时不安装依赖，不需要 writable volume。
5. 输出只包含固定 markers：`KQ_SEED_APPLIED`、`KQ_SEED_ALREADY_APPLIED`、
   `KQ_SEED_FAILED`。成功 exit 0，配置、DB 或关闭连接失败 exit 1；
   不输出异常正文、SQL、URL 或数据行。

## 幂等性

单个 transaction 与 advisory lock 串行化 seed。每个 v1 模式的完成状态以
固定 UUID 写入既有 `audit_log`，和数据一同提交；失败全部回滚。
重复运行已完成模式不再写入，也不修复已移除或改名的内容。
minimal 后可升级为 demo，demo 后运行 minimal 不会删除演示数据。

首次初始化优先复用固定 ID 或自然键（机构名、email、模板 name/version）
已有数据，不更新原始字段或 membership role；存在多条同名机构时失败，
不任意选择 provider。已存在用户使用其现有 role 决定新增 membership。
需保留 `deployment.seed.completed` audit records；不要把删除完成记录当作
重置手段。seed 不是持续 reconciliation 或清理工具。

## Focused tests

`deploy/seed/seed.test.ts` 使用内存 transaction port，不连接数据库。
`deploy/seed/index.test.ts` 覆盖配置验证、关闭连接和错误日志脱敏。
`deploy/seed/store.test.ts` 为显式 opt-in 的 PostgreSQL integration contracts，
使用 `SEED_TEST_DATABASE_URL` 指向已迁移的独立测试数据库。
本次实施按约束未运行 tests、lint、typecheck、build 或容器。
