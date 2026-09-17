# Kuintessence 中英双语术语表

本表供界面、API 文档和操作手册使用。中文内容采用表中的中文名称，英文内容使用对应英文名称。
命令、API 路径、配置项、代码标识以及 Slurm、OpenPBS、Torque、Kubernetes 等专有名称保持原文。

## 1. 使用规则

1. 中文正文首次出现重要概念时，采用“中文名称（English Name）”，后续只使用中文名称。
2. 空间有限的导航、按钮和表头直接使用中文简称，不机械附加英文。
3. 面向用户的中文文案使用“作业、工作流、调度系统、接入代理、用量计量”等业务术语，不直接显示 `Job`、`Workflow`、`Scheduler`、`Agent`、`Metering`。
4. `Agent ID`、`Job ID`、API、OIDC、SSH、mTLS、CPU、GPU、Spack spec 等技术字段保留英文标识，中文说明补充其用途。
5. 状态值在界面中翻译，在日志、API 响应和故障工单中保留原始枚举值，便于检索。
6. `NetDrive` 中文称“平台文件空间”；`Server` 称“平台服务”，`Registry` 称“软件仓库”。“软件中心”是 Web 中浏览和管理软件、用例与模板的功能入口，不是后端服务名称。
7. 角色名称区分“人”和“组织”：`Compute Provider` 指“算力提供方”，具体操作人员称“算力提供方运营人员”或“算力提供方管理员”。

## 2. 平台与角色

| 中文规范名称 | English | 释义与使用说明 |
|---|---|---|
| 算力网络平台 | Computing Network Platform | 统一接入异构算力、数据和软件并提供调度与编排能力的平台。 |
| 平台服务 | Kuintessence Server | 提供 API、身份与权限、调度、工作流、文件服务和审计的中央服务；组件简称 Server。 |
| 算力提供方 | Compute Provider | 提供集群、队列、软件环境或数据服务的组织。中文不使用“CP”代替正式名称。 |
| 算力使用方 | Compute Consumer | 使用平台算力、软件和数据的组织；具体个人通常称“科研计算用户”。 |
| 科研计算用户 | Research Computing User | 提交作业、编排工作流和管理科研数据的最终用户。 |
| 算力提供方运营人员 | Compute Provider Operator | 查看本组织运行状态、用量和待办，并执行获授权的日常运营操作。 |
| 算力提供方管理员 | Compute Provider Administrator | 管理本组织用户、执行账号、队列、软件策略和接入代理。 |
| 平台运营人员 | Platform Operator | 查看跨组织运营、审计、用量和告警，默认不修改技术配置。 |
| 平台管理员 | Platform Administrator | 管理平台级身份、授权、安全和基础设施配置。 |
| 系统运维人员 | System Operator | 负责部署、升级、备份、监控、故障恢复和基础服务维护的人员。 |
| 超级管理员 | Super Administrator | 管理全局成本、偏好和紧急管理能力的最高技术角色。 |
| 组织管理员 | Organization Administrator | 在授权组织范围内管理成员和业务资源的技术角色。 |
| 访客 | Guest | 仅可访问公开目录或待授权页面的用户。 |
| 业务身份 | Business Identity | 用户在具体组织中的业务职责，如算力使用方、算力提供方或软件提供方。 |
| 技术角色 | Technical Role | 决定平台级访问能力的角色，如 `user`、`org_admin`、`operator`、`platform_admin`。 |
| 当前组织 | Active Organization | 用户当前操作所绑定的组织范围，决定列表、审批和写操作的数据边界。 |

## 3. 计算与调度

| 中文规范名称 | English | 释义与使用说明 |
|---|---|---|
| 作业 | Job | 由调度系统执行的一次计算任务。 |
| 作业编号 | Job ID | 平台生成的作业唯一标识；原生调度系统编号称“调度系统作业编号”。 |
| 工作流 | Workflow | 由多个计算、控制和数据节点组成的可编排执行图。 |
| 工作流运行 | Workflow Run | 工作流定义的一次具体执行实例。 |
| 工作流模板 | Workflow Template | 可复用的工作流定义和参数框架。 |
| 调度系统 | Scheduler | Slurm、OpenPBS、Torque、Kubernetes 等承载任务排队和执行的系统。 |
| 调度队列 | Scheduler Queue | 调度系统向用户开放的资源队列；Slurm 的 partition 在平台中也归入此概念。 |
| 调度选址 | Placement | 平台根据权限、软件、计量、负载和策略选择执行位置的过程。 |
| 调度选址说明 | Placement Explanation | 展示候选节点通过或未通过各选址阶段的原因。 |
| 算力节点 | Compute Resource | 用户可见的集群或 Kubernetes 算力入口，不等同于单台物理计算节点。 |
| 接入代理 | Agent | 部署在站点登录节点或控制节点上的 Kuintessence 服务，负责连接平台与本地调度系统。 |
| 控制通道 | Control Channel | Server 与接入代理之间用于心跳、派发和状态回传的连接。 |
| 计算健康状态 | Compute Health | 接入代理检查本地调度系统能否执行任务后上报的状态。 |
| 心跳 | Heartbeat | 接入代理周期性上报的在线、资源和健康信息。 |
| 执行账号 | Execution Account | 作业在 Unix 或 Kubernetes 中实际使用的身份。 |
| 账号映射 | Account Mapping | 平台用户与集群执行账号之间经审批建立的关系。 |
| 隔离运行环境 | Sandbox | 按运行环境、身份和网络策略执行脚本；调度器支持范围见[软件与 Sandbox](software.md#sandbox)。 |
| 运行环境 | Runtime | 作业执行所需的容器、解释器、库和环境配置。 |
| 运行环境配置 | Runtime Profile | 描述隔离运行环境及其可验证约束的配置。 |
| 待处理 | Pending | 平台已接收请求，正在校验、选址或等待派发。 |
| 已排队 | Queued | 已进入原生调度系统队列。 |
| 运行中 | Running | 已在目标算力环境中执行。 |
| 已完成 | Completed | 正常结束并进入成功终态。 |
| 已失败 | Failed | 因校验、调度、运行或输出归集错误进入失败终态。 |
| 已取消 | Cancelled | 用户或管理员取消后进入终态。 |

## 4. 数据、文件与软件

| 中文规范名称 | English | 释义与使用说明 |
|---|---|---|
| 平台文件空间 | NetDrive | 基于对象存储的用户文件空间，用于上传、下载和跨集群传输。首次出现可写作“平台文件空间（NetDrive）”。 |
| 集群文件根目录 | Cluster File Root | 平台获准浏览和传输的集群目录边界。 |
| 文件传入 | Stage In | 将平台文件空间中的输入文件传送到集群运行目录。 |
| 文件归集 | Stage Out | 将集群产生的输出文件传回平台文件空间。 |
| 作业文件 | Job Files | 与作业输入、输出和归集状态关联的文件列表。 |
| 分段上传 | Multipart Upload | 将大文件拆分为多个部分上传并在服务端完成合并。 |
| 断点续传 | Resumable Transfer | 传输中断后从已完成位置继续，而非重新开始。 |
| 数据市场 | Data Market | 发布、申请和使用数据资产的业务目录。 |
| 数据资产 | Data Asset | 具有所有者、版本、可见性和授权规则的数据对象。 |
| 数据版本 | Data Version | 数据资产在特定时间发布的不可变版本记录。 |
| 访问申请 | Access Request | 用户请求使用受限数据、软件或存储额度的审批记录。 |
| 软件仓库 | Kuintessence Registry | 存储和分发软件目录、发布版本、工作流模板、OCI 制品与 Spack buildcache 的服务；组件简称 Registry。 |
| 软件中心 | Software Center | Web 中浏览、发布和管理软件、用例与工作流模板的功能入口。 |
| 软件用例 | Software Use Case | 对软件版本、命令、参数、输入输出和资源要求的业务封装。 |
| 软件策略 | Software Policy | 算力提供方在组织、集群和接入代理层设置的软件安装和使用规则。 |
| 可用性预览 | Availability Preview | 保存策略或提交任务前查看哪些候选算力可运行所选软件。 |
| 预装软件识别 | Preinstalled Software Discovery | 接入代理识别站点已有软件并提交管理员确认的过程。 |
| 构建缓存 | Build Cache | Spack 用于分发已构建软件包的缓存。 |
| 对象制品 | OCI Artifact | 通过 OCI Distribution API 管理的镜像或通用制品。 |

## 5. 运营、安全与系统运维

| 中文规范名称 | English | 释义与使用说明 |
|---|---|---|
| 运营概览 | Operations Overview | 汇总业务指标、审批待办和运行告警的页面。 |
| 用量计量 | Metering | 记录并聚合 CPU、GPU、内存、存储和网络等资源使用量，不等同于计费。 |
| 成本费率 | Cost Rate | 调度选址成本评分使用的参考费率，不直接生成账单。 |
| 审计日志 | Audit Log | 记录操作者、时间、动作、目标和结果的业务事实。 |
| 授权 | Authorization | 判断用户能否对资源执行指定操作的过程，平台使用 SpiceDB 承载关系授权。 |
| 身份认证 | Authentication | 确认用户或服务身份的过程，用户登录主要采用 OIDC。 |
| 单点登录 | Single Sign-On, SSO | 用户通过统一身份提供方登录多个系统的机制。 |
| 身份提供方 | Identity Provider, IdP | 完成用户认证并向平台提供身份声明的系统。 |
| 数据脱敏 | Data Desensitization | 按规则隐藏、替换或别名化敏感业务字段。 |
| 活跃会话 | Active Session | 当前仍可使用的 Web 或 SSH 会话。 |
| 会话录制 | Session Recording | 按配置记录 SSH 终端输出，供授权人员审计和回放。 |
| 凭据保管库 | Credential Vault | 加密保存 SSH 等运行凭据的受控存储。 |
| 接入凭证 | Registration Token | 用于接入代理首次注册的一次性凭证。 |
| 证书台账 | Certificate Ledger | 记录接入代理证书状态、有效期和撤销信息的管理视图。 |
| 授权同步积压 | Authorization Backlog | 等待写入授权系统的关系变更数量。 |
| 死信 | Dead Letter | 多次处理失败、需要人工介入的异步记录。 |
| 降级 | Degraded | 能力仍可部分使用，但存在需要关注的缺项。 |
| 严重异常 | Critical | 必要条件不满足，相关能力必须停止进入就绪状态。 |
| 就绪 | Ready | 服务或能力满足当前配置规定的运行前置条件。 |
| 反向代理 | Reverse Proxy | 统一接收外部请求并按域名或路径转发到内部服务的网关。 |
| 单域名模式 | Single-Domain Mode | 所有浏览器服务使用同一域名并按路径路由的部署方式。 |
| 多域名模式 | Multi-Domain Mode | 身份、软件和对象存储等服务分别使用不同域名的部署方式。 |
| 发布候选版本 | Release Candidate, RC | 供发布前验证使用的候选版本。 |
| 回滚 | Rollback | 发布失败时恢复到上一个已知可用版本的操作。 |
| 运行手册 | Runbook | 面向运维或验收人员的可执行操作文档。 |

## 6. 保留原文的名称

以下名称在中文界面和文档中保留原文，必要时补充中文说明：

- 产品与项目：Kuintessence、Casdoor、SpiceDB、MinIO、OpenTUI。
- 调度与编排系统：Slurm、OpenPBS、Torque、Kubernetes、K3s。
- 软件与协议：Spack、Apptainer、OCI、OIDC、SSH、mTLS、WebSocket、REST、gRPC。
- 客户端形态：Web、CLI、TUI、GUI。
- 资源单位：CPU、GPU、MiB、GiB、CPU 核·小时、GPU 小时。
- 命令与标识：`kq`、`Agent ID`、`Job ID`、`Workflow Run ID`、环境变量、API 路径和枚举值。

## 7. 中英文示例

| 场景 | 中文 | English |
|---|---|---|
| 导航 | 算力提供方 → 用量计量 | Compute Provider → Metering |
| 状态 | 接入代理在线，计算健康状态为“就绪” | The agent is online and compute health is Ready. |
| 提交失败 | 未找到可用的执行账号映射，请联系算力提供方管理员。 | No eligible execution-account mapping is available. Contact your compute provider administrator. |
| 软件不可用 | 目标算力节点尚未提供所需软件，请选择其他节点或提交安装申请。 | The required software is unavailable on the selected compute resource. Choose another resource or request installation. |
| 运维告警 | 授权同步存在死信，请检查失败原因后重新处理。 | Authorization synchronization has dead letters. Review the failure and retry the records. |
