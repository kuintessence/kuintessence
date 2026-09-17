# @kuintessence/web

Kuintessence 平台的 Vite + React 19 SPA。

## 启动开发服务器

```bash
bun run --filter @kuintessence/web dev
```

开发服务器运行在 5173 端口，并把公共 `/platform/api/*`、`/platform/ws/*` 分别代理到 Server 的 `/api/*`、`/ws/*`。`/software/api/*` 代理到 Registry；旧 `/api/*` 只保留给历史开发客户端。

生产与远端测试的单域名、多域名入口约定见 [`docs/deployment.md#proxy`](../../docs/deployment.md#proxy)。

## 构建

```bash
bun run --filter @kuintessence/web build
```

## 测试

```bash
bun run --filter @kuintessence/web test
```

## 技术栈

- Vite 8 + React 19 + TypeScript
- TanStack Router（基于文件的路由，`src/routes/`）
- TanStack Query（服务端状态）
- Tailwind CSS v4（通过 `@tailwindcss/vite` plugin）
- React Flow（`@xyflow/react`），用于工作流编辑和运行图
- ECharts，用于 metering 与资源图表
- xterm.js，用于 Web SSH 与会话回放界面

## 路由树

`src/routeTree.gen.ts` 由 `vite.config.ts` 中的 `TanStackRouterVite` plugin
在 Vite dev/build 时生成并纳入版本控制。修改 `src/routes/` 后，在仓库根目录执行
`bun run --filter @kuintessence/web build` 更新路由树，提交生成结果。

## 当前界面

- Dashboard、Jobs、Agents、Workflows、Software、Files、Terminal、CP Console、Settings、Auth。
- 工作流创建页使用 YAML/React Flow 双向编辑器。
- 工作流运行详情根据持久化 graph 显示节点与依赖；graph 为空时显示节点状态列表或等待状态。
- SSH 走 Server gateway 与 Agent relay；通用 `/terminal` shell 执行是独立的 HTTP polling 界面。
- 登录页支持 SSO/OIDC，非生产模式另提供开发登录。平台管理员可在 Settings/Operations 的 Security 区域配置中英文品牌文案、Logo 与 favicon；空值使用内置默认，图片支持随 Web 镜像发布的 `/branding/logo.svg`、`/branding/favicon.svg` 或安全 HTTPS URL。
- CP Console 包含 Agent registration token 签发、metering 查询、导出和 webhook 管理界面。
- 本地 GUI 模式可通过 `kq gui serve` 注入 `window.__KQ_LOCAL__` 复用同一 SPA。

## 已知缺口

- 浏览器会话、CSRF 与 CSP 的部署要求见[认证与浏览器安全指南](../../docs/security.md#authentication)。
- NetDrive UI 行为依赖 Server 侧 `NETDRIVE_ENABLED` 以及相关 S3/MinIO 配置。
- CP Console 提供治理界面，完整租户委派模型尚未确定。

组件功能见[当前状态](../../docs/status/current-state.md)。
