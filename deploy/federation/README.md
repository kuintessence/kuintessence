# 联邦机构认证入口

当前只接通签名委派的额度预留，不创建或执行 Job，也没有 Fabric Adapter。完整目标与边界见[实现进展](../../docs/design/federation/progress.md)。不要将入口连通作为完整联邦验收结果。

## 认证路径

```text
远端机构 ── TLS 1.3 + 客户端证书 ── Node Gateway
                                     │ 私有 Unix socket（0600）
                                     ▼
                                Bun 接单入口
                                     │ 证书登记 + JWS 公钥登记
                                     ▼
                              PostgreSQL 原子预留
```

Gateway 使用 Node 22，强制校验客户端证书链，按实际 TLS 证书计算 SHA-256 指纹。客户端提供的身份头、Authorization、Cookie、代理头均不转发。Bun 私有入口按指纹查本地登记，验证机构签名，并在接单事务中锁定、复查信任状态。普通 Server HTTP 端口没有 `/federation/v1/delegations` 路由。

Unix socket 只允许 Server 与 Gateway 的相同系统 UID 访问。独立目录须为该 UID 所有、权限 0700；socket 为 0600。运行时拒绝公开目录和权限过宽的签名私钥。Gateway 与 Server 属于同一机构的信任边界，不能把此 socket 挂给其他机构容器。各机构使用独立目录、数据库和签名密钥。

## 本地运行与 Compose

Server 设置：

| 变量 | 值 |
| --- | --- |
| `FEDERATION_ENABLED` | `true`；默认关闭 |
| `FEDERATION_SITE_ID` | 本机构 UUID，必须与信任登记一致 |
| `FEDERATION_SIGNING_KEY_ID` | 本地登记中的签名公钥 ID |
| `FEDERATION_SIGNING_KEY_FILE` | 专用 RSA PKCS#8 PEM 私钥路径，至少 2048 位，文件 0600 |
| `FEDERATION_SOCKET_PATH` | 私有 Unix socket 绝对路径 |

Gateway 设置 `FEDERATION_TLS_CA_FILE`、`FEDERATION_TLS_CERT_FILE`、`FEDERATION_TLS_KEY_FILE`、`FEDERATION_SOCKET_PATH`、`FEDERATION_TLS_PORT`。服务端证书须含正确 DNS SAN 和 serverAuth；机构客户端证书须含 clientAuth。CA 信任与本站证书登记都要满足；仅持有某受信任 CA 签发的证书仍不能接单。JWS 私钥和 TLS 私钥分别管理，均不进入镜像、仓库或 seed。

本地构建 Gateway：

```sh
bun build packages/server/src/federation/gateway-main.ts --target=node --outfile=temp/federation-gateway.mjs
node temp/federation-gateway.mjs
```

现有完整 Compose 可叠加[入口配置](compose.ingress.yml)：

```sh
docker compose --project-directory . \
  -f deploy/compose/docker-compose.yml \
  -f deploy/federation/compose.ingress.yml up --build -d
```

宿主机设置的 `FEDERATION_SIGNING_KEY_FILE` 和三个 `FEDERATION_TLS_*_FILE` 指向部署方管理的文件。缺失变量使 Compose 直接报错。示例采用当前 Server 镜像的默认 UID；变更 UID 时须同步两端及宿主机文件所有者。Gateway 默认只发布到 `127.0.0.1:3443`；跨机构部署时明确配置 `FEDERATION_TLS_BIND`、防火墙和 TLS 直通入口。不得让 HTTP 代理终止 TLS 后伪造证书头。

此叠加文件无任何 Fabric 服务或依赖。Gateway 缺失或上游不可用时返回失败，客户端后续须使用同一个 operationId 核对/重试。当前尚无完整源站发送器、状态核对接口或 Helm 联邦配置。Docker/Compose 镜像运行尚待预览环境验证。

## 本地信任管理 API

使用现有登录认证与 `platform.manage` 权限，所有接口均在 `/api/admin/federation` 下。普通用户、提供者和运营者不会因角色名称获得信任配置权。此权限只管理基础设施信任，不授予商业合同批准权；协议审批 API 见下节，管理 UI 尚待实现。

| 方法与路径 | 内容 |
| --- | --- |
| `GET /sites?limit=50&offset=0` | 机构分页清单 |
| `POST /sites` | `{id,name,endpoint}`；endpoint 为无凭据、路径、查询的 HTTPS origin |
| `GET /sites/:siteId` | 机构详情、登记公钥和证书及其有效期/撤销状态 |
| `PUT /sites/:siteId` | `{name,endpoint}`；不能改机构 ID |
| `POST /sites/:siteId/state` | `{state: active或suspended或revoked}`；revoked 不可恢复 |
| `POST /sites/:siteId/keys` | `{keyId,publicKeyPem,allowedKinds,validFrom,validUntil}`；用途为 agreement/delegation/acceptance |
| `POST /sites/:siteId/certificates` | `{certificatePem}`；服务端计算指纹及有效期 |
| `POST /sites/:siteId/revoke` | `{keyId}` 或 `{fingerprint}`；永久撤销 |

同一证书指纹不能绑定两个机构；同一机构 keyId 不可覆盖。轮换时先登记新凭据，再切换发送方，最后撤销旧凭据。机构暂停可以恢复，撤销不可恢复。信任写入和审计记录在同一事务内，不物理删除历史登记。部署时也须登记本机构回执公钥，才能验签自己的回执。

## 当前验证证据

- Node 真实 TLS：缺证书、不受信任证书、伪造身份头、越界路径、超大请求、上游不可用。
- Bun 实际 Unix listener：权限过宽拒绝启动；私有目录/socket 权限；管理路由与机构路由隔离。
- Node mTLS → Bun Unix listener → PostgreSQL：签名委派得到可验证的 RESERVED 回执，重试不重复预留。
- PostgreSQL：证书跨机构复用、公钥撤销/过期、登记不可覆盖、信任撤销后的旧请求、审计失败回滚、管理权限。

测试文件位于 [Server federation](../../packages/server/src/federation/)。PG 测试只接受 `kuintessence_unit_*` 隔离库，测试证书和私钥临时生成并清理；不使用部署凭据。

## 协议审批 API

平台管理员通过 `GET /api/admin/federation/capabilities?orgId=...` 查询授权，或 `PUT /api/admin/federation/capabilities` 提交 `{orgId,userId,capability,enabled}`。capability 为 `agreement.read` 或 `agreement.approve`，后者包含读取权。被授权人必须是该组织的当前真人成员；自动化凭据和受限服务账号不能代表机构审批。平台管理员如需审批，也必须被显式授予该组织权限。

审批人切换到目标本地组织后，使用现有登录 session 调用：

| 方法与路径（`/api/federation/agreements`） | 用途 |
| --- | --- |
| `GET /`（不含末尾斜杠） | 本地活动组织的已签协议，支持 limit/offset |
| `GET /:revisionId` | 条款、本方签名、对方签名及本地状态 |
| `POST /approve` | `{terms,executionUserId?}`；签署不可变条款，接收方必须指定本组织受限执行账号，源方不传执行账号 |
| `POST /:revisionId/counterparty` | `{approvalJws}`；导入对方针对同一条款的签名；接收方原子建立接单协议和预算 |
| `POST /:revisionId/state` | `{state: active或suspended或revoked}`；修改本站协议状态 |

`orgId`、审批人和签名私钥不能从请求正文指定；机构 ID 来自部署配置，组织及审批人来自当前会话和数据库成员/授权校验。本站用于协议签署的登记公钥还须有 `agreement` 用途。签名密钥轮换后，旧批准仍按原 keyId 验证，不静默改写旧证据。

两端可交换返回的 `approvalJws`，分别导入对方签名。目前这一步是明确的 API 操作，尚无自动协议协商发送器或 UI。源方只记录双签，额度以接收方已安装协议为准。接收方本地暂停会阻止继续接单；源方本地暂停不证明远端运行任务已停止，跨站撤销确认尚待实现。链协调模式当前仍明确拒绝，不会降级为双边模式。
