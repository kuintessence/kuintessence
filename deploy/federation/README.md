# 联邦机构认证入口

当前已接通源站持久发送、接收方原子接单、准备后的授权入队，以及源站签名运行状态查询；本机双平台真实 Kubernetes 文件工作流已通过。另有独立的 [Fabric 证据链码与 Adapter](fabric-evidence.md)，已接通 Server outbox 和恢复 worker，并通过真实 Fabric 隐私/背书与断链恢复验证；完整作业与链联合验收仍未完成。完整目标与边界见[实现进展](../../docs/design/federation/progress.md)。不要将入口连通作为完整联邦验收结果。

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

Gateway 使用 Node 22，强制校验客户端证书链，按实际 TLS 证书计算 SHA-256 指纹。客户端提供的身份头、Authorization、Cookie、代理头均不转发。Bun 私有入口按指纹查本地登记，验证机构签名，并在接单事务中锁定、复查信任状态。网关仅转发[固定路径白名单](../../packages/server/src/federation/gateway.ts)内的机构请求，覆盖协议/商业签名交换、任务提案、委派、状态、取消、终态、用量、材料和文件传输；普通 Server HTTP 端口不挂载这些机构路由。

Unix socket 只允许 Server 与 Gateway 的相同系统 UID 访问。独立目录须为该 UID 所有、权限 0700；socket 为 0600。运行时拒绝公开目录和权限过宽的签名私钥。Gateway 与 Server 属于同一机构的信任边界，不能把此 socket 挂给其他机构容器。各机构使用独立目录、数据库和签名密钥。Linux 启动依赖 util-linux 的 flock（Server、开发及 AIO 镜像已包含）。Server 与 Fabric Adapter 在同目录的持久 .lock 文件上串行化检查、清理和绑定：仅清理本 UID 所有且连接明确被拒绝的遗留 socket；仍有监听、探测超时、普通文件、符号链接或锁异常时拒绝替换。进程退出自动释放锁，.lock 文件不能在运行中删除；跨容器共享目录使用同一文件锁，存储须支持可靠的 flock 语义。非 Linux 保留原有拒绝占用路径的行为，不自动清理。

## 本地运行与 Compose

Server 设置：

| 变量 | 值 |
| --- | --- |
| `FEDERATION_ENABLED` | `true`；默认关闭 |
| `FEDERATION_SITE_ID` | 本机构 UUID，必须与信任登记一致 |
| `FEDERATION_SIGNING_KEY_ID` | 本地登记中的签名公钥 ID |
| `FEDERATION_SIGNING_KEY_FILE` | 专用 RSA PKCS#8 PEM 私钥路径，至少 2048 位，文件 0600 |
| `FEDERATION_CASE_TRUST_FILE` | 可选，案件链公开信任配置的绝对路径；启用[独立存证审批](fabric-cases.md#平台独立存证审批)，仅此项不会投递上链 |
| `FEDERATION_CASE_SOCKET_PATH` | 可选，本机构独立 case Adapter 的私有 Unix socket；须同时配置案件信任，启用[持久投递与私有收据](fabric-cases.md#server-持久投递与私有收据) |
| `FEDERATION_SOCKET_PATH` | 私有 Unix socket 绝对路径 |
| `FEDERATION_RESULT_DOWNLOAD_ORIGINS` | 本机构存储的 HTTPS origin，逗号分隔；用于结果下载和本端上传地址验证，默认空 |
| `FEDERATION_INPUT_DOWNLOAD_ORIGINS` | 本机构输入文件存储的 HTTPS origin，逗号分隔；独立于结果授权，默认空（关闭） |
| `FEDERATION_INPUT_IMPORT_SOURCE_ORIGINS` | 接收输入文件允许访问的源站存储 HTTPS origin，逗号分隔；独立于本地/结果存储配置，默认空（不发输入搬运凭据） |
| `FEDERATION_RESULT_IMPORT_SOURCE_ORIGINS` | 导入结果允许访问的对端存储 HTTPS origin，逗号分隔；默认空，不启用 Agent 结果传输服务 |
| `FEDERATION_MEDIA_OBJECT_DOWNLOAD_ORIGINS` | 本站任务介质源对象的 HTTPS origin，逗号分隔，默认空（不启用对象导出）；Compose 已透传，不能代替 Agent 本地允许清单 |
| `FEDERATION_MEDIA_AGE_DIRECTORY` | 可选，来源介质包使用的固定版本官方 age 工具绝对目录；须与 wrapping key 同时配置 |
| `FEDERATION_MEDIA_WRAPPING_KEY` | 可选，来源包私钥托管的独立高熵密钥，至少 32 字符，不得复用 JWT/SSO 密钥；需安全备份 |

介质来源准备接口只生成签名清单和托管密钥，不自动复制文件或发放私钥；工具版本、数据披露授权要求及未完成边界见[介质包说明](../../docs/design/federation/media-package.md)。当前 Compose 叠加文件未挂载 age 工具或配置其密钥，启用时须由部署方单独注入。

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

此叠加文件无任何 Fabric 服务或依赖。Gateway 缺失或上游不可用时返回失败，客户端后续须使用同一个 operationId 核对/重试。源站发送器和按需签名状态查询已接通，启用方式见下节；完整 Helm 联邦配置、Docker/Compose 镜像运行尚待预览环境验证。

## 源站发送与状态查询

Server 另行配置 `FEDERATION_CLIENT_CERT_FILE`、`FEDERATION_CLIENT_KEY_FILE`、`FEDERATION_CLIENT_CA_FILE` 三个绝对路径，必须同时提供。客户端私钥由 Server UID 持有，权限 0600；客户端证书须在对端按机构登记。Compose 入口叠加文件当前仅配置接收入站，源站部署须额外将上述文件只读挂载给 Server 并设置容器内路径；不复用 Agent 凭据。

平台管理员为活动组织成员显式分配 `delegation.submit` 或 `delegation.read`，前者包含读取权。两端登记原协议/模板/材料，交换同一条款的签名后，源站使用人类登录 session 调用：

| 方法与完整路径 | 用途 |
| --- | --- |
| `POST /api/federation/outbound` | 提交签名委派原字段，202 表示已持久入队 |
| `GET /api/federation/outbound` | 组织内出站操作分页清单，accepted 仅表示可信接单 |
| `POST /api/federation/outbound/:operationId/retry` | 按原操作/JWS 重试，并确认采用同一对端当前登记端点 |
| `GET /api/federation/outbound/:operationId/remote-status` | 按需取得签名准备/运行状态，响应含观测时间及验签时间 |
| `GET /api/federation/outbound/:operationId/results` | 查看协议允许的签名结果清单，尚不传输文件 |
| `POST /api/federation/outbound/:operationId/result-imports` | `{importId: UUID}`，持久保存整份结果导入意图，202 仅表示排队 |
| `GET /api/federation/outbound/:operationId/result-imports/:importId` | 查询自己提交的导入及文件成员状态 |
| `POST /api/federation/outbound/:operationId/result-imports/:importId/cancel` | 保存取消和清理责任，不代表实际清理完成 |
| `POST /api/federation/outbound/:operationId/cancel` | 持久请求停止，202 不代表已经停止 |
| `POST /api/federation/outbound/:operationId/cancel-retry` | 修复信任/端点后明确重试同一停止意图 |

签名状态查询须为源端密钥登记 `status-query`、接收端密钥登记 `status-report` 用途；旧记录不自动扩权，按新 keyId 轮换并保留历史验证所需密钥。每次查询使用独立 challenge 和一分钟有效期，绑定原任务/预留/摘要，不返回结果正文或内部账号。当前组织读取权和机构信任必须有效；原协议到期不阻止历史状态核对。网络不通返回明确错误，不将接单等同于完成。

取消须为源/接收签名密钥分别登记 `cancellation`/`cancellation-receipt` 用途，并授予操作者 `delegation.cancel`（submit 包含 cancel，cancel 包含 read）。原接单状态与 cancellation 分别展示；只有 cancellation.state=stopped 才表示已确认停止。接单未知也可取消，接收方永久阻止迟到委派；在途接单仍保留，预算不自动释放。停止意图不因操作者随后离职而丢弃，机构信任异常需人工核对。

结果清单需要双方新签协议的 `resultPolicy`（持久文件范围、总文件数/字节数上限及结果披露截止时间）、源站用户的独立 `result.read` 权限，以及两端密钥分别登记 `result-query`/`result-report` 用途。没有结果条款的旧协议拒绝开放；普通委派读取权不允许读取结果清单。暂时只返回已完成运行的 Persistent File/FileBatch 元数据和 SHA-256，清单签名不等于文件已经传回，不生成下载链接。详见[结果清单契约](../../docs/design/federation/implementation.md#签名结果清单)。

机构下载授权使用独立 `/federation/v1/result-downloads`，仍须相同结果条款和当前权限。源/接收密钥分别新增 `result-download-query`/`result-download-grant` 用途，旧密钥不自动扩权。接收方须启用 NetDrive，并将其预签名 HTTPS 公网地址的 origin 配入 `FEDERATION_RESULT_DOWNLOAD_ORIGINS`，例如 `https://storage.example.org:9443`。Compose 叠加文件已传递该变量；HTTP 地址、路径、凭据、query 和 fragment 均不接受。无需为 direct 模式配置 Fabric。

输入文件授权使用独立 `/federation/v1/input-downloads`。源站启用 NetDrive，并配置 `FEDERATION_INPUT_DOWNLOAD_ORIGINS`；Compose 叠加文件已传递该变量，其他部署可通过 Server 环境变量设置。接收机构密钥须登记 `input-download-query`，源站密钥须登记 `input-download-grant`；旧信任记录不自动扩权。双方协议必须批准 `inputPolicy`，委派必须绑定 `inputFilesDigest` 与源站 invocation 快照，单有普通材料/结果读取权不能下载输入。

签名地址绑定具体文件与传输尝试，最多有效 30 秒，并受原任务、查询与签名密钥期限限制。Server 只查对象元数据并生成固定 versionId 的地址，不中转文件内容。短期 URL 是 bearer 凭据，禁止存入普通日志、数据库或清单；撤权后不再续发，已经签发的地址可能持续有效至短期期限，不保证即时收回。

新云盘上传使用 `netdrive/objects/<随机 UUID>`，归属仍由数据库与上传 token 校验。旧 `netdrive/<用户 UUID>/...` 路径在本平台仍可正常访问，但输入跨站下载目前拒绝，避免 URL 暴露真实账号标识；后续须补受管匿名副本转换，不能直接修改活动快照。结果导入生成的随机 `federation-results/<UUID>/<UUID>` 对象也可作为输入来源。接收端准备后台已保存任务私有输入清单并按原执行服务账号预留统一云盘空间，重复获取不重复占用；未开始的导入在取消/授权失效后释放预留。搬运/校验已接通生产 Agent 通道和后台扫描，受管副本映射仍待接通，以上配置不等于已完成文件输入端到端验收。


每个下载凭据最多 30 秒，并受协议结果截止时间限制；同时核对实际 S3 SigV4 的过期时间，支持时固定对象 versionId。地址及签名响应含 bearer 凭据，仅交给受信任的搬运组件，不写日志、数据库或普通清单响应。已发预签名地址无法即时撤销，撤权阻止续发；已建立的 S3 响应不保证在地址过期瞬间断开，受管 Agent 会按授权截止时间取消连接。需要逐字节即时撤权的部署不能把此通道当作满足该要求。

结果导入 API 已接入持久状态与自动传输 worker，提交先返回 pending。读取及首次提交需要独立 `result.read`，自己的已提交导入可在失去该权限后请求停止；取消 ID 不重启，重新授权导入使用新 ID。全部成员验证并原子发布后才返回 available 和成员 fileId。详见[持久导入契约](../../docs/design/federation/implementation.md#持久结果导入与传输尝试)。

源站已实现当前组织授权、发出签名下载请求、验签、对象/尝试绑定及返回前重新授权的内部方法；已连接生产持久传输任务与 AgentStream；短期搬运地址不通过普通用户 REST 接口返回。完整交付须同时检查本地发布与回执状态。

出站、状态、取消与结果清单接口不依赖 Fabric。额度尚未接通结算释放；源站结果交付已接通；后台状态同步、普通 Workflow 自动委派和已接单端点迁移仍待完成。详细契约见[实现说明](../../docs/design/federation/implementation.md#源站持久发送)。

## 本地信任管理 API

使用现有登录认证与 `platform.manage` 权限，所有接口均在 `/api/admin/federation` 下。普通用户、提供者和运营者不会因角色名称获得信任配置权。此权限只管理基础设施信任，不授予商业合同批准权；协议审批 API 见下节。平台管理员可在“平台安全 → 联邦信任”完成下表中的信任登记与维护，移动端只读；业务协议管理 UI 仍待完成。公钥用途按需逐项选择，页面不上传或生成私钥。

| 方法与路径 | 内容 |
| --- | --- |
| `GET /sites?limit=50&offset=0` | 机构分页清单 |
| `POST /sites` | `{id,name,endpoint}`；endpoint 为无凭据、路径、查询的 HTTPS origin |
| `GET /sites/:siteId` | 机构详情、登记公钥和证书及其有效期/撤销状态 |
| `PUT /sites/:siteId` | `{name,endpoint}`；不能改机构 ID |
| `POST /sites/:siteId/state` | `{state: active或suspended或revoked}`；revoked 不可恢复 |
| `POST /sites/:siteId/keys` | `{keyId,publicKeyPem,allowedKinds,validFrom,validUntil}`；用途为 agreement/delegation/acceptance/evidence-batch/status-query/status-report/cancellation/cancellation-receipt/result-query/result-report/result-download-query/result-download-grant/result-receipt/result-receipt-ack/material-query/material-chunk/input-download-query/input-download-grant |
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

平台管理员可在“平台安全 → 联邦权限”按组织查看、授予或撤销业务权限。组织按名称搜索，成员按姓名或邮箱搜索；候选人仅限该组织当前未停用的真人成员，手机只读。权限逐项授予；批准协议包含查看协议、管理映射包含查看材料、提交委派包含查看和取消委派、取消委派包含查看委派。撤销一项直接授权不保证其他授权不再包含同一能力，也不等于运行任务已经停止。

平台管理员通过 `GET /api/admin/federation/capabilities?orgId=...` 查询授权，或 `PUT /api/admin/federation/capabilities` 提交 `{orgId,userId,capability,enabled}`。审批相关 capability 为 `agreement.read` 或 `agreement.approve`，后者包含读取权。被授权人必须是该组织的当前真人成员；自动化凭据和受限服务账号不能代表机构审批。平台管理员如需审批，也必须被显式授予该组织权限。

管理员新增只读入口 `GET /api/admin/federation/capabilities/members?orgId=...&search=...&limit=20&offset=0`，返回 `data/hasMore`，便于选择当前符合条件的成员；授权列表额外返回姓名、邮箱和成员/账号有效性，历史无效授权仍可显式撤销。平台成员管理 API 移除成员时，在同一事务删除该组织的联邦授权、写入权限投影待办和记录包含被撤销能力的审计；之后重新加入须重新授予，不影响其他组织授权。老版本留下的无效授权仍须在此页清理，不能直接改数据库代替业务操作。

`GET /api/federation/capabilities` 返回当前真人会话在活动组织的 `orgId/userId/grants/effectiveCapabilities`；不接收用户或组织参数，不因平台角色自动增加权限。不存在成员关系、已停用或服务账号均拒绝；自动化请求不允许。此接口和管理列表均为 no-store。返回值只是权限视图，不能代替具体写入/执行接口的实时授权检查，也不表示联邦部署或 Fabric 已就绪。

审批人切换到目标本地组织后，使用现有登录 session 调用：

| 方法与路径（`/api/federation/agreements`） | 用途 |
| --- | --- |
| `GET /`（不含末尾斜杠） | 本地活动组织的已签协议，支持 limit/offset |
| `GET /:revisionId` | 条款、本方签名、对方签名及本地状态 |
| `POST /approve` | `{terms,executionUserId?}`；签署不可变条款，接收方必须指定本组织受限执行账号，源方不传执行账号 |
| `POST /:revisionId/counterparty` | `{approvalJws}`；导入对方针对同一条款的签名；接收方原子建立接单协议和预算 |
| `POST /:revisionId/state` | `{state: active或suspended或revoked}`；修改本站协议状态 |

`orgId`、审批人和签名私钥不能从请求正文指定；机构 ID 来自部署配置，组织及审批人来自当前会话和数据库成员/授权校验。本站用于协议签署的登记公钥还须有 `agreement` 用途。签名密钥轮换后，旧批准仍按原 keyId 验证，不静默改写旧证据。

两端可交换返回的 `approvalJws`，分别导入对方签名。目前这一步是明确的 API 操作，尚无自动协议协商发送器或 UI。源方记录双签，并在实际出站提交时预留本地预算；接收方仍按自己已安装的协议独立检查和预留额度。接收方本地暂停会阻止继续接单；源方本地暂停不证明远端运行任务已停止，跨站停止须显式调用下述源站 cancel 接口，并取得独立 stopped 确认。链协调模式当前仍明确拒绝，不会降级为双边模式。

## 资源映射和材料准备

管理员可以为组织成员分配 `asset.read`、`asset.map`，后者包含读取权，仍不自动授予本地软件或数据的使用权。以下入口均要求人类登录会话，并只作用于活动组织：

| 方法与完整路径 | 内容 |
| --- | --- |
| `GET /api/federation/assets/mappings` | 映射清单，支持 limit/offset |
| `POST /api/federation/assets/mappings` | `{reference,localRevisionId}`；来源 ref 包含 originSiteId/kind/id/revision/digest |
| `POST /api/federation/assets/mappings/:id/revoke` | 永久撤销映射，不改写旧版本 |
| `POST /api/federation/assets/materials` | `{originSiteId,content}`；保存 inputs 或 environment-lock 清单，返回摘要 |
| `GET /api/federation/assets/materials/:originSiteId/:digest` | 在本地组织范围读取并验证摘要 |
| `GET /api/federation/assets/reservations/:id/plan` | 只读转换为本地工作流，要求 agreement.read、asset.read 及操作者自己的资源查看权；仅启用联邦时注册 |
| `GET /api/federation/agreements/:revisionId/reservations` | 接收方协议的预留与准备状态、阻断原因、更新时间，要求 agreement.read |

软件、脚本、工作流、用例分别映射到本地 `software_asset_revisions.id`；数据集映射到 `data_asset_versions.id`，不接受可变的 latest 或最新版本跟随。普通映射登记不能覆盖已有来源机构/资源/版本组合，即使替换版本恰有相同内容，也必须明确采用新的来源 revision。

软件类 ref.digest 是 SHA-256(`federationCanonicalJson(software_asset_revisions.payload)`)；该函数按确定的键顺序编码 JSON，保留数组顺序，拒绝非 JSON 值及超过 32 层/一 MiB 的材料。它仅服务于联邦材料，不修改旧生态包签名和 JWS 原字节签名。数据集 ref.digest 采用现有不可变版本的 manifestDigest，数据位置与使用授权仍由 Data Market 检查；真正的文件字节验证在后续传输/执行时进行。

输入清单含 `protocolVersion:1, kind:inputs, parameters, datasets, bindings`，datasets 每项为 `{descriptor,asset,selectedEntries,targetPath?}`，bindings 每项为 `{sourceRevisionId?,sourceSelector?,asset}`，至少提供一种来源标识。sourceSelector 使用现有工作流的 `{source,name,version,providerOrgId?}`；同一种资源的 selector 不可重复绑定，不查询 latest。原 UUID 格式继续有效。转换仅处理 DSL 中的类型化引用，不替换脚本、参数或文本中的 UUID。

环境锁清单含 `protocolVersion:1, kind:environment-lock, target:{platform,architecture}, nativeLockDigest, software, sandboxRuntime?, runtimeBindings?`；software 每项为 `{asset,concreteSpec,dagHash}`，sandboxRuntime 为 `{kind:OCI或SIF,digest}`。当前只存储/解析这些引用，native lock 文件、真实目标环境和安装材料验证仍待接通，不能据此声称支持完整离线安装。

启用联邦后，引用 worker 每十秒检查一批，每批最多八条预留，等待/阻断项至少间隔三十秒重试。准备状态为 `waiting`、`blocked`、`resolved`，无记录表示尚未处理。查询会返回更新时间；resolved 是引用快照，不是环境已装好或已批准运行。缺输入清单、映射或可用数据位置不会创建占位 Job。协议/签名租期过期后不会自动延长授权，跨站续租仍待实现。

## 工作流转换检查

`GET /api/federation/assets/reservations/:id/plan` 重新验证接收方协议、委派签名/租期、受限执行账号和所有资源映射。操作者须具有本组织协议与材料读取权限，并独立通过每项资源的查看授权；不能借用执行账号的权限读出模板。接口返回 `workflow`、`workflowVersions`、原 template 引用和输入/环境清单摘要，`executionReady` 固定为 false，不创建工作流、Job 或更新预留状态。

转换支持 UUID/命名用例与软件引用、固定脚本版本、内联脚本、循环、内联和 ByVersion 子工作流、参数及 Dataset 输入。ByVersion 转换后的 ID 属于本地软件资产修订，须从返回的 `workflowVersions` 解析，不能拿它查询普通工作流版本表。自引用保持版本引用，由原引擎 maxDepth 控制执行，不无限展开定义。Dataset 的 descriptor 在整张图中表示同一份签名输入选择；同名槽复用该选择，无消费槽的输入会拒绝。

来源 runtimeProfileId 不能直接使用，可在 environment-lock 的 `runtimeBindings` 中提供 `{sourceProfileId,contract:{name,version}}`，转换为由接收方配置的运行环境契约。仍必须声明 sandboxRuntime 摘要；真实 Agent 的运行环境绑定和摘要检查属于后续派发门禁，不能用这一步替代。

不兼容的模板返回 HTTP 409：`{error:{code:TEMPLATE_NOT_PORTABLE,path,reason}}`。原站队列、执行账号映射、站点/集群/输出存储 ID、静态文件/文本记录 ID、未声明参数、缺失版本映射、已有执行器不支持的 Milestone/Command Reduce 均明确拒绝。文件型输入暂只接受上游文件输出，拒绝参数/CEL 输入及单脚本外部文件输入；完整受管文件交付和运行时 provenance 检查待接通。模板的 skipStaticValidation 不能绕过接收方校验。

这仍是输入转换检查：用例内部 packageId/packageRevisionId、软件 providerOrgId 等来源本地引用的完整可移植导入、用例命名空间/许可证检查、native lock 和安装材料、目标环境校验及真正派发尚待连接。不得把转换结果直接作为 trusted materialization 提交 Job；既有包、软件许可、数据授权和可信生态验证仍然必须执行。

## 固定安装的 Agent 兼容性

内部工作流执行 intent 现可携带 Spack pin（DAG、材料发布与锁文件摘要、引擎版本、目标三元组）。Server 只向通过 mTLS 验证且声明 `spack_pinned_execution_v1` 的 Agent 派发，重连重放也重新检查。Agent 使用材料 v2 的受管安装，并复用现有 worker 对实际环境进行校验和加载；不能改用普通宿主 Spack 或同名软件。

带 pin 的 Job 命令为不可直接运行科学软件的 `exit 126` 占位，只有新 Agent 完整检查 pin 后才生成实际命令；旧工作流的 `exit 125` 行为保留。应同时升级 Server 和 Agent：旧 Agent 不执行带 pin 的任务，连接降级时已持久化指令保持等待，不删除 pin 重试。

目前联邦环境清单还没有接通该内部 pin 的构造与自动安装绑定。这项能力不意味着 native lock 已导入、联邦任务可执行，或已有一次真实离线安装验收。

结果存储协调器已挂入生产后台。存储角色需要 `s3:GetObjectVersion` 读取 netdrive、federation-results 与 federation-inputs 固定版本，并需要仅限 `federation-results/*`、`federation-inputs/*` 的 `s3:ListBucketMultipartUploads`、`s3:ListBucketVersions` 及 `s3:DeleteObjectVersion`。仓库 RustFS 和 Helm 初始化脚本已同步更新；外部 S3 需由存储管理员配置等效权限。已有部署须重新应用初始化策略（外部 S3 更新等效 IAM），单独升级 Server 不会补齐输入目录权限。不要扩大普通云盘历史版本的删除权限或取消不可变存储的显式删除拒绝。真实 RustFS 已验证该边界，不能据此假定所有兼容 S3 实现均具有相同策略行为。

Agent 输入搬运独立默认关闭。可向接收端 Agent 进程注入 `AGENT_FEDERATION_INPUT_COPY='{"stagingRoot":"/var/lib/kq/input-staging","maxStagingBytes":1073741824,"allowedSourceOrigins":["https://source-storage.example.org"],"allowedDestinationOrigins":["https://receiver-storage.example.org"]}'`；目录须归 Agent 独占（0700、无符号链接），地址与 Server 的输入 origins 对应，使用 Agent 实际可访问的 HTTPS 域名。输入和结果客户端共用一个传输槽，限制同时暂存/读写的文件数；原结果配置不会自动开启输入搬运。Server 与 Agent 同步升级后才能协商输入复制和目的校验能力，要求 mTLS。两端 Server 的协议/材料/签名信任和存储权限仍须配置。

输入后台每 10 秒扫描，成员至少间隔 30 秒尝试派发，单轮至多使用 4 个不同 Agent；重连/到期未完成的传输先清理旧代次再重传。整单发布和 Workflow 文件映射已接通；开启输入搬运不会让缺少模板映射或本地授权的任务直接运行。停用输入配置不阻止遗留清理。

Agent 结果搬运配置默认关闭。`AGENT_FEDERATION_RESULT_COPY` 是 JSON，例如 `{"stagingRoot":"/var/lib/kq/result-staging","maxStagingBytes":1073741824,"allowedSourceOrigins":["https://remote-storage.example.org"],"allowedDestinationOrigins":["https://local-storage.example.org"]}`。暂存路径须是 Agent 用户独占的绝对目录（0700，无符号链接），需要完整单文件空间；容量是文件上限，不是已验证支持 TB 级搬运。当前运行结果不跨进程续传。双方服务都需升级以协商复制与目的校验两项能力；仅支持复制的旧 Agent 不领取新任务，Agent 到 Server 必须通过 mTLS；缺失任一条件不派发。

### 纯介质任务接收

介质文件已在接收 Agent 的私有导入目录时，不需要配置远端对象下载地址。Server 保留联邦、签名/mTLS、介质导入和本地对象存储配置；按方向设置 `FEDERATION_INPUT_DOWNLOAD_ORIGINS` / `FEDERATION_RESULT_DOWNLOAD_ORIGINS` 为本地存储的 HTTPS origin，对应 `FEDERATION_INPUT_IMPORT_SOURCE_ORIGINS` / `FEDERATION_RESULT_IMPORT_SOURCE_ORIGINS` 可以为空。控制面仍须能联系来源机构重新核对授权，介质交付不等于完全离线执行。

Agent 继续配置 `AGENT_FEDERATION_MEDIA_IMPORT`、受管根目录及原输入/结果传输设置；将 `allowedSourceOrigins` 留空或省略，例如：

```json
{
  "stagingRoot": "/var/lib/kq/input-staging",
  "maxStagingBytes": 1073741824,
  "allowedSourceOrigins": [],
  "allowedDestinationOrigins": ["https://receiver-storage.example.org"]
}
```

将该 JSON 用于 `AGENT_FEDERATION_INPUT_COPY`；结果方向使用 `AGENT_FEDERATION_RESULT_COPY` 并为其选择独立暂存目录。没有 source origins 时只声明目标校验能力，不能领取网络复制任务；目标上传和校验仍必须使用配置的 HTTPS origin。暂存配置保留原格式，介质上传直接读取私有导入文件，不新增整份明文暂存。来源仍需按来源导出配置读取原始对象并生成加密包。

新 Agent 显式声明 `federation_target_transfer_v1`，支持独立的目标校验协商。Server 不给旧 Agent 派发仅有目标配置的介质任务；原网络配置完整时，新旧版本继续按原复制＋校验能力协商。旧 Server 不认识独立能力时，纯介质 Agent 保持不派发，不用伪造来源地址开启功能。


Server 已接结果传输服务、Agent RPC 与自动扫描。配置上述值并具备有效双边授权和可用 Agent 后，后台会处理 pending 导入，依次完成搬运、目的字节验证、整单发布及签名回执发送；以导入详情的实际状态为准，HTTP 202 不表示已交付。

目的校验需要上述固定版本 GET 权限，分片完成后保存对象 ETag 与可用的 versionId，再由 Agent 实际读取字节。开启 versioning 的存储可固定读取已组装版本；未开启时使用 If-Match 和 SHA-256，不提供历史版本保留保证。Agent 需要能访问本端预签名 HTTPS 地址，校验读取不经 Server 中转、不占完整文件暂存空间。目前 verified 只代表传输完整性，不代表已登记云盘副本或已签收/结算。

结果导入先预留整份清单的用户云盘额度，与普通上传提交共享事务锁。取消后须等残留清理完成才释放额度，清理失败时不能靠重试抢占新空间。迁移 0101、0102 分别新增预留字段与云盘对象版本字段；普通上传和分片提交保存版本，后续下载不随同 key 覆盖切换对象。

结果整单发布要求目的 bucket 已启用版本管理且 HEAD 返回真实 versionId（不能是 null）。服务按固定版本登记云盘文件；不满足时拒绝发布，不能降级读取最新同名对象。发布会重新向对端验签相同清单，并在 30 秒内提交本地全部文件与额度转换；网络调用不持有数据库锁。重复请求不会重复登记，路径冲突拒绝整单。自动 worker 和对端回执已接通；available 仅表示本地文件登记，须分别查看 receipt.pending/recorded，不把它当作科学验收或结算。

回执协议要求源站签名密钥显式具有 result-receipt 用途，接收方具有 result-receipt-ack 用途；通过已有机构密钥管理登记，旧配置不自动扩权。回执发送沿用机构 mTLS 客户端，不需要存储连接保持可用。后台错误只保存脱敏错误码，30 秒后重试；重复回执返回原确认，不重复登记或复制文件。披露过期之后可以补送已经完成发布的历史回执，但当前机构和密钥信任仍须有效。新建导入不能绕过结果披露期限。

存储初始化现在默认对 NETDRIVE_BUCKET 启用版本管理，Docker 与 Helm 脚本一致。已有部署须重新执行初始化或由存储管理员启用；已经写成无版本的对象不会自动获得新版本，旧的未发布导入应取消并重新导入。不要设置会删除仍被云盘记录引用的历史版本的自动过期规则；用户逻辑删除与物理历史版本回收是不同操作，当前云盘配额按已发布文件及导入预留计量，不代表存储后端实际占用。

源站签名密钥轮换后，可由拥有该导入且具有 result.read 的用户调用 POST /api/federation/outbound/:operationId/result-imports/:importId/receipt-retry。它保留收到时间与原正文，仅允许后台采用当前密钥重新签署；已获确认的回执不重开。接收方切换密钥后，会为原登记事实重签确认，保持原 recordedAt 与回执摘要，避免返回已经撤销密钥签署的旧确认。


### 接收端输入凭据

接收方需要单独配置 FEDERATION_INPUT_IMPORT_SOURCE_ORIGINS（对端源存储）与 FEDERATION_INPUT_DOWNLOAD_ORIGINS（本地目标存储），Compose 叠加文件已传递两项变量。两者默认空，不从结果传输设置继承。缺少配置时，清单准备和已有尝试清理仍可进行，但不发输入搬运凭据。

内部 input-reader 使用接收机构的 input-download-query 专用密钥请求源站 /federation/v1/input-downloads，核对 source 的 input-download-grant 专用签名。请求和响应同时绑定已接受委派、原清单成员、接收方当前 transferId/generation 和 Agent 租约；不能仅凭源站签名跳过本地活动尝试。响应返回前再次持锁检查接收身份、协议、Agent、源站地址与双方当前密钥用途。URL 必须属于允许的源站 HTTPS origin，带唯一真实 versionId，实际 S3 凭据与签名信封的期限一致且最多 30 秒，不越过查询、任务、当前尝试或签名密钥期限。

上传地址绑定当前接收方 multipart uploadId/partNumber、固定分片大小及目标 origin，签发后复查当前授权和尝试。地址与 JWS 不进入持久记录或审计；已发地址有剩余短期有效窗口。输入 Agent 消息、能力协商、自动派发和整单发布已接入。全部文件校验后由后台复查固定版本及源站授权，在原执行账号下登记本地文件；失败至少 30 秒后重试。取消先隐藏原文件并保留清理额度，等执行停止、传输租约到期及对象清理确认后释放。Workflow 文件映射已接入：源端 File 槽走签名导出，接收端在全部发布后按原执行身份读取固定版本，并在创建/恢复/派发时复查。还须批准远端模板映射、执行账号及软件/沙箱/队列策略；输入未齐全时继续 DATA_WAITING。真实双平台小文件输入、两个 Script、结果回传及源站强制重启恢复已通过（同机隔离 Kubernetes、独立数据库与存储）；未覆盖 Spack/Slurm/PBS/Fabric 联合运行，启用配置不代表完整交付已验收。


### 输入存储未知请求的运维核对

页面入口为“平台安全 → 输入存储核对”，要求平台管理员，手机只读。列表最多展示 100 条未知请求，可输入代次 UUID 查询已不在列表中的请求。先按以下步骤实际完成运维隔离/排空，再在页面填写工单号、证据摘要与本地停止时间，逐项确认并登记。登记结果显示审计人及时间；通过刷新查看后台清理状态，不能把“已登记声明”当作清理完成。快照变化后必须重新核对并填写。

输入创建上传或合并的请求结果未知，且始终没有 uploadId/对象的正向证据时，默认继续占用原清单预留。管理员可使用以下本地平台 API（正常登录鉴权，要求 platform manage；机构 mTLS 入口不开放）：

- `GET /api/admin/federation/input-reconciliation?limit=50`：待核对代次。
- `GET /api/admin/federation/input-reconciliation/:generation`：原站点、清单、对象 key、请求时间、租约、状态与 snapshotDigest。
- `POST /api/admin/federation/input-reconciliation/:generation`：登记运维停止声明，返回 202。不会直接删除数据、释放配额或伪造上传/合并成功记录。

操作顺序：

1. 取消原委派，确认接收端 Workflow/全部 Job 已停止，相关取消和撤权回执已确认，等待原传输租约到期。由于存储未收尾，远端取消总回执仍可能 pending，不能要求它先变 stopped。
2. 对原尝试的所有写入者做运维隔离：停止原 Server/Agent 进程与在途回调，禁用相关派发；必要时撤销旧存储凭据或在存储侧永久禁止原 key 的新写入。与存储管理员确认已受理的创建/合并请求也已处理结束，不能只凭重启 Server、断网、单次 HEAD 或空列表推断。保留重启/隔离、存储排空的核查证据。可启动干净的管理进程保留清理权限；不恢复原代次写入。
3. 重新读取快照。保存工单号、完整证据文件的 SHA-256，以及完成上述隔离和存储排空的 stoppedAt。使用返回的 snapshotDigest 提交：

```json
{
  "snapshotDigest": "sha256:<GET 返回的 64 位摘要>",
  "stoppedAt": "2026-11-07T08:00:00.000Z",
  "incidentId": "storage-maintenance-42",
  "evidenceDigest": "sha256:<核查材料的 64 位摘要>",
  "allWritersStopped": true,
  "storageRequestsDrained": true
}
```

4. 后台使用既有存储权限清理该代次的精确 key（全部 multipart、版本和删除标记），确认无残留后才标记 cleaned 并释放清单预留。失败保留记录与配额、继续重试；检查原导入 cancelled/reservedBytes=0 和取消回执，不把 POST 202 当完成。

这是受信任平台管理员对外部运维事实的声明，软件不能独立核验工单内容或证明外部存储已排空；无法取得可信停止依据时不得提交。SHA-256 用于关联核查材料，不使声明自动成为存储证明。API 不接收口令、预签名 URL 或证据正文。决定与审计原子保存，重复提交相同正文幂等；状态快照变化、未取消、租约未到期、运行未停止或服务身份均拒绝。迟到的上传/合并事实在实际清理提交前使原决定及清理 token 失效，要求重新核对。原 key 永不复用；不得在清理后恢复旧写入进程或撤销原 key 的隔离。

迁移 0113 增加独立 reconciliation 字段。此入口仅处理接收端输入的未知分配/合并，不是结果导入、普通云盘或账单额度的通用强制释放接口；Web 已通过平台安全的“输入存储核对”页签接入。


### 在页面签署双边合作协议

进入资源区“机构合作”，选择本次签约所属机构。平台管理员先在联邦权限页为该机构的指定成员授予 agreement.approve；只读人员授予 agreement.read。平台管理角色不自动取得代签权。本站须配置联邦签名身份，双方机构/公钥须已登记且允许 agreement 用途。

1. 双方约定同一份符合 FederationAgreementSchema 的 JSON（见共享协议定义），包含站点、有效期、额度、允许模板和资源、文件传输政策及合同材料摘要。协议版本不可改写，改变条款须用新版本。当前页面可导入文件或粘贴 JSON，完整可视化合同编辑器尚未提供。
2. 导入后核对摘要与完整条款。接收方选择本机构有效的受限执行账户；必须预先建好该账户、队列/沙箱及相应使用授权，页面不替代这些配置。委派方无需执行账户。
3. 明确确认签署，复制本方 JWS，经双方认可的受控通道交换；在各自协议详情粘贴对方 JWS，点击“验证并导入对方签名”。Server 核验机构、完整条款和实时授权后，接收方安装约定额度。普通文件内容或未经验证的签名不能激活协议。
4. 查看双方签名与本地状态。直接合作无需链；异步存证须另行配置 Adapter，链故障不阻塞合作；链上协调当前拒绝签署。启用还受有效期、信任、材料、执行身份和本地资源策略约束，不代表可以任意执行脚本。
5. 本地暂停可恢复，永久撤销不可恢复。两者不证明远端运行已停止，需要取消任务并核对回执。手机端只读。

切换机构或登录身份后，旧草稿和签署确认失效，须在新上下文重新核对；失败会保留原输入以便核查和重试。不要把此页面接通视为完整联邦、真实调度器或 Fabric 联合验收完成。


### 私有合同与用量链码

独立 kq-commercial 的机构 PDC、双签、原生双方背书及不可变用量/更正已接通并经过真实 Fabric 检查，见[商业链码配置与边界](fabric-commercial.md)。当前业务协议页面尚不提交商业链码，商业 Adapter、市场 gate、账单与结算继续开发；不会因登记了私有合同就放开链协调作业执行。


## 已批准执行协议的自动签名交换

迁移 0136 增加按站点与执行协议 revision 的持久交换进度。双方仍各自用本组织当前人工 `agreement.approve` 批准完全相同的条款；提供方在批准时自行选定受限执行账户。后台只交换已存在的原 `agreement` JWS，不代签对方、不替另一机构挑选账户，也不自动批准新合同或任务。直接合作、异步存证和链上协调都可使用；原人工 `counterparty` 导入入口继续保留。

启用条件为原联邦签名配置、源站 TLS 发送配置及双方的机构信任登记。查询方当前签名密钥须明确允许 `agreement-approval-query`；接收方用于尚未批准响应的密钥须允许 `agreement-approval-waiting`；原协议签名密钥继续要求 `agreement`。新增用途仅用于机构传输，不加入 Fabric 商业签名治理。已有密钥不会自动扩权；目前用途目录共 34 项，部署只选择实际需要的项。

固定私有入口为 `POST /federation/v1/agreement-approvals`，只接受 `application/jose`，证书指纹来自 Node Gateway；普通 Server HTTP 端口不暴露此路由。查询绑定双方、revision、原字节摘要、随机 queryId 和至多一分钟期限。未批准时返回不含正文或签名的专用等待回执；已批准时直接返回原协议 JWS，保持原 256 KiB 正文/512 KiB JOSE 限额，不嵌套第二层大信封。第三方机构、错摘要/正文、失效证书/签名用途及网络期间端点变化均拒绝。

后台取得对签后复用人工安装路径：双签、协议状态、当前信任、组织与执行身份均重新核对；协调模式还要求相同组织的原商业合同双签。对签落库、接收方执行同意安装、必要的双边预算、机器审计和交换 complete 在同一事务提交，失败全部回滚。直接/异步存证合作只在接收方创建一次原预算，不增加链依赖；协调模式不创建可花费的本地预算，也不据此取得执行 gate 或放行作业。

授权人的后续个人角色变化不会撤销已签机构同意；机构应显式暂停/撤销协议。停用接收方执行身份也阻止自动安装。后台采用持久租约及退避，重启/重复响应不重复安装或改写原签名；旧租约不能保存迟到成功/失败。未知网络错误自动重试，内容/信任/授权冲突进入 `needs_review`。无发送配置时不扫描或推进，仍可接收受信任查询并返回本地已批准的原签名。

组织 API：

- `GET /api/federation/agreements/:revisionId/exchange`：当前人工组织读取权限；返回 `enabled` 和 `sync`，后者为 `null` 或 `pending/complete/needs_review`、脱敏错误、下次尝试与确认时间，不返回原签名、证书或租约 token。
- `POST /api/federation/agreements/:revisionId/exchange/retry {}`：当前人工审批权限；不能替换 revision、原签名、执行账户，不能抢占活租约或重置 complete。修正信任/恢复暂停协议后，可复核原记录。

`complete` 仅表示本站取得并安装了所需同意，不保证另一方已完成交换，更不表示任务、材料、链 VALID 或结算已完成。Web 的“机构合作 → 合作协议 → 协议详情”现已展示签名交换进度、脱敏错误及下次尝试/验证时间；页面刷新读取当前状态，不把自动交换完成当作任务或账单完成。修复信任或权限后，有审批权限的电脑端用户可对需复核记录确认重试，仍使用原 revision 与空正文。暂停/撤销、只读和手机端不提供该操作；通信未配置时保留历史展示，接口读取失败时不提供旧状态重试。人工导入操作继续保留；CLI 入口待补。


## 实际存储容量保护

可用[存储侧签名观测](storage-capacity.md)限制新接单：采样实际数据库/节点卷，Server 校验报告身份和时效，保留旧请求恢复入口。该功能与双方签署的业务积压上限分别配置；阈值余量不是物理磁盘预留，完整容量保护仍在实现中。


### 任务介质来源导出

任务包沿用来源 age/wrapping key 配置和原任务审批，另需启用 NetDrive 版本存储，以及 Server 的 `FEDERATION_MEDIA_OBJECT_DOWNLOAD_ORIGINS`。源 Agent 的 `AGENT_FEDERATION_MEDIA_EXPORT` 在原 `mediaDirectory`、`ageDirectory` 之外配置 `allowedSourceOrigins`，例如 `["https://storage.example.org"]`；默认空，仍可处理受管目录的数据集包。两处允许清单独立校验，不继承远端任务输入/结果复制的 origin。

更新 Server 和 Agent 后协商 `federation_media_object_export_v1`，旧 Agent 仅接目录包。按原任务准备包后可显式调用 `/api/federation/media/exports/:id/run`；读取许可经受认证 AgentStream 发放，固定原对象版本、包和代次，最多 30 秒。HTTPS 存储证书必须被 Agent 信任，不关闭 TLS 校验。对象存储不应改写已签名 URL 的 Host 或丢失 versionId。

任务包导出成功只说明完整密文已在源 Agent outbox，目标任务导入/原子发布及 DATA_WAITING 恢复仍未接通，不能作为可离线运行的证明。接口、边界与实际测试见[任务介质交付](../../docs/design/federation/task-media.md)。
