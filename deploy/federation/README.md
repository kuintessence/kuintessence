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

Gateway 使用 Node 22，强制校验客户端证书链，按实际 TLS 证书计算 SHA-256 指纹。客户端提供的身份头、Authorization、Cookie、代理头均不转发。Bun 私有入口按指纹查本地登记，验证机构签名，并在接单事务中锁定、复查信任状态。网关只允许 `/federation/v1/delegations` 、`/federation/v1/status`、`/federation/v1/cancellations` 、`/federation/v1/results` 和 `/federation/v1/result-downloads`；普通 Server HTTP 端口不挂载这些机构路由。

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
| `FEDERATION_RESULT_DOWNLOAD_ORIGINS` | 本机构存储的 HTTPS origin，逗号分隔；用于结果下载和本端上传地址验证，默认空 |
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

每个下载凭据最多 30 秒，并受协议结果截止时间限制；同时核对实际 S3 SigV4 的过期时间，支持时固定对象 versionId。地址及签名响应含 bearer 凭据，仅交给受信任的搬运组件，不写日志、数据库或普通清单响应。已发预签名地址无法即时撤销，撤权阻止续发；已建立的 S3 响应不保证在地址过期瞬间断开，受管 Agent 会按授权截止时间取消连接。需要逐字节即时撤权的部署不能把此通道当作满足该要求。

结果导入 API 已接入持久状态，但自动传输 worker 尚未启动，提交保持 pending。读取及首次提交需要独立 `result.read`，自己的已提交导入可在失去该权限后请求停止；取消 ID 不重启，重新授权导入使用新 ID。未连接的阶段不会返回 available 或云盘文件。详见[持久导入契约](../../docs/design/federation/implementation.md#持久结果导入与传输尝试)。

源站已实现当前组织授权、发出签名下载请求、验签、对象/尝试绑定及返回前重新授权的内部方法；生产持久传输任务与 AgentStream 桥接尚未连接，没有新增面向普通用户的下载授权 REST 接口。尚不代表完整跨站文件交付。

出站、状态、取消与结果清单接口不依赖 Fabric。额度尚未接通结算释放；源站结果交付、后台状态同步、普通 Workflow 自动委派和已接单端点迁移仍待完成。详细契约见[实现说明](../../docs/design/federation/implementation.md#源站持久发送)。

## 本地信任管理 API

使用现有登录认证与 `platform.manage` 权限，所有接口均在 `/api/admin/federation` 下。普通用户、提供者和运营者不会因角色名称获得信任配置权。此权限只管理基础设施信任，不授予商业合同批准权；协议审批 API 见下节，管理 UI 尚待实现。

| 方法与路径 | 内容 |
| --- | --- |
| `GET /sites?limit=50&offset=0` | 机构分页清单 |
| `POST /sites` | `{id,name,endpoint}`；endpoint 为无凭据、路径、查询的 HTTPS origin |
| `GET /sites/:siteId` | 机构详情、登记公钥和证书及其有效期/撤销状态 |
| `PUT /sites/:siteId` | `{name,endpoint}`；不能改机构 ID |
| `POST /sites/:siteId/state` | `{state: active或suspended或revoked}`；revoked 不可恢复 |
| `POST /sites/:siteId/keys` | `{keyId,publicKeyPem,allowedKinds,validFrom,validUntil}`；用途为 agreement/delegation/acceptance/evidence-batch/status-query/status-report/cancellation/cancellation-receipt/result-query/result-report/result-download-query/result-download-grant |
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

结果存储协调器尚未挂入生产后台。准备接线的存储角色需要 `s3:GetObjectVersion` 读取 netdrive 与 federation-results 固定版本，并需要仅限 `federation-results/*` 的 `s3:ListBucketMultipartUploads`、`s3:ListBucketVersions` 及 `s3:DeleteObjectVersion`。仓库 RustFS 和 Helm 初始化脚本已同步更新；外部 S3 需由存储管理员配置等效权限。不要扩大普通云盘历史版本的删除权限或取消不可变存储的显式删除拒绝。真实 RustFS 已验证该边界，不能据此假定所有兼容 S3 实现均具有相同策略行为。

Agent 结果搬运配置默认关闭。`AGENT_FEDERATION_RESULT_COPY` 是 JSON，例如 `{"stagingRoot":"/var/lib/kq/result-staging","maxStagingBytes":1073741824,"allowedSourceOrigins":["https://remote-storage.example.org"],"allowedDestinationOrigins":["https://local-storage.example.org"]}`。暂存路径须是 Agent 用户独占的绝对目录（0700，无符号链接），需要完整单文件空间；容量是文件上限，不是已验证支持 TB 级搬运。当前运行结果不跨进程续传。双方服务都需升级以协商复制与目的校验两项能力；仅支持复制的旧 Agent 不领取新任务，Agent 到 Server 必须通过 mTLS；缺失任一条件不派发。

Server 已构造结果传输服务并接 Agent RPC，但自动扫描 worker 尚未启动。配置上述值不会让 pending 导入自动完成；分片完成和目的字节校验已接通，仍需补齐配额及整单发布，不能据此宣布离线包或联邦结果已交付。

目的校验需要上述固定版本 GET 权限，分片完成后保存对象 ETag 与可用的 versionId，再由 Agent 实际读取字节。开启 versioning 的存储可固定读取已组装版本；未开启时使用 If-Match 和 SHA-256，不提供历史版本保留保证。Agent 需要能访问本端预签名 HTTPS 地址，校验读取不经 Server 中转、不占完整文件暂存空间。目前 verified 只代表传输完整性，不代表已登记云盘副本或已签收/结算。
