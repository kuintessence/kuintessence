# Kuintessence 系统运维人员手册

本手册供系统运维人员、平台管理员和站点集群管理员使用，说明基础服务维护、发布、回滚、数据保护与恢复操作。

## 1. 运维职责

系统运维人员（System Operator）负责平台基础服务和部署环境，不代替业务管理员审批用户、软件或数据。

| 范围 | 主要职责 |
|---|---|
| 平台入口 | DNS、TLS、反向代理、单域名/多域名路由和 WebSocket |
| 平台组件 | Server、Web、Registry、Casdoor、PostgreSQL、RustFS、SpiceDB |
| 站点接入 | 接入代理进程、控制通道、证书、调度系统连通性 |
| 数据保护 | 数据库备份、对象存储保护、配置备份和恢复演练 |
| 发布维护 | 镜像或二进制发布、数据库迁移、滚动更新、回滚和观察 |
| 监控响应 | 健康检查、容量、日志、告警、故障分诊和事件记录 |

## 2. 系统组成

平台服务、接入代理和软件仓库负责后端与站点服务，Web 提供浏览器界面：

- Server：提供身份、授权、作业、工作流、调度选址、文件、SSH、计量和运营 API。
- 接入代理（Agent）：连接站点调度系统，执行派发、状态回传、资源监控和文件传输。
- 软件仓库（Registry）：存储和分发工作流模板、软件用例、Spack 软件和 OCI 制品。
- Web：面向用户、算力提供方和平台管理人员的统一界面。

主要基础服务：

| 服务 | 用途 | 关键依赖 |
|---|---|---|
| PostgreSQL | Server、Casdoor 等持久化数据 | 磁盘、备份和连接容量 |
| RustFS/S3 | 平台文件空间、数据市场和可选 SSH 录制 | 对象存储容量和公共访问地址 |
| SpiceDB | 关系授权 | PostgreSQL、Server 授权同步 |
| Casdoor | OIDC 身份提供方 | PostgreSQL、反向代理和回调地址 |
| Nginx gateway | 统一 TLS 入口和路径路由 | 上游服务、证书和 DNS |

## 3. 部署入口

平台反向代理支持两种模式。

### 3.1 单域名模式

推荐使用单域名模式。Web、Server、Registry、身份认证和对象存储使用同一域名，按路径路由：

| 公共路径 | 服务 |
|---|---|
| `/` | Web SPA |
| `/platform/api/` | Server REST、OIDC callback 和 SSH upgrade |
| `/platform/ws/` | 作业与工作流 WebSocket |
| `/software/api/` | 软件仓库 API |
| `/v2/` | OCI Distribution API |
| `/buildcache/` | Spack 构建缓存 |
| OIDC 必要根路径 | Casdoor |
| 对象存储 bucket 路径 | RustFS/S3 |

单域名模式减少 CORS 和 Cookie 配置，适合当前云环境和多数单位部署。

### 3.2 多域名模式

平台、身份、软件和对象存储分别使用域名，适合已有统一网关或独立存储域名的单位。浏览器控制面仍通过平台域名访问 `/platform/api/`、`/platform/ws/` 和 `/software/api/`，以保持同源会话。

两种模式使用相同业务路径。切换模式时需要同步 OIDC issuer、callback、`WEB_BASE_URL` 和对象存储公共地址，不能只修改 Nginx。

完整配置见[反向代理部署](../deployment.md#proxy)。

## 4. 日常巡检

### 4.1 平台页面

通过“平台管理 → 运营总览”和“平台安全”检查：

1. Server、Registry 和基础服务是否可达。
2. 授权服务是否就绪，授权同步是否存在积压或死信。
3. 接入代理是否在线，计算健康状态是否就绪。
4. 隔离运行环境是否存在严重异常。
5. SSH 活跃会话、录制和证书状态是否符合预期。

### 4.2 容器服务

使用仓库平台 Compose 配置时，从仓库根目录执行以下只读命令。
其他部署须指定实际的 `-f`、`--env-file` 和 project：

```bash
docker compose --project-directory . -f deploy/compose/docker-compose.yml ps
docker compose --project-directory . -f deploy/compose/docker-compose.yml logs --since 30m server
docker compose --project-directory . -f deploy/compose/docker-compose.yml logs --since 30m registry
```

网关是独立 Compose 配置，配置见[反向代理部署](../deployment.md#proxy)，
须沿用部署时的环境变量和 project，并指定 `platform-gateway` 服务。

查看容器健康状态、重启次数、持续错误和资源使用。容器为 `Up` 时，仍需按下一节检查 API。

### 4.3 API 健康检查

通过正式入口检查 Web、Server 和网关：

```bash
curl -fsS https://platform.example.com/healthz
curl -fsS https://platform.example.com/platform/api/health
```

需要认证的 readiness、授权和运营接口应使用运维账号在受控会话中检查，凭据不写入脚本或日志。

### 4.4 接入代理

在各站点检查：

```bash
systemctl status kuintessence-agent
journalctl -u kuintessence-agent --since "30 minutes ago"
```

接入代理在线后，继续检查计算健康、调度队列、执行账号和软件状态。在线只表示控制通道正常。

### 4.5 调度系统

| 调度系统 | 常用只读检查 |
|---|---|
| Slurm | `scontrol ping`、`sinfo -Nel`、`squeue` |
| OpenPBS | `qstat -Bf`、`pbsnodes -a`、`qstat` |
| Torque | `qstat -Bf`、`pbsnodes -a`、`qstat` |
| Kubernetes/K3s | `kubectl get nodes`、`kubectl get pods -A` |

调度系统队列应结合平台作业和维护窗口判断。发现不明原生作业时先确认是否由平台、管理员或其他业务提交，不直接删除。

## 5. 服务启停

### 5.1 启动顺序

1. PostgreSQL 和 RustFS/S3。
2. SpiceDB 和 Casdoor。
3. Server 和 Registry。
4. Web 和反向代理。
5. 各站点接入代理。

启动后逐层检查依赖和服务健康。排障时按故障范围重启服务，避免同时重启全部组件。

### 5.2 停止顺序

1. 发布维护公告并停止新提交入口。
2. 等待或处置运行中作业和文件传输。
3. 停止接入代理或 Server 派发能力。
4. 停止 Web、Registry 和 Server。
5. 最后停止身份、授权、数据库和对象存储。

停止服务前核对平台作业与原生调度系统状态。运行中的作业由业务负责人决定等待、取消或迁移。

<a id="sop"></a>
<a id="release"></a>

## 6. 发布与回滚

### 6.1 发布前

发布前需批准变更单，并准备以下信息；缺项时暂停发布：

- 版本/source commit、镜像 digest、迁移镜像、Agent artifact 和运行中 binary SHA。
- 影响服务与站点、migration、维护窗口、数据库/对象/配置备份编号（`BACKUP_REF`）。
- 可恢复的回滚版本（`ROLLBACK_VERSION`）、逐条获批回滚命令（`ROLLBACK_COMMAND`）和恢复演练结果。
- 发布主机、命名空间、仓库/部署目录、Compose 或 Helm 入口及正式 HTTPS 检查地址。
- 发布人、独立观察人、系统运维负责人、权限复核的平台管理员，以及负责验证基本业务流程的业务负责人。

检查运行中作业、调度队列、待取消任务和授权积压，确认可在维护窗口内处理。发布人执行并记录，观察人独立复核，系统运维负责人决定暂停后续发布或回滚。PostgreSQL、RustFS、SpiceDB、Casdoor 等基础设施升级需安排在应用发布前的独立维护窗口，恢复健康后再发布应用。

执行与变更范围匹配的 focused test、lint、typecheck 和部署配置检查。以下为发布主机上的检查示例，从仓库根目录执行；实际配置、project 和地址必须来自部署记录：

```bash
bun run lint
bun run typecheck
docker compose --project-directory . -f deploy/compose/docker-compose.yml config --quiet
curl -fsS https://platform.example.com/healthz
curl -fsS https://platform.example.com/platform/api/health
```

命令应返回 0，配置校验通过，健康检查返回 HTTP 200。使用 `--quiet` 避免泄露展开后的凭据。检查失败时暂停 migration 和服务更新，记录失败命令、返回码和相关日志摘要，修正后重新检查前置条件。

### 6.2 发布顺序

跨组件发布的顺序和回滚条件见[发布契约](release-contract.json)。以下步骤与契约的阶段 ID 对应；未变化组件可标记 N/A，其余阶段仍按顺序执行。

1. 冻结候选与备份（`freeze-backup`）：核对待发布版本、影响范围、窗口、责任人、备份与回滚信息，完成数据库、对象和配置备份。缺少任一项时停止发布。
2. 目标 DB migration（`db-migration`）：migration Job 返回 0、ledger 到达目标 tag，且 N-1 Server/Registry 通过目标 schema 兼容验证后，才能继续。migration 为 expand-only/forward-only，应用回滚不自动回退 schema。
3. Server（兼容模式）（`server-compatible`）：确认 readiness 的 `schemaMatches`、授权 pending/processing/dead 恢复正常，并通过协议兼容测试；新 enforcement/dispatch 保持关闭。
4. Agent 单站点 canary 后逐站点滚动（`agent-rollout`）：记录 binary SHA，检查 systemd 稳定性、Server online/compute ready、原生 scheduler 健康，运行最小作业并核对 N/N-1 注册、心跳和 ACK。本站点全部通过后再进入下一站点。
5. Registry（`registry`）：健康检查后，用授权账号读取已知 catalog/template，确认 Server 能解析同一 revision；滚动期间保持 `ECOSYSTEM_RELEASE_AUTO_ACTIVATE=false`。
6. gateway 兼容路由（`gateway-compatible-route`）：只增加兼容路由，验证 `/platform/api/`、`/software/api/`、WebSocket 和 OIDC callback；本窗口不删除或改名旧路由。
7. Web/CLI 客户端（`web-cli`）：匿名检查公开入口和 OIDC 配置，再用授权会话验证登录、权限、最小作业/工作流和文件传输。使用锁定版本的 CLI 按[用户手册 CLI 流程](user-manual.md#cli)提交[最小作业 spec](examples/job-smoke.json)，记录唯一 ID，查询状态并在终态核对日志。
8. 激活新能力或生态版本（`activate`）：前一阶段的检查和所有 Agent 验证通过后再激活，记录 source commit、镜像 digest 和批准人。
9. 观察（`observe`）：至少持续 30 分钟，每 10 分钟记录服务健康、Agent 重连、作业状态、传输和授权积压；每个受影响站点都需完成基本业务验证，期间不进行无关变更。

发布完成后，各服务应运行目标版本并通过健康检查，Agent 在线且计算就绪，登录、权限、业务与运营页面检查通过。观察期内新增积压需查明原因。单位发布制度要求更长观察期时，按其执行。

<a id="rollback"></a>

### 6.3 回滚边界

| 阶段 | 允许的恢复方式 |
|---|---|
| migration 前 | 任一预检、备份或恢复演练失败即停止，运行态不变 |
| migration 后、产生新格式写入前 | 仅在 expand-only 且 N-1 Server/Registry 兼容验证通过时回滚应用制品并保留 schema；不执行未知 down migration |
| Agent 滚动中 | 暂停后续站点升级，在受影响站点恢复旧 binary，不重置其他站点或原生调度器作业 |
| Registry/gateway/Web 阶段 | 优先回滚对应镜像或 gateway 配置，不回滚业务数据；N-1 不可读时按 Registry blob 与 PostgreSQL 一致性单元恢复 |
| 激活后或首次不兼容写入后 | 停止新提交、发布和传输，用同一时间点 PostgreSQL 与 blob 快照恢复，核对对象引用、授权 outbox 和原生调度器状态 |

回滚范围限于本次发布涉及的服务、配置，以及必须一同恢复的数据库和对象，不重置无关数据。恢复前确认快照回退会丢失哪些新增或修改的数据；回滚后复查备份、服务健康、权限、基本业务流程和积压。

<a id="failure-handling"></a>

### 6.4 失败与停止条件

- migration 或对象写入异常：立即停止发布，保留错误记录并通知系统运维负责人；不得直接修改数据库中的执行结果。
- 正式登录/核心 API 大范围不可用、权限或数据错误、Agent 无法稳定重连、主流程失败、积压持续增长：立即暂停后续发布，按上述阶段条件使用获批 `ROLLBACK_COMMAND` 与 `BACKUP_REF` 恢复。
- 无法核实备份、回滚命令未批准、维护窗口结束、健康检查非 200、授权范围不明，或任一受影响站点未完成验证：暂停发布。
- 回滚后复查仍失败：保持事件打开，通过平台事件或变更工单及当班值班群通知系统运维负责人，不尝试未经确认的命令。

## 7. 身份认证与会话

生产环境使用 OIDC 单点登录。运维人员需要维护：

- issuer 与 discovery 地址。
- client ID、client secret 和 callback。
- IdP group 到平台技术角色的映射。
- Web 公共地址、Cookie path 和 HTTPS。

修改后使用无持久化浏览器完成登录、OIDC callback、会话刷新、退出登录，并确认退出后的旧会话不能访问受保护 API。

`NODE_ENV=development` 时可能存在开发登录入口。正式交付前关闭 development login；生产环境的登录、刷新和退出验证通过后，再调整临时网络访问限制。

## 8. 授权服务

SpiceDB 承载关系授权，Server 通过授权同步队列写入关系。

### 8.1 正常状态

- readiness 为就绪。
- pending/processing 在业务处理后逐步减少。
- dead letter 为零或已有明确处置记录。
- 授权观察差异没有持续增长。

### 8.2 重建

授权重建是可逆的平台管理操作。执行前确认 PostgreSQL 和 SpiceDB 正常，记录当前积压；执行后检查关系数量、readiness、积压处理情况和代表性角色的访问权限。

业务源数据异常时，先修复数据库或关系生成逻辑，再重建授权。

## 9. PostgreSQL

### 9.1 日常检查

- 服务健康和连接使用量。
- 数据盘容量与增长趋势。
- 长事务、锁等待和失败迁移。
- 备份任务和最近一次恢复验证。

### 9.2 备份

数据库备份应包含 schema、业务数据和 migration ledger。备份文件放在受控存储中，按单位制度设置保留周期。

### 9.3 恢复

恢复前停止 Server 写入，明确目标时间点和数据影响。恢复后依次检查 migration ledger、Server readiness、授权同步、登录和代表性业务资源。

## 10. RustFS 与平台文件空间

对象存储承载平台文件空间、数据市场暂存/不可变对象以及可选 SSH 录制。

日常关注：

- 服务健康、磁盘容量和 bucket 增长。
- 公共访问地址是否与反向代理一致。
- 上传、分段上传、下载和删除是否正常。
- 数据库元数据与对象状态是否一致。

文件传输失败时，先区分对象存储不可达、预签名地址错误、集群路径不可写和接入代理离线。详细步骤见[存储故障排查](../storage.md#troubleshooting)。

## 11. 接入代理与证书

### 11.1 注册

接入代理通过一次性接入凭证完成 CSR、证书签发和组织绑定。注册后检查：

- 平台记录的算力提供方组织正确。
- 证书台账存在且在有效期内。
- 控制通道建立，心跳和计算健康持续更新。
- 调度系统类型和站点名称正确。

### 11.2 证书撤销

只撤销已确认停用、泄露或重新接入的证书。撤销前确认目标接入代理，避免影响现役站点。完整流程见[接入代理注册与证书](../security.md#agent)。

### 11.3 升级

按站点逐个升级接入代理。每个站点完成服务重启、自动重连、计算健康和调度系统只读检查后，再进入下一个站点。

## 12. SSH 运维

SSH 子系统包括凭据保管库、活跃会话、会话限制和可选会话录制。

- 凭据按目标接入代理维护，加密保存。
- 更新凭据后执行短会话验证。
- 强制断开前确认用户和事件原因。
- 启用录制时监控对象存储容量和保留策略。
- 录制仅供授权审计人员访问。

详细配置见[SSH 运维](../security.md#ssh)。

## 13. 隔离运行环境

隔离运行环境按平台上限、算力提供方策略和接入代理能力共同决定是否就绪。

- 必要能力缺失时状态为严重异常，修复后才能进入就绪。
- 算力提供方策略只能继续收紧平台上限。
- OpenPBS/Torque 等不具备所需执行模式的环境不回退到未批准身份。
- 已有验证结果满足检查要求时，不重复执行破坏性 canary。

使用前按[当前实现状态](../status/current-state.md)核对目标调度系统、执行模式和 GA 状态；仅有界面入口的能力仍需确认是否可用。

## 14. 日志与监控

### 14.1 日志原则

使用结构化日志按时间、服务、请求或业务资源定位问题。工单只附与故障相关的最小片段，不上传完整生产配置或凭据。

### 14.2 建议指标

- Server、Registry 和 gateway 可用性与延迟。
- PostgreSQL 连接、锁等待、容量和备份结果。
- RustFS 容量、请求失败和对象增长。
- 授权同步 pending、processing 和 dead letter。
- 接入代理在线率、重连和计算健康。
- 作业失败率、待取消任务和队列深度。
- 文件传输失败率和重试量。

## 15. 故障分诊

### 15.1 用户无法登录

检查 gateway、Casdoor discovery、OIDC callback、Server 日志和浏览器 Cookie path。使用 OIDC 登录流程复查，开发登录不会验证这条路径。

### 15.2 页面可打开但 API 返回错误

检查 `/platform/api/` 路由、Server 健康和会话。若仅软件页面失败，再检查 `/software/api/` 与 Registry。

### 15.3 多个接入代理同时离线

优先检查 Server 控制通道 listener、证书、网络和最近 Server 变更；单站点离线再检查该站点服务和网络。

### 15.4 接入代理在线但作业不能执行

继续检查计算健康、调度队列、执行账号映射、软件可用性和调度选址说明。

### 15.5 作业状态不收敛

对照平台作业、接入代理日志和原生调度系统状态，检查状态回传、离线队列和待取消任务。不得直接修改数据库将作业置为终态。

### 15.6 文件传输失败

确认方向、源对象、集群文件根目录、目标可写性、接入代理在线和对象存储公共地址。源或目标仍有效时再使用重试。

<a id="handover"></a>

## 16. 维护与交班

发布完成、回滚或维护交班时至少记录：

- 事件/变更单、起止时间与时区、服务/站点范围、发布人和观察人。
- 候选版本、source commit、digest、binary SHA、变更前状态、备份和回滚编号。
- 执行命令及返回码、migration ledger、N-1 兼容性与每站点 Agent 结果。
- 登录、权限、作业/工作流、文件和运营页面验证结果，以及带时间的 30 分钟观察记录。
- 当前状态（已恢复、仍在观察、已回滚或无法继续）、业务影响、遗留风险和已执行恢复动作。
- 未完成项的责任人、下一次检查时间、升级渠道、操作入口及需要的权限。

每次检查都需记录时间和结果。工单只保留必要日志，不写密码、Cookie、Bearer token、私钥、完整生产配置或受限数据正文。维护结束后清理临时账号和 tunnel，正式备份及回滚制品按保留策略保存。

## 17. 交付前检查

1. 正式 HTTPS 单域名或多域名入口可用。
2. OIDC 登录、刷新和退出验证通过。
3. development login 已关闭，临时网络访问限制已按登录验证结果调整。
4. Server、Web、Registry、PostgreSQL、RustFS、SpiceDB 和 Casdoor 健康。
5. 目标接入代理在线且计算健康状态符合实际。
6. 代表性调度系统完成最小作业与状态回传。
7. 平台文件空间上传、下载和双向传输通过。
8. 备份、恢复和回滚流程已经演练。
9. 界面和文档已标明尚未交付的能力。
10. 交付说明已列出仍在观察的问题和功能限制。

## 18. 相关文档

- [平台通用用户手册](user-manual.md)
- [中英双语术语表](../terminology-glossary.md)
- [反向代理部署](../deployment.md#proxy)
- [认证与浏览器安全](../security.md#authentication)
- [存储与传输](../storage.md#transfers)
- [当前实现状态](../status/current-state.md)
