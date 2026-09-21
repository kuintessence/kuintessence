# 安全与访问运维指南

本文供平台运维与 Compute Provider 管理员配置认证、授权、软件仓库、
Agent 身份和 SSH 接入。功能范围见[当前状态](status/current-state.md)。
API 路径默认指 Server 内部路径；统一网关下 `/api/*` 通常对应 `/platform/api/*`。

- [认证、浏览器与可信代理](#authentication)
- [SpiceDB 授权与恢复](#authz)
- [Registry 权限与 artifact](#registry)
- [Agent 注册与证书](#agent)
- [SSH vault、会话与录屏](#ssh)

生产入口使用 HTTPS，密钥通过受控 Secret 管理。
token、cookie、私钥、真实主机清单和运行证据不得写入仓库、代理日志和工单。

下文示例均为占位配置。授权通过后，对应服务还会检查资源是否存在、生命周期、
quota、路径限制、调度策略和 Agent 在线状态。

<a id="authentication"></a>
## 认证、浏览器与可信代理

### 浏览器会话

生产 Web 使用同源 HttpOnly cookie 认证 REST、WebSocket 和 SSH upgrade。
`localStorage` 仅保留 email、显示 role、到期信息与 cookie-session marker，不能作为服务端授权依据。

| Cookie | 用途 | Server 写入的 Path |
|---|---|---|
| `kq_access_token` | 短期 access JWT | `/` |
| `kq_refresh_token` | 浏览器续期 JWT | `/api/auth` |

两者均为 `HttpOnly; SameSite=Lax`；生产启用 `Secure`。
`Secure` 来自按 `NODE_ENV` 装配的 `allowInsecureIssuer` 配置，不通过请求协议头动态推断。
代理仍必须正确传递外部 origin，并保留请求 `Cookie` 和响应 `Set-Cookie`。

| 接口 | 会话行为 |
|---|---|
| `POST /api/auth/login` | 仅非生产可用；写 cookie，并为开发客户端返回 token |
| OIDC callback | 写 cookie；重定向只带非敏感 metadata，不携带 JWT 或授权 role |
| `GET /api/auth/session` | 读取现有会话 metadata，不延长会话 |
| `POST /api/auth/session/refresh` | 校验 refresh cookie，轮换两类 cookie，返回当前身份和 `expiresIn` |
| `POST /api/auth/logout` | 撤销当前 session，清除两类 cookie |

Web 在 access 到期前主动续期；同源 API 首次返回 `401` 时也会尝试一次续期并重放。
OIDC landing 后从 Server 获取显示 role；access 过期不妨碍有效 refresh cookie 续期。
refresh 接口可能在响应体中以 `authenticated: false` 表示失败，客户端须同时检查响应体和 HTTP 状态码。

### Session ledger 与 TTL

`auth_sessions` 是会话账本，只保存 refresh `jti` 的 SHA-256，不保存明文 token。
access 与 refresh 有不同 `tokenUse`，不能互换；浏览器 refresh 必须携带有效 `sid`。
每次 refresh 原子轮换 `jti`，复用旧 refresh token 会触发 replay 判定并撤销 session family。

- 客户端合并并发 refresh，并用同源 `navigator.locks` 协调多个标签页；不依赖 replay 宽限窗口。
- refresh 沿用 ledger 的会话到期时间，不会无限滚动延长 session。
- 登出后不能继续 refresh，也不能通过后续 Server API 或 WebSocket upgrade 复用该 session。
- 已建立的长连接有独立生命周期；事件处置时应另外关闭活动连接。

| 配置 | 默认 | 约束 |
|---|---:|---|
| `AUTH_ACCESS_TOKEN_TTL_SEC` | `900` | 至少 `60` 秒 |
| `AUTH_REFRESH_TOKEN_TTL_SEC` | `604800` | 必须大于 access TTL |

所有 Server 实例应共享 PostgreSQL 会话账本、签名配置和一致的时间基准，数据库 schema 须与部署版本匹配。
TTL 变更需要重启 Server；IdP 会话不能替代 Server refresh cookie，续期失败须重新登录。

### OIDC、CLI 与身份绑定

生产使用 Settings 的 SSO 配置或 `SSO_BOOTSTRAP_*` 接入 IdP。
`SSO_BOOTSTRAP_ENABLED=true` 仅在配置为空时初始化；`SSO_BOOTSTRAP_FORCE=true` 会覆盖已有配置。
OIDC `redirectUri` 与 `WEB_BASE_URL` 必须指向最终用户可访问的 HTTPS 入口。

`users.external_id` 使用 issuer-namespaced identity key，新 token 的 `sub` 为 canonical `users.id`。
Server 从 DB 重读 role、email 和 membership，权限以这些当前值为准；组织成员关系保存在 `user_org_memberships`。
兼容 token 的 email lookup 仅用于查找已有身份，不分配新身份，也不得据此创建授权 tuple。

`kq login --server <serverUrl>` 使用 OIDC 和 loopback callback；path 模式的 `serverUrl` 包含 `/platform`。
浏览器仅向 `http://127.0.0.1:<port>/callback` 传递短时一次性 code，CLI 调用 `/api/auth/oidc/exchange` 换 token。
code 单次消费状态存于 PostgreSQL；CLI session 可由 `kq logout` 撤销，access token 不进入浏览器 URL。

系统仍接受 Bearer header、WebSocket query/subprotocol token。
生产 Web 使用 cookie 认证，避免将 JWT 放入 URL。

### CSRF 与代理 origin

Server 对 cookie 鉴权的非 `GET/HEAD/OPTIONS` 请求执行以下检查：

1. cookie 使用 `SameSite=Lax`。
2. `Sec-Fetch-Site: cross-site` 被拒绝。
3. `same-origin` 或 `same-site` 被接受，适用于受控同站点代理。
4. 缺少上述可信 Fetch Metadata 时，若有 `Origin`，必须匹配服务端识别的 origin。

该检查不使用独立 CSRF token，也不会统一拒绝同时缺少 Fetch Metadata 和 `Origin` 的请求。
Bearer 鉴权不走该 cookie CSRF 检查，不能让不受控代理任意把外来 cookie 变成 Bearer。
同站点子域也属于信任边界，避免在其中托管不可信应用。

ingress 应剥离外来 `X-Forwarded-Proto/Host`，写入 canonical proto/host，并限制绕过 ingress 直连 Server。
`HTTP_TRUSTED_PROXY_CIDRS` 不会替代这两个头的清洗。

统一网关若把 `/platform/api/*` 转为 Server `/api/*`，还须改写响应 cookie：

| Server Cookie Path | 外部 Cookie Path |
|---|---|
| `/api/auth/oidc` | `/platform/api/auth/oidc` |
| `/api/auth` | `/platform/api/auth` |

否则可能出现 IdP 跳转成功、callback 缺 state 或 refresh 不带 cookie。

### 客户端 IP

Server 以 socket peer 为基础解析审计 IP。`HTTP_TRUSTED_PROXY_CIDRS` 默认空，
此时忽略 `X-Forwarded-For`；仅当 peer 命中可信 CIDR 时才从右向左剥离可信 proxy hop。
XFF 缺失或非法时回退到已验证的 socket peer；无法取得合法 peer 时不填入推测地址。
若整条 XFF 都是可信地址，实现返回最左端地址，但未验证它是否属于终端用户。

只配置直接受控代理的最窄地址范围，例如：

```dotenv
HTTP_TRUSTED_PROXY_CIDRS=10.42.7.18/32,fd00:42::18/128
```

边缘入口须先覆写外来 XFF，再追加 peer；仅使用 `$proxy_add_x_forwarded_for` 不能代替清洗。
该配置只控制 HTTP/SSH 审计 IP，与 Agent mTLS 的代理白名单独立。

### CSP

Server 的 `WEB_CSP` 写入正式 `Content-Security-Policy`，未配置时不发出 CSP。
Report-only 由 ingress 注入 `Content-Security-Policy-Report-Only`，观察页面依赖后再启用 enforce。
独立服务提供的 Web HTML 也须配置 CSP，API 响应上的策略不能代替页面策略。

可从以下策略按部署域名收紧：

```text
default-src 'self';
base-uri 'self';
object-src 'none';
frame-ancestors 'none';
form-action 'self';
img-src 'self' data: blob:;
font-src 'self' data:;
style-src 'self' 'unsafe-inline';
script-src 'self';
connect-src 'self' ws: wss:;
worker-src 'self' blob:;
```

`ws: wss:` 是宽泛兼容配置，生产应尽量列出实际连接源。
`unsafe-inline` 用于当前运行时样式兼容，不能扩展到 `script-src`。
策略调整需覆盖登录、续期、退出、jobs/workflows WS、SSH、编辑器和管理页面；
HTTPS-only 环境可按实际资源情况增加 `upgrade-insecure-requests`。
Server 同时发出 `nosniff`、`X-Frame-Options: DENY` 和 `Referrer-Policy: no-referrer`。

<a id="authz"></a>
## SpiceDB 授权与恢复

### 模式与配置

Server DB 保存业务事实，SpiceDB 保存可重建的 relationship 投影。
业务 API 应修改事实表并投递 `authz_outbox`，不把 raw tuple 当作常规配置入口。

| 配置 | 默认 | 运维含义 |
|---|---|---|
| `AUTHZ_MODE` | `off` | `off` 本地判定；`shadow` 记录差异；`enforce` 强制资源授权 |
| `AUTHZ_SPICEDB_ENDPOINT` | `localhost:50051` | SpiceDB gRPC 地址 |
| `AUTHZ_SPICEDB_TOKEN` | 本地开发值 | 生产必须替换为受控 pre-shared key |
| `AUTHZ_SCHEMA_PATH` | `authz/schema.zed` | Server 写入及 readiness 比对的 schema |
| `AUTHZ_OUTBOX_INTERVAL_SEC` | `5` | 后台投递间隔 |
| `AUTHZ_OUTBOX_BATCH_SIZE` | `100` | 单轮投递预算 |
| `AUTHZ_PLATFORM_ADMIN_DEGRADE` | `true` | SpiceDB 异常时的平台管理员降级开关 |
| `AUTHZ_RAW_TUPLE_ADMIN_ENABLED` | `false` | 受审计的 break-glass tuple 写入口 |

Compose 的 Server 使用内置 SpiceDB 和 `enforce`，覆盖了裸进程的默认配置。
Helm chart 未内置 SpiceDB 服务，部署方须落实外部 endpoint、Secret、网络隔离、健康检查及备份恢复。

### 主体与本地业务边界

`shadow/enforce` 检查使用 canonical `users.id`；缺绑定时 fail-closed，不用 email、opaque subject 或 `unknown` 代替。
审计身份和本地 fallback role 同样来自 bound principal。

平台 `users.role` 与组织 membership role 是两层事实：
- 平台角色包含 `super_admin/platform_admin/operator/org_admin/user/guest`。
- 组织角色为 `owner/admin/operator/member/viewer`。
- 平台 `operator` 可 `view/operate`，不具备 `platform#manage` 或 break-glass 资格。
- `off/shadow` 使用当前 DB 身份的本地判定；`shadow` 仍保留本地拒绝结果。
- `enforce` 依资源权限决定结果，不按旧 JWT role 提前放行或统一拦截。

| 资源 | 权限与仍由本地约束的事项 |
|---|---|
| platform / organization | `view/manage`；global preference 还要求 canonical `super_admin` |
| provider / agent | Provider 管理及 `agent#view/operate/manage`；Agent 存在性和在线状态不由 SpiceDB 替代 |
| queue / job / workflow | `view/submit/manage/cancel`；queue enabled、调度意图和资源状态仍需检查 |
| netdrive_file | `view/use/delete`；删除仍有 owner-scoped mutation 约束 |
| cluster_file_root | `manage/use`；路径必须落在允许 root，默认无静态 root 时拒绝 |
| software_asset | `view/use/install/manage`；生命周期、Spack policy、quota 和可安装性仍需检查 |
| SSH 资源 | credential、session、recording 分别授权，见 [SSH](#ssh) |

direct `platform` 关系提供平台管理链路，公开软件则依赖 `platform#member` 和 `software_view/software_use`。
`platform-public` 恢复 view/use，`trustedForGlobalUse=true` 才额外恢复 install，两者不能混用。

### Outbox 顺序与故障处理

Outbox 按单调 `sequence` 投递，同资源较早的 `pending/processing/dead` 会阻塞后续 mutation。
独立资源仍可处理。worker 使用短 lease claim，过期 `processing` 会重新投递。
投递顺序以 sequence 为准，不按时间或 UUID 排序。
同一批 relationship key 保留最终操作，角色替换会删除旧授权并保留当前目标关系。

处理积压时先看错误、资源和 predecessor：
1. 查询 `/api/admin/authz/health`、`/readiness` 与 outbox 明细。
2. 修复 SpiceDB 连通性、schema 或业务事实，不直接丢弃阻塞行。
3. 对 `dead` 逐条确认后调用 `POST /api/admin/authz/outbox/:id/retry`。
4. 必要时调用 `POST /api/admin/authz/outbox/process` 投递 pending。
5. 再检查计数、shadow diff 和受影响资源权限。

后台、启动恢复和批量 process 不自动重放 `dead`；retry 重置状态、attempts 和下次投递时间。
`lastError` 保留到下次投递，原始错误与 attempts 写入 `authz.outbox.retry`。
资源删除、tombstone、grant 缩减与 SSH 关闭应投递删除关系，避免授权残留。

### Readiness、降级与重建

`/api/admin/authz/*` 管理面要求 `platform#manage`。
`GET /api/admin/authz/readiness` 的 `enforceReady` 要求：

- mode 非 `off`，SpiceDB 已配置且健康。
- 当前 Server 已写 schema，远端 schema 与 `AUTHZ_SCHEMA_PATH` 匹配。
- outbox `pending/processing/dead` 均为零。
- shadow diff 为零。

`externalSmokeRequired=true` 表示还需在部署环境中验证授权链路。
Settings 清理已审阅 diff 只删除差异记录，并写 `authz.shadow_diff.clear`，不会修复关系；
权限结果须另行核对。

`enforce` 下授权服务不可用时通常拒绝请求。只有开启降级、bound DB role 为
`platform_admin/super_admin`，且该资源路径支持降级时，检查才可 fallback。
放行前必须写 `authz.degraded_fallback`，审计失败则拒绝。
明确的 permission denied 始终拒绝。

批量检查使用 gRPC `CheckBulkPermissions`；item error 或响应数量不匹配也按授权不可用处理。
`POST /api/admin/authz/rebuild` 写当前 schema、清除受管 resource types 的旧 tuple，再从 Server DB 批量恢复关系。
重建会替换受管关系，并影响 `ssh_session` 等临时关系，应在维护窗口或低流量时执行。
成功后记录 `authz.rebuild`、tuple 数量、资源分类计数和清理范围。

Raw tuple break-glass 要求开启配置、具有 canonical `super_admin` 身份并完成二次确认。
操作先记录 `authz.raw_tuple.break_glass`，再写 outbox。
此类修复可能被 rebuild 覆盖；事件结束后应修正事实源、核对 outbox 并关闭开关。

<a id="registry"></a>
## Registry 权限与 Artifact

### JWT 与 canonical principal

生产必须显式启用 JWT：

```dotenv
REGISTRY_AUTH_MODE=jwt
REGISTRY_JWT_SECRET=<与发行方一致的高强度共享签名密钥>
REGISTRY_PUBLISHER_ROLES=super_admin,platform_admin,org_admin
```

缺少 secret 时 JWT 模式配置失败；`dev` 与 `X-Test-Principal` 仅供开发，生产禁用 `REGISTRY_ALLOW_TEST_PRINCIPAL`。
验证器检查三段式 HS256、signature、principal claims 及数值型 `exp/nbf` 的时间，但不强制要求 `exp` 存在。
发行方必须自行保证短期 token 策略。

Server access token 不设置 `iss/aud`；直接复用时不配置 `REGISTRY_JWT_ISSUER` / `REGISTRY_JWT_AUDIENCE`。
只有发行方确实写入对应 claims 时才启用匹配校验。

服务按 UUID `sub` 查询共享 DB 的 `users` 和 `user_org_memberships`，
用当前 role/orgIds 覆盖 JWT，拒绝不存在或停用的用户。
此部署要求 `sub` 为 UUID，不接受 email；membership 变更无需等待 refresh 即可生效。
支持 `operator` 角色，但默认 publisher 集合不包含它。

两服务的 `REGISTRY_PUBLISHER_ROLES` 必须一致：Server 控制 `software.publish` capability，Registry 执行发布检查。
加入 `user` 只增加 publisher 资格，不消除 namespace 或资源 owner 约束。

同域 Web 不读取 access cookie；gateway 将其转为 Bearer，显式 `Authorization` 优先。
该路径不经过 Server cookie CSRF middleware，cookie 转换也不检查 CSRF。
可信入口须控制跨站写请求。

### Namespace 与 API 边界

下表适用于 OCI `/v2` 和 Spack `/buildcache` 的 namespace RBAC：

| Namespace | 读 | 写 |
|---|---|---|
| `public/<repo>` | 任意有效 principal | `platform_admin/super_admin` |
| `org/<orgId>/<repo>` | 对应组织成员或 `super_admin` | 该组织 `org_admin`，或 `platform_admin/super_admin` |
| `user/<sub>/<repo>` | 本人或 `super_admin` | 本人或 `super_admin` |

所有写操作都先要求 publisher role，`super_admin` 也不能绕过该集合检查。
namespace owner 不自动拥有发布资格；`platform_admin` 不自动跨用户 namespace，读 org namespace 也不绕过 membership。
用户 namespace 应使用 canonical UUID，不使用 email。

其他 Registry API 按各自规则授权：

- OCI 与 buildcache 的读写均要求有效 principal，写入额外检查 publisher 和 namespace。
- App template 写入要求平台管理员，读接口公开，不使用三层 namespace 规则。
- Usecase package、workflow template 写入检查 publisher 及各自资源归属规则。
- Spack catalog 允许受限匿名读取；显式 `source=vendor` 要求认证，并按服务规则收窄可见性。
- 受保护写路径包括 blob upload、manifest/tag mutation、artifact 删除及模板/package 修改。

| 失败条件 | HTTP / 错误 |
|---|---|
| 必须认证但没有 Bearer | `401 UNAUTHORIZED` |
| token 无效、canonical 用户缺失或停用 | `401 INVALID_TOKEN` |
| 无 publisher 资格 | `403 PUBLISHER_ROLE_REQUIRED` |
| namespace 或资源归属不满足 | 按 route 返回 `403/404` |

OCI 和共享 principal middleware 的拒绝使用 Distribution v2 envelope，非 OCI 路径的鉴权失败也可能返回该形状。

### Artifact 回收与上传限额

删除使用产品 API，不直接删 BlobStore 或 metadata：

- `DELETE /v2/<namespace>/<repo>/manifests/<tag>` 只移除该 tag。
- 同一路径用 `<digest>` 时，移除该 repository 中指向该 digest 的所有 tag。
- manifest 不再被任何 repository tag 引用后才删除，并回收无引用 config/layer blob。
- `latest` 改指新 manifest 后也回收旧的无引用内容；其他 tag/repository 引用保持有效。
- blob 还需确认没有 OCI manifest 或 buildcache row 引用才可回收。
- repository 没有 tag 且没有进行中的 upload session 时，可从 catalog 清除。
- `DELETE /buildcache/<namespace>/build_cache/<filename>` 删除对应 index entry；
  `.spack` 与配套 `.spec.json` 是同一 entry 的两个视图，删除任一即删除该 entry。

已提交 artifact 采用 mutation 后引用回收，没有通用定时孤儿扫描。
未完成 upload 单独清理，每五分钟清扫超过 idle 阈值的 session。

| 配置 | 默认 |
|---|---:|
| `REGISTRY_MAX_UPLOAD_BYTES` | 10 GiB |
| `REGISTRY_UPLOAD_IDLE_SEC` | 3600 秒 |
| `REGISTRY_MAX_ACTIVE_UPLOADS` | 100 |
| `REGISTRY_MAX_ACTIVE_UPLOADS_PER_REPOSITORY` | 10 |
| `REGISTRY_MAX_INCOMPLETE_UPLOAD_BYTES` | 40 GiB |

生产设置持久化 `BLOB_STORE_DIR`，未设置时使用开发用内存 BlobStore。
清理后分别核对 catalog/index、DB metadata 和 blob 引用，不删除其他资源共用内容。
CLI 跨域访问须设置可信 `KQ_REGISTRY_URL`；它会转发 Bearer token，非 loopback 地址必须用 HTTPS。

<a id="agent"></a>
## Agent 注册与证书

### HTTP/2 与 mTLS 边界

`AgentService.Connect` 是长期双向流，使用 `@connectrpc/connect-node` HTTP/2 transport。
proxy 不能降级 HTTP/1.1 或缓冲请求/响应；Agent 请求流打开时，Server 仍须能返回控制消息。
Agent 重连会重建 transport；开发 Server 使用进程级 `bun --watch`，不用会留下旧 listener 的 `--hot`。
生产不得使用 `MTLS_MODE=off` 的 h2c。

Direct mTLS 由 Server 终止 TLS，握手要求可信 CA 签发的 client certificate：

```dotenv
MTLS_MODE=direct
SERVER_GRPC_TLS_CERT_FILE=/etc/kuintessence/grpc-server.crt
SERVER_GRPC_TLS_KEY_FILE=/etc/kuintessence/grpc-server.key
SERVER_CA_DIR=/var/lib/kuintessence/server-ca
```

Trusted proxy 由专用入口验证 client certificate，并仅向 Server 注入其 fingerprint：

```dotenv
MTLS_MODE=trusted-proxy
MTLS_TRUSTED_PROXY_CIDRS=10.20.0.18/32,fd00:20::18/128
MTLS_HEADER_FINGERPRINT=x-agent-cert-fingerprint
```

- trusted-proxy 白名单为空时拒绝启动；非可信 socket 来源不能靠 header 获得身份。
- proxy 必须剥离外来 fingerprint header，在证书校验成功后注入 DER SHA-256 的 64 位 hex。
- Server 配置默认 header 为 `x-agent-cert-fingerprint`；
  Helm production profile 默认 `x-kq-client-cert-fingerprint`，两端必须统一。
- Direct 模式从已验证 TLS peer 提取 fingerprint，不信任客户端自报 header。
- 两种模式均以 `agent_certs` ledger 拒绝未知或撤销证书，并绑定 Agent ID。
- trusted proxy 负责证书链和有效期校验；单独的 fingerprint header 不提供这些保证。
- Proxy 到 Server 跨不可信网络时须另加 TLS 或等效受控链路。

Helm production profile 默认 trusted-proxy；无法部署专用可信代理时可显式选择 direct。
CA 私钥、服务端 TLS key 和 Agent key 均须受控保存，不能随示例配置分发。

### 一次性 Enrollment

Provider 事实源是 `agent_registration_intents` 和 `agents.provider_org_id`，不信任 Agent 自报组织。
CP Console `/cp/agent-registration` 按 scope 提供 Provider；平台管理员可跨 Provider，但须明确 `providerOrgId`。

| 接口 | 用途 |
|---|---|
| `GET /api/cp/agent-registration-context` | 获取 scope 内 Provider 和 scheduler 选项 |
| `GET /api/cp/agent-registration-tokens` | 读取未使用、未撤销、未过期 token metadata |
| `POST /api/cp/agent-registration-tokens` | 签发指定 Agent/Provider 的一次性 token |
| `DELETE /api/cp/agent-registration-tokens/:id` | 撤销未使用 token |
| `POST /api/agent-registration/metadata` | 以 token 读取 enrollment metadata |
| `POST /api/agent-registration/complete` | 以 token 和 CSR 完成签发、登记及 Provider 绑定 |

token 只存 hash，明文仅在创建响应和 Web 本次签发区域显示一次。
metadata/complete 接口使用 token 授权，登记必须提供有效 token。
同一 `agentId` 有有效 intent 时不能重复签发；撤销未使用 token 后可重新签发。
已登记的 Agent 应轮换证书，不应重新签发 enrollment token。

节点侧命令形态如下；须防止真实 token 留在 shell history、录屏或进程采集系统：

```bash
kq agent register \
  --url https://server.example.invalid/platform \
  --grpc-url https://agent.example.invalid \
  --token <one-time-token> \
  --scheduler slurm \
  --output-dir ~/.kuintessence/agent/<agentId>
```

`--url` 指 Server HTTP API base，不是 Web dev server；`--grpc-url` 是 HTTP/2 入口。
Scheduler 支持 `slurm/pbs-pro/torque/kubernetes`，CLI 识别本地 adapter 并提交类型与版本。
私钥只在节点生成，CSR 交 Server 验证签名和 CN 与 `agentId` 的一致性。

输出包括 `certs/client.key`、`client.crt`、`ca.crt` 和 `agent.env`。
目录权限设为 `0700`，新私钥和 env 为 `0600`；证书轮换后也应检查既有文件权限。
`agent.env` 写 Server URL、Agent ID/site、mTLS、证书和 DB 路径，不写 scheduler 类型；部署须保持运行时配置一致。
Server 还会检查 Agent 是否已登记；即使 mTLS 验证通过，缺少 Server Agent row 的连接仍会被拒绝。

### 证书 API 与审计

| 接口 | 所需权限 / 行为 |
|---|---|
| `GET /api/cp/agents/:agentId/certs` | `agent#operate`；返回 metadata |
| `POST /api/cp/agents/:agentId/certs/:fingerprint/revoke` | `agent#manage`；可提交 `reason` |
| `GET /api/admin/agents/:id/certs` | `platform#manage`；全局查询 |
| `POST /api/admin/agents/:id/cert` | `platform#manage`；提交 `csrPem` 签发或轮换 |
| `POST /api/admin/agents/:id/cert/:fingerprint/revoke` | `platform#manage`；可提交 `reason` |

CP 在 `off/shadow` 下仍受本地 scope 限制；`enforce` 按表中资源权限判断。
CP Agent 聚合列表要求 `agent#operate`，普通 Agent 列表要求 `agent#view`。
证书列表只返回 fingerprint、CN、issuedAt、expiresAt、revokedAt、issuedBy，不返回 PEM 或私钥。
签发接口返回 certificate/CA PEM，不返回节点私钥。

轮换时在节点生成新 key/CSR，经签发 API 获取新证书，部署后确认新身份再撤销旧证书。
撤销使用完整 hex SHA-256 fingerprint；先从目标 Agent 的 ledger 核对，不手工猜测。
POST revoke 的 `reason` 进入 audit diff；兼容 DELETE 撤销接口不携带 reason。
撤销 ledger 不会主动断开已建立的长流。处置凭据泄露时，还需隔离节点并关闭既有连接。

审计 action 包括 `agent.registration_token.create`、`agent.registration.complete`、`agent_cert_issued` 和 `agent_cert_revoked`。
在 `/cp/audit` 按 action 或原始 Agent ID 查找，不仅搜索 SSH 使用的 `agent:` 前缀；详情含 fingerprint、revokedAt 和可选 reason。

### 故障分诊

| 现象 | 核对与处理 |
|---|---|
| 创建 token 返回 400/403 | 核对 CP scope、Provider、重复 active intent 或已有 Agent row |
| token 无效 | 检查过期、撤销、已消费和 Server URL；不要盲目重复 complete |
| complete 报错但 Agent 已登记 | 检查 ledger、intent 和节点文件；DB 提交后仍有投影/审计步骤，先判断实际落点 |
| Agent 在线但 CP 不可见 | 检查 Provider 绑定、membership、`agent#operate` 和 outbox |
| 证书列表拒绝 | CP 检查 `operate`，平台入口检查 `platform#manage` |
| 撤销失败 | 核对权限、完整 fingerprint 及目标 ledger，使用 POST 记录 reason |
| `401 MTLS_REJECTED` | 检查 peer CIDR、header 名、证书校验与 ledger 未知/撤销状态 |
| HTTP/2 反复断连 | 检查代理协议、buffering、超时和 transport 重建，不能降级 HTTP/1.1 |
| 本地 cert bundle 不完整 | 恢复完整 key/cert/CA 配对；已消费 token 不能用于恢复丢失私钥 |

<a id="ssh"></a>
## SSH Vault、会话与录屏

### 通路与授权

Web terminal、`kq ssh <agentId>` 和 TUI 共用 `/api/ssh/sessions/:agentId`，经 Server 和 Agent `ssh2` relay 接入登录节点 PTY。
Web 主链路用 cookie；CLI 用 Authorization header，构造 WebSocket 失败时仍有 query token fallback。
常规代理应支持 Authorization header，不记录含 token 的 URL。
客户端支持 resize 控制帧；CLI 的 `--no-tty` 或管道输入不转发终端尺寸。

`AGENT_SSH_ENABLED=true` 默认开启 relay 能力，但还需要在线 Agent、凭据和会话授权：

- `off/shadow` 检查 bound DB 身份、管理角色和 Provider ownership；目标 Provider 的 `owner/admin` membership 也可满足条件。
- `enforce` 使用 `ssh_session#open`，获此权限的非管理员角色也可打开会话。
- session owner、并发计数、open-rate 和 recording actor 使用 canonical `users.id`。
- open 前建立临时 Agent/platform 关系；成功后补 opener；关闭时删除 session 关系。
- Legacy HTTP terminal 通过 Agent service-account 执行短命令，不提供 SSH PTY。
  Unix mapping 仅用于审计，不切换进程的 POSIX 身份。

### Credential Vault

生产按 Agent 从 `ssh_credentials` 读取 vault；password/private key/passphrase 以 AES-GCM 加密，使用独立 HKDF domain `kq-ssh-cred-v1`。
Wrapping key 使用 `SSO_SECRET_KEY ?? JWT_SECRET`；HKDF 域分离仍依赖同一根密钥。
更换 wrapping key 后，旧密文无法用新 key 解密。更换前必须安排旧密文恢复或重新录入凭据。

凭据材料仅写入，不向 Web/API 读回；host、port、username 和 pin 是可读 metadata。
Server 仅在打开 session 时解密并发送给 Agent，Agent 建立到登录节点的 SSH 连接。
Server/Agent 在运行时处理明文凭据，传输使用 [Agent mTLS](#agent)。

| 接口 | 权限 |
|---|---|
| `GET /api/admin/ssh-credentials` | `ssh_credential#view` |
| `PUT /api/admin/ssh-credentials/:agentId` | `agent#manage` |
| `DELETE /api/admin/ssh-credentials/:agentId` | `agent#manage` |

Settings 提供 vault 管理界面；写入记录连接 metadata 和是否设置 secret，不记录 secret 内容。
管理 API 在 `enforce` 下按资源授权，路径中的 `admin` 不限定调用者必须具有平台角色。
credential 的写入和删除检查目标 Agent 的管理权限，而非 credential 自身的 `manage`。

生产只使用 vault。非生产直接使用 env mock resolver，不查询 vault；
`SSH_CRED_<AGENT_ID>` 的 ID 转大写、连字符改下划线，值为 JSON。

### Host-key Pin 与连接加固

未设 `hostKeySha256` 时不安装 `hostVerifier`，不验证 host key、不记录首次密钥，
也不检查后续变化；系统没有 TOFU 机制。
通过可信带外渠道取得公钥，将其字节的 SHA-256 标准 Base64 存入 `hostKeySha256`。
该字段使用公钥字节的摘要，不使用 certificate fingerprint，也不带 `SHA256:` 前缀。

使用网络 `ssh-keyscan` 取得的公钥前，必须通过可信带外渠道核验。
pin 必须对应服务端实际协商的 host-key 类型；变更算法或轮换密钥也可能造成不匹配。
发生 `host key verification failed` 时停止重试，带外确认合法轮换后才更新 pin，不能靠清空 pin 消除告警。

`AGENT_SSH_STRICT_ALGORITHMS=true` 启用现代算法 allowlist，旧服务器须先核对兼容性。
`AGENT_SSH_KEEPALIVE_SEC` 大于零时发送 keepalive，连续三次无响应后断开。
两者默认关闭，不替代 pin。

### 限额与活动会话

Gateway 默认每 `(user, agent)` 最多 3 个 session、每用户跨 Agent 最多 10 个，每用户每 60 秒最多 20 次 open。
open-rate 使用滑动窗口；超限映射为 HTTP 429 或 WS close 4429。
这些计数保存在当前 Server gateway 内存中，仅在当前实例内生效。
并发与 open-rate 数值是 gateway 默认值，没有对应公开环境变量。

`SSH_IDLE_TIMEOUT_SEC` 约束无输入/输出的空闲时长，`SSH_MAX_SESSION_SEC` 约束绝对寿命。
两者默认 `0` 关闭；生产应显式设置，绝对寿命到达后即使持续活动也会关闭。

| 接口 | 权限 / 用途 |
|---|---|
| `GET /api/admin/ssh-sessions` | `ssh_session#view`；查看当前实例活动会话 |
| `DELETE /api/admin/ssh-sessions/:sessionId` | `ssh_session#close`；强制关闭并审计 |

Settings 的活动会话视图显示 user、Agent、来源 IP 和持续时间。
多实例处置须覆盖持有连接的实例；登出、凭据轮换或证书撤销不能代替主动断开。
客户端断开、Agent 离线和超时关闭共用 session 清理路径。

### 录屏、留存与审计

`SSH_SESSION_RECORDING=true` 还需要 `NETDRIVE_ENABLED=true` 和可用 RustFS backend；
缺少 NetDrive 时记录警告，录屏保持关闭。
只录制终端输出，不直接记录输入帧，但终端回显、命令输出仍可能包含密码或其他敏感数据。

输出先在 Server 内存缓冲，session 关闭后写 asciinema v2：
`ssh-recordings/<agentId>/<sessionId>.cast`，成功上传后写 `ssh_recordings` 索引。
每 session 输出缓冲默认上限 5,000,000 bytes，超出后追加截断标记；
该上限只约束输出缓冲，不限制最终 cast 文件大小。录屏头记录终端尺寸，默认 80×24。
录屏在会话关闭后上传，进程异常退出或上传失败可能导致录屏缺失。

| 接口 | 权限 / 行为 |
|---|---|
| `GET /api/admin/ssh-recordings` | `ssh_recording#view`；metadata 列表 |
| `GET /api/admin/ssh-recordings/:agentId/:sessionId` | `ssh_recording#view`；返回 presigned cast URL |
| `DELETE /api/admin/ssh-recordings/:agentId/:sessionId` | `ssh_recording#delete`；删除对象和索引 |

Settings 可浏览、回放和删除录屏；presigned URL 本身是临时访问凭据，不写入公开日志。
`SSH_RECORDING_RETENTION_DAYS=0` 表示不自动过期；大于零时每小时清扫超期录屏。
手动删除和 retention 都清理 recording 授权关系；需关注对象、索引或投影部分失败的日志。
审计以 `ssh.session_open/close` 的 sessionId 关联录屏，并结合 `ssh.credential.*`、`ssh.recording.*`、`ssh.session.force_close` 排查。

### 配置速查

| 变量 | 组件 | 默认 / 作用 |
|---|---|---|
| `AGENT_SSH_ENABLED` | Agent | `true`；relay 总开关 |
| `AGENT_SSH_STRICT_ALGORITHMS` | Agent | `false`；算法 allowlist |
| `AGENT_SSH_KEEPALIVE_SEC` | Agent | `0`；keepalive 间隔 |
| `SSH_IDLE_TIMEOUT_SEC` | Server | `0`；空闲关闭 |
| `SSH_MAX_SESSION_SEC` | Server | `0`；绝对寿命 |
| `SSH_SESSION_RECORDING` | Server | `false`；输出录屏，依赖 NetDrive |
| `SSH_RECORDING_RETENTION_DAYS` | Server | `0`；录屏自动留存天数 |
| `SSO_SECRET_KEY` | Server | 未设置时以 `JWT_SECRET` 作为 vault wrapping key |
| `SSH_CRED_<AGENT_ID>` | Server | 仅开发 env mock，生产禁用 |
