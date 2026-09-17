# 故障排查

按以下症状排查环境、登录、软件治理、调度和文档站问题。

## 登录无限转圈

先确认 Web、Server、Postgres 处于同一 compose stack：

```bash
docker compose --project-directory . -p kq-schedulers --env-file deploy/schedulers/ports-alt.env \
  -f deploy/compose/docker-compose.schedulers.yml ps
```

检查基础接口：

```bash
curl -i -m 5 http://localhost:15173/api/health
curl -i -m 5 http://localhost:15173/api/auth/oidc/config-public
curl -i -m 8 -X POST http://localhost:15173/api/auth/login \
  -H "Content-Type: application/json" \
  --data '{"email":"dev@example.com","role":"platform_admin"}'
```

如果 `/api/health` 正常但 `/api/auth/login` 超时，检查 Server 到 Postgres 的连接及 Server 是否阻塞。查看日志：

```bash
docker compose --project-directory . -p kq-schedulers --env-file deploy/schedulers/ports-alt.env \
  -f deploy/compose/docker-compose.schedulers.yml logs --tail=120 server
```

必要时只重启 Server：

```bash
docker compose --project-directory . -p kq-schedulers --env-file deploy/schedulers/ports-alt.env \
  -f deploy/compose/docker-compose.schedulers.yml restart server
```

## Registry 数据不显示

检查：

```bash
curl -i http://localhost:15173/software
curl -i http://localhost:15173/software/api/spack/catalog?page=1&pageSize=5
docker compose --project-directory . -p kq-schedulers --env-file deploy/schedulers/ports-alt.env \
  -f deploy/compose/docker-compose.schedulers.yml ps registry
```

如果 API 正常但页面为空，检查前端 query、source filter 和浏览器 console。若 API 为空，检查 Registry 启动日志中 upstream asset sync 是否完成。

## Spack package 解析为空

确认本地 metadata 是否存在：

```bash
ls packages/registry/src/data/spack-package-catalog.json
ls packages/registry/src/data/spack-package-metadata.json
```

官方 upstream package 详情从本地全量缓存读取，无需临时访问外网。若单个 package 缺少 metadata，重新运行生成脚本并更新相关文档。

## CP 软件页面显示范围内暂无集群

检查 Agent 是否注册，以及 provider org 是否属于当前用户的管理范围。`/cp/software` 也会列出尚无 policy row 的 Agent，并标记为未配置策略；列表为空时，检查：

- 当前登录用户是否属于 provider org。
- `agents.providerOrgId` 是否为空或不匹配。
- Server CP overview API 是否返回 clusters/agents。

```bash
curl -i http://localhost:15173/api/cp/software/overview
```

如果 `/cp/software` 可以打开，但提示“没有 Agent 控制通道在线”，说明 Server 只有历史心跳记录，没有可下发软件操作的 Agent stream。先检查 scheduler Agent 容器是否在当前 compose project 中运行：

```bash
docker compose --project-directory . -p kq-schedulers --env-file deploy/schedulers/ports-alt.env \
  -f deploy/compose/docker-compose.schedulers.yml ps
```

若列表里没有 `scheduler-slurm`、`scheduler-pbs`、`scheduler-k3s`，说明只启动了应用服务，软件安装、删除和加载按钮因此禁用。需要 scheduler smoke 栈时，按部署指南启动对应 scheduler services。

若容器存在但控制通道仍离线，执行识别验证脚本。脚本会检查调度器 CLI 与 Server `agents.last_heartbeat`，确认最近是否收到心跳：

```bash
bash deploy/schedulers/verify-recognition.sh deploy/compose/docker-compose.schedulers.yml deploy/schedulers/ports-alt.env
```

控制通道恢复后，用 Spack operation smoke 检查软件操作能否从 CP Web 经 Server、Agent 执行到 Spack。脚本默认对第一个在线 Agent 执行单条 `install`、批量 `import_preinstalled` 和单条 `load`：

```bash
bash deploy/schedulers/spack-operation-smoke.sh deploy/schedulers/ports-alt.env
```

需要检查删除操作时，显式加入 `uninstall`：

```bash
KQ_SPACK_SMOKE_ACTIONS=install,batch_import_preinstalled,load,uninstall \
bash deploy/schedulers/spack-operation-smoke.sh deploy/schedulers/ports-alt.env
```

批量 smoke 的 spec 列表使用换行分割：

```bash
KQ_SPACK_SMOKE_BATCH_SPECS=$'zlib\nopenmpi' \
KQ_SPACK_SMOKE_ACTIONS=batch_import_preinstalled \
bash deploy/schedulers/spack-operation-smoke.sh deploy/schedulers/ports-alt.env
```

没有在线控制通道时，脚本会在提交 operation 前停止，并打印 `/api/cp/software/overview` 中各 Agent 的 DB 状态、runtime 状态、控制通道状态和最近心跳。这些信息与 `/cp/software` 顶部诊断一致。

HTTP 请求默认使用 10 秒连接超时和 30 秒总超时，可通过 `KQ_SPACK_SMOKE_CONNECT_TIMEOUT_SEC` 与 `KQ_SPACK_SMOKE_CURL_TIMEOUT_SEC` 调整。批量 smoke 在本地检查 2000 条原始行、200 个唯一 spec 的上限，再向 Server 提交原始换行列表。Server batch 响应包含 `summary` 时，脚本会打印接收条数、忽略的空项和重复项数量，便于核对输入与创建的 operation 数量。

轮询 operation history 支持旧数组响应与当前 `{items}` 响应。`install`、`import_preinstalled` 和 `uninstall` 成功后，脚本还会读取 CP software overview 检查 installed ledger。只需检查 operation 终态时，可设置 `KQ_SPACK_SMOKE_VERIFY_LEDGER=false`。

## Scheduler Agent 周期性重连

Server 日志中的 `Inbound stream reader crashed` 加 `Agent channel unregistered/registered` 可能来自 Agent 长连接重建。若 Agent 很快重新 online，通常不影响登录和普通 API。若 Agent 持续 offline，再检查 scheduler 容器、网络和 Agent 日志。

## 文档站构建失败

先确认依赖：

```bash
bun install
bun run docs:build
```

常见原因：

- `DOCS_BASE` 缺少首尾 `/`，导致 GitHub Pages 静态资源路径错误。
- Markdown 内部链接指向尚未创建页面。
- VitePress 或 TypeScript 依赖未写入 lockfile。

## 静态检查失败

TS/JSON/CSS 改动后必须运行：

```bash
bun run lint
bun run typecheck
```

优先修正类型或规则问题。确需使用 `as any`、`@ts-expect-error` 或 `biome-ignore` 时，应说明原因。
