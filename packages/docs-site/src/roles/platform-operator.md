# 平台运营手册

平台运营人员在授权范围内管理资源、协调审批、查询审计和处理事件。SSO、安全与基础服务配置由平台管理员负责，部署发布由系统运维负责。

## 入口

- 设置：`/settings`
- 软件治理：`/software` 的 Governance 区域
- 平台业务运营：`/operations`；算力中心工作区：`/cp`（需组织管理权限）
- 平台审计：`/audit`；组织审计：`/cp/audit`
- 作业与 workflow：`/jobs`、`/workflows`

业务运营使用 `operator` 角色及 `workspace.platform.operate` 能力；平台技术配置使用独立权限，平台角色不自动授予联邦签署、财务或仲裁权限。

## 日常职责

- 按权限管理算力中心、集群、队列、软件与执行账号，协调组织成员及角色问题。
- 将身份认证和安全配置问题交平台管理员处理。
- 审核 Software Provider 或算力中心提交的软件资产。
- 生成 trusted official fork。
- 管理软件 lifecycle：`published`、`deprecated`、`revoked`、`archived`。
- 处理用户 access request。
- 监控 Agent 在线状态、计量、审计、SSH 和 NetDrive。
- 跟踪维护窗口、备份和升级结果；由系统运维执行变更。

## 登录与 SSO（平台管理员）

生产环境应启用 OIDC/SSO。dev login 只允许非生产模式：

- `GET /api/auth/oidc/config-public`：前端判断是否展示 SSO。
- `GET /api/auth/oidc/login`：跳转 IdP。
- `GET /api/auth/oidc/callback`：写入 HttpOnly `kq_access_token`。
- `POST /api/auth/login`：dev-only passwordless login。
- `POST /api/auth/logout`：清理 cookie。

排查登录时先确认：

```bash
curl -i http://localhost:15173/api/health
curl -i http://localhost:15173/api/auth/oidc/config-public
```

如果 public route 正常但登录卡住，继续检查 Server 到 Postgres 的连接和 Server 日志。

## 软件审核

审核入口在 `/software` 的 Governance 区域，后端 API 包括：

- `GET /api/software/review-queue`
- `GET /api/software/assets/:assetId/review-detail`
- `POST /api/software/assets/:assetId/review`
- `POST /api/software/assets/:assetId/fork-official`
- `POST /api/software/assets/:assetId/lifecycle`
- `GET /api/software/assets/:assetId/impact`

审核前应检查：

- 最新 revision 与上一个 revision 的 diff。
- package/usecase/workflow 的 dependency refs。
- upstream、SP 或算力中心的 provenance。
- checksum、license、外部 URL、危险 install hook。
- 影响面：下游 usecase/workflow、active grants、pending requests、mirror/cache 状态。

平台默认通过 official fork 发布可信内容。界面保留 SP attribution，运行时引用平台冻结的 fork。

## Access Request 审批

用户缺少 `view/use/install` 时会创建 access request。审批原则：

- `view`：允许看到资产详情。
- `use`：允许运行依赖该资产的 usecase/workflow。
- `install`：允许在符合算力中心策略 的节点触发安装。

审批通过后，授权写入 `software_asset_grants`；拒绝时必须填写 reason，说明原因和可采取的操作。

## 安全与审计

重点配置：

- `WEB_CSP`：浏览器安全策略。
- `MTLS_MODE`：Agent-Server mTLS 模式。
- `REGISTRY_AUTH_MODE=jwt`：生产 Registry 鉴权。
- `SSH_SESSION_RECORDING`：SSH 会话录制。
- `SSH_IDLE_TIMEOUT_SEC`：SSH 空闲回收。
- `NETDRIVE_ENABLED`：对象存储文件能力。
- `CLUSTER_FILE_STATIC_ROOTS`：仅用于开发 bootstrap 的静态集群目录；production 默认留空并通过 Settings 管理持久化 roots。

审计重点：

- 角色和 capability 变化。
- 软件资产 submit/review/fork/lifecycle。
- access request 审批。
- SSH credential 和 session 操作。
- 算力中心策略 overlay 修改。
- NetDrive transfer 和计量导出。

## 发布与 CI（系统运维）

主项目使用 Bun workspace。基础验证：

```bash
bun run lint
bun run typecheck
bun run test:unit
```

文档站使用 VitePress，发布到 `gh-pages` 分支：

```bash
bun run docs:build
```

GitHub workflow 会设置 `DOCS_BASE` 以适配 GitHub Pages project site。

## 运行条件与限制

执行前确认以下条件：

- sandbox 中的 `spack concretize/install`。
- source mirror 和 buildcache worker。
- signed air-gap bundle export/import。
- Monaco + 结构化 `package.py` 编辑器。
- 通知执行器。
- 正式 OIDC、对象存储和调度资源需按所在环境完成配置。
