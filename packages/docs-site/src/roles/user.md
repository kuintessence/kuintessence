# 用户手册

科研用户和 Compute Consumer 可按本手册登录平台、查找资源、提交任务及排查运行问题。

## 入口

- Web 控制台：`/`
- 登录页：`/login`
- 作业列表：`/jobs`
- Workflow：`/workflows`
- 文件：`/files`
- 软件目录：`/software`
- SSH 终端：`/terminal` 与 Agent 详情 SSH 入口

本地开发环境默认使用 dev login。生产环境应通过平台配置的 OIDC/SSO 登录。

## 日常流程

1. 登录系统，确认右上角账户与当前角色。
2. 在 `/software` 搜索需要的软件、软件用例或 workflow template。
3. 进入详情页查看 trusted source、lifecycle、版本、依赖和节点可用性。
4. 如果页面提示缺少 `view`、`use` 或 `install` 权限，发起 access request。
5. 在 `/workflows/new` 创建 workflow，或从 template 启动。
6. 运行前检查 placement preview，确认软件、队列、数据 locality 和权限没有阻断项。
7. 提交后在 `/jobs` 或 `/workflows/:runId` 查看状态、日志和输出文件。

## 作业提交

普通作业通过 Web 表单或 CLI 提交。CLI 常用流程：

```bash
kq login --server https://<平台地址>
kq submit docs/manuals/examples/job-smoke.json
kq list
kq status <job-id>
kq logs <job-id>
```

远程 `kq submit` 接收 JSON spec 文件，不支持 `--agent` 或 `--command` 选项。提交成功后，记录输出的 Job ID，用它查询状态和日志。失败时先保留返回码与首个错误，排查原因后再重试。

如果系统部署在 Web 反向代理后，Server URL 使用平台运营提供的 API 地址。

## Workflow

Workflow 使用控制流 DSL，Web 编辑器提供 YAML 与 React Flow 双向编辑：

- `when`：条件执行。
- `Switch`：分支。
- `Loop`：有界循环。
- `Reduce`：聚合。
- `SubWorkflow`：复用子流程。
- `Generate`：批量生成节点。

以下情况会影响运行：

- ACL：缺少软件资产的 `use` 或 `install` 权限。
- CP policy：目标算力提供者禁止安装、命中 deny list 或 lock。
- Lifecycle：资产被 `revoked` 或 `hidden` 会阻断；`deprecated` 只提示风险。

## 文件与数据

`/files` 将对象存储 NetDrive 与集群文件分开展示：

- NetDrive 是平台对象存储视图，适合跨站点输入输出。
- 集群文件走 Agent/Server 权限边界，只允许浏览管理员配置的安全 root。
- 大文件上传和任务输出优先走 multipart 或 Range-resume 路径。

当 workflow 输入文件有 mirror 记录时，调度器会把数据站点作为 locality hint 使用。

## 软件权限申请

软件详情页或 catalog 卡片会显示当前用户是否可 `view/use/install`。缺权限时：

1. 点击申请入口。
2. 选择需要的 capability：通常运行需要 `use`，自动安装需要 `install`。
3. 填写用途说明。
4. 等待资产管理员或平台运营审批。

审批通过后，授权写入 `software_asset_grants`，resolver 和调度器据此校验权限。

## 常见问题

### 登录后又回到登录页

先刷新页面。若仍失败，检查浏览器是否禁用了同站 cookie。开发环境可用：

```bash
curl -i http://localhost:15173/api/auth/oidc/config-public
curl -i -X POST http://localhost:15173/api/auth/login \
  -H "Content-Type: application/json" \
  --data '{"email":"dev@example.com","role":"user"}'
```

### 任务没有可用节点

打开 placement preview 或软件详情页的 availability 区域，按阻断类型处理：

- `acl`：申请软件权限。
- `cp-policy`：联系算力提供者调整 allow/deny、install mode 或 lock。
- `agent-status`：等待节点在线，或选择其他队列。
- `lifecycle`：改用 official fork 或更新 workflow template。

### SSH 连接失败

确认目标 Agent 在线，且平台或 CP 管理员已配置 SSH credential vault。生产环境还应确认 host-key pinning 和并发会话限制。
