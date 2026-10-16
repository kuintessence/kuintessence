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
Biome、本地文档链接、workflow 引用、轻量 CI 编排检查，以及科学工作流交付模板的离线合同检查
和该检查文件的 TypeScript 类型检查。模板检查只读取仓库文件，不下载或执行 recipe。
依赖安装使用
`bun install --frozen-lockfile --ignore-scripts`，不运行安装生命周期脚本、
protobuf 生成、业务运行时测试、构建或容器。

完整 TypeScript 检查依赖生成的 protobuf，由手动完整检查或 `PR preview tests` 调用。
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
| `CI` | 独立入口自动静态检查；手动完整模式或由 `PR preview tests` 调用时执行 protobuf、类型、Helm、数据库及容器测试 |
| `Build production images` | 推送 `main` 或发布 GitHub Release 时构建生产镜像并推送 GHCR；仅 main 在全部镜像成功后通过 SSH 部署 |
| `Verify Server Agent bundle` | 相关 PR 构建 Server 镜像，提取并校验两种架构的 Agent、提交号与 SHA-256，执行 Linux x64 空配置 smoke |
| `PR preview tests` | 同仓库非草稿 PR 固定 head SHA，按完整 PR diff 选择 Spack 和 scheduler 重型测试；手动触发强制全部组，全部必测组成功后允许进入部署门禁 |
| `Build Agent binary` / `Build CLI binary` | 仅手动构建并运行 binary smoke，默认只保存 Actions artifact；在 `v*` tag 上手动触发且勾选 `publish_release` 才上传 Release |
| `Scheduler image architecture` | 仅手动构建并运行调度器镜像架构验证 |
| `PR scheduler tests` | 相关源码变更时由 PR 测试编排调用，或手动触发；`run_spack`、`run_schedulers` 分别选择材料验收与 Slurm/PBS matrix |
| `Spack workflow execution` | 自动调用默认仅 GNU Hello 工作流；手动或当前 HEAD 提交消息含 `[full-workflows]` 时运行完整三案例 |
| `Docs Site` | 仅从 `main` 手动构建并发布到 `gh-pages`；GitHub Pages 须单独配置发布源 |
| `Preview` / `Preview Cleanup` | 全部必需测试成功且通过信任门禁后部署远程 k3s，关闭/暂停/撤销标签后清理；无 main 常驻预览 |

### 生产镜像

[`Build production images`](../.github/workflows/build-images.yml) 使用现有 Dockerfile，
构建 `linux/amd64` 镜像，发布到 `ghcr.io/<仓库所有者的小写名称>/`：

| 组件 | 镜像名称 | Helm 镜像配置键 |
|---|---|---|
| Server | `kuintessence-server` | `server.image` |
| Registry | `kuintessence-registry` | `registry.image` |
| Web | `kuintessence-web` | `web.image` |
| 数据库迁移 | `kuintessence-db-migrate` | `migration.image` |

- 每次推送 `main`，从该事件的 commit 构建并更新固定 `main` tag，不更新 `latest`。
- 发布 GitHub Release（`release.published`）时，从对应 tag 的 commit 构建，
  镜像 tag 完整保留 Git tag，例如 `v1.2.3`。单独推送 Git tag 不触发构建。
- 正式 Release 同时将 `latest` 指向本次构建；预发布只推送 Git tag，不更新 `latest`。
  发布工作流串行执行；重新运行旧正式 Release 的工作流也会重新指向该版本。
- Git tag 必须符合容器 tag 格式（最多 128 字符，仅字母、数字、`_`、`.`、`-`，
  首字符不能是 `.` 或 `-`），且不能使用保留名称 `main`、`latest`；不兼容时直接失败。
- Web 显式使用 `VITE_PREVIEW_LOGIN=false`。这些镜像不包含预览 seed 或调度器；
  数据库迁移镜像发布本身不会执行生产数据库迁移。

例如 Server 镜像地址为 `ghcr.io/kuintessence/kuintessence-server:main`。
在生产 Helm 配置中，将上表各组件的 `repository` 和 `tag` 设置为对应镜像地址与版本。
使用滚动的 `main` / `latest` 时将 `pullPolicy` 设置为 `Always`，并主动触发滚动更新；
推送镜像不会自动重启现有 Pod。需要固定部署内容时记录构建摘要并按 digest 部署。

发布使用仓库 `GITHUB_TOKEN` 的 `packages: write` 权限，无需另配推送凭据。
GHCR package 的可见性由仓库所有者配置；私有镜像需通过 Helm 的
`global.imagePullSecrets` 提供拉取凭据，公开镜像可匿名拉取。
构建与发布结果以对应 Actions run 为准，生产配置与站点验收仍按 Chart 指南执行。

### Server 内置 Agent

Server Dockerfile 使用独立的 glibc Bun 构建阶段，从同一源码编译 Linux x64、ARM64
Agent（Server 运行镜像仍为 Alpine），存放在
`/opt/kuintessence/agent/`，文件名分别为 `kq-agent-bun-linux-x64`、
`kq-agent-bun-linux-arm64`，附带 `manifest.json` 与 `SHA256SUMS`。
CI 将精确构建提交写入 manifest；本地未传 `KQ_BUILD_REVISION` 时为 `unknown`。

公开只读接口 `GET /api/agent-binaries` 返回版本、提交、文件大小和 SHA-256；
`GET|HEAD /api/agent-binaries/:filename` 下载上述四个文件。Web 入口前缀为
`/platform/api/agent-binaries`。下载附加 `?revision=<manifest 中的提交>` 可避免
服务升级期间拿到不同提交的产物，版本不符返回 409。获取与安装示例见
[Agent systemd 部署](../deploy/systemd/README.md#获取二进制)。

[PR 校验工作流](../.github/workflows/server-agent-bundle.yml) 构建并提取实际镜像产物；
生产发布后也按镜像 digest 提取并校验，失败会阻止 main SSH 部署。
两种架构均检查 ELF、SHA-256 与提交一致性，x64 执行空配置拒绝 smoke；
ARM64 未在此工作流中执行，目标节点的 OS、调度器及 mTLS 兼容性仍需站点验证。

### main SSH 部署

推送 `main` 时，镜像 workflow 在四个镜像全部构建和推送成功后执行 `deploy-main`。
Release（包括正式发布与预发布）只发布镜像。部署步骤使用同一个 commit 的
[`deploy/main/compose.yml`](../deploy/main/compose.yml) 和
[`env.example`](../deploy/main/env.example)，避免构建期间 main 前进造成配置错配。
工作流串行执行，后续推送不会中断正在进行的部署。

在 GitHub 仓库 Actions secrets 中配置：

| Secret | 含义 |
|---|---|
| `MAIN_SSH_HOST` | 部署服务器 IP 或主机名 |
| `MAIN_SSH_PORT` | SSH 端口（1–65535） |
| `MAIN_SSH_USER` | SSH 用户，须能写入 `/opt/deploy`、执行 Docker 命令及部署脚本 |
| `MAIN_SSH_KEY` | 该用户的 SSH 私钥完整内容，使用无需交互解密的专用部署密钥 |

[`remote.sh`](../deploy/main/remote.sh) 在 runner 登录 GHCR 并拉取四个应用镜像，核对
`linux/amd64`、项目来源和本次 commit，再将镜像压缩归档与 Compose 配置通过 SSH
一并上传。临时部署 runner 启用 BBR 和从 1200 字节 MSS 开始的 MTU 探测，
减少跨网链路丢包造成的传输降速；不修改部署服务器的网络参数。
服务器校验归档 SHA-256、加载镜像并核对镜像 ID 后，才覆盖
`/opt/deploy/compose.yml` 和 `/opt/deploy/env.example`；如果仓库没有示例环境文件，
只更新 Compose。随后从 `/opt/deploy` 执行服务器已有的
`/opt/deploy/run.sh deploy --expected-revision <commit>`，其退出码直接决定部署 job 成败。
站点脚本必须支持该版本参数并拒绝镜像版本不匹配。SSH 采用 `accept-new` 首次接受主机密钥，
私钥和本次 known_hosts 存在 runner 临时目录，退出时清理。

服务器需预先准备可执行的 `run.sh` 和实际 `.env`。CI 不创建或覆盖它们，也不会
向服务器传输仓库源码、SSH 私钥或 GitHub token。runner 使用本次 workflow 的只读
package 权限下载私有镜像。`run.sh` 仍负责站点认证、版本核对、数据库备份、升级和
健康验证，CI 不自动回滚。站点脚本如果再次拉取相同镜像，可复用加载后的本地镜像层；
注册表元数据访问仍需要站点网络及相应凭据。此传输方式不包含 PostgreSQL 等基础服务镜像。
重新运行失败的部署 job 会重新传输并校验镜像，然后调用脚本；未完成的迁移仍应按站点维护流程处理。

main 专用 Compose 直接引用四个 `kuintessence-*:main` 镜像，
不依赖源码构建或仓库 bind mount。它内置 PostgreSQL、Redis、RustFS、SpiceDB，
使用外部 SSO；Server/Registry 为单实例，数据库、Registry 内容和 Server CA 使用持久卷。
应用服务等待数据库迁移完成。Web、Server 和 RustFS 的宿主端口仅绑定回环地址，
由站点 HTTPS 入口及 Agent mTLS 代理转发；`MTLS_TRUSTED_PROXY_CIDRS` 必须填写
实际证书验证代理的来源范围。沿用已有部署的项目名、数据卷和密钥，避免建立空的新实例。

首次使用时将服务器上的 `env.example` 复制为 `.env`，填写空置密钥、数据库 URL、
SSO 和代理配置。`JWT_SECRET` 至少 32 字符，`DATABASE_URL` 中的数据库密码必须与
`POSTGRES_PASSWORD` 一致。示例不含可用密钥，不能直接启动。
NetDrive 默认关闭；RustFS bucket/IAM 初始化与启用步骤见
[对象存储指南](../deploy/rustfs/README.md)，由站点脚本和私有 Compose 覆盖文件配置。

### 重型测试范围

自动 PR 测试使用 [路径策略](../deploy/preview/test-scope.cjs) 判断，按 PR 相对 base 的
完整文件列表而非最后一次 push 判断，包含删除文件和重命名前的路径。

- Spack：材料、recipe、Registry、软件治理、受管安装、工作流、相关门户及测试夹具。
- 调度器：CLI 作业命令、Agent 适配器与执行链路、Server 调度和作业派发、
  调度器镜像及 E2E 夹具。CLI 本地 Spack/软件命令触发 Spack 组；
  CLI 共享 API、认证、workflow 和 Agent 入口触发两组。
- 共享 schema、protobuf、数据库、依赖清单和共同运行基础等变更保守触发相关的两组。
- 测试夹具及专属 workflow 的变更也触发对应组；调度器 workflow 变更触发两组。
- `ci.yml` 修改按 PR merge base 与固定 head 的完整内容比较 job：静态检查、类型检查、
  单元/集成、RustFS 和 migration artifact job 的修改不额外启用重型组；
  Spack job 修改只启用 Spack，`e2e-slice` 修改只启用调度器，两者同时修改则启用两组。
  全局配置、job 增删、未知 job、共享 outputs、YAML anchor/alias 或无法识别的结构
  仍启用两组；CI 文件新增、删除或重命名也保守启用两组。API 读取失败或内容不完整
  则阻止范围解析，不依赖可能缺失或截断的 patch 来跳过检查。
- 文档、普通 Web 展示与预览控制器变更不会仅因 PR 更新就启动这两组。
  基础静态检查、typecheck/Helm、unit/integration、Web 单测/build 及 RustFS 检查仍执行。

### 工作流测试档位

正式 Spack 工作流矩阵独立于材料导入和调度器专项：

- 自动快速档：相关源码变更时运行 contracts 和一个 GNU Hello managed 工作流，
  保留真实材料导入、安装、两节点执行及重启回读；不运行 samtools 和 samtools-file。
  它是相对完整矩阵的快速档，不是用模拟测试代替实际执行。
- 完整档：手动运行 `Spack workflow execution`，或在当前 PR HEAD 提交消息中
  加入精确标记 `[full-workflows]`，运行 Hello、samtools、samtools-file。
  提交标记即使没有命中 Spack 路径也会启动完整工作流矩阵，但不会额外强制其他专项。
- 合并前需要全部检查时，在当前 PR 分支手动运行 `PR preview tests`，
  提供 `pr_number`，会同时强制完整工作流、材料和调度器组。

标记只读取当前被测 HEAD 的提交消息，不读取 PR 标题、描述或历史提交；
下一次无标记的提交恢复按路径选择的快速档。提交信息仅作为数据读取，不插入 shell。
部署控制器独立复核档位，完整档少一个案例也不会放行；
快速档失败不会自动降级或视为通过。所有执行仍在 Actions，现有 k3s 环境不受该设置改动。

手动运行 `PR preview tests` 会强制全部组；也可以使用独立入口运行指定组：

```bash
gh workflow run pr-scheduler-tests.yml --ref feat/example \
  -f run_spack=false -f run_schedulers=true
gh workflow run spack-workflow-execution.yml --ref feat/example
gh workflow run preview-tests.yml --ref feat/example -f pr_number=123
gh workflow run ci.yml --ref feat/example -f run_runtime_checks=true \
  -f run_spack=false -f run_schedulers=false
```

独立入口的部分检查不能替代预览部署所需的 PR 测试证据。最终汇总要求每个必测组成功，
仅接受规则明确未选中的组为 `skipped`，不能将失败、取消或缺失的必测组视为成功。

`Scheduler image architecture` 的构建步骤提供固定占位值，满足 Compose 的环境变量解析；
该值不作为 build arg 传入镜像，工作流不启动对象存储或完整 scheduler 栈。

首次推送 `main` 不自动运行业务运行时测试、binary smoke、调度器容器验证或发布文档站；
推送 tag 也不自动发布 Release。PR 部署必须等待所有适用的必测组成功；
`preview-paused` 标签可持续暂停该 PR 的预览，但不暂停独立的
[PR 调度器测试](../deploy/pr-test/README.md)。后者不提供公网入口、不使用预览口令，
使用 `docker-compose.pr-test.yml` 和独立的临时卷，结果以对应提交的 Actions 为准。
在仅允许静态检查时，不应手动触发完整检查、构建、发布或预览。

<a id="preview"></a>
## GitHub 预览环境

PR 预览改为远程单节点 amd64 k3s，runner 不再托管十分钟 Quick Tunnel 环境。
runner 仍运行测试容器；全部必需测试通过后才构建并推送 GHCR 镜像，再通过 SSH
隧道调用 Kubernetes API 部署。入口固定为 `https://pr-<PR编号>.preview.dev.kuintessence.com`。

详见 [k3s PR 预览操作指南](preview-k3s.md)：信任门禁、SSH/KUBE_CONFIG、
GHCR 拉取权限、首次启用、HTTPS、访问口令和清理策略。
用户安装使用 [kq-platform](../deploy/helm/kq-platform/README.md)，CI 演示使用
[kq-preview](../deploy/helm/kq-preview/README.md)，共用模板但采用不同 seed 配置。

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

离线 recipe/material/生态交付与 main Compose 启动 seed：参见 [离线交付说明](offline-delivery.md)，包括 readiness 屏障、服务身份、签名、公钥及失败重试。
