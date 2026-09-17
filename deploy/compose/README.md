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
