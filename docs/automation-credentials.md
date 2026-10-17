# 自动化凭据

发布验收等无人值守任务可以使用独立 Bearer 凭据，不再复制浏览器 refresh token。
凭据由平台管理员创建，绑定一个独立的 `service_account` 普通用户和一个组织，
保留用户、组织、SpiceDB、软件治理及文件权限检查；scope 只是进一步收窄权限。
机器身份不能通过浏览器/CLI 登录换取不受 scope 限制的 JWT。

## 创建与轮换

平台管理员使用现有认证请求 `POST /api/automation/credentials`：

```json
{
  "name": "deployment-smoke",
  "orgId": "00000000-0000-4000-8000-000000000001",
  "ttlSeconds": 2592000,
  "scopes": ["agents:read", "software:read", "workflows:submit", "workflows:read", "workflows:cancel", "jobs:read", "files:read"]
}
```

响应为 `{ credential, token }`，token 仅此次返回，响应禁止缓存。secret 为 256 位随机值，
数据库仅保存 SHA-256 摘要。`ttlSeconds` 必填，范围 60 秒至 90 天；没有永久凭据。
新身份通过现有 outbox 投影组织 member 和 platform member 关系，授权同步完成前可能暂时不可见。
首次创建不自动分享私有软件、不添加队列使用权，也不赋予安装或管理员权限。

将 token 保存到站点受保护的凭据源，运行客户端时通过环境变量注入，例如客户端配置
`"tokenEnv": "KQ_ACCEPTANCE_TOKEN"`。不要将 token 写进命令行、Compose、仓库或日志。
不要同时配置 `sessionFile`；机器凭据无需会话刷新，但仍需在到期前轮换。

轮换时使用同一请求并增加 `"rotateFrom": "旧凭据 UUID"`，orgId 必须一致。
返回的新凭据沿用原机器身份，能继续读取原工作流和结果；旧凭据不会自动撤销。
更新执行器并确认新凭据可用后，请求 `POST /api/automation/credentials/:id/revoke` 撤销旧凭据。
旧凭据过期或已撤销时也允许管理员为同一正常身份签发替代凭据。
被停用或已失去组织 member 关系的身份不能轮换。

`GET /api/automation/credentials?orgId=UUID` 返回该组织最新 100 条凭据元数据，
包含期限、最后使用时间及撤销时间，永不返回 secret 或摘要；此接口与创建、撤销均仅向平台管理员开放。
对单个凭据可直接按已保存的 UUID 撤销，无需先列举。
创建请求没有自动重试契约：若返回丢失，检查元数据，撤销无法取回 secret 的凭据后重新创建。

## 权限边界

| Scope | 允许的请求 |
|---|---|
| `agents:read` | GET `/api/agents`，仍按现有授权过滤 |
| `software:read` | GET `/api/software/agents/:id/installed`，仍检查 Agent view 权限 |
| `queues:read` | GET `/api/queues/visible` |
| `workflows:submit` | POST `/api/workflows`，保留现有用例、数据、队列及软件治理检查 |
| `workflows:read` | GET `/api/workflows/:id`，只读本机器身份的运行 |
| `workflows:cancel` | POST `/api/workflows/:id/cancel`，只取消本机器身份的运行 |
| `jobs:read` | GET `/api/jobs/:id`、`/api/jobs/:id/logs`，只读本身份、绑定组织内的作业 |
| `files:read` | GET `/api/netdrive/files/:id`、`/api/netdrive/files/:id/download-url`，只读本身份文件 |

其他请求全部拒绝，包括修改队列、管理用户组织、直接提交作业、直接安装卸载软件和签发新凭据。
scope 不会为工作流中的软件安装提供额外许可；工作流自动安装仍需现有治理授权。
服务用户被停用、角色变为非 user，或绑定组织的 member 关系被删除/更改后，凭据拒绝认证。
跨主体资源请求在进入具体业务处理器之前拒绝，不能利用管理员继承或组织共享扩大读取范围。

SpiceDB enforce 模式仍使用对应用户的实时授权。off/shadow 模式保留现有本地规则，
普通用户的 Agent/库存读取可能受限；不要为此提升机器身份角色或绕过授权。
本能力不授予 SSH 权限、不支持 WebSocket/Registry API，也不替代调度器运行账户的配置。

每次成功认证的 API 请求记录 credential ID、机器用户、组织、scope、资源 ID 和结果状态，
创建及撤销另有审计；不记录 token、Cookie 或请求正文。随机无效 token 只返回统一 401，
不暴露凭据是否存在。撤销和到期在后续 API 请求时生效，不回收已开始的作业，
也不使已签发的短期文件下载 URL 立即失效；这两项遵循原有作业取消及下载链接期限。

## 发布验收

先运行数据库 migration，再发布 Server。凭据表是新增表，现有用户的 service_account 默认 false。
在测试环境验证有效/无效、过期、撤销、停用、组织撤回、scope 越权、跨主体文件与轮换，
并验证原有浏览器和 CLI session 仍能登录刷新。

正常发布后使用机器凭据运行一条轻量跨调度器工作流，关联 CI revision、工作流 ID、作业及文件证据。
凭据过期应令检查明确失败，不能自动退回管理员会话。发布成功但检查失败时保留已部署版本和证据，
不要通过重复数据库迁移来重试工作流。本能力提供认证契约，不代表任何站点已完成现场验收。
