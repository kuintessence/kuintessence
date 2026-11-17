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

- Dashboard、Jobs、Agents、Workflows、Software、Files、Terminal、算力中心控制台、Settings、Auth。
- 首页快速开始可提交示例计算作业，或运行无需软件依赖的两节点编排示例；成功后
  打开作业/工作流详情。编排示例仅演示节点依赖与运行状态，不执行科学计算。
- 内置 Logo 在深色主题下保持可见；自定义品牌图片保留原始颜色。
- 窄屏侧栏默认关闭，桌面展开偏好独立保存；软件生态的授权/发布、Recipe/材料管理可按需展开。
- 作业列表首次加载有状态提示，失败可原地重试；作业和工作流名称支持键盘操作。主要运行状态及相对时间支持中英文。
- 标签页和管理区域使用短淡入反馈，系统减少动态效果设置会关闭这些动画。
- 工作流创建页使用 YAML/React Flow 双向编辑器；草稿删除需确认，失败保留草稿并支持重试。
- 打开草稿时先加载再编辑，加载失败可重试。保存期间的新编辑会保留，成功后草稿列表自动刷新；预算必须为有限非负数，名称不可为空。
- 作业与工作流状态筛选提供选中语义，便于辅助技术识别；等待预算审批的详情保持刷新并允许取消，审批操作仍需既有 API。
- 节点注册页对不可用接口提供配置提示与重试，有效期限制为 60 秒至 30 天，签发/撤销/复制失败可见。
- 个人账号信息在窄屏纵向排布，长邮箱自动换行。
- 工作流运行详情根据持久化 graph 显示节点与依赖；graph 为空时显示节点状态列表或等待状态。
- 运行详情读取失败可重试；关联作业读取失败显示提示，并使用可用的持久化状态。运行及已读取作业均结束后停止轮询；取消成功刷新列表缓存。
- 作业实时通知触发完整详情读取，完成时间、退出码等诊断字段与终态一起更新；服务端关闭 WebSocket 时触发 REST 刷新。
- SSH 走 Server gateway 与 Agent relay；通用 `/terminal` shell 执行是独立的 HTTP polling 界面。
- 登录页支持 SSO/OIDC，非生产模式另提供开发登录。平台管理员可在 Settings/Operations 的 Security 区域配置中英文品牌文案、Logo 与 favicon；空值使用内置默认，图片支持随 Web 镜像发布的 `/branding/logo.svg`、`/branding/favicon.svg` 或安全 HTTPS URL。
- 算力中心控制台 包含 Agent registration token 签发、metering 查询、导出和 webhook 管理界面。
- 平台与算力中心 材料面板共用 [Spack 安装绑定编辑器](docs/spack-install-bindings.md)，支持精确 spec 的查询、绑定、停用与审计；实际安装需由目标 Agent 完成。
- 本地 GUI 模式可通过 `kq gui serve` 注入 `window.__KQ_LOCAL__` 复用同一 SPA。
- 作业日志避免请求重叠，切换主题或错误恢复后保留完整日志，切换作业时清空旧终端；失败可重试。
- 作业与工作流取消响应绑定发起时的记录，详情读取失败隐藏旧名称和取消入口。文件页读取完整分页结果，状态变化时刷新，也支持手动刷新和重试；验证失败隐藏旧下载链接。
- 切换算力中心组织时清除作业日志与文件缓存。
- 队列表单按算力中心组织筛选 Agent；切换组织会清空 Agent、调度队列和 QoS，已有队列的所属组织不可修改。长表单和弹窗内的资源下拉列表支持独立滚动。
- 算力中心列表的“可用区”数量可进入对应组织的算网一览，查看或维护中心、集群及 Agent 归属。工作流创建页的标题和操作按可用宽度排列，空间足够时保持同行，窄屏允许换行。

文件页与路径选择器按 Agent 区分集群目录缓存；当前 Agent 离线后需显式重新选择，避免将旧目录带到其他 Agent。
目录读取或 Agent 列表刷新失败时禁止确认目录和使用旧目标传输。文件与目录名称支持键盘操作及选中语义，
长云端目录可在窄屏换行或截断。删除确认会重新验证文件与权限，成功后同步刷新作业文件缓存；
临时 NetDrive 503 与未启用服务分别提示。
传输表单在云文件使用权限失效或另选的执行 Agent 离线后要求重新选择；
再次打开路径选择器保留所选 Agent 与目录，
父组件刷新不重置正在浏览的路径。工作流刷新同时更新草稿；删除确认在草稿读取失败、消失
或版本变化后禁用，需重新核对后操作。
传输列表读取失败时隐藏旧记录、计数与操作入口；筛选提供选中语义，相对时间随语言切换。
本地文件按批次串行上传，进行中阻止重复选择与拖入，显示当前文件和固定目标目录，
单文件失败后继续其余文件并刷新相关文件缓存。云盘配额申请使用共享 schema 验证，
按界面要求填写整数 GB，检查策略上限和未来有效期；历史仅显示全局云盘申请。

## 已知缺口

- 浏览器会话、CSRF 与 CSP 的部署要求见[认证与浏览器安全指南](../../docs/security.md#authentication)。
- NetDrive UI 行为依赖 Server 侧 `NETDRIVE_ENABLED` 以及相关 S3 配置。
- 算力中心控制台 提供治理界面，完整租户委派模型尚未确定。

组件功能见[当前状态](../../docs/status/current-state.md)。

### 资源管理与日志

算力中心下设可用区，集群归属于一个可用区。目录中的可用区、集群和成员数量提供组织范围入口；集群和成员入口通过现有组织切换 API 校验权限后再加载目标页面。算网一览支持可用区内高速网络以及跨可用区的高速网络／专线配置，可选择整个可用区或具体集群；配置带宽独立于观测指标，不会创建实际网络或改写传输路由。

`LogViewer` 复用 `GET /audit-log` 的关键词、起止时间、`limit`／`offset` 与总数，提供服务端分页、检索及脱敏详情。`RefreshButton` 统一图标刷新入口，保留读屏名称、提示和加载状态。资源页签采用紧凑的选中背景，窄屏允许换行；计量筛选在桌面优先同行展示。
