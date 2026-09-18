# 平台 Compose 配置

本目录包含平台开发与演示环境的 Compose 配置。以下命令均从仓库根目录执行。
示例账号和固定口令仅用于本地开发，不得用于公网生产部署。

## 入口

| 文件 | 用途 | CLI profile |
|---|---|---|
| `docker-compose.yml` | 从源码构建 Server、Registry、Web 及依赖服务 | `full` |
| `docker-compose.dev.yml` | 仅基础设施，应用进程在宿主机运行 | `infra` |
| `docker-compose.watch.yml` | 叠加主配置，容器内热更新 | `watch` |
| `docker-compose.schedulers.yml` | 平台及 Slurm、PBS、K3s 本地调度器栈 | `scheduler` / `scheduler-watch` |
| `docker-compose.aio.yml` | 单容器 all-in-one 演示 | `aio` |
| `docker-compose.preview.yml` | GitHub-hosted runner 限时 PR/main 预览 | Actions 专用，不经 CLI |
| `docker-compose.pr-test.yml` | 隔离的 Slurm/PBS PR 测试与 Spack 材料回归 | `deploy/pr-test/run.sh`，不经 CLI |
| `docker-compose.casdoor-external.yml` | 非 scheduler 栈使用外部 Casdoor | `--casdoor-external` |
| `docker-compose.spicedb-external.yml` | 非 scheduler 栈使用外部 SpiceDB | `--spicedb-external` |
| `docker-compose.local.yml` | 可选私有 NetDrive 覆盖层，不随 Git 分发 | `netdrive` / `watch-netdrive` |

```bash
bun run compose -- full up --build --attach
bun run compose -- watch up
bun run compose -- full down
```

`scheduler` 和 `scheduler-watch` 需要设置 `KQ_DATA_MARKET_COMMITTER_SECRET_KEY`，
示例见[调度器指南](../../docs/deployment.md#compose)。
`scheduler up` 默认运行 smoke 检查，只启动服务时加 `--no-verify`。
`aio` 提供固定测试凭据和本机开发登录，启动与账号见[单容器演示](../../docs/deployment.md#aio)。

`netdrive` 和 `watch-netdrive` 需要本地覆盖文件，公开仓库不包含该文件。
没有覆盖文件时使用 `full` 或 `watch`。

## Spack Recipe 持久化

Recipe Git 使用现有 Registry 数据卷，不新建卷，也不迁移已有 blob：

| 配置 | 数据卷 | `SPACK_RECIPE_STORE_DIR` |
|---|---|---|
| `full` / `watch` / preview | `registry-data` | `/var/lib/kuintessence/registry/recipes` |
| `scheduler` / `scheduler-watch` | `scheduler-registry-data` | `/var/lib/kuintessence/registry/recipes` |
| `aio` | `kq-aio-data` | `/data/registry/recipes` |

`watch` 继承主配置的 recipe 环境变量与 Registry 持久卷。`infra` 不运行 Registry；
宿主机启动 Registry 时需自行设置持久绝对路径 `SPACK_RECIPE_STORE_DIR`，未配置时
recipe 功能不可用。独立运行 AIO 镜像也默认使用 `/data/registry/recipes`，须持久挂载 `/data`。

Recipe Git 只保存 recipe 内容及其版本历史，源码包、厂商安装包和 buildcache 必须放在
独立制品存储中，不能导入 recipe Git。Registry、dev 和 AIO runtime 均包含 Git，
通过 `GIT_CONFIG_GLOBAL=/dev/null`、`GIT_CONFIG_NOSYSTEM=1` 禁用默认 global/system config。
本地 Git 模式限定单 Registry 写者；不要 scale Registry，也不要让多个容器共享此目录写入。

### 管理员离线初始化

`SPACK_RECIPE_BOOTSTRAP_MANIFEST` 默认为空，只有管理员需要启动时导入 bundle 时才设置。
它是容器内 manifest 的绝对本地路径，不是 URL 或宿主机路径。示例 manifest：

```json
{
  "version": 1,
  "repositories": [
    {"repository": "public/example", "bundlePath": "/recipe-bootstrap/example.bundle"}
  ]
}
```

Bundle 应为自包含、含 HEAD 的完整 Git bundle，例如管理员在已有 recipe 仓库中执行
`git bundle create example.bundle HEAD`。将 manifest 和 bundle 放在同一个管理员输入目录，
通过私有 Compose 覆盖文件只读挂载；不要将这些输入或本地配置提交到平台仓库：

```yaml
services:
  registry:
    environment:
      SPACK_RECIPE_BOOTSTRAP_MANIFEST: /recipe-bootstrap/manifest.json
    volumes:
      - /srv/kq/recipe-bootstrap:/recipe-bootstrap:ro
```

将该覆盖文件叠加到所用配置上；AIO 将服务名 `registry` 改为 `kq`。
仅设置环境变量不会自动挂载文件；manifest 及其引用的所有 bundle 都必须在容器内可读。
Bootstrap 不重导入已有仓库，也不覆盖激活状态；新快照仍须显式确认并激活。
只读输入挂载不能覆盖可写的 recipe 存储目录。

#### 原需求源码材料文件包

四个上述 Registry/AIO Compose 变体均将 `SPACK_MATERIAL_BOOTSTRAP_MANIFEST` 默认空透传；
空字符串视为未设置。启用时必须填写容器内 manifest 的绝对本地路径，并配置
`SPACK_MATERIAL_STORE_DIR`；材料存储原有的 `SPACK_RECIPE_STORE_DIR` 和 `BLOB_STORE_DIR`
依赖及目录隔离规则继续生效。Compose 已提供持久材料目录，但不会自动挂载输入文件包。

运维自行取得并校验 manifest 与其引用的源码材料文件包，通过私有覆盖文件只读挂载：

```yaml
services:
  registry:
    environment:
      SPACK_MATERIAL_BOOTSTRAP_MANIFEST: /material-bootstrap/manifest.json
    volumes:
      - /srv/kq/material-bootstrap:/material-bootstrap:ro
```

AIO 将服务名改为 `kq`。所有引用文件都必须在容器内可读；不要让只读输入覆盖
可写的 recipe、material 或 OCI 存储目录，也不要将受限文件包和运维清单提交到仓库。
Registry 先完成 recipe bootstrap，再执行 material bootstrap；已有 recipe 时可以只配置
material manifest。初始化导入不自动激活 Agent，也不修改 Server 的材料绑定；
失败时同样不会自动激活 Agent 或改写 Server 绑定，运维应检查错误并修正输入后重试。
完整材料约定见 [Spack 材料交付](../../docs/spack-material-delivery.md)。

需要关闭 recipe 功能时，在私有覆盖文件中同时把 `SPACK_RECIPE_STORE_DIR`、
`SPACK_RECIPE_BOOTSTRAP_MANIFEST`、`SPACK_MATERIAL_STORE_DIR` 和
`SPACK_MATERIAL_BOOTSTRAP_MANIFEST` 设为空字符串，以免违反材料存储依赖；
已有卷中历史保留，不删除目录。
备份时先停止 Registry 写入，保存完整 `recipes/`（包括 repositories、manifests、staging）
及原有 blob 数据；恢复时保持原卷布局。`down -v` 或 preview 卷清理会删除其中的 recipe 历史，
preview 的命名卷只保证该预览实例生命周期内的容器重建持久性。

离线静态检查：`bun test scripts/spack-recipe-storage.test.ts`。测试不启动服务或容器，
有本地 Helm 时仅执行 `helm template`；无 Helm 时渲染用例明确跳过。
材料配置与接线检查：
`bun test packages/registry/src/config.test.ts scripts/spack-material-delivery.test.ts`。
材料流水线用例仅使用进程内 fixture 与替身，不启动监听服务、容器或真实 Spack。

## 直接调用

构建上下文和 bind mount 均以仓库根目录为基准。直接调用时指定
`--project-directory .`，以便读取根目录 `.env` 并使用一致的路径和默认项目名。
更新已有部署时，沿用原来的 `-p` 或 `COMPOSE_PROJECT_NAME`。

```bash
docker compose --project-directory . \
  -f deploy/compose/docker-compose.yml \
  -f deploy/compose/docker-compose.watch.yml up
```

直接调用时通过 `-f` 选择配置；根目录没有可自动发现的平台配置文件。
CLI profile 会选择对应文件并设置路径基准。

旧的私有覆盖文件移到本目录后，继续保留在 Git 忽略列表中，不要提交部署参数。

## 专用配置

- [PR 调度器测试](../pr-test/README.md) 使用独立 Compose，从 scheduler base
  构建含当前代码和依赖的测试镜像，运行后删除本次临时卷。只覆盖 Slurm/PBS 与
  指定的材料回归，不复用 preview 或开发栈，不代表真实 Spack 离线安装验收。

Registry 的 Spack source/material 存储已放入现有 Registry 数据卷的 `materials` 子目录，
与 recipe Git 和 OCI blobs 分离。材料发布、Server 的 mTLS/下载配置与 Agent 缓存见
[Spack 材料交付](../../docs/spack-material-delivery.md)。
默认 Compose 不自动启用 Server 材料分发；平台未受管安装已被阻断，当前阶段只准备材料，
尚未接入离线执行器，不应作为恢复安装能力的生产升级。

- [`docker-compose.preview.yml`](docker-compose.preview.yml) 使用独立临时数据库与带认证的
  Quick Tunnel 入口，配置与暂停操作见[预览部署](../../docs/deployment.md#preview)。
  使用独立凭据，不沿用开发栈的固定口令。该配置仅用于临时预览，不连接业务集群或用于生产部署。

- [`examples/docker-compose.demo.yml`](../../examples/docker-compose.demo.yml) 与示例说明放在一起，
  使用 `bun run compose -- demo up`，或按[示例文档](../../examples/README.md)调用。
  此配置以 `examples/` 为路径基准，不使用上面的 `--project-directory .`。
- [`deploy/reverse-proxy/`](../reverse-proxy/) 保存 gateway 与本地转发配置及相邻 Nginx 模板，
  按[反向代理指南](../../docs/deployment.md#proxy)调用。
- [`deploy/schedulers/`](../schedulers/) 保存调度器 Dockerfile、脚本与 architecture-only overlay；
  overlay 叠加本目录的 scheduler 配置，见[调度器指南](../../docs/deployment.md#compose)。
