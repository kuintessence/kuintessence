# 离线材料闭包与可安装声明

平台对已明确报告 `siteOperations.transport=ssh-forward` 或 `http-proxy` 的 Agent，
不再仅凭在线、策略允许和安装权限，把尚未安装的软件列入 `installableAvailable`。
没有匹配有效 source-audit proof 的候选返回 `offline site material closure has not been verified`，页面显示材料闭包未验证及下一步操作，
不会把该状态解释为权限拒绝。过期、未来时间或格式异常的离线站点报告同时返回状态不可采信原因。

此约束只作用于明确报告离线传输的 Agent 和尚未安装的软件。
已有安装记录的软件保留原有可运行性、授权和许可检查；直接模式和尚无站点报告的既有 Agent 保持原行为。
`materials.state=ready`、`installation.state=ready`、已激活 release 和 enabled install binding 都不是某个 spec 的闭包证明。

现有证据分为三个阶段：

- Registry 发布验证已声明 blob 的 digest/大小、recipe 身份与授权及 lock 静态结构。报告明确为 `static-only`，不证明实际 recipe 的源码、resource、patch 或 bootstrap 依赖齐全。
- Agent 的隔离 source audit 在固定运行时中验证 recipe、native DAG、`pkg.stage` 包含的 source/resource staging，以及独立的 `spack.patch.UrlPatch.stage`；各下载 stage 均使用 `mirror_only=True` fetch 后执行 checksum check，并触发 native FilePatch 检查。未知 patch 类型、缺失 stage 或不支持的 fetcher 均拒绝通过，不调用可能回退上游的 `patch.fetch()`。审计禁用 bootstrap，在无网络命名空间执行；安装 worker 同样强制镜像 fetch，材料缺失不得回退上游。审计必须在目标 Spack/runtime 中完成，成功后可走下述持久凭据通道。
- 启用实验性持久安装后，只有隔离 build 和独立只读 verify 都通过，才保存并发布 installed/ready 安装记录。下载成功或 source audit 通过不能替代安装验证。

Server 复用 `software_operations` 和 append-only `audit_log` 保存 source-audit proof，不新增由客户端任填的 ready 字段。
授权材料派发先保存 Server 核验的 manifest/native lock digest、准确 spec、当前 binding scope/revision、Agent mTLS 证书 fingerprint，
以及新鲜 Agent 心跳中的 site-profile/runtime digest。Agent 对固定运行时执行实际隔离审计，
并在执行前后重新核验受保护 site profile 与其关联的宿主材料；缺少 pinned site profile 时不产生 proof。
只有同一 mTLS 身份返回、与派发快照匹配的严格审计 envelope 才能入库。
原有操作结果中的普通 stdout、`materials.state=ready`、enabled binding 或静态 lock 报告均不能签发凭据。

凭据有效期为 Server 接收真实执行结果起 24 小时，超过派发后 24 小时才到达的结果不受理。
查询与 availability 均复核当前证书状态、在线 mTLS 身份、请求人操作权限和策略、准确 spec、
binding revision、release 生命周期、新鲜 site-profile/runtime digest 及操作终态。
撤销、过期、绑定切换（即便之后切回相同 manifest）、配置变化、审计/安装失败或最新安装操作无有效凭据，均不接受旧 proof。
重放不能延长时效或复活已撤销凭据。离线 Agent 只有匹配有效 proof 才能进入 `installableAvailable`；
这只声明预安装材料闭包，后续安装仍重新审计并执行 build 和独立 verify，不能冒充 installed/ready。

需要单独预安装审计时，调用
`POST /api/cp/software/operations/source-audit`，请求体 `{"agentId":"目标Agent","spec":"准确spec"}`，
沿用操作权限与 `Idempotency-Key`。该入口复用现有持久操作队列，以 Server 的 `source-audit:` 幂等命名空间保存模式，
通过授权材料 ticket 和 manifest 响应传给 Agent；即使开启持久安装，也只执行材料准备与 source audit，不调用 build 或更新安装库存。
底层 install 记录标记未执行安装（`rejected`），通过审计后的 API view 为 `auditOnly:true`、`auditStatus:passed`、`status:succeeded`；
操作列表显示“材料审计 / 审计通过，尚未安装”，不刷新 installed 账本。凭据当前是否仍有效以 proof API 为准。
普通显式 install 仍在成功审计后继续 build/verify；新安装失败会阻止复用旧审计结果作为 availability 依据。

有权操作 Agent 的 算力中心用户可查询 `GET /api/cp/software/operations/:operationId/source-audit-proof`，
返回完整绑定、签发/到期时间、`revoked` 与实时 `valid`；从未产生凭据时为 404。
拥有 Agent manage 权限的用户可调用
`POST /api/cp/software/operations/:operationId/source-audit-proof/revoke`，请求体 `{"reason":"材料隔离原因"}`。
撤销追加审计事件；重新审计必须发起新操作，不通过更新旧凭据恢复。

需要继续验证材料时，由有权操作目标 Agent 的用户进入 **算力中心门户 → 软件 → 软件操作**，
为准确 spec 发起显式 `install`。对应现有 API 是 `POST /api/cp/software/operations`，
请求体为 `{"agentId":"目标Agent","action":"install","spec":"准确spec"}`，
沿用登录授权与 `Idempotency-Key`。该入口仍执行现有材料绑定、权限、策略、隔离审计和运行时检查；
没有因 availability 声明收紧而绕过或禁用显式安装。
未启用 source audit / 持久安装、缺材料或本站不兼容时会失败或拒绝；HTTP 202 仅表示受理。
须检查操作终态和安装清单，不能把受理、下载或预检成功记作软件已就绪。

现有材料下载走 **Agent → 平台 Server 材料 API → Registry**，不依赖原生 OCI 客户端认证发现。
材料客户端与 Server 转发均拒绝重定向；离线 site transport 对目标 origin 校验，不会因跳转直连额外上游。
对象预签名 URL 需要平台统一出口及明确的公共 origin，签名 authority/path/query 不由现场客户端重写。

原生 OCI 已补充标准 Bearer challenge 与 Server token exchange，统一 HTTPS 公共 origin、
Basic 登录凭据复用现有人类 access JWT，并按 repository/subject 限定 pull/push。
配置及 Docker/Apptainer 用法见 [原生 OCI 登录](native-oci-authentication.md)。

材料下载 ticket 默认有效期为 900 秒；隔离运行环境可将 Server 的
`SPACK_MATERIAL_TICKET_TTL_SEC` 设为 30..900 秒（例如 60），真实等待签名 `exp` 过期后验证原有证书续票流程。
该配置不改变 source-audit proof 的 24 小时有效期，也不放宽 ticket 的 15 分钟最大年龄检查。
