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

Gateway 使用 Node 22，强制校验客户端证书链，按实际 TLS 证书计算 SHA-256 指纹。客户端提供的身份头、Authorization、Cookie、代理头均不转发。Bun 私有入口按指纹查本地登记，验证机构签名，并在接单事务中锁定、复查信任状态。网关只允许 `/federation/v1/delegations` 、`/federation/v1/status`、`/federation/v1/cancellations` 、`/federation/v1/results` 、`/federation/v1/result-downloads` 、`/federation/v1/result-receipts`、`/federation/v1/materials` 和 `/federation/v1/input-downloads`；普通 Server HTTP 端口不挂载这些机构路由。

Unix socket 只允许 Server 与 Gateway 的相同系统 UID 访问。独立目录须为该 UID 所有、权限 0700；socket 为 0600。运行时拒绝公开目录和权限过宽的签名私钥。Gateway 与 Server 属于同一机构的信任边界，不能把此 socket 挂给其他机构容器。各机构使用独立目录、数据库和签名密钥。Linux 启动依赖 util-linux 的 flock（Server、开发及 AIO 镜像已包含）。Server 与 Fabric Adapter 在同目录的持久 .lock 文件上串行化检查、清理和绑定：仅清理本 UID 所有且连接明确被拒绝的遗留 socket；仍有监听、探测超时、普通文件、符号链接或锁异常时拒绝替换。进程退出自动释放锁，.lock 文件不能在运行中删除；跨容器共享目录使用同一文件锁，存储须支持可靠的 flock 语义。非 Linux 保留原有拒绝占用路径的行为，不自动清理。

## 本地运行与 Compose

Server 设置：

| 变量 | 值 |
| --- | --- |
| `FEDERATION_ENABLED` | `true`；默认关闭 |
| `FEDERATION_SITE_ID` | 本机构 UUID，必须与信任登记一致 |
| `FEDERATION_SIGNING_KEY_ID` | 本地登记中的签名公钥 ID |
| `FEDERATION_SIGNING_KEY_FILE` | 专用 RSA PKCS#8 PEM 私钥路径，至少 2048 位，文件 0600 |
| `FEDERATION_SOCKET_PATH` | 私有 Unix socket 绝对路径 |
| `FEDERATION_RESULT_DOWNLOAD_ORIGINS` | 本机构存储的 HTTPS origin，逗号分隔；用于结果下载和本端上传地址验证，默认空 |
| `FEDERATION_INPUT_DOWNLOAD_ORIGINS` | 本机构输入文件存储的 HTTPS origin，逗号分隔；独立于结果授权，默认空（关闭） |
| `FEDERATION_INPUT_IMPORT_SOURCE_ORIGINS` | 接收输入文件允许访问的源站存储 HTTPS origin，逗号分隔；独立于本地/结果存储配置，默认空（不发输入搬运凭据） |
| `FEDERATION_RESULT_IMPORT_SOURCE_ORIGINS` | 导入结果允许访问的对端存储 HTTPS origin，逗号分隔；默认空，不启用 Agent 结果传输服务 |

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

使用现有登录认证与 `platform.manage` 权限，所有接口均在 `/api/admin/federation` 下。普通用户、提供者和运营者不会因角色名称获得信任配置权。此权限只管理基础设施信任，不授予商业合同批准权；协议审批 API 见下节，管理 UI 尚待实现。

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

平台管理员通过 `GET /api/admin/federation/capabilities?orgId=...` 查询授权，或 `PUT /api/admin/federation/capabilities` 提交 `{orgId,userId,capability,enabled}`。审批相关 capability 为 `agreement.read` 或 `agreement.approve`，后者包含读取权。被授权人必须是该组织的当前真人成员；自动化凭据和受限服务账号不能代表机构审批。平台管理员如需审批，也必须被显式授予该组织权限。

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
