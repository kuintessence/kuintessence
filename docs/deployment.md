# 部署、调度器与队列

本指南介绍本地 Compose、生产入口与调度队列配置。命令示例从仓库根目录执行；
启动、重建、迁移和运行态验收会改变环境，执行前应确认目标与维护窗口。
Server 当前只支持单实例部署，尚未通过 Redis 实现多实例协调。

自托管对象存储使用 RustFS，旧 MinIO 数据不自动迁移；升级前先阅读
[RustFS 迁移边界](../deploy/rustfs/README.md)，不要复用旧对象存储目录。

- [Compose 与本地调度器](#compose)
- [单容器演示](#aio)
- [Spack 材料升级屏障](#spack-material-rollout)
- [GitHub Actions](#actions)
- [GitHub 预览环境](#preview)
- [反向代理](#proxy)
- [队列治理](#queues)
- [运行排查](#troubleshooting)

生产 Helm 配置见 [Chart 指南](../deploy/helm/kq-platform/README.md)，
独立 Agent 见 [systemd 部署](../deploy/systemd/README.md)，
发布、备份和恢复见[系统运维手册](manuals/system-operations-manual.md)。

<a id="compose"></a>
## Compose 与本地调度器

平台入口统一位于 [`deploy/compose/`](../deploy/compose/README.md)。
`bun run compose` 负责选择配置；手动调用须加 `--project-directory .`，
以保留构建、bind mount、根 `.env` 与默认项目名的路径基准。
`examples/docker-compose.demo.yml` 与独立反向代理 Compose 保持自己的路径基准。

```bash
bun run compose -- full up --build --attach
bun run compose -- full down
```

`full` 保留开发模式和对外端口，供跨机器手动测试使用。
Registry 使用 JWT 认证，`REGISTRY_JWT_SECRET` 与 Server 的 `JWT_SECRET` 一致；
Web 和 CLI 使用登录后取得的凭证，不需要 `X-Test-Principal`。
`watch` 继承该配置，scheduler 栈使用相同的认证方式。

默认 full 栈不包含真实站点 Agent。多调度器开发栈使用单一
`deploy/compose/docker-compose.schedulers.yml`，仅叠加 architecture-only overlay，
不混用其他业务 overlay：

```bash
export KQ_DATA_MARKET_COMMITTER_SECRET_KEY='scheduler-test-committer-secret-not-for-production'
bun run compose -- scheduler-watch up
bun run compose -- scheduler-watch up --build
bun run compose -- scheduler-watch down
```

`scheduler` 和 `scheduler-watch` 必须设置 `KQ_DATA_MARKET_COMMITTER_SECRET_KEY`，
用于 RustFS 初始化和 Server 文件服务。上面的固定值仅供开发测试。
后续启停、重建和配置解析也需要该变量；新终端中重新 export，或写入本地忽略的 `.env`。
使用下面的 `--env-file deploy/schedulers/ports-alt.env` 命令时，仍需先 export 该变量。

scheduler 栈包括 Server/Web/Registry、PostgreSQL、对象存储、内置 Casdoor/SpiceDB，
以及运行各自 Agent 的 Slurm、OpenPBS、K3s 容器。该栈用于研发，不适合直接部署到生产集群。
首次构建需要 registry、apt、OpenPBS、K3s 与 Spack 源可达；建议至少 8 CPU、
16 GiB 内存，并确认允许 privileged 容器。

### 架构与端口

| 环境 | 配置 |
|---|---|
| Apple Silicon | 默认跟随 Docker daemon 使用 `linux/arm64` |
| x86 Linux | 显式叠加 `deploy/schedulers/platform-amd64.yml` |
| 固定 ARM CI | 显式叠加 `deploy/schedulers/platform-arm64.yml` |
| 独立 Agent | x86 使用 `kq-agent-bun-linux-x64`；ARM 使用 `kq-agent-bun-linux-arm64` |

BuildKit `TARGETARCH` 决定 Bun 与 K3s 资产；ARM 使用 `k3s-arm64`。
共享 base 与 runtime entrypoint 会检查 image target、runtime 和 ELF 架构。
ARM 日常开发应使用原生架构；全局强制 amd64 可能让 QEMU 掩盖架构错误。

手动启动并固定 x86 的示例：

```bash
docker compose --project-directory . -p kq-schedulers \
  --env-file deploy/schedulers/ports-alt.env \
  -f deploy/compose/docker-compose.schedulers.yml \
  -f deploy/schedulers/platform-amd64.yml up -d
```

`ports-alt.env` 隔离 `kq-schedulers` project；常用端点为 Web `15173`、
Server `13000`、Registry `13100`。Casdoor issuer 默认
`http://casdoor.localhost:15180`，与 bootstrap issuer 配置保持一致。
实际映射以 Compose 和所选 env 文件为准。
`KQ_SCHEDULER_APT_MIRROR` 默认留空，使用基础镜像的 Ubuntu 软件源；
需要替换镜像源时由部署方配置，不内置地区或机构镜像。

### 初始化与持久化

- scheduler CLI ready 后，`common/register-agent.sh` 通过 CP registration token API
  调用 `kq agent register`，不通过 register body 自报 provider。
- 私钥、证书和 `agent.env` 写入 scheduler state volume；
  `common/start-agent.sh` 重启时复用它们。
- Slurm/PBS/K3s 各有独立 `/scratch` named volume，开发 root 为 `1777`；
  平台可见路径仍必须由 Cluster File Root 授权。
- `agent-deps` 为三个 Agent 初始化共享 Linux 依赖卷，避免并发写入。
- `db-migrate` 使用当前挂载仓库的 migrations；代码已引用但表不存在时先查 migration
  服务和 `__drizzle_migrations`，不要删除数据库绕过。

`down` 保留卷；`down -v` 会删除 PostgreSQL、RustFS、Casdoor、Agent 和 scheduler
状态，只能用于明确批准的开发数据销毁。仅删除 scheduler state 而保留 Server DB 会导致
同名 Agent 的 enrollment intent 冲突。恢复时应核对原证书、执行正式轮换或采用新 Agent ID，
禁止未经数据销毁批准清空全栈。

### 身份服务

scheduler 栈固定使用内置 Casdoor 与 SpiceDB，Server 默认 `AUTHZ_MODE=enforce`。
非 scheduler profile 可选择 `--casdoor-external` / `--spicedb-external`，
这些 overlay 不适用于 scheduler project。

`SSO_BOOTSTRAP_*` 默认只在空 `sso_config` 写入。更改 issuer 后出现 mismatch 时，
先核对 Settings 中保存的配置；有意覆盖才使用 `SSO_BOOTSTRAP_FORCE=true`。
Casdoor 初始化表缺失时检查镜像版本、数据库 schema 和初始化日志，备份后按组件恢复，
不要直接清空整栈卷。已有 Casdoor application 不随 seed 文件自动更新。

SpiceDB 的 connection-pool flags 只传给 `spicedb serve`，不能传给 `migrate`。
enforce readiness、outbox 与生产鉴权要求见[安全指南](security.md#authz)。
开发固定账号与口令不能用于公网部署。

<a id="aio"></a>
## 单容器演示

`aio` 将 Web、Server、Registry、PostgreSQL、Redis 和 RustFS 放在同一个容器中，
用于本机测试，不包含站点 Agent 或真实调度器。

```bash
bun run compose -- aio up --build --attach
```

打开 `http://localhost:8080`，输入邮箱并选择角色，首次登录会自动创建用户，无需密码。

| 用途 | 测试账号 | 角色或口令 |
|---|---|---|
| 平台管理员 | `admin@example.com` | 选择 `super_admin` |
| 普通用户 | `user@example.com` | 选择 `user` |
| RustFS console，`http://localhost:9001` | `rustfsadmin` | `rustfsadmin` |
| PostgreSQL 应用账号，仅容器内部 | `kq` | `kq` |
| RustFS 应用访问密钥 | `kq-data-market-committer` | `aio-test-committer-secret-not-for-production` |

这些都是公开的测试值。Compose 仅发布本机回环地址上的 `8080`、`9000`、`9001`，
不通过公网代理或 Tunnel 暴露。存储密钥可用 `KQ_DATA_MARKET_COMMITTER_SECRET_KEY` 覆盖。
用户、数据库、RustFS 数据和 Registry 文件保存在 `kq-aio-data` 卷中。
Registry 的 `BLOB_STORE_DIR=/data/registry/blobs` 保存 OCI blob 和 Spack buildcache，
重启或重建容器时保留。启动脚本完成数据库迁移、存储桶和存储账号初始化。

AIO 构建启用 `VITE_PREVIEW_LOGIN=true`，Server 使用 `NODE_ENV=development`、
`AUTHZ_MODE=off`，不接入 SSO 或 SpiceDB。其他镜像的默认登录配置不变。
容器健康检查覆盖 Server、Registry、RustFS 和 Web。

```bash
bun run compose -- aio down
```

加 `-v` 会删除演示数据。生产部署使用 [Helm 配置](../deploy/helm/kq-platform/README.md)。

<a id="spack-material-rollout"></a>
## Spack 材料升级屏障

材料生命周期第二批提供离线 `SpackMaterialRollout.execute` 的
`inspect/pause/reconcile/activate`，不是下架、恢复、ACL 或 GC。
第三批另有[离线绑定退役](spack-binding-retirement.md) 的 `retire`：
要求维护窗口、额外的旧配置移除确认及重新 reconcile，不提供恢复或 Web 入口。
完整步骤与命令 JSON 见 [Spack 材料 Rollout](spack-material-rollout.md)。
CLI 约定为 `bun packages/db/src/spack-material-rollout-cli.ts <absolute-command-json-path>`；
`DATABASE_URL` 从受信任 shell 环境读取，不通过 CLI 参数传入。
mutation 的管理员 UUID 只记录操作归属，不是登录证明。

full、scheduler、preview Compose 同时向 Server 和 Registry 透传可选
`SPACK_MATERIAL_EPOCH`；watch 继承 full，AIO 由共享环境传给两个子进程。
Helm 使用共享 `spackMaterial.epoch`，默认空且不注入环境变量，没有默认 UUID。
必须采用 `pause` 返回的新 epoch，在重启前为所有升级后的 Server/Registry 配置一致值。
持久化仍为 PostgreSQL、recipe 本地 Git 和不可变源码文件系统，
原有数据卷/PVC、Secret 引用与单 Registry 写者要求不变。

`pause` 后须在外部停止并排空所有 Server/Registry，包括离线及回滚副本，
撤销/轮换旧 DB、Registry、ticket 凭据并更新访问与网络策略。
epoch 不能 fence 不检查它的旧代码；门禁只控制准入，不中断已开始的流。
只有无 journal 且无 epoch 时保留 observe 兼容模式；paused、DB 失败或
ready 时 epoch 缺失/不匹配均拒绝材料 runtime。新的 pause 更换 epoch，不自动回退。
保留 append-only journal，删除历史可能不安全地重置 observe，禁止以清表解除屏障。
部署静态测试只覆盖接线、配置和文档；测试与运行态验收仅在 GitHub Actions
隔离环境执行，以对应提交结果为准，部署接线不代表运行态验收通过。

<a id="actions"></a>
## GitHub Actions

`CI` 工作流在推送 `main` 和目标为 `main` 的 PR 时默认只执行静态检查：
Biome、本地文档链接、workflow 引用，以及科学工作流交付模板的离线合同检查
和该检查文件的 TypeScript 类型检查。模板检查只读取仓库文件，不下载或执行 recipe。
依赖安装使用
`bun install --frozen-lockfile --ignore-scripts`，不运行安装生命周期脚本、
protobuf 生成、业务运行时测试、构建或容器。

完整 TypeScript 检查依赖生成的 protobuf，因此放在手动完整检查中。
自动静态 job 的结果仅覆盖上述范围，不证明材料闭包、受管安装或科学工作流成功。

仅允许在 Actions 执行生成器时，可手动选择目标分支并勾选
`generate_db_migrations`（默认关闭）。独立 job 运行 `db:generate`，
将完整 `packages/db/migrations/`（含 `meta`）作为
`pg-migrations-<commit SHA>` artifact 保存 7 天，不连接生产数据库、不执行迁移，
也不自动 commit 或回推。下载后先比对原有迁移，确认无非预期删除/重建，再将生成产物
原样纳入对应分支；完整 CI 应在包含该 migration 的最终提交上另行运行。
不要手改生成的 SQL、snapshot 或 journal，也不要把 artifact 当成迁移已应用的证明。

| 工作流 | 触发与范围 |
|---|---|
| `CI` | 自动静态检查；手动勾选 `run_runtime_checks` 才执行 protobuf 生成、完整类型检查、Helm 测试、数据库与全栈容器测试 |
| `Build Agent binary` / `Build CLI binary` | 仅手动构建并运行 binary smoke，默认只保存 Actions artifact；在 `v*` tag 上手动触发且勾选 `publish_release` 才上传 Release |
| `Scheduler image architecture` | 仅手动构建并运行调度器镜像架构验证 |
| `PR scheduler tests` | 可信同仓库非草稿 PR 自动构建隔离 Slurm/PBS 测试环境，执行真实作业与材料 fixture 回归；也可手动触发 |
| `Docs Site` | 仅从 `main` 手动构建并发布到 `gh-pages`；GitHub Pages 须单独配置发布源 |
| `Preview` / `Preview Cleanup` | 可信同仓库 PR 自动预览与关闭清理，main 手动启停，见下节 |

`Scheduler image architecture` 的构建步骤提供固定占位值，满足 Compose 的环境变量解析；
该值不作为 build arg 传入镜像，工作流不启动对象存储或完整 scheduler 栈。

首次推送 `main` 不自动运行业务运行时测试、binary smoke、调度器容器验证或发布文档站；
推送 tag 也不自动发布 Release。PR 预览不执行测试套件；
`preview-paused` 标签可持续暂停该 PR 的预览，但不暂停独立的
[PR 调度器测试](../deploy/pr-test/README.md)。后者不提供公网入口、不使用预览口令，
使用 `docker-compose.pr-test.yml` 和独立的临时卷，结果以对应提交的 Actions 为准。
在仅允许静态检查时，不应手动触发完整检查、构建、发布或预览。

<a id="preview"></a>
## GitHub 预览环境

[`Preview`](../.github/workflows/preview.yml) 在 GitHub-hosted `ubuntu-24.04` runner
内构建并运行独立的[预览 Compose](../deploy/compose/docker-compose.preview.yml)。
Cloudflare Quick Tunnel 提供随机 HTTPS 地址；地址发布后最多保留 10 分钟，
整个 job 上限 40 分钟，包含构建、启动与清理。没有定时续跑、常驻服务或持久数据库。
CI 的手动完整检查与预览互相独立，预览工作流不执行测试套件。

### 首次配置

1. 将 workflow 合入 `main`，确保仓库默认分支为 `main`，并允许 GitHub Actions。
   `workflow_dispatch` 和关闭 PR 的清理入口需要先存在于默认分支。
2. 在 Settings → Secrets and variables → Actions 创建 repository secret
   `PREVIEW_PASSWORD`，使用至少 24 字符的独立随机口令，不复用账号、生产或存储凭据。
   未配置时预览失败关闭，不发布无认证入口。通过私密渠道向审阅者提供此口令。
3. 在仓库创建 `preview-paused` 标签。不要给预览 job 配置生产 environment、
   云凭据、集群凭据或数据库备份。

### 生命周期

| 操作 | 行为 |
|---|---|
| 同仓库、目标为 `main` 的非草稿 PR 新建/重开/更新/转为 ready | 自动构建并部署；同一 PR 只保留最新 run |
| fork PR | 不部署，不提供预览 secret |
| PR 加 `preview-paused` 标签 | 取消正在执行的预览；后续 push 也不重新部署 |
| PR 移除 `preview-paused` 标签 | PR 仍打开且非草稿时重新部署 |
| PR 转为草稿、关闭或合并 | 取消该 PR 的预览并清理 |
| `main` 更新或 PR 合并进入 `main` | 不自动创建 main 预览 |
| Actions → Preview → Run workflow，分支选择 `main`，`action=start` | 手动创建 main 预览；替换已有 main 预览 |
| 同一入口选择 `action=pause` | 停止并销毁 main 预览；下次 `start` 才重新部署 |
| 到期、部署失败、取消 run | 清理 tunnel、容器、网络、临时数据卷与凭据文件 |

暂停会销毁环境，再次启动时使用新地址与空数据库。
可以在 Actions 页面直接 Cancel workflow 停止单次运行，但 PR 后续 push 仍会部署；
持续暂停 PR 应保留标签。
不同 PR 与 main 相互独立，也会各自消耗 runner 并发额度。

打开对应 PR 的 Preview check 或 Actions run 的 Summary 获取地址。
浏览器首先弹出入口认证：用户名为 `preview`，口令为 `PREVIEW_PASSWORD`。
通过后进入应用登录，使用虚构邮箱（如 `reviewer@example.com`）及所需预览角色。

生产 Web 默认不提供这一入口：
预览 Compose 和本机 AIO 演示显式设置构建参数 `VITE_PREVIEW_LOGIN=true`，
并将各自的 Server 设为 `NODE_ENV=development`。
GitHub 预览入口认证换取本次环境的 HttpOnly/Secure cookie，
不占用应用自己的 Bearer Authorization。

### 范围与安全边界

- 包含 Web、Server、Registry、PostgreSQL 和数据库迁移；数据只来自空库及本次人工操作。
  不含 Agent、Slurm/PBS/Kubernetes、Casdoor、SpiceDB 或 RustFS；SSO、细粒度授权、
  NetDrive、真实作业与集群 SSH 的运行验证需另备环境。当前 Server 不连接 Redis，
  这里只保留配置占位；引入 Redis 运行依赖时，须同步补齐预览配置。
- 数据库与业务服务不映射宿主端口，只有认证 gateway 绑定 runner loopback。
  Quick Tunnel 只连接该 gateway，不直接公开开发登录、Server gRPC 或数据库。
- 能通过入口认证的审阅者可使用开发角色登录，因此仅给可信审阅者使用，不录入真实数据。
  同仓库 PR 也必须是可信代码：提交者可修改构建与工作流，入口口令无法限制构建中的恶意代码。
  对不可信改动先做人工代码审查，不要为了自动预览开放 fork secrets。
- 部署 job 仅有 `contents: read`、`pull-requests: read`，checkout 不保留 Git 凭据。
  独立 [`Preview Cleanup`](../.github/workflows/preview-cleanup.yml) 使用
  `pull_request_target` 和 `actions: write`，只读取事件元数据并取消匹配的 Preview run，
  不 checkout、构建、导入或执行 PR 代码。
- 控制工作流负责取消；运行中的预览也定期确认 PR 状态，API 不可用时提前退出。
  清理步骤为 best effort：强制取消、runner 故障或 job 超时时，最终依赖 GitHub 回收
  临时 VM。Summary 里的历史地址不会自动消失，job 结束后即不可用。
- 不向 PR 评论或日志公开密码，不上传数据库、运行日志或凭据 artifact。
  Quick Tunnel 地址会出现在 Actions Summary，仅持有地址不能通过认证。
- 预览只用于短时开发检查，不适合生产托管，也不提供高可用。
  Quick Tunnel 不支持 SSE，依赖 SSE 的功能需通过其他入口验证。

部署方须遵守 Quick Tunnel 的服务限制、GitHub Actions 使用条款和并发/额度要求。
多人同时访问 runner 服务前，应向 GitHub 确认相应条款的适用方式。

<a id="proxy"></a>
## 反向代理

### 公共路径契约

| 公共路径 | 上游 |
|---|---|
| `/` | Web SPA |
| `/platform/api/` | Server REST、OIDC、session、SSH upgrade |
| `/platform/ws/` | Job / Workflow WebSocket |
| `/software/api/` | Registry API |
| `/v2/` | OCI Distribution |
| `/buildcache/` | Spack buildcache |
| `/.well-known/`、`/login/oauth/`、`/static/` 与必要 `/api/*` | Casdoor |
| 原始 bucket path | RustFS/S3 presigned transfer |

Web 通过 `packages/web/src/lib/platform-paths.ts` 生成 Server 路径。
Casdoor 使用根路径，不把整个 IdP 挂到 `/identity/`；对象存储不能插入额外 path prefix。
Agent 使用独立 HTTP/2 mTLS listener，不经过普通 HTTP/1.1 path proxy。

### 单域名

[`compose.gateway.yml`](../deploy/reverse-proxy/compose.gateway.yml) 加入既有 external
network，只负责 gateway，不创建业务服务：

```bash
PLATFORM_HOST=platform.example.com \
PLATFORM_NETWORK=platform_default \
REVERSE_PROXY_TLS_DIR=/opt/kuintessence/tls \
REVERSE_PROXY_BIND=0.0.0.0:443 \
docker compose -f deploy/reverse-proxy/compose.gateway.yml up -d
```

TLS 目录由部署方提供 `server.crt/server.key`。证书与私钥不进 Git。
外部 `/platform` 前缀要求同时改写两个 cookie path：

```nginx
proxy_cookie_path /api/auth/oidc /platform/api/auth/oidc;
proxy_cookie_path /api/auth /platform/api/auth;
```

否则 OIDC callback 或 refresh 请求不会携带正确 cookie。
Registry gateway 保留显式 `Authorization`，没有时把 HttpOnly access cookie 转换为
Bearer；不记录 token。Registry 使用 `jwt` 模式和与 Server 一致的签名配置。

| 配置 | 值 |
|---|---|
| Casdoor origin / `SSO_BOOTSTRAP_ISSUER_URL` | `https://${PLATFORM_HOST}` |
| Casdoor redirect / `SSO_BOOTSTRAP_REDIRECT_URI` | `https://${PLATFORM_HOST}/platform/api/auth/oidc/callback` |
| `WEB_BASE_URL` | platform 根 URL |
| `NETDRIVE_PUBLIC_URL` | platform 根 URL |
| `REGISTRY_AUTH_MODE` | `jwt` |
| `REGISTRY_JWT_SECRET` | 与 Server `JWT_SECRET` 一致 |

先在 IdP 管理面登记 callback，再切换 Server 配置。
gateway 的 `NETDRIVE_BUCKET/DATA_MARKET_STAGING_BUCKET/DATA_MARKET_IMMUTABLE_BUCKET`
必须与 Server 一致。仅 recreate 配置改变的组件，不连带重启 scheduler 与 Agent。

### 多域名

使用 [`multi-domain.conf.template`](../deploy/reverse-proxy/multi-domain.conf.template)：

```bash
PLATFORM_HOST=platform.example.com \
IDENTITY_HOST=identity.example.com \
SOFTWARE_HOST=software.example.com \
OBJECT_STORAGE_HOST=objects.example.com \
PLATFORM_NETWORK=platform_default \
REVERSE_PROXY_TEMPLATE=./multi-domain.conf.template \
REVERSE_PROXY_TLS_DIR=/opt/kuintessence/tls \
docker compose -f deploy/reverse-proxy/compose.gateway.yml up -d
```

证书 SAN/wildcard 覆盖全部 hostname。IdP issuer 使用 identity 域，
对象 public URL 使用 objects 域；callback 仍使用 platform 域。
浏览器继续走 platform 的同源 `/platform/api/`、`/platform/ws/`、`/software/api/`；
software 域供独立 machine client 使用，对象域配置最小 CORS。
两种拓扑都要保留 cookie path rewrite 和显式 Bearer 优先规则。

远端仅私网可达时，可用
[`compose.local-forward.yml`](../deploy/reverse-proxy/compose.local-forward.yml)
经 SSH 本地转发验证正式 hostname；Host、OIDC issuer、callback、证书和对象 URL 必须
保持一致。不要为连通性临时关闭证书验证。

gateway bind-mounted 配置经原子 rename 更新后，单纯 reload 可能仍读取旧 inode；
此时只 recreate gateway。

<a id="queues"></a>
## 队列治理

### Registry 与观测

Server 不修改 scheduler 的 queue 配置。CP Queue Registry 保存纳管配置，
Agent Queue Inventory 保存调度器观测结果。
`target.mode=default` 表示使用调度器默认目标，不应改写成具名队列。

| API / 配置 | 职责 |
|---|---|
| `GET /api/admin/agents/:agentId/queue-inventory` | provider 管理范围内的 observed/default/managed 状态 |
| `/api/admin/queues` | Registry 查询、创建和更新 |
| `GET /api/queues/visible` | 当前 active organization 可见且可提交的目标 |
| `QUEUE_VALIDATION_MODE=off|shadow|enforce` | Server 全局门禁模式 |
| `QUEUE_INVENTORY_MAX_AGE_SEC` | fresh observation 窗口，默认 120 秒 |
| `AGENT_QUEUE_INVENTORY_INTERVAL_SEC` | 队列观测缓存周期，默认 30 秒 |
| `AGENT_SCHEDULER_METRICS_INTERVAL_SEC` | scheduler 指标缓存周期，默认 120 秒，不再控制队列观测 |
| `AGENT_SCHEDULER_CLI_TIMEOUT_SEC` | 采集命令超时 |

Agent 协商 `queue_inventory_v1` 后，Slurm 用 `scontrol show partition -o`，
OpenPBS 用 `qstat -Bf/-Qf -F json`，Torque 用 `qmgr` 上报。
Kubernetes 不纳入 HPC queue enforce。

队列刷新与普通指标采集分别配置。升级前若使用 `AGENT_SCHEDULER_METRICS_INTERVAL_SEC`
调节队列刷新，升级后须通过 `AGENT_QUEUE_INVENTORY_INTERVAL_SEC` 显式配置。
队列缓存周期加 heartbeat 等待、完整采集耗时及传输/时钟余量，应小于 Server 的 freshness 窗口；
不要把缓存周期设置成与 freshness 相等。默认 30 秒队列缓存与 30 秒 heartbeat
为 120 秒 freshness 留出余量，但自定义更长 heartbeat 或更短 freshness 时仍需联合调整。
Agent 无法从本地配置获知 Server 的自定义 freshness，不对其硬编码跨服务约束。
这不会跳过 stale/no-go，也不会立即清除既有 no-go；仍须满足后述连续健康恢复条件。

CP `/cp/queues` 分别展示“已纳管目标”和“调度器观测”：

- named target 固定一个发现的 `queueName`；default target 不发送 queueName。
- fresh 可用 observation 才能启用目标；stale last-known named fact 可预建，
  但必须 `enabled=false`。default/unavailable/unknown/unsupported 不适用预建。
- observed 但未纳管的队列不是故障；失效观测仍显示 last-known facts 和观测时间。
- freshness 由 Server 计算，Web 依据 `freshUntil` 重新读取，不自行推断。
- 切换组织后等待新 scope 响应，不复用上一组织的 Registry/inventory。

### 提交与失败语义

Job 选择 Auto 时不发送显式 queue；Scheduler default 和 Named 都只发送稳定
`schedulingStrategy.queueId`。preview 与最终 submit 使用相同 payload。
`warning` 保留兼容提交；`blocked` 阻止提交但保留用户选择。
`409 QUEUE_UNAVAILABLE` / `503 QUEUE_INVENTORY_UNAVAILABLE` 后需用户明确重选，
系统保留原选择，不自动切回 Auto。

工作流通过节点的 `schedulingStrategy` 配置调度：

```yaml
schedulingStrategy:
  type: Manual
  queues:
    - 88888888-8888-4888-8888-888888888301
```

创建页递归检查 Loop body 与 inline SubWorkflow 中的引用；最终权限仍由 Server 判断。
完整节点字段见[工作流规范](workflow-schema/README.md)。

Agent 在 shadow/enforce 提交前绕过 heartbeat cache 重新检查目标。
shadow 记录失败但继续提交；enforce 拒绝时不调用 scheduler。
稳定错误码为 `QUEUE_NOT_FOUND/QUEUE_NOT_ACCEPTING/QUEUE_CHANGED`，
scheduler submit 拒绝为 `SCHEDULER_SUBMIT_FAILED`，不向 API 透传 scheduler stderr。

shadow 事件先写 SQLite outbox，再由 Server 幂等计数并 ACK。
队列持久化失败会把 inventory 降为 unavailable；恢复必须完成失败操作和当前连接
generation 的 heartbeat ACK；仅重连或旧 timer 完成不会恢复 ready。
Server 的 no-go 持久化；ready 后须连续健康 `2 × QUEUE_INVENTORY_MAX_AGE_SEC` 才解除
运行时门禁。最终 dispatch 前还会按冻结 target 再查 enforce。
用户取消会阻止后续 scheduler submit；Agent shutdown 不应将业务状态改为 cancelled。

### 启用 Enforce

`QUEUE_VALIDATION_MODE` 为全局配置，不支持生产 Server 的 per-Agent override。
先以 shadow 观察所有 Slurm/OpenPBS/Torque Agent，确保能力与 freshness 连续覆盖、
无持久 no-go，再在独立 Server/DB canary 环境验证 enforce。

中心 `/metrics` 提供低基数指标，不输出组织、queue、Agent 或 Job ID：

| 指标 | 关注点 |
|---|---|
| `kq_server_queue_inventory_hpc_agents` | HPC Agent 总数 |
| `kq_server_queue_inventory_capability_declared` / `available` | 能力和可用数量 |
| `kq_server_queue_inventory_capability_coverage_ratio` / `fresh_coverage_ratio` | 应连续为 1 |
| `kq_server_queue_inventory_no_go_agents` | 应为 0 |
| `kq_server_queue_inventory_last_no_go_timestamp_seconds` | 最近 no-go；0 表示尚无事件 |
| `kq_server_queue_inventory_agents` | `unknown/available/unavailable/stale/unsupported` 分布 |
| `kq_server_queue_validation_shadow_rejections_total` | 按固定 failure_code 聚合 |
| `kq_server_scheduler_submit_failures_total` | 按固定 failure_code 聚合 |

先应用对应 additive migrations。counter 使用持久 ledger/rollup，不从 telemetry
历史回填；原始 telemetry retention 不应使 counter 回退。
最后一次 probe 或 no-go 后观察至少 30 分钟，预期有效提交的两类 failure counter
增量应为 0，有意拒绝需单独记录原因。还须持续检查 freshness，counter 为零时也可能存在过期观测。
异常时切回 shadow，必要时 off，保留 schema、inventory、counter 与 policy。

<a id="troubleshooting"></a>
## 运行排查

| 现象 | 检查与边界 |
|---|---|
| Agent 心跳在线但不能操作 | Server 当前 connectRPC control stream，不只看 DB 历史心跳 |
| 定期断流 / reconnect | HTTP/2 双向 streaming、代理 timeout/buffering、当前依赖和证书 |
| PostgreSQL too many clients | 各组件连接池；`db-pool-diagnostic.sh` 用进程与 Docker 网络映射定位 |
| SpiceDB unknown pool flag | flags 是否误放进 migrate service |
| Casdoor relation missing | 镜像/schema/init 版本一致性；先备份，不全栈删卷 |
| 同名 Agent 注册冲突 | registration intent、原 state volume、证书轮换 |
| Queue selector 为空 | enabled、visible org、active organization、queue view/submit 权限 |
| K3s seccomp/cgroup 错误 | Bun/K3s ELF 架构；nested K3s 的 `cgroup: host` 和宿主能力 |
| completed 却无文件 | output collection 与对象 commit，见[存储指南](storage.md#troubleshooting) |

connectRPC 使用 `@connectrpc/connect-node` HTTP/2 transport；不可降级为 HTTP/1.1。
scheduler 指标缓存默认 120 秒、采集超时默认 5 秒，不改变真实 submit/status/cancel 的语义。
队列观测使用独立的 30 秒缓存；旧观测时间不会因缓存命中或 heartbeat 重发而更新。
K3s graceful shutdown 后只清理无进程的特定空 cgroup；不要为释放空间删除数据卷。

`deploy/schedulers/` 下保留识别、Job、workflow、file-transfer、Spack 与重启验证脚本。
它们可能提交作业、安装软件、更新授权或重启服务，不属于静态检查。
仅在明确授权后于隔离环境运行，并记录目标环境的验证结果。
