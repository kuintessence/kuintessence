# 功能示意图接入与依据

基线：`origin/main` 的 `6cda40924501edec94325c1f02b94897f9245b96`。范围固定为上一轮图册的 42 个位置；不新增选址。

## 位置、任务与选型

| 编号／位置 | 用户任务 | 主要类型 | 源码依据 |
| --- | --- | --- | --- |
| D01 我的工作台：计算与数据<br>`/` | 在任务、数据和可用资源之间建立入口关系。 | 资源依赖图 | `packages/web/src/components/workspace-navigation.ts` |
| D02 算力提供方：运营与治理<br>`/cp` | 资源、账号、软件和使用记录对应同一提供方范围。 | 资源依赖图 | `packages/web/src/components/workspace-navigation.ts`、`packages/web/src/components/cp/CpDashboard.tsx` |
| D03 平台管理：运营、审计与配置<br>`/interconnect` | 分清平台运营资源、审计读取和平台配置三类能力。 | 资源依赖图 | `packages/web/src/components/workspace-navigation.ts`、`packages/web/src/components/settings/OperationsPage.tsx` |
| D04 软件生态：资产类型与使用入口<br>`/software#workflow-templates` | 工作流模板组合用例与脚本，软件包提供环境基础。 | 资源依赖图 | `packages/web/src/components/workspace-navigation.ts`、`packages/web/src/lib/software-navigation.ts` |
| D05 个人中心：账号、映射与偏好<br>`/settings#personal/account` | 个人设置为并列功能，不表示必须依次办理。 | 资源依赖图 | `packages/web/src/components/workspace-navigation.ts`、`packages/web/src/components/settings/SettingsPage.tsx` |
| D06 联邦协同：跨机构业务全景<br>`/federation#tasks` | 本站、合作机构与共同证据分别保有各自的权限和状态。 | 资源依赖图 | `packages/web/src/components/workspace-navigation.ts`、`packages/web/src/lib/federation-navigation.ts`、`packages/web/src/components/federation/FederationPage.tsx` |
| G01 计算任务：选择、提交与跟踪<br>`/jobs` | 本地集群与获准合作集群共用选择入口，实际执行按目标分派。 | 业务流程图 | `packages/web/src/components/jobs/JobsPage.tsx`、`packages/web/src/components/jobs/SubmitJobDialog.tsx`、`packages/web/src/lib/queue-selection.ts` |
| G02 工作流：模板、编排与运行<br>`/workflows` | 输入映射与步骤关系属于工作流，运行许可仍由后端独立检查。 | 业务流程图 | `packages/web/src/components/workflows/NewWorkflowPage.tsx`、`packages/web/src/components/workflows/WorkflowRunGraph.tsx` |
| G03 文件空间：云盘、集群与传输<br>`/files` | 文件位置和传输任务是不同实体；传输授权、进度和审计分开观察。 | 资源依赖图 | `packages/web/src/components/files/FilesPage.tsx`、`packages/web/src/components/files/NewTransferSheet.tsx`、`packages/web/src/components/files/TransfersTray.tsx` |
| G04 数据市场：发现、许可与使用<br>`/data-market` | 数据版本、访问申请与实际材料准备分别处理。 | 业务流程图 | `packages/web/src/routes/data-market.tsx`、`packages/web/src/components/cp/CpDataPage.tsx` |
| G05 基础设施：集群、Agent 与连接<br>`/cp/infrastructure` | 集群包含接入代理，调度与互联状态分别观察。 | 运行状态图 | `packages/web/src/components/cp/CpInfrastructurePage.tsx`、`packages/web/src/components/cp/CpAgentsTable.tsx`、`packages/web/src/components/cp/AgentRegistrationPage.tsx` |
| G06 调度资源：队列、账号与软件<br>`/cp/queues` | 队列、账号和软件共同决定可运行条件，不相互替代。 | 资源依赖图 | `packages/web/src/components/cp/CpQueuesPage.tsx`、`packages/web/src/components/cp/CpAccountsPage.tsx`、`packages/web/src/components/cp/SoftwarePolicyTable.tsx` |
| G07 提供方授权：用户与执行身份<br>`/cp/users` | 平台用户、组织成员和集群执行账号属于不同层次。 | 资源依赖图 | `packages/web/src/components/cp/UsersTable.tsx`、`packages/web/src/components/cp/CpAccountsPage.tsx`、`packages/web/src/components/cp/SandboxMappingReviewPanel.tsx` |
| G08 集群软件：策略、材料与运行<br>`/cp/software` | 目录资产经过材料和运行环境准备，才能在目标集群运行。 | 业务流程图 | `packages/web/src/components/cp/SoftwarePolicyTable.tsx`、`packages/web/src/components/software/EcosystemGovernancePanels.tsx` |
| G09 提供方数据：版本、发布与访问<br>`/cp/data` | 资产、不可变版本、发布范围和访问审批构成数据管理关系。 | 业务流程图 | `packages/web/src/components/cp/CpDataPage.tsx`、`packages/web/src/lib/data-market-client.ts` |
| G10 提供方计量：用量、额度与通知<br>`/cp/metering` | 计量查询、配额治理和 Webhook 是相关但独立的功能。 | 资源依赖图 | `packages/web/src/components/cp/MeteringPage.tsx`、`packages/web/src/components/cp/MeteringWebhooks.tsx`、`packages/web/src/components/cp/UsersTable.tsx` |
| G11 平台资源：机构、集群与全局范围<br>`/interconnect` | 机构范围影响资源、账号和软件的可见性。 | 资源依赖图 | `packages/web/src/components/settings/OperationsResources.tsx`、`packages/web/src/components/interconnect/InterconnectDashboard.tsx` |
| G12 组织与授权：身份到资源权限<br>`/settings#security/authz` | 组织成员关系经授权同步进入判定层，再决定页面与资源访问。 | 资源依赖图 | `packages/web/src/components/settings/AuthzAdminPanel.tsx`、`packages/web/src/components/settings/OrganizationMembershipPanel.tsx`、`packages/web/src/components/settings/AuditCapabilityPanel.tsx` |
| G13 平台安全：身份、隔离与敏感信息<br>`/settings#security` | 安全设置是多项独立控制，不组成一次性开通流水线。 | 资源依赖图 | `packages/web/src/components/settings/SettingsPage.tsx`、`packages/web/src/components/settings/SSOConfigForm.tsx`、`packages/web/src/components/settings/DesensitizeAdminPanel.tsx` |
| G14 SSH 会话：凭据、连接与审计<br>`/settings#security/ssh-vault` | 凭据服务支持会话建立；会话观察和录制回放保留独立入口。 | 业务流程图 | `packages/web/src/components/settings/SshCredentialsForm.tsx`、`packages/web/src/components/settings/SshActiveSessions.tsx`、`packages/web/src/components/settings/SshRecordingPlayer.tsx`、`packages/web/src/components/terminal/TerminalPage.tsx` |
| G15 存储治理：根目录、配额与传输<br>`/settings#infrastructure/cluster-file-roots` | 集群目录策略与平台云盘配额分别约束各自的数据空间。 | 资源依赖图 | `packages/web/src/components/settings/ClusterFileRootsPanel.tsx`、`packages/web/src/components/settings/CloudStorageGovernancePanel.tsx`、`packages/web/src/components/settings/FileTransferAuditConfigPanel.tsx` |
| G16 审计与治理：范围、事件与证据<br>`/operations#audit` | 平台事件、提供方事件和 SSH 记录分别拥有自己的读取范围。 | 资源依赖图 | `packages/web/src/components/settings/AuditLogPanel.tsx`、`packages/web/src/components/settings/AuditCapabilityPanel.tsx`、`packages/web/src/components/cp/AuditSearchPanel.tsx` |
| G17 软件管理：申请、审核与生命周期<br>`/software#spack` | 资产提交和审核控制发布，生命周期及下游授权分别管理。 | 业务流程图 | `packages/web/src/components/software/SoftwarePage.tsx`、`packages/web/src/components/software/MaterialLifecycle.tsx` |
| G18 软件授权：证据、审批与环境绑定<br>`/software#spack` | 使用方运行许可与提供方源码／安装许可分别核查。 | 业务流程图 | `packages/web/src/components/software/EcosystemGovernancePanels.tsx` |
| G19 软件构建：配方、材料与安装绑定<br>`/software#spack` | 源材料、配方修订和安装选择均保留稳定版本与来源。 | 资源依赖图 | `packages/web/src/components/software/RecipeRepositoriesPanel.tsx`、`packages/web/src/components/software/SpackMaterialsPanel.tsx`、`packages/web/src/components/software/SpackInstallBindingEditor.tsx` |
| G20 联邦管理：合作算力与信任准备<br>`/settings#security/federation-clusters` | 人员能力、机构信任、输入存储和合作集群独立准备。 | 资源依赖图 | `packages/web/src/components/workspace-navigation.ts`、`packages/web/src/components/settings/FederationClustersPanel.tsx`、`packages/web/src/components/settings/FederationPermissionsPanel.tsx`、`packages/web/src/components/settings/FederationTrustPanel.tsx`、`packages/web/src/components/settings/FederationStoragePanel.tsx` |
| G21 联邦任务：委派、观察与结果<br>`/federation#tasks` | 本站意图、远端接收、真实计算和结果交付分别跟踪。 | 业务流程图 | `packages/web/src/components/federation/FederationTasksPanel.tsx`、`packages/web/src/components/federation/FederationTaskCreate.tsx`、`packages/web/src/components/federation/FederationTaskDetail.tsx` |
| G22 任务市场：公开需求与原请求认领<br>`/federation#market` | 公开需求不包含私有材料和价格；认领关联已送达的原预约请求。 | 业务流程图 | `packages/web/src/components/federation/FederationMarketPanel.tsx`、`packages/web/src/components/federation/MarketClaimForm.tsx`、`packages/web/src/components/federation/CommercialMarketRequestsPanel.tsx` |
| G23 合作协议：条款、双签与有效范围<br>`/federation#agreements` | 双方执行同意与资源范围是任务委派的前置条件。 | 业务流程图 | `packages/web/src/components/federation/AgreementPanel.tsx`、`packages/web/src/components/federation/AgreementTerms.tsx`、`packages/web/src/components/federation/AgreementExchangeStatus.tsx` |
| G24 联邦资产：原件、映射与本地准备<br>`/federation#assets` | 原件摘要、不可变来源和本地版本绑定共同描述材料身份。 | 资源依赖图 | `packages/web/src/components/federation/FederationAssetsPanel.tsx`、`packages/web/src/components/federation/FederationAssetImport.tsx` |
| G25 商业合同：履约、账务与争议<br>`/federation#commercial` | 按现有三组页签组织，财务、自动授权和仲裁权限独立。 | 资源依赖图 | `packages/web/src/components/federation/CommercialPanel.tsx`、`packages/web/src/components/federation/CommercialDetail.tsx` |
| G26 介质交付：加密包到可用结果<br>`/federation#delivery` | 包导出、运输、批准解密和导入回执分别记录。 | 业务流程图 | `packages/web/src/components/federation/MediaDeliveryPanel.tsx`、`packages/web/src/components/federation/MediaDeliveryDetail.tsx`、`packages/web/src/components/federation/MediaDeliveryForm.tsx` |
| G27 仲裁案件：限定证据与独立裁决<br>`/federation#cases` | 仲裁机构 R 只按双方许可读取限定证据并签发原裁决。 | 业务流程图 | `packages/web/src/components/federation/FederationEvidencePanel.tsx`、`packages/web/src/components/federation/EvidenceCaseDetail.tsx`、`packages/web/src/components/federation/ArbitrationDecisionPanel.tsx` |
| G28 介质运输：载体、批次与交接<br>`/federation#logistics` | 运输记录关联介质与交付包，和逻辑数据导入保持独立。 | 业务流程图 | `packages/web/src/components/federation/MediaLogisticsPanel.tsx`、`packages/web/src/components/federation/MediaLogisticsForm.tsx` |
| G29 平台身份：用户、机构与执行账号<br>`/operations#accounts` | 平台登录用户与实际执行账号是不同对象，授权由组织和资源范围连接。 | 资源依赖图 | `packages/web/src/components/settings/OperationsResources.tsx`、`packages/web/src/components/settings/PlatformUsersTable.tsx`、`packages/web/src/components/settings/OrganizationMembershipPanel.tsx` |
| G30 Agent 证书：登记、有效性与撤销<br>`/settings#security/agent-certs` | 证书身份支持 Agent 接入；证书有效与调度可用是独立状态。 | 业务流程图 | `packages/web/src/components/settings/AgentCertsPanel.tsx`、`packages/web/src/components/agent/AgentCertRevokeDialog.tsx`、`packages/web/src/components/cp/AgentRegistrationPage.tsx` |
| T01 授权专题：同步、差异与恢复<br>`/settings#security/authz` | 结构图映射实际健康、差异和 outbox；未知不会显示为正常。 | 运行状态图 | `packages/web/src/components/settings/AuthzAdminPanel.tsx` |
| T02 联盟链专题：三种合作模式<br>`/federation#agreements` | 按协议模式分别观察执行、账务和存证，联盟链是条件性参与方。 | 业务流程图 | `packages/web/src/components/federation/AgreementTerms.tsx`、`packages/web/src/components/federation/CommercialDetail.tsx`、`packages/web/src/components/federation/GovernanceProgress.tsx` |
| T03 账务专题：用量、结算与付款<br>`/federation#commercial` | 账单确认、结算与外部付款凭证不合并为一个已完成状态。 | 资源依赖图 | `packages/web/src/components/federation/CommercialUsagePanel.tsx`、`packages/web/src/components/federation/CommercialBillingPanel.tsx`、`packages/web/src/components/federation/CommercialSettlementPanel.tsx`、`packages/web/src/components/federation/CommercialPaymentPanel.tsx` |
| T04 争议专题：冻结、裁决与执行<br>`/federation#commercial` | 开案、披露、裁决送达和实际执行保留各自的人员责任。 | 业务流程图 | `packages/web/src/components/federation/CommercialDisputePanel.tsx`、`packages/web/src/components/federation/CommercialArbitrationPanel.tsx`、`packages/web/src/components/federation/CommercialDisputeProgress.tsx` |
| T05 联邦信任：机构、密钥与人员能力<br>`/settings#security/federation-trust` | 传输认证、消息验签、协议和人员能力共同约束跨站操作。 | 资源依赖图 | `packages/web/src/components/settings/FederationTrustPanel.tsx`、`packages/web/src/components/settings/FederationTrustForms.tsx`、`packages/web/src/components/settings/FederationPermissionsPanel.tsx` |
| T06 合作集群：统一选择与远端执行<br>`/settings#security/federation-clusters` | 映射远端队列后，普通作业选择器显示获准合作集群。 | 业务流程图 | `packages/web/src/components/settings/FederationClustersPanel.tsx`、`packages/web/src/components/settings/FederationClusterProfiles.tsx`、`packages/web/src/components/jobs/SubmitJobDialog.tsx`、`packages/web/src/lib/queue-selection.ts` |

## 实现组织

- `packages/web/src/components/function-maps/catalog.json` 是固定 42 个位置的结构化业务模型，包含中英文名称、目的、角色、起止条件、节点前置条件／输入／输出、类型化关系、真实页面入口和源码依据。维护时直接修改该文件，并同步两种语言。它不保存实例进度或运行健康。
- 每个节点通过 `icon` 指定业务语义图标，`icons.tsx` 静态引用现有 Lucide SVG 组件；231 个配置节点均已指定图标，运行时 Agent 和空清单查询节点也有各自图标。桌面节点使用同一图标组件，以现有 `--brand` 适配深浅主题，无需网络、字体图标或外部图片。图标不表示实时健康；文字仍负责名称、类型与状态说明。桌面节点宽度为 208px，为图标与文本保留独立空间；运行节点额外保留状态摘要高度。
- `model.ts` 定义模型、关系和数据获取状态；`access.ts` 复用工作区导航授权与显式联邦能力，过滤节点及相连边，不补造跨越隐藏节点的连线。
- `FunctionMaps.tsx` 接入现有 TanStack Router、Query、登录和活动组织；`FunctionMapView.tsx` 仅负责模型布局、SVG 交互和节点弹窗。已有 Dagre 自动布局；较长流程按原有图层折为三列往返行，保留分支及每条关系的箭头方向，避免横向长链缩成难以辨认的小字；纯包含关系及无连线节点使用紧凑网格布局，业务含义不依赖坐标。
- `runtime.ts` 是纯数据适配层。基础设施页把现有查询结果传入，授权页把现有手动刷新快照传入；绘图组件不判断业务操作是否成功，不触发安装、提交、授权、撤销、重建或入账。
- `function-maps.css` 仅引用 `app.css` 的语义变量，浅色／深色均跟随现有主题。节点使用平面轮廓，移除 2.5D 底座；外层沿用无卡片外框的 PageShell。图形自动缩放到可用宽度，高度不超过 360px 或视口高度的 46%，不提供内部滚动、拖拽、缩放或展开大图。

## 选型中的关键判断

- 六个大菜单是能力目录，采用带明确包含关系的资源依赖图，不按菜单顺序绘制办理流水线。
- G12 区分组织成员关系、同步服务、授权服务和独立审计能力；T01 才显示实际同步队列、健康检查与就绪字段。
- G19 表达配方、材料修订和安装绑定的引用关系；G24 表达原件、摘要与本地映射。它们不宣称材料已到达或软件已安装。
- T03 采用资源依赖图：用量、账单、结算、付款和收尾相互引用，不存在所有合同都必须遵循的固定付款顺序。
- G23 将双方签名作为独立条件汇合，不假定双方固定签署顺序。T02 只有一种主要类型（业务流程），按真实的 `bilateral_direct`、`bilateral_attested`、`ledger_coordinated` 分支。
- G21 表达流程模板，送达、计算、复制、结果确认和实际停止分别核查；不根据模板给某次委派标进度。T04 同时保留通用和解与仲裁路径，避免把 R 裁决当作所有争议的必经步骤。

## 入口与上下文

图放入原页面及其既有权限边界内。算力中心和平台运营的组织范围选择器统一放在二级导航标题下，不占用图形或业务内容区。大菜单与同页功能组使用图选择器，默认一张；License、材料管理、商业合同及账务／争议分别在已有区域中接入。未移除原来的表单、按钮、Tab 或列表。

点击节点弹出目的、前置条件、输入输出、业务关系、运行状态及页内位置；弹窗限制在当前视口内，较长内容仅在弹窗正文滚动。关闭后焦点回到原节点。打开已有表单或入口时先关闭节点弹窗。界面不展示源码依据、画法说明及操作提示。点击“打开已有入口”才跳转：

- 作业的资源选择和提交确认直接打开原 SubmitJobDialog，保留页面当前筛选和已有校验，不提交作业。
- 商业合同内使用原 `setSection` 切换条款、用量、账单、结算、付款、争议等 Tab，保留当前合同 revisionId、组织和草稿状态；协调模式专属入口及免费合同不适用的付款入口不显示。
- Agent 实例链接保留真实 Agent ID，进入原清单后定位对应行；没有新增 Agent 详情 API。
- 其余跳转使用现有 route/hash，保留 `tenantId`、`projectId`、`region`、`providerOrgId`、`orgId` 字符串参数。活动组织继续由现有组织上下文保存，不因图跳转重新选择；不会复制 token、分页或无关对象 ID。
- 对于没有深链的 React 页内功能，说明现有页面内位置，再进入已有页面；不编造 URL 或声称已定位某个业务对象。跨页面选择某个具体仲裁案件等能力仍以原页面支持的入口为准。

依赖图中的“使用／调用／部署于／属于／包含／观测”与“依赖”分开命名。只有 `depends-on` 关系使用“A → B 代表 A 依赖 B”的约定；当前无可靠部署或调用证据的位置不会补出此类边。设计关系统一标注为实现已确认的设计关系；不冒充实际配置或观测拓扑。循环关系保留，图上可达不代表根因或故障传播。

## 实际运行数据及缺口

| 位置 | 来源与判定 | 时间与刷新 | 保持未知的内容 |
| --- | --- | --- | --- |
| G05 基础设施 | `useCpAgents` 的 `GET /cp/agents`：只展示服务端 `status`；`useCpSoftwareOverview` 的 `GET /cp/software/overview`：按 Agent ID 与提供方匹配心跳和控制通道 | 清单 30 秒、概览 15 秒；手动刷新两者。`lastHeartbeat` 只代表最近心跳。两个获取时间分开说明 | online 不证明业务健康；没有接入 computeHealth、任务进度，status 没有独立观测时间，不用心跳时间冒充 status 采集时间 |
| T01 授权同步 | `AuthzAdminPanel` 已有 health／readiness／shadow-diffs／outbox；死信大于 0 表示该项确认异常；健康 boolean 只表示 SpiceDB 探测；enforceReady 独立显示，externalSmokeRequired 不省略 | 沿用原手动刷新。接口未返回观测时间，显示“数据源未提供”；页面获取时间单列 | 成员事件是否实际投递、恢复操作是否完成未接入；0 差异不直接证明可切换强制模式；不据刷新失败推断服务故障 |

G05 最多展示获准清单前 24 项，并说明已显示数／清单数；没有连线时明确没有已确认关系。其他图是流程模板或设计关系，不含伪造数量、在线状态或执行实例。

数据获取状态单独区分加载、未知、无数据、无权限、获取失败与过期；资源生命周期、进度和健康也分别建模。当前来源未提供通用 TTL 或过期判定，因此不会仅因刷新失败或经过一段任意时间就宣布过期。获取失败时不展示旧的私有数据；授权页旧快照全部清除，未知数量不再显示为 0。

## 权限、取消与刷新

前端复用 `canUseWorkspaceIdentity`、`canUseWorkspaceNavItem`、`useMeCapabilities` 及 `/federation/capabilities` 的 effectiveCapabilities。平台管理员不自动拥有联邦业务能力；能力获取失败时关闭对应入口，节点与相连边一起消失，旧说明也清除。后端授权保持原有实现。

组织、会话或角色变化会重建图的选择状态。联邦能力查询带组织及会话 revision 并传入 TanStack 的 AbortSignal。提供方两个数据查询增加会话 revision 隔离与请求取消；CP 读取在发送、重试和接收后检查组织／会话范围，避免旧响应写入新对象视图。授权手动刷新取消前一次请求，卸载时取消，在每次写入前检查 signal，较旧结果不能覆盖新快照。

## 可访问性与本地验证方法

SVG 内使用原生 button，支持 Tab、Enter、Space 与可见焦点，以 aria-haspopup 和 aria-expanded 表达节点弹窗。弹窗复用现有 Dialog，支持 Escape、点击外部关闭及焦点返回。宽度小于 768px 时隐藏整套示意图及其选择、外观控件；页面既有业务入口继续可用。主题与状态均保留文字，不只靠颜色。

外观弹层提供静态／流动切换、语义颜色、1–3px 线宽与 1–5 秒流动周期；设置作用于当前图组件，默认静态。动态粒子沿原有关系方向移动，不改变实线／虚线语义，不表示业务实际执行中；系统减少动态效果设置会关闭流动。滚轮直接滚动页面。

`packages/web/visual/` 是本地组件验收夹具，复用正式组件及 app.css；其模拟数据始终标记为本地演示，按钮只显示目标，不连接后端。它没有进入正式路由。构建与验证不会启动平台服务：

```bash
bun node_modules/vite/bin/vite.js build --config packages/web/visual/function-maps.config.ts
node packages/web/visual/verify-function-maps.mjs
```

若单次检查受执行时限限制，可按 `KQ_MAP_THEME=light`／`dark` 拆分深浅主题，并分别设置 `KQ_MAP_WIDTH=1440`、`390`、`320` 运行同一脚本；每批写独立的 verification JSON，汇总三批计数并保留原报告。

浏览器脚本从本机已有 Patchright 读取 Chromium；`KQ_CHROMIUM_PATH` 可以指定本机路径。输出位于 `.impeccable/review/`，包括尺寸、语言、主题和交互统计。

宿主页面原有单元测试对新增图组件做隔离，继续验证各自业务行为。新增图单元测试则挂载真实 QueryClient 与内存 Router，核对权限撤销、组织切换、保留上下文、节点解释及只导航不执行变更；模型和适配层另检验关键关系、真实来源、固定 42 项覆盖和状态语义。

## 已执行检查

- 完整 Web 回归：197 个测试文件、2563 项测试通过。随后增加宿主导航检查，作业及商业合同两个文件的 60 项测试通过；运行节点呈现修复后，图视图、权限适配、模型和上述宿主共 5 个文件的 74 项测试通过；新增检查确认现有作业弹窗、合同 revision 与组织范围，以及只导航、不提交。
- 完整根级 `bun run typecheck` 通过，包含 protobuf 生成、所有包、Fabric 测试代码和 site-release 静态类型检查。
- 全仓 `bun run lint` 通过，现存 57 个 warnings、2 个 infos；没有将其视为零告警。
- Web 生产构建通过；输出仍报告大于 500 kB 的 chunk，以及共享 federation 签名模块的 `node:crypto` 浏览器 externalization 警告。本次没有测量改动前后的体积差或完成包体优化。
- 浏览器组合检查：42 张图 × 1440／390／320 三种宽度 × 深浅主题 × 中英文，共 504 次渲染、2736 次节点激活、16 张代表截图；无页面脚本错误及整页横向溢出。历史脚本同时检查手机关系文本、原生按钮 Enter 激活和加载／无权限／错误／已获取场景，以及桌面运行节点摘要的文字边界。本轮按三种宽度分批运行，三批各 168 次渲染、912 次激活，保留各批 JSON 并汇总。此处记录旧版验收；当前交互以本文“可访问性与本地验证方法”为准。它不等于所有 SVG 标签几何已逐项人工检查，也不代表生产页面在线验收。
- 独立 HTML 预览已在浏览器以普通 file URL 打开，确认 42 项选择、深浅切换与无页面脚本错误；不需要启动平台服务。
- 设计检测器未发现 primary findings，报告两处 11px 字号偏离 DESIGN.md 字号阶梯的 advisory，交由视觉审阅核对。

## 视觉审阅与交付文件

独立视觉审阅逐张检查 15 张效果图，指出运行图未在节点上独立呈现健康状态。修复后重新捕获原图并增加 T01 深色中文 390px；复核评分为 resolved、disposition 为 ship，仅确认该修复项解决及未见其引入的可见回归。没有据此扩大生产或完整读屏验收范围。节点现在优先显示名称、获取状态与健康短文字，完整字段依据保留在详情。

设计文档只读对照已完成，确认本次属于现有 Operate 界面的普通扩展，保留 DESIGN.md。既有 `.impeccable/design.json` 不存在而 DESIGN.md 仍有其引用；本次未创建或修复该既有状态。

独立图册位于 `/root/kq-bundles/artifacts/function-maps-20261115/功能图预览.html`，内嵌当前正式组件构建，可直接打开、选择全部 42 张图、切换主题和语言。它仍是本地演示，使用标记的模拟状态且不发起业务操作；正式页面上的入口才复用真实路由和查询。

### SVG 图标补齐

前版只渲染节点底座与文字，缺少业务图标。本轮为所有配置节点补充显式 `icon`，并给真实 Agent 实例和空清单查询补充图标。图标渲染为本地内联 SVG，作为装饰从辅助技术中隐藏，按钮名称与键盘操作继续由文字和原生按钮提供。主题切换不依赖重新加载图片。

图标补齐后的相关 3 个测试文件共 15 项通过，全仓 lint（保留 57 warnings、2 infos）、typecheck 和 Web 生产构建通过。浏览器三批完整复核共 504 次渲染、2736 次节点激活，覆盖 42 张图、三种宽度、深浅色、中英文；每个可见节点均包含有几何内容、正确 SVG 命名空间、可见描边且在按钮边界内的图标，无页面脚本错误。首轮未完成的检查不计入该统计。16 张代表截图已重录；独立 HTML 已在普通 file URL 下验证 42 项选择、深浅色图标与无页面脚本错误。前文独立视觉审阅对应图标补齐前版本；本轮在本地对照检查桌面、运行摘要和手机截图。

2026-11-16 提交前再次运行完整 Web 回归，198 个文件、2567 项测试全部通过；界面规范扫描、741 项本地文档链接及 workflow 引用检查通过。

## 交付边界

本次修改正式页面与组件。提交前的本地验收没有创建、重启或变更真实生产资源；发布状态以对应提交的生产部署流水线及站点验收结果为准。运行接口已在代码中接入；本地模拟截图不能证明生产集群健康、当前账务或某次任务进度。完整辅助技术人工验收、真实生产角色组合与跨机构运行观察仍未执行。
