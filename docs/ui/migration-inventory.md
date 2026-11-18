# 全平台组件迁移清单

此清单按当前源码生成，包含所有路由与业务组件（排除测试、生成文件与 UI 基础组件）。每个表单控件单独列出；页签、弹窗、抽屉及编辑器通过所属组件覆盖。静态遍历不等于逐页浏览器验收，实际渲染范围见 verification.md。

运行 `bun scripts/check-ui-surfaces.ts --write` 更新；不带参数执行静态回归。

## packages/web/src/components/AppShell.tsx

容器：继承父容器 / 无独立容器。

已检查：无独立填写字段。复用共用组件或保留业务列表/展示、画布、权限及错误边界。

## packages/web/src/components/CapabilityLoadingOverlay.tsx

容器：继承父容器 / 无独立容器。

已检查：无独立填写字段。复用共用组件或保留业务列表/展示、画布、权限及错误边界。

## packages/web/src/components/GlobalErrorPage.tsx

容器：继承父容器 / 无独立容器。

已检查：无独立填写字段。复用共用组件或保留业务列表/展示、画布、权限及错误边界。

## packages/web/src/components/OrganizationQueryScope.tsx

容器：继承父容器 / 无独立容器。

已检查：无独立填写字段。复用共用组件或保留业务列表/展示、画布、权限及错误边界。

## packages/web/src/components/ProtectedRoute.tsx

容器：继承父容器 / 无独立容器。

已检查：无独立填写字段。复用共用组件或保留业务列表/展示、画布、权限及错误边界。

## packages/web/src/components/ThemeProvider.tsx

容器：继承父容器 / 无独立容器。

已检查：无独立填写字段。复用共用组件或保留业务列表/展示、画布、权限及错误边界。

## packages/web/src/components/WorkspaceSidebar.tsx

容器：继承父容器 / 无独立容器。

已检查：无独立填写字段。复用共用组件或保留业务列表/展示、画布、权限及错误边界。

## packages/web/src/components/agent/AgentCertRevokeDialog.tsx

容器：DialogContent:55。

| 行 | 控件 / 字段 | 状态 | 原因 |
| --- | --- | --- | --- |
| 73 | Textarea · {reasonId} | 保留 | 只读、受权限或状态约束的字段，保留原数据展示与禁用规则。 |

## packages/web/src/components/agents/AgentCard.tsx

容器：Card:72。

已检查：无独立填写字段。复用共用组件或保留业务列表/展示、画布、权限及错误边界。

## packages/web/src/components/agents/AgentSiteOperations.tsx

容器：继承父容器 / 无独立容器。

已检查：无独立填写字段。复用共用组件或保留业务列表/展示、画布、权限及错误边界。

## packages/web/src/components/agents/AgentSoftwarePage.tsx

容器：继承父容器 / 无独立容器。

已检查：无独立填写字段。复用共用组件或保留业务列表/展示、画布、权限及错误边界。

## packages/web/src/components/agents/AgentsPage.tsx

容器：PageShell:29。

已检查：无独立填写字段。复用共用组件或保留业务列表/展示、画布、权限及错误边界。

## packages/web/src/components/cp/AgentRegistrationPage.tsx

容器：Card:210、Card:400、Card:441。

| 行 | 控件 / 字段 | 状态 | 原因 |
| --- | --- | --- | --- |
| 224 | ResourceSelectField · "agent-registration-provider" | 已替换 | 共用 Radix Popover + cmdk / Dialog 资源选择器，沿用业务候选与 stable ID。 |
| 258 | Input · "agent-registration-ttl" | 保留 | 数值输入；共用 Input 提供合法范围内的原生预设，并保留自定义数值与 min/max/step。 |
| 284 | Input · "agent-registration-agent-id" | 保留 | 登记新 Agent 的标识或名称，属于创建内容，不限制为已有资源。 |
| 301 | Input · "agent-registration-site-name" | 保留 | 登记新 Agent 的标识或名称，属于创建内容，不限制为已有资源。 |
| 334 | NativeSelect · "agent-registration-scheduler" | 保留 | 少量固定枚举、分页大小、布尔策略或共用资源选择器的原生表单桥接，保留统一简单选择。 |
| 472 | Input · {`agent-registration-token-value-${token.id}`} | 保留 | 自由内容（名称、路径、命令、表达式、凭据或搜索查询），保持原提交与校验。 |

## packages/web/src/components/cp/AuditSearchPanel.tsx

容器：继承父容器 / 无独立容器。

| 行 | 控件 / 字段 | 状态 | 原因 |
| --- | --- | --- | --- |
| 198 | Input · "cp-audit-from" | 保留 | 自由内容（名称、路径、命令、表达式、凭据或搜索查询），保持原提交与校验。 |
| 210 | Input · "cp-audit-to" | 保留 | 自由内容（名称、路径、命令、表达式、凭据或搜索查询），保持原提交与校验。 |
| 222 | Input · "cp-audit-text" | 保留 | 自由内容（名称、路径、命令、表达式、凭据或搜索查询），保持原提交与校验。 |

## packages/web/src/components/cp/CpAccountsPage.tsx

容器：Card:128、DialogContent:228。

已检查：无独立填写字段。复用共用组件或保留业务列表/展示、画布、权限及错误边界。

## packages/web/src/components/cp/CpAgentsTable.tsx

容器：继承父容器 / 无独立容器。

已检查：无独立填写字段。复用共用组件或保留业务列表/展示、画布、权限及错误边界。

## packages/web/src/components/cp/CpAttentionCards.tsx

容器：继承父容器 / 无独立容器。

已检查：无独立填写字段。复用共用组件或保留业务列表/展示、画布、权限及错误边界。

## packages/web/src/components/cp/CpCapabilityError.tsx

容器：继承父容器 / 无独立容器。

已检查：无独立填写字段。复用共用组件或保留业务列表/展示、画布、权限及错误边界。

## packages/web/src/components/cp/CpDashboard.tsx

容器：Card:136、Card:171、Card:197。

已检查：无独立填写字段。复用共用组件或保留业务列表/展示、画布、权限及错误边界。

## packages/web/src/components/cp/CpDataPage.tsx

容器：PageShell:223。

| 行 | 控件 / 字段 | 状态 | 原因 |
| --- | --- | --- | --- |
| 236 | Input · {name} | 保留 | 自由内容（名称、路径、命令、表达式、凭据或搜索查询），保持原提交与校验。 |
| 267 | Input · {version} | 保留 | 发布或登记新版本的版本号，属于创建内容；已有版本引用在独立资源选择控件中处理。 |
| 275 | ResourceSelectField · "cp-data-agent-select" | 已替换 | 共用 Radix Popover + cmdk / Dialog 资源选择器，沿用业务候选与 stable ID。 |
| 300 | ResourceSelectField · "cp-data-root-select" | 已替换 | 共用 Radix Popover + cmdk / Dialog 资源选择器，沿用业务候选与 stable ID。 |
| 320 | Input · {relativePath} | 保留 | 自由内容（名称、路径、命令、表达式、凭据或搜索查询），保持原提交与校验。 |

## packages/web/src/components/cp/CpInfrastructurePage.tsx

容器：继承父容器 / 无独立容器。

已检查：无独立填写字段。复用共用组件或保留业务列表/展示、画布、权限及错误边界。

## packages/web/src/components/cp/CpLayout.tsx

容器：继承父容器 / 无独立容器。

已检查：无独立填写字段。复用共用组件或保留业务列表/展示、画布、权限及错误边界。

## packages/web/src/components/cp/CpManageBoundary.tsx

容器：继承父容器 / 无独立容器。

已检查：无独立填写字段。复用共用组件或保留业务列表/展示、画布、权限及错误边界。

## packages/web/src/components/cp/CpQueuesPage.tsx

容器：DialogContent:1074。

| 行 | 控件 / 字段 | 状态 | 原因 |
| --- | --- | --- | --- |
| 957 | Input · "cp-queues-search" | 保留 | 自由内容（名称、路径、命令、表达式、凭据或搜索查询），保持原提交与校验。 |
| 965 | ResourceSelectField · "cp-queues-agent-filter" | 已替换 | 共用 Radix Popover + cmdk / Dialog 资源选择器，沿用业务候选与 stable ID。 |
| 981 | input · input | 保留 | 勾选、单选、文件上传或隐藏表单值，保留原生语义。 |
| 1082 | Input · "cp-queue-field-queue-id" | 保留 | 创建或登记调度器队列的外部标识/QoS/标签；不是选择现有平台队列，没有权威枚举来源。 |
| 1092 | Input · "cp-queue-field-name" | 保留 | 自由内容（名称、路径、命令、表达式、凭据或搜索查询），保持原提交与校验。 |
| 1105 | ResourceSelectField · "cp-queue-field-provider-org-id" | 已替换 | 共用 Radix Popover + cmdk / Dialog 资源选择器，沿用业务候选与 stable ID。 |
| 1124 | input · "cp-queue-field-provider-org-id" | 保留 | 勾选、单选、文件上传或隐藏表单值，保留原生语义。 |
| 1131 | ResourceSelectField · "cp-queue-field-agent-id" | 已替换 | 共用 Radix Popover + cmdk / Dialog 资源选择器，沿用业务候选与 stable ID。 |
| 1176 | input · "cp-queue-target-default" | 保留 | 勾选、单选、文件上传或隐藏表单值，保留原生语义。 |
| 1187 | input · "cp-queue-target-named" | 保留 | 勾选、单选、文件上传或隐藏表单值，保留原生语义。 |
| 1225 | ResourceSelectField · "cp-queue-field-queue-name" | 已替换 | 共用 Radix Popover + cmdk / Dialog 资源选择器，沿用业务候选与 stable ID。 |
| 1274 | Input · "cp-queue-field-qos" | 保留 | 创建或登记调度器队列的外部标识/QoS/标签；不是选择现有平台队列，没有权威枚举来源。 |
| 1282 | input · "cp-queue-field-enabled" | 保留 | 勾选、单选、文件上传或隐藏表单值，保留原生语义。 |
| 1301 | input · "cp-queue-field-visible-org-ids" | 保留 | 勾选、单选、文件上传或隐藏表单值，保留原生语义。 |
| 1317 | input · input | 保留 | 勾选、单选、文件上传或隐藏表单值，保留原生语义。 |
| 1338 | Input · "cp-queue-field-policy-tags" | 保留 | 创建或登记调度器队列的外部标识/QoS/标签；不是选择现有平台队列，没有权威枚举来源。 |

## packages/web/src/components/cp/DataDisclosurePolicyPanel.tsx

容器：继承父容器 / 无独立容器。

| 行 | 控件 / 字段 | 状态 | 原因 |
| --- | --- | --- | --- |
| 203 | Input · {`${formId}-expiry`} | 保留 | 只读、受权限或状态约束的字段，保留原数据展示与禁用规则。 |
| 217 | Input · {`${formId}-reason`} | 保留 | 只读、受权限或状态约束的字段，保留原数据展示与禁用规则。 |

## packages/web/src/components/cp/EditAccountQueues.tsx

容器：DialogContent:30。

| 行 | 控件 / 字段 | 状态 | 原因 |
| --- | --- | --- | --- |
| 62 | Input · {id} | 保留 | 只读、受权限或状态约束的字段，保留原数据展示与禁用规则。 |

## packages/web/src/components/cp/EditPolicyDialog.tsx

容器：继承父容器 / 无独立容器。

| 行 | 控件 / 字段 | 状态 | 原因 |
| --- | --- | --- | --- |
| 89 | NativeSelect · "edit-policy-list" | 保留 | 少量固定枚举、分页大小、布尔策略或共用资源选择器的原生表单桥接，保留统一简单选择。 |
| 104 | Textarea · "edit-policy-specs" | 保留 | 自由内容（名称、路径、命令、表达式、凭据或搜索查询），保持原提交与校验。 |

## packages/web/src/components/cp/KpiTile.tsx

容器：Card:33。

已检查：无独立填写字段。复用共用组件或保留业务列表/展示、画布、权限及错误边界。

## packages/web/src/components/cp/MeteringChart.tsx

容器：继承父容器 / 无独立容器。

已检查：无独立填写字段。复用共用组件或保留业务列表/展示、画布、权限及错误边界。

## packages/web/src/components/cp/MeteringPage.tsx

容器：PageShell:117。

| 行 | 控件 / 字段 | 状态 | 原因 |
| --- | --- | --- | --- |
| 152 | NativeSelect · "metering-period" | 保留 | 少量固定枚举、分页大小、布尔策略或共用资源选择器的原生表单桥接，保留统一简单选择。 |
| 169 | NativeSelect · "metering-grouping" | 保留 | 少量固定枚举、分页大小、布尔策略或共用资源选择器的原生表单桥接，保留统一简单选择。 |
| 186 | Input · "metering-from" | 保留 | 自由内容（名称、路径、命令、表达式、凭据或搜索查询），保持原提交与校验。 |
| 198 | Input · "metering-to" | 保留 | 自由内容（名称、路径、命令、表达式、凭据或搜索查询），保持原提交与校验。 |

## packages/web/src/components/cp/MeteringWebhooks.tsx

容器：Card:90。

| 行 | 控件 / 字段 | 状态 | 原因 |
| --- | --- | --- | --- |
| 174 | Input · "webhook-url" | 保留 | 只读、受权限或状态约束的字段，保留原数据展示与禁用规则。 |
| 188 | Input · "webhook-secret" | 保留 | 只读、受权限或状态约束的字段，保留原数据展示与禁用规则。 |
| 203 | input · "webhook-event-daily" | 保留 | 勾选、单选、文件上传或隐藏表单值，保留原生语义。 |
| 213 | input · "webhook-event-monthly" | 保留 | 勾选、单选、文件上传或隐藏表单值，保留原生语义。 |
| 224 | input · "webhook-enabled" | 保留 | 勾选、单选、文件上传或隐藏表单值，保留原生语义。 |

## packages/web/src/components/cp/ProviderOrganizationSelector.tsx

容器：继承父容器 / 无独立容器。

| 行 | 控件 / 字段 | 状态 | 原因 |
| --- | --- | --- | --- |
| 78 | ResourceSelectField · {t("cp.organizationSelector.ariaLabel")} | 已替换 | 共用 Radix Popover + cmdk / Dialog 资源选择器，沿用业务候选与 stable ID。 |

## packages/web/src/components/cp/RegisterExecutionAccount.tsx

容器：DialogContent:45。

| 行 | 控件 / 字段 | 状态 | 原因 |
| --- | --- | --- | --- |
| 133 | ResourceSelectField · {`${id}-agent`} | 已替换 | 共用 Radix Popover + cmdk / Dialog 资源选择器，沿用业务候选与 stable ID。 |
| 156 | Input · {`${id}-name`} | 保留 | 自由内容（名称、路径、命令、表达式、凭据或搜索查询），保持原提交与校验。 |
| 163 | Input · {`${id}-${name}`} | 保留 | 数值输入；共用 Input 提供合法范围内的原生预设，并保留自定义数值与 min/max/step。 |
| 186 | input · "sharedService" | 保留 | 勾选、单选、文件上传或隐藏表单值，保留原生语义。 |

## packages/web/src/components/cp/SandboxMappingReviewPanel.tsx

容器：继承父容器 / 无独立容器。

已检查：无独立填写字段。复用共用组件或保留业务列表/展示、画布、权限及错误边界。

## packages/web/src/components/cp/SoftwareInstalledSpecList.tsx

容器：继承父容器 / 无独立容器。

已检查：无独立填写字段。复用共用组件或保留业务列表/展示、画布、权限及错误边界。

## packages/web/src/components/cp/SoftwareOperations.tsx

容器：继承父容器 / 无独立容器。

| 行 | 控件 / 字段 | 状态 | 原因 |
| --- | --- | --- | --- |
| 401 | NativeSelect · "cp-software-operation-action-filter" | 保留 | 少量固定枚举、分页大小、布尔策略或共用资源选择器的原生表单桥接，保留统一简单选择。 |

## packages/web/src/components/cp/SoftwarePolicyAgentDetailSheet.tsx

容器：SheetContent:494。

| 行 | 控件 / 字段 | 状态 | 原因 |
| --- | --- | --- | --- |
| 549 | NativeSelect · "cp-software-operation-action" | 保留 | 少量固定枚举、分页大小、布尔策略或共用资源选择器的原生表单桥接，保留统一简单选择。 |
| 562 | Input · "cp-software-operation-spec" | 保留 | 自由内容（名称、路径、命令、表达式、凭据或搜索查询），保持原提交与校验。 |
| 616 | NativeSelect · "cp-software-batch-action" | 保留 | 少量固定枚举、分页大小、布尔策略或共用资源选择器的原生表单桥接，保留统一简单选择。 |
| 629 | Textarea · "cp-software-batch-specs" | 保留 | 自由内容（名称、路径、命令、表达式、凭据或搜索查询），保持原提交与校验。 |

## packages/web/src/components/cp/SoftwarePolicySummary.tsx

容器：继承父容器 / 无独立容器。

已检查：无独立填写字段。复用共用组件或保留业务列表/展示、画布、权限及错误边界。

## packages/web/src/components/cp/SoftwarePolicyTable.tsx

容器：PageShell:219、Card:358、Card:630、SheetContent:796。

| 行 | 控件 / 字段 | 状态 | 原因 |
| --- | --- | --- | --- |
| 646 | Input · "cp-software-preview-spec" | 保留 | 自由内容（名称、路径、命令、表达式、凭据或搜索查询），保持原提交与校验。 |
| 658 | Input · "cp-software-preview-usecase" | 保留 | 策略预览接受用例或版本标识/匹配模式；当前目录不能完整枚举策略对象，保留原查询契约。 |
| 670 | Input · "cp-software-preview-usecase-version" | 保留 | 策略预览接受用例或版本标识/匹配模式；当前目录不能完整枚举策略对象，保留原查询契约。 |
| 812 | ResourceSelectField · {draft.providerOrgId} | 已替换 | 共用 Radix Popover + cmdk / Dialog 资源选择器，沿用业务候选与 stable ID。 |
| 828 | NativeSelect · {draft.installMode} | 保留 | 少量固定枚举、分页大小、布尔策略或共用资源选择器的原生表单桥接，保留统一简单选择。 |
| 843 | input · input | 保留 | 勾选、单选、文件上传或隐藏表单值，保留原生语义。 |
| 851 | input · input | 保留 | 勾选、单选、文件上传或隐藏表单值，保留原生语义。 |
| 893 | input · input | 保留 | 勾选、单选、文件上传或隐藏表单值，保留原生语义。 |
| 979 | Textarea · {id} | 保留 | 自由内容（名称、路径、命令、表达式、凭据或搜索查询），保持原提交与校验。 |

## packages/web/src/components/cp/SpackCatalogPickerDialog.tsx

容器：DialogContent:153。

| 行 | 控件 / 字段 | 状态 | 原因 |
| --- | --- | --- | --- |
| 287 | ResourceSelectField · "cp-spack-catalog-version" | 已替换 | 共用 Radix Popover + cmdk / Dialog 资源选择器，沿用业务候选与 stable ID。 |
| 332 | NativeSelect · {variantInputId} | 保留 | 少量固定枚举、分页大小、布尔策略或共用资源选择器的原生表单桥接，保留统一简单选择。 |
| 353 | Input · {variantInputId} | 保留 | 自由内容（名称、路径、命令、表达式、凭据或搜索查询），保持原提交与校验。 |
| 393 | Input · "cp-spack-catalog-spec" | 保留 | 自由内容（名称、路径、命令、表达式、凭据或搜索查询），保持原提交与校验。 |

## packages/web/src/components/cp/UsersTable.tsx

容器：继承父容器 / 无独立容器。

| 行 | 控件 / 字段 | 状态 | 原因 |
| --- | --- | --- | --- |
| 90 | Input · "cp-users-search" | 保留 | 自由内容（名称、路径、命令、表达式、凭据或搜索查询），保持原提交与校验。 |
| 104 | input · input | 保留 | 勾选、单选、文件上传或隐藏表单值，保留原生语义。 |

## packages/web/src/components/dashboard/AgentsTable.tsx

容器：继承父容器 / 无独立容器。

已检查：无独立填写字段。复用共用组件或保留业务列表/展示、画布、权限及错误边界。

## packages/web/src/components/dashboard/AttentionOverviewCard.tsx

容器：Card:56。

已检查：无独立填写字段。复用共用组件或保留业务列表/展示、画布、权限及错误边界。

## packages/web/src/components/dashboard/Dashboard.tsx

容器：PageShell:114。

已检查：无独立填写字段。复用共用组件或保留业务列表/展示、画布、权限及错误边界。

## packages/web/src/components/dashboard/EventsList.tsx

容器：继承父容器 / 无独立容器。

已检查：无独立填写字段。复用共用组件或保留业务列表/展示、画布、权限及错误边界。

## packages/web/src/components/dashboard/QuickStart.tsx

容器：Card:68。

已检查：无独立填写字段。复用共用组件或保留业务列表/展示、画布、权限及错误边界。

## packages/web/src/components/dashboard/StatCard.tsx

容器：Card:31。

已检查：无独立填写字段。复用共用组件或保留业务列表/展示、画布、权限及错误边界。

## packages/web/src/components/dashboard/ThroughputChart.tsx

容器：继承父容器 / 无独立容器。

已检查：无独立填写字段。复用共用组件或保留业务列表/展示、画布、权限及错误边界。

## packages/web/src/components/data-market/DataMarketPage.tsx

容器：PageShell:102、Card:291。

| 行 | 控件 / 字段 | 状态 | 原因 |
| --- | --- | --- | --- |
| 139 | Input · {t("dataMarket.search")} | 保留 | 自由内容（名称、路径、命令、表达式、凭据或搜索查询），保持原提交与校验。 |
| 184 | Input · "private-data-name" | 保留 | 自由内容（名称、路径、命令、表达式、凭据或搜索查询），保持原提交与校验。 |
| 193 | Input · "private-data-version" | 保留 | 发布或登记新版本的版本号，属于创建内容；已有版本引用在独立资源选择控件中处理。 |
| 202 | NativeSelect · {privateKind} | 保留 | 少量固定枚举、分页大小、布尔策略或共用资源选择器的原生表单桥接，保留统一简单选择。 |
| 215 | Input · {t("dataMarket.elements")} | 保留 | 自由内容（名称、路径、命令、表达式、凭据或搜索查询），保持原提交与校验。 |
| 223 | Input · {t("dataMarket.privateFile")} | 保留 | 勾选、单选、文件上传或隐藏表单值，保留原生语义。 |
| 333 | Input · {t("dataMarket.ownerEntitlementReason")} | 保留 | 自由内容（名称、路径、命令、表达式、凭据或搜索查询），保持原提交与校验。 |

## packages/web/src/components/federation/AgreementBacklog.tsx

容器：继承父容器 / 无独立容器。

已检查：无独立填写字段。复用共用组件或保留业务列表/展示、画布、权限及错误边界。

## packages/web/src/components/federation/AgreementExchangeStatus.tsx

容器：继承父容器 / 无独立容器。

已检查：无独立填写字段。复用共用组件或保留业务列表/展示、画布、权限及错误边界。

## packages/web/src/components/federation/AgreementImport.tsx

容器：继承父容器 / 无独立容器。

| 行 | 控件 / 字段 | 状态 | 原因 |
| --- | --- | --- | --- |
| 97 | Input · {`${fieldId}-file`} | 保留 | 勾选、单选、文件上传或隐藏表单值，保留原生语义。 |
| 125 | Textarea · {`${fieldId}-json`} | 保留 | 只读、受权限或状态约束的字段，保留原数据展示与禁用规则。 |
| 169 | Input · {t("federation.agreements.accountSearch")} | 保留 | 只读、受权限或状态约束的字段，保留原数据展示与禁用规则。 |
| 193 | input · {`${fieldId}-account`} | 保留 | 勾选、单选、文件上传或隐藏表单值，保留原生语义。 |

## packages/web/src/components/federation/AgreementPanel.tsx

容器：DialogContent:308、Card:380。

| 行 | 控件 / 字段 | 状态 | 原因 |
| --- | --- | --- | --- |
| 451 | Textarea · {t("federation.agreements.localSignature")} | 保留 | 自由内容（名称、路径、命令、表达式、凭据或搜索查询），保持原提交与校验。 |
| 470 | Textarea · {t("federation.agreements.counterpartySignature")} | 保留 | 自由内容（名称、路径、命令、表达式、凭据或搜索查询），保持原提交与校验。 |
| 479 | Textarea · {t("federation.agreements.counterpartySignature")} | 保留 | 只读、受权限或状态约束的字段，保留原数据展示与禁用规则。 |

## packages/web/src/components/federation/AgreementTerms.tsx

容器：继承父容器 / 无独立容器。

已检查：无独立填写字段。复用共用组件或保留业务列表/展示、画布、权限及错误边界。

## packages/web/src/components/federation/ArbitrationDecisionPanel.tsx

容器：DialogContent:589。

| 行 | 控件 / 字段 | 状态 | 原因 |
| --- | --- | --- | --- |
| 463 | Input · {`${id}-domain`} | 保留 | 只读、受权限或状态约束的字段，保留原数据展示与禁用规则。 |
| 514 | NativeSelect · {`${id}-outcome`} | 保留 | 少量固定枚举、分页大小、布尔策略或共用资源选择器的原生表单桥接，保留统一简单选择。 |
| 531 | NativeSelect · {`${id}-target`} | 保留 | 少量固定枚举、分页大小、布尔策略或共用资源选择器的原生表单桥接，保留统一简单选择。 |
| 553 | Input · {`${id}-amount`} | 保留 | 自由内容（名称、路径、命令、表达式、凭据或搜索查询），保持原提交与校验。 |
| 565 | Textarea · {`${id}-reason`} | 保留 | 自由内容（名称、路径、命令、表达式、凭据或搜索查询），保持原提交与校验。 |

## packages/web/src/components/federation/CommercialAdjustmentPanel.tsx

容器：DialogContent:727。

| 行 | 控件 / 字段 | 状态 | 原因 |
| --- | --- | --- | --- |
| 397 | Input · {`${id}-settlement`} | 保留 | 只读、受权限或状态约束的字段，保留原数据展示与禁用规则。 |
| 408 | Input · {`${id}-amount`} | 保留 | 只读、受权限或状态约束的字段，保留原数据展示与禁用规则。 |
| 420 | Textarea · {`${id}-reason`} | 保留 | 只读、受权限或状态约束的字段，保留原数据展示与禁用规则。 |
| 431 | Input · {`${id}-evidence`} | 保留 | 只读、受权限或状态约束的字段，保留原数据展示与禁用规则。 |
| 463 | Textarea · {`${id}-json`} | 保留 | 只读、受权限或状态约束的字段，保留原数据展示与禁用规则。 |
| 621 | Textarea · {`${id}-signature`} | 保留 | 只读、受权限或状态约束的字段，保留原数据展示与禁用规则。 |

## packages/web/src/components/federation/CommercialAdjustmentTerms.tsx

容器：继承父容器 / 无独立容器。

已检查：无独立填写字段。复用共用组件或保留业务列表/展示、画布、权限及错误边界。

## packages/web/src/components/federation/CommercialArbitrationPanel.tsx

容器：DialogContent:291。

已检查：无独立填写字段。复用共用组件或保留业务列表/展示、画布、权限及错误边界。

## packages/web/src/components/federation/CommercialAutomationPanel.tsx

容器：DialogContent:566。

| 行 | 控件 / 字段 | 状态 | 原因 |
| --- | --- | --- | --- |
| 375 | Input · {`${id}-${field}`} | 保留 | 自由内容（名称、路径、命令、表达式、凭据或搜索查询），保持原提交与校验。 |
| 394 | input · input | 保留 | 勾选、单选、文件上传或隐藏表单值，保留原生语义。 |
| 413 | input · input | 保留 | 勾选、单选、文件上传或隐藏表单值，保留原生语义。 |
| 432 | Input · {`${id}-expiry`} | 保留 | 自由内容（名称、路径、命令、表达式、凭据或搜索查询），保持原提交与校验。 |

## packages/web/src/components/federation/CommercialBillTerms.tsx

容器：继承父容器 / 无独立容器。

已检查：无独立填写字段。复用共用组件或保留业务列表/展示、画布、权限及错误边界。

## packages/web/src/components/federation/CommercialBillingPanel.tsx

容器：DialogContent:561。

| 行 | 控件 / 字段 | 状态 | 原因 |
| --- | --- | --- | --- |
| 309 | Input · {`${id}-report`} | 保留 | 只读、受权限或状态约束的字段，保留原数据展示与禁用规则。 |
| 334 | Textarea · {`${id}-json`} | 保留 | 只读、受权限或状态约束的字段，保留原数据展示与禁用规则。 |
| 465 | Textarea · {`${id}-signature`} | 保留 | 只读、受权限或状态约束的字段，保留原数据展示与禁用规则。 |

## packages/web/src/components/federation/CommercialClosingPanel.tsx

容器：DialogContent:579。

| 行 | 控件 / 字段 | 状态 | 原因 |
| --- | --- | --- | --- |
| 356 | Input · {`${id}-${field}`} | 保留 | 自由内容（名称、路径、命令、表达式、凭据或搜索查询），保持原提交与校验。 |
| 380 | input · input | 保留 | 勾选、单选、文件上传或隐藏表单值，保留原生语义。 |

## packages/web/src/components/federation/CommercialDetail.tsx

容器：继承父容器 / 无独立容器。

| 行 | 控件 / 字段 | 状态 | 原因 |
| --- | --- | --- | --- |
| 189 | Textarea · {t("federation.agreements.localSignature")} | 保留 | 自由内容（名称、路径、命令、表达式、凭据或搜索查询），保持原提交与校验。 |
| 203 | Textarea · {`${id}-counterparty`} | 保留 | 只读、受权限或状态约束的字段，保留原数据展示与禁用规则。 |

## packages/web/src/components/federation/CommercialDisputeCreate.tsx

容器：DialogContent:203。

| 行 | 控件 / 字段 | 状态 | 原因 |
| --- | --- | --- | --- |
| 162 | Textarea · {`${id}-reason`} | 保留 | 只读、受权限或状态约束的字段，保留原数据展示与禁用规则。 |
| 174 | Textarea · {`${id}-request`} | 保留 | 只读、受权限或状态约束的字段，保留原数据展示与禁用规则。 |

## packages/web/src/components/federation/CommercialDisputePanel.tsx

容器：DialogContent:949。

| 行 | 控件 / 字段 | 状态 | 原因 |
| --- | --- | --- | --- |
| 656 | Input · {`${id}-file`} | 保留 | 勾选、单选、文件上传或隐藏表单值，保留原生语义。 |
| 693 | select · {`${id}-mode`} | 保留 | 少量固定枚举、分页大小、布尔策略或共用资源选择器的原生表单桥接，保留统一简单选择。 |
| 719 | select · {`${id}-record`} | 保留 | 少量固定枚举、分页大小、布尔策略或共用资源选择器的原生表单桥接，保留统一简单选择。 |
| 743 | Input · {`${id}-amount`} | 保留 | 只读、受权限或状态约束的字段，保留原数据展示与禁用规则。 |
| 758 | Textarea · {`${id}-reason`} | 保留 | 只读、受权限或状态约束的字段，保留原数据展示与禁用规则。 |

## packages/web/src/components/federation/CommercialDisputeProgress.tsx

容器：继承父容器 / 无独立容器。

已检查：无独立填写字段。复用共用组件或保留业务列表/展示、画布、权限及错误边界。

## packages/web/src/components/federation/CommercialEditor.tsx

容器：继承父容器 / 无独立容器。

| 行 | 控件 / 字段 | 状态 | 原因 |
| --- | --- | --- | --- |
| 152 | input · {`${id}-source`} | 保留 | 勾选、单选、文件上传或隐藏表单值，保留原生语义。 |
| 234 | Input · {`${id}-file`} | 保留 | 勾选、单选、文件上传或隐藏表单值，保留原生语义。 |
| 262 | Textarea · {`${id}-json`} | 保留 | 只读、受权限或状态约束的字段，保留原数据展示与禁用规则。 |
| 299 | select · {draft.consideration} | 保留 | 少量固定枚举、分页大小、布尔策略或共用资源选择器的原生表单桥接，保留统一简单选择。 |
| 324 | Input · {`${id}-domain`} | 保留 | 自由内容（名称、路径、命令、表达式、凭据或搜索查询），保持原提交与校验。 |
| 354 | select · {`${id}-${priceIds[index]}-meter`} | 保留 | 少量固定枚举、分页大小、布尔策略或共用资源选择器的原生表单桥接，保留统一简单选择。 |
| 406 | Input · {`${id}-${priceIds[index]}-${field}`} | 保留 | 只读、受权限或状态约束的字段，保留原数据展示与禁用规则。 |
| 466 | Textarea · {`${id}-text`} | 保留 | 自由内容（名称、路径、命令、表达式、凭据或搜索查询），保持原提交与校验。 |

## packages/web/src/components/federation/CommercialGovernancePanel.tsx

容器：DialogContent:447。

| 行 | 控件 / 字段 | 状态 | 原因 |
| --- | --- | --- | --- |
| 341 | Textarea · {`${id}-import`} | 保留 | 只读、受权限或状态约束的字段，保留原数据展示与禁用规则。 |
| 367 | Textarea · {`${id}-local-signature`} | 保留 | 自由内容（名称、路径、命令、表达式、凭据或搜索查询），保持原提交与校验。 |
| 379 | Textarea · {`${id}-signature`} | 保留 | 只读、受权限或状态约束的字段，保留原数据展示与禁用规则。 |

## packages/web/src/components/federation/CommercialHistoryRecoveryImport.tsx

容器：DialogContent:132。

| 行 | 控件 / 字段 | 状态 | 原因 |
| --- | --- | --- | --- |
| 97 | Input · {id} | 保留 | 勾选、单选、文件上传或隐藏表单值，保留原生语义。 |

## packages/web/src/components/federation/CommercialHistoryRecoveryPanel.tsx

容器：DialogContent:471。

| 行 | 控件 / 字段 | 状态 | 原因 |
| --- | --- | --- | --- |
| 372 | Textarea · {`${id}-reason`} | 保留 | 只读、受权限或状态约束的字段，保留原数据展示与禁用规则。 |
| 390 | Input · {`${id}-import`} | 保留 | 勾选、单选、文件上传或隐藏表单值，保留原生语义。 |

## packages/web/src/components/federation/CommercialMarketRequestsPanel.tsx

容器：DialogContent:429。

已检查：无独立填写字段。复用共用组件或保留业务列表/展示、画布、权限及错误边界。

## packages/web/src/components/federation/CommercialPanel.tsx

容器：DialogContent:720。

已检查：无独立填写字段。复用共用组件或保留业务列表/展示、画布、权限及错误边界。

## packages/web/src/components/federation/CommercialPaymentPanel.tsx

容器：DialogContent:791。

| 行 | 控件 / 字段 | 状态 | 原因 |
| --- | --- | --- | --- |
| 448 | Input · {`${id}-bill`} | 保留 | 只读、受权限或状态约束的字段，保留原数据展示与禁用规则。 |
| 461 | Input · {`${id}-amount`} | 保留 | 只读、受权限或状态约束的字段，保留原数据展示与禁用规则。 |
| 476 | Input · {`${id}-time`} | 保留 | 只读、受权限或状态约束的字段，保留原数据展示与禁用规则。 |
| 489 | Input · {`${id}-evidence`} | 保留 | 只读、受权限或状态约束的字段，保留原数据展示与禁用规则。 |
| 502 | Textarea · {`${id}-reason`} | 保留 | 只读、受权限或状态约束的字段，保留原数据展示与禁用规则。 |
| 535 | Textarea · {`${id}-json`} | 保留 | 只读、受权限或状态约束的字段，保留原数据展示与禁用规则。 |
| 688 | Textarea · {`${id}-signature`} | 保留 | 只读、受权限或状态约束的字段，保留原数据展示与禁用规则。 |

## packages/web/src/components/federation/CommercialPaymentTerms.tsx

容器：继承父容器 / 无独立容器。

已检查：无独立填写字段。复用共用组件或保留业务列表/展示、画布、权限及错误边界。

## packages/web/src/components/federation/CommercialRefundPanel.tsx

容器：DialogContent:602。

| 行 | 控件 / 字段 | 状态 | 原因 |
| --- | --- | --- | --- |
| 345 | Input · {`${id}-operation`} | 保留 | 只读、受权限或状态约束的字段，保留原数据展示与禁用规则。 |
| 356 | Textarea · {`${id}-reason`} | 保留 | 只读、受权限或状态约束的字段，保留原数据展示与禁用规则。 |
| 384 | Textarea · {`${id}-json`} | 保留 | 只读、受权限或状态约束的字段，保留原数据展示与禁用规则。 |
| 503 | Textarea · {`${id}-signature`} | 保留 | 只读、受权限或状态约束的字段，保留原数据展示与禁用规则。 |

## packages/web/src/components/federation/CommercialRefundTerms.tsx

容器：继承父容器 / 无独立容器。

已检查：无独立填写字段。复用共用组件或保留业务列表/展示、画布、权限及错误边界。

## packages/web/src/components/federation/CommercialSettlementPanel.tsx

容器：DialogContent:600。

| 行 | 控件 / 字段 | 状态 | 原因 |
| --- | --- | --- | --- |
| 321 | Input · {`${id}-bill`} | 保留 | 只读、受权限或状态约束的字段，保留原数据展示与禁用规则。 |
| 345 | Textarea · {`${id}-json`} | 保留 | 只读、受权限或状态约束的字段，保留原数据展示与禁用规则。 |
| 498 | Textarea · {`${id}-signature`} | 保留 | 只读、受权限或状态约束的字段，保留原数据展示与禁用规则。 |

## packages/web/src/components/federation/CommercialSettlementTerms.tsx

容器：继承父容器 / 无独立容器。

已检查：无独立填写字段。复用共用组件或保留业务列表/展示、画布、权限及错误边界。

## packages/web/src/components/federation/CommercialTerms.tsx

容器：继承父容器 / 无独立容器。

已检查：无独立填写字段。复用共用组件或保留业务列表/展示、画布、权限及错误边界。

## packages/web/src/components/federation/CommercialUsagePanel.tsx

容器：DialogContent:670。

| 行 | 控件 / 字段 | 状态 | 原因 |
| --- | --- | --- | --- |
| 437 | Input · {`${id}-${index}-quantity`} | 保留 | 自由内容（名称、路径、命令、表达式、凭据或搜索查询），保持原提交与校验。 |
| 456 | Input · {`${id}-${index}-digest`} | 保留 | 自由内容（名称、路径、命令、表达式、凭据或搜索查询），保持原提交与校验。 |
| 479 | Textarea · {`${id}-reason`} | 保留 | 自由内容（名称、路径、命令、表达式、凭据或搜索查询），保持原提交与校验。 |
| 625 | Textarea · {t("federation.usage.signature")} | 保留 | 自由内容（名称、路径、命令、表达式、凭据或搜索查询），保持原提交与校验。 |

## packages/web/src/components/federation/EvidenceCaseDetail.tsx

容器：DialogContent:330。

| 行 | 控件 / 字段 | 状态 | 原因 |
| --- | --- | --- | --- |
| 222 | Input · {`${id}-${key}`} | 保留 | 自由内容（名称、路径、命令、表达式、凭据或搜索查询），保持原提交与校验。 |
| 248 | input · input | 保留 | 勾选、单选、文件上传或隐藏表单值，保留原生语义。 |

## packages/web/src/components/federation/FederationAssetImport.tsx

容器：继承父容器 / 无独立容器。

| 行 | 控件 / 字段 | 状态 | 原因 |
| --- | --- | --- | --- |
| 77 | Input · {`${id}-origin`} | 保留 | 自由内容（名称、路径、命令、表达式、凭据或搜索查询），保持原提交与校验。 |
| 88 | Input · {`${id}-file`} | 保留 | 勾选、单选、文件上传或隐藏表单值，保留原生语义。 |
| 113 | Textarea · {`${id}-content`} | 保留 | 自由内容（名称、路径、命令、表达式、凭据或搜索查询），保持原提交与校验。 |
| 131 | select · {`${id}-kind`} | 保留 | 少量固定枚举、分页大小、布尔策略或共用资源选择器的原生表单桥接，保留统一简单选择。 |
| 151 | Input · {`${id}-${field}`} | 保留 | 自由内容（名称、路径、命令、表达式、凭据或搜索查询），保持原提交与校验。 |
| 164 | Input · {`${id}-local`} | 保留 | 自由内容（名称、路径、命令、表达式、凭据或搜索查询），保持原提交与校验。 |

## packages/web/src/components/federation/FederationAssetsPanel.tsx

容器：DialogContent:468。

已检查：无独立填写字段。复用共用组件或保留业务列表/展示、画布、权限及错误边界。

## packages/web/src/components/federation/FederationEvidencePanel.tsx

容器：继承父容器 / 无独立容器。

| 行 | 控件 / 字段 | 状态 | 原因 |
| --- | --- | --- | --- |
| 157 | Input · {`${id}-${key}`} | 保留 | 自由内容（名称、路径、命令、表达式、凭据或搜索查询），保持原提交与校验。 |

## packages/web/src/components/federation/FederationLayout.tsx

容器：继承父容器 / 无独立容器。

已检查：无独立填写字段。复用共用组件或保留业务列表/展示、画布、权限及错误边界。

## packages/web/src/components/federation/FederationMarketPanel.tsx

容器：DialogContent:821。

已检查：无独立填写字段。复用共用组件或保留业务列表/展示、画布、权限及错误边界。

## packages/web/src/components/federation/FederationPage.tsx

容器：PageShell:40。

| 行 | 控件 / 字段 | 状态 | 原因 |
| --- | --- | --- | --- |
| 115 | select · "federation-organization" | 保留 | 少量固定枚举、分页大小、布尔策略或共用资源选择器的原生表单桥接，保留统一简单选择。 |

## packages/web/src/components/federation/FederationSiteIdentity.tsx

容器：继承父容器 / 无独立容器。

已检查：无独立填写字段。复用共用组件或保留业务列表/展示、画布、权限及错误边界。

## packages/web/src/components/federation/FederationTaskCreate.tsx

容器：继承父容器 / 无独立容器。

| 行 | 控件 / 字段 | 状态 | 原因 |
| --- | --- | --- | --- |
| 168 | select · {`${id}-agreement`} | 保留 | 少量固定枚举、分页大小、布尔策略或共用资源选择器的原生表单桥接，保留统一简单选择。 |
| 228 | select · {`${id}-template`} | 保留 | 少量固定枚举、分页大小、布尔策略或共用资源选择器的原生表单桥接，保留统一简单选择。 |
| 258 | select · {`${id}-${kind}`} | 保留 | 少量固定枚举、分页大小、布尔策略或共用资源选择器的原生表单桥接，保留统一简单选择。 |
| 308 | Input · {`${id}-${field}`} | 保留 | 数值输入；共用 Input 提供合法范围内的原生预设，并保留自定义数值与 min/max/step。 |
| 327 | Input · {`${id}-amount`} | 保留 | 自由内容（名称、路径、命令、表达式、凭据或搜索查询），保持原提交与校验。 |

## packages/web/src/components/federation/FederationTaskDetail.tsx

容器：DialogContent:506。

已检查：无独立填写字段。复用共用组件或保留业务列表/展示、画布、权限及错误边界。

## packages/web/src/components/federation/FederationTasksPanel.tsx

容器：DialogContent:297。

已检查：无独立填写字段。复用共用组件或保留业务列表/展示、画布、权限及错误边界。

## packages/web/src/components/federation/GovernanceForm.tsx

容器：继承父容器 / 无独立容器。

| 行 | 控件 / 字段 | 状态 | 原因 |
| --- | --- | --- | --- |
| 34 | Input · {`${id}-${name}`} | 保留 | 自由内容（名称、路径、命令、表达式、凭据或搜索查询），保持原提交与校验。 |
| 109 | NativeSelect · {`${id}-recordType`} | 保留 | 少量固定枚举、分页大小、布尔策略或共用资源选择器的原生表单桥接，保留统一简单选择。 |
| 144 | input · input | 保留 | 勾选、单选、文件上传或隐藏表单值，保留原生语义。 |
| 161 | input · input | 保留 | 勾选、单选、文件上传或隐藏表单值，保留原生语义。 |
| 189 | input · input | 保留 | 勾选、单选、文件上传或隐藏表单值，保留原生语义。 |
| 208 | input · input | 保留 | 勾选、单选、文件上传或隐藏表单值，保留原生语义。 |

## packages/web/src/components/federation/GovernanceProgress.tsx

容器：继承父容器 / 无独立容器。

已检查：无独立填写字段。复用共用组件或保留业务列表/展示、画布、权限及错误边界。

## packages/web/src/components/federation/MarketClaimForm.tsx

容器：继承父容器 / 无独立容器。

| 行 | 控件 / 字段 | 状态 | 原因 |
| --- | --- | --- | --- |
| 162 | select · {id} | 保留 | 少量固定枚举、分页大小、布尔策略或共用资源选择器的原生表单桥接，保留统一简单选择。 |
| 196 | select · {`${id}-request`} | 保留 | 少量固定枚举、分页大小、布尔策略或共用资源选择器的原生表单桥接，保留统一简单选择。 |

## packages/web/src/components/federation/MarketDemandForm.tsx

容器：继承父容器 / 无独立容器。

| 行 | 控件 / 字段 | 状态 | 原因 |
| --- | --- | --- | --- |
| 74 | Input · {`${id}-${field}`} | 保留 | 数值输入；共用 Input 提供合法范围内的原生预设，并保留自定义数值与 min/max/step。 |
| 91 | textarea · {`${id}-description`} | 保留 | 自由内容（名称、路径、命令、表达式、凭据或搜索查询），保持原提交与校验。 |

## packages/web/src/components/federation/MarketRequestForm.tsx

容器：继承父容器 / 无独立容器。

| 行 | 控件 / 字段 | 状态 | 原因 |
| --- | --- | --- | --- |
| 133 | select · {`${id}-policy`} | 保留 | 少量固定枚举、分页大小、布尔策略或共用资源选择器的原生表单桥接，保留统一简单选择。 |
| 188 | Input · {`${id}-${field}`} | 保留 | 自由内容（名称、路径、命令、表达式、凭据或搜索查询），保持原提交与校验。 |
| 206 | textarea · {`${id}-description`} | 保留 | 自由内容（名称、路径、命令、表达式、凭据或搜索查询），保持原提交与校验。 |
| 216 | select · {`${id}-template`} | 保留 | 少量固定枚举、分页大小、布尔策略或共用资源选择器的原生表单桥接，保留统一简单选择。 |
| 234 | select · {`${id}-${kind}`} | 保留 | 少量固定枚举、分页大小、布尔策略或共用资源选择器的原生表单桥接，保留统一简单选择。 |
| 279 | Input · {`${id}-${field}`} | 保留 | 数值输入；共用 Input 提供合法范围内的原生预设，并保留自定义数值与 min/max/step。 |
| 298 | Input · {`${id}-amount`} | 保留 | 自由内容（名称、路径、命令、表达式、凭据或搜索查询），保持原提交与校验。 |

## packages/web/src/components/federation/MediaDeliveryDetail.tsx

容器：继承父容器 / 无独立容器。

已检查：无独立填写字段。复用共用组件或保留业务列表/展示、画布、权限及错误边界。

## packages/web/src/components/federation/MediaDeliveryForm.tsx

容器：继承父容器 / 无独立容器。

| 行 | 控件 / 字段 | 状态 | 原因 |
| --- | --- | --- | --- |
| 220 | Input · {`${id}-${name}`} | 保留 | 自由内容（名称、路径、命令、表达式、凭据或搜索查询），保持原提交与校验。 |
| 262 | select · {`${id}-subject`} | 保留 | 少量固定枚举、分页大小、布尔策略或共用资源选择器的原生表单桥接，保留统一简单选择。 |
| 367 | Input · {`${id}-file`} | 保留 | 勾选、单选、文件上传或隐藏表单值，保留原生语义。 |
| 402 | Textarea · {`${id}-reason`} | 保留 | 自由内容（名称、路径、命令、表达式、凭据或搜索查询），保持原提交与校验。 |

## packages/web/src/components/federation/MediaDeliveryPanel.tsx

容器：继承父容器 / 无独立容器。

已检查：无独立填写字段。复用共用组件或保留业务列表/展示、画布、权限及错误边界。

## packages/web/src/components/federation/MediaLogisticsForm.tsx

容器：继承父容器 / 无独立容器。

| 行 | 控件 / 字段 | 状态 | 原因 |
| --- | --- | --- | --- |
| 255 | Input · {`${id}-name`} | 保留 | 自由内容（名称、路径、命令、表达式、凭据或搜索查询），保持原提交与校验。 |
| 268 | Input · {`${id}-tag`} | 保留 | 自由内容（名称、路径、命令、表达式、凭据或搜索查询），保持原提交与校验。 |
| 278 | Input · {`${id}-capacity`} | 保留 | 数值输入；共用 Input 提供合法范围内的原生预设，并保留自定义数值与 min/max/step。 |
| 295 | select · {`${id}-state`} | 保留 | 少量固定枚举、分页大小、布尔策略或共用资源选择器的原生表单桥接，保留统一简单选择。 |
| 317 | Textarea · {`${id}-note`} | 保留 | 自由内容（名称、路径、命令、表达式、凭据或搜索查询），保持原提交与校验。 |
| 332 | Input · {`${id}-time`} | 保留 | 自由内容（名称、路径、命令、表达式、凭据或搜索查询），保持原提交与校验。 |
| 341 | Input · {`${id}-evidence`} | 保留 | 自由内容（名称、路径、命令、表达式、凭据或搜索查询），保持原提交与校验。 |
| 388 | input · input | 保留 | 勾选、单选、文件上传或隐藏表单值，保留原生语义。 |
| 463 | input · input | 保留 | 勾选、单选、文件上传或隐藏表单值，保留原生语义。 |

## packages/web/src/components/federation/MediaLogisticsPanel.tsx

容器：继承父容器 / 无独立容器。

已检查：无独立填写字段。复用共用组件或保留业务列表/展示、画布、权限及错误边界。

## packages/web/src/components/federation/MediaLogisticsShared.tsx

容器：继承父容器 / 无独立容器。

已检查：无独立填写字段。复用共用组件或保留业务列表/展示、画布、权限及错误边界。

## packages/web/src/components/federation/MediaOptionPicker.tsx

容器：继承父容器 / 无独立容器。

| 行 | 控件 / 字段 | 状态 | 原因 |
| --- | --- | --- | --- |
| 125 | select · {id} | 保留 | 少量固定枚举、分页大小、布尔策略或共用资源选择器的原生表单桥接，保留统一简单选择。 |

## packages/web/src/components/files/CloudPane.tsx

容器：继承父容器 / 无独立容器。

| 行 | 控件 / 字段 | 状态 | 原因 |
| --- | --- | --- | --- |
| 178 | input · "files-cloud-upload-input" | 保留 | 勾选、单选、文件上传或隐藏表单值，保留原生语义。 |
| 221 | Input · "files-cloud-search" | 保留 | 自由内容（名称、路径、命令、表达式、凭据或搜索查询），保持原提交与校验。 |
| 229 | NativeSelect · "files-cloud-sort" | 保留 | 少量固定枚举、分页大小、布尔策略或共用资源选择器的原生表单桥接，保留统一简单选择。 |

## packages/web/src/components/files/ClusterPane.tsx

容器：继承父容器 / 无独立容器。

| 行 | 控件 / 字段 | 状态 | 原因 |
| --- | --- | --- | --- |
| 132 | ResourceSelectField · "files-cluster-agent-select" | 已替换 | 共用 Radix Popover + cmdk / Dialog 资源选择器，沿用业务候选与 stable ID。 |
| 170 | ResourceSelectField · "files-cluster-root-select" | 已替换 | 共用 Radix Popover + cmdk / Dialog 资源选择器，沿用业务候选与 stable ID。 |
| 197 | Input · "files-cluster-search" | 保留 | 自由内容（名称、路径、命令、表达式、凭据或搜索查询），保持原提交与校验。 |
| 205 | NativeSelect · "files-cluster-sort" | 保留 | 少量固定枚举、分页大小、布尔策略或共用资源选择器的原生表单桥接，保留统一简单选择。 |

## packages/web/src/components/files/DeleteCloudFileDialog.tsx

容器：DialogContent:40。

已检查：无独立填写字段。复用共用组件或保留业务列表/展示、画布、权限及错误边界。

## packages/web/src/components/files/FileContextMenu.tsx

容器：继承父容器 / 无独立容器。

已检查：无独立填写字段。复用共用组件或保留业务列表/展示、画布、权限及错误边界。

## packages/web/src/components/files/FilesPage.tsx

容器：PageShell:434。

已检查：无独立填写字段。复用共用组件或保留业务列表/展示、画布、权限及错误边界。

## packages/web/src/components/files/NewTransferSheet.tsx

容器：SheetContent:439。

已检查：无独立填写字段。复用共用组件或保留业务列表/展示、画布、权限及错误边界。

## packages/web/src/components/files/PathPickerSheet.tsx

容器：SheetContent:412。

| 行 | 控件 / 字段 | 状态 | 原因 |
| --- | --- | --- | --- |
| 834 | ResourceSelectField · "path-picker-agent-select" | 已替换 | 共用 Radix Popover + cmdk / Dialog 资源选择器，沿用业务候选与 stable ID。 |
| 857 | ResourceSelectField · "path-picker-cluster-root-select" | 已替换 | 共用 Radix Popover + cmdk / Dialog 资源选择器，沿用业务候选与 stable ID。 |

## packages/web/src/components/files/StorageQuotaRequestDialog.tsx

容器：DialogContent:129。

| 行 | 控件 / 字段 | 状态 | 原因 |
| --- | --- | --- | --- |
| 165 | Input · "storage-quota-gb" | 保留 | 数值输入；共用 Input 提供合法范围内的原生预设，并保留自定义数值与 min/max/step。 |
| 194 | Input · "storage-quota-expires-at" | 保留 | 自由内容（名称、路径、命令、表达式、凭据或搜索查询），保持原提交与校验。 |
| 204 | Textarea · "storage-quota-reason" | 保留 | 自由内容（名称、路径、命令、表达式、凭据或搜索查询），保持原提交与校验。 |

## packages/web/src/components/files/TransfersTray.tsx

容器：继承父容器 / 无独立容器。

已检查：无独立填写字段。复用共用组件或保留业务列表/展示、画布、权限及错误边界。

## packages/web/src/components/interconnect/InterconnectDashboard.tsx

容器：DialogContent:906。

| 行 | 控件 / 字段 | 状态 | 原因 |
| --- | --- | --- | --- |
| 586 | ResourceSelectField · {t("interconnect.filterCenter")} | 已替换 | 共用 Radix Popover + cmdk / Dialog 资源选择器，沿用业务候选与 stable ID。 |

## packages/web/src/components/interconnect/InterconnectMap.tsx

容器：继承父容器 / 无独立容器。

| 行 | 控件 / 字段 | 状态 | 原因 |
| --- | --- | --- | --- |
| 230 | NativeSelect · {t("interconnect.mapLevel")} | 保留 | 少量固定枚举、分页大小、布尔策略或共用资源选择器的原生表单桥接，保留统一简单选择。 |
| 240 | ResourceSelectField · {t("interconnect.province")} | 已替换 | 共用 Radix Popover + cmdk / Dialog 资源选择器，沿用业务候选与 stable ID。 |

## packages/web/src/components/interconnect/MetadataEditor.tsx

容器：DialogContent:65。

| 行 | 控件 / 字段 | 状态 | 原因 |
| --- | --- | --- | --- |
| 204 | Input · "name" | 保留 | 自由内容（名称、路径、命令、表达式、凭据或搜索查询），保持原提交与校验。 |
| 207 | NativeSelect · "status" | 保留 | 少量固定枚举、分页大小、布尔策略或共用资源选择器的原生表单桥接，保留统一简单选择。 |
| 222 | ResourceSelectField · "orgId" | 已替换 | 共用 Radix Popover + cmdk / Dialog 资源选择器，沿用业务候选与 stable ID。 |
| 240 | Input · "country" | 保留 | 自由内容（名称、路径、命令、表达式、凭据或搜索查询），保持原提交与校验。 |
| 247 | Input · "province" | 保留 | 自由内容（名称、路径、命令、表达式、凭据或搜索查询），保持原提交与校验。 |
| 254 | Input · "city" | 保留 | 自由内容（名称、路径、命令、表达式、凭据或搜索查询），保持原提交与校验。 |
| 259 | Input · "longitude" | 保留 | 数值输入；共用 Input 提供合法范围内的原生预设，并保留自定义数值与 min/max/step。 |
| 269 | Input · "latitude" | 保留 | 数值输入；共用 Input 提供合法范围内的原生预设，并保留自定义数值与 min/max/step。 |
| 284 | ResourceSelectField · {centerId} | 已替换 | 共用 Radix Popover + cmdk / Dialog 资源选择器，沿用业务候选与 stable ID。 |
| 303 | input · "computeTypes" | 保留 | 勾选、单选、文件上传或隐藏表单值，保留原生语义。 |
| 316 | Input · "cpuCores" | 保留 | 数值输入；共用 Input 提供合法范围内的原生预设，并保留自定义数值与 min/max/step。 |
| 326 | Input · "storageGiB" | 保留 | 数值输入；共用 Input 提供合法范围内的原生预设，并保留自定义数值与 min/max/step。 |
| 341 | Input · "storageTypes" | 保留 | 自由内容（名称、路径、命令、表达式、凭据或搜索查询），保持原提交与校验。 |
| 348 | Input · "applications" | 保留 | 自由内容（名称、路径、命令、表达式、凭据或搜索查询），保持原提交与校验。 |
| 365 | input · "agentIds" | 保留 | 勾选、单选、文件上传或隐藏表单值，保留原生语义。 |
| 395 | ResourceSelectField · {name} | 已替换 | 共用 Radix Popover + cmdk / Dialog 资源选择器，沿用业务候选与 stable ID。 |
| 422 | Input · {name} | 保留 | 数值输入；共用 Input 提供合法范围内的原生预设，并保留自定义数值与 min/max/step。 |
| 435 | Input · "observedAt" | 保留 | 自由内容（名称、路径、命令、表达式、凭据或搜索查询），保持原提交与校验。 |
| 451 | Input · "source" | 保留 | 自由内容（名称、路径、命令、表达式、凭据或搜索查询），保持原提交与校验。 |

## packages/web/src/components/jobs/CommandWorkdirDialog.tsx

容器：DialogContent:262。

| 行 | 控件 / 字段 | 状态 | 原因 |
| --- | --- | --- | --- |
| 301 | Input · "command-workdir-cloud-search" | 保留 | 只读、受权限或状态约束的字段，保留原数据展示与禁用规则。 |
| 396 | Input · "command-workdir-new-folder-name" | 保留 | 自由内容（名称、路径、命令、表达式、凭据或搜索查询），保持原提交与校验。 |
| 423 | input · "command-workdir-upload" | 保留 | 勾选、单选、文件上传或隐藏表单值，保留原生语义。 |
| 501 | Input · {`command-workdir-rename-dir-${safeTestId(row.fullPath)}`} | 保留 | 自由内容（名称、路径、命令、表达式、凭据或搜索查询），保持原提交与校验。 |
| 546 | Input · {`command-workdir-stage-${row.entry.fileMetadataId}`} | 保留 | 自由内容（名称、路径、命令、表达式、凭据或搜索查询），保持原提交与校验。 |

## packages/web/src/components/jobs/ImportJobJsonDialog.tsx

容器：DialogContent:236。

| 行 | 控件 / 字段 | 状态 | 原因 |
| --- | --- | --- | --- |
| 251 | input · "import-job-json-file" | 保留 | 勾选、单选、文件上传或隐藏表单值，保留原生语义。 |

## packages/web/src/components/jobs/JobDetailSheet.tsx

容器：SheetContent:146。

已检查：无独立填写字段。复用共用组件或保留业务列表/展示、画布、权限及错误边界。

## packages/web/src/components/jobs/JobFilesTab.tsx

容器：继承父容器 / 无独立容器。

已检查：无独立填写字段。复用共用组件或保留业务列表/展示、画布、权限及错误边界。

## packages/web/src/components/jobs/JobLogsTab.tsx

容器：继承父容器 / 无独立容器。

已检查：无独立填写字段。复用共用组件或保留业务列表/展示、画布、权限及错误边界。

## packages/web/src/components/jobs/JobOverviewTab.tsx

容器：继承父容器 / 无独立容器。

已检查：无独立填写字段。复用共用组件或保留业务列表/展示、画布、权限及错误边界。

## packages/web/src/components/jobs/JobResourcesTab.tsx

容器：继承父容器 / 无独立容器。

已检查：无独立填写字段。复用共用组件或保留业务列表/展示、画布、权限及错误边界。

## packages/web/src/components/jobs/JobsPage.tsx

容器：PageShell:108。

已检查：无独立填写字段。复用共用组件或保留业务列表/展示、画布、权限及错误边界。

## packages/web/src/components/jobs/JobsTable.tsx

容器：继承父容器 / 无独立容器。

已检查：无独立填写字段。复用共用组件或保留业务列表/展示、画布、权限及错误边界。

## packages/web/src/components/jobs/JobsToolbar.tsx

容器：继承父容器 / 无独立容器。

| 行 | 控件 / 字段 | 状态 | 原因 |
| --- | --- | --- | --- |
| 97 | NativeSelect · "jobs-status-select" | 保留 | 少量固定枚举、分页大小、布尔策略或共用资源选择器的原生表单桥接，保留统一简单选择。 |

## packages/web/src/components/jobs/SubmitJobDialog.tsx

容器：SheetContent:1097、DialogContent:1815。

| 行 | 控件 / 字段 | 状态 | 原因 |
| --- | --- | --- | --- |
| 390 | ResourceSelectField · {`submit-usecase-dataset-select-${descriptor}`} | 已替换 | 共用 Radix Popover + cmdk / Dialog 资源选择器，沿用业务候选与 stable ID。 |
| 1244 | Textarea · {fieldId} | 保留 | 自由内容（名称、路径、命令、表达式、凭据或搜索查询），保持原提交与校验。 |
| 1255 | Input · {fieldId} | 保留 | 自由内容（名称、路径、命令、表达式、凭据或搜索查询），保持原提交与校验。 |
| 1380 | Textarea · "submit-job-command-input" | 保留 | 自由内容（名称、路径、命令、表达式、凭据或搜索查询），保持原提交与校验。 |
| 1443 | Input · "submit-job-name-input" | 保留 | 自由内容（名称、路径、命令、表达式、凭据或搜索查询），保持原提交与校验。 |
| 1460 | Input · "submit-job-cpus-input" | 保留 | 数值输入；共用 Input 提供合法范围内的原生预设，并保留自定义数值与 min/max/step。 |
| 1476 | Input · "submit-job-memory-input" | 保留 | 数值输入；共用 Input 提供合法范围内的原生预设，并保留自定义数值与 min/max/step。 |
| 1492 | input · "submit-job-placement-auto" | 保留 | 勾选、单选、文件上传或隐藏表单值，保留原生语义。 |
| 1506 | input · "submit-job-placement-default" | 保留 | 勾选、单选、文件上传或隐藏表单值，保留原生语义。 |
| 1520 | input · "submit-job-placement-named" | 保留 | 勾选、单选、文件上传或隐藏表单值，保留原生语义。 |
| 1592 | ResourceSelectField · "submit-job-queue-select" | 已替换 | 共用 Radix Popover + cmdk / Dialog 资源选择器，沿用业务候选与 stable ID。 |
| 1838 | NativeSelect · "submit-usecase-runtime-filter" | 保留 | 少量固定枚举、分页大小、布尔策略或共用资源选择器的原生表单桥接，保留统一简单选择。 |
| 1852 | NativeSelect · "submit-usecase-input-filter" | 保留 | 少量固定枚举、分页大小、布尔策略或共用资源选择器的原生表单桥接，保留统一简单选择。 |
| 1864 | Input · "submit-usecase-software-filter" | 保留 | 自由内容（名称、路径、命令、表达式、凭据或搜索查询），保持原提交与校验。 |

## packages/web/src/components/providers/ComputeProvidersPage.tsx

容器：PageShell:80、DialogContent:215、DialogContent:304。

| 行 | 控件 / 字段 | 状态 | 原因 |
| --- | --- | --- | --- |
| 93 | Input · "search" | 保留 | 自由内容（名称、路径、命令、表达式、凭据或搜索查询），保持原提交与校验。 |
| 355 | Input · {`${id}-name`} | 保留 | 只读、受权限或状态约束的字段，保留原数据展示与禁用规则。 |
| 368 | Textarea · {`${id}-${key}`} | 保留 | 只读、受权限或状态约束的字段，保留原数据展示与禁用规则。 |
| 378 | Input · {`${id}-${key}`} | 保留 | 只读、受权限或状态约束的字段，保留原数据展示与禁用规则。 |

## packages/web/src/components/scheduler/PlacementPipelineView.tsx

容器：继承父容器 / 无独立容器。

已检查：无独立填写字段。复用共用组件或保留业务列表/展示、画布、权限及错误边界。

## packages/web/src/components/scheduler/PlacementPreviewPanel.tsx

容器：继承父容器 / 无独立容器。

已检查：无独立填写字段。复用共用组件或保留业务列表/展示、画布、权限及错误边界。

## packages/web/src/components/settings/AgentCertsPanel.tsx

容器：Card:101。

| 行 | 控件 / 字段 | 状态 | 原因 |
| --- | --- | --- | --- |
| 107 | Input · "agent-certs-agent-id" | 保留 | 证书审计可查询历史或已撤销 Agent；当前在线目录不能覆盖全部有效查询对象，保留 ID 查询。 |

## packages/web/src/components/settings/AuditCapabilityPanel.tsx

容器：Card:56。

| 行 | 控件 / 字段 | 状态 | 原因 |
| --- | --- | --- | --- |
| 72 | Input · "search" | 保留 | 自由内容（名称、路径、命令、表达式、凭据或搜索查询），保持原提交与校验。 |

## packages/web/src/components/settings/AuditLogPanel.tsx

容器：继承父容器 / 无独立容器。

已检查：无独立填写字段。复用共用组件或保留业务列表/展示、画布、权限及错误边界。

## packages/web/src/components/settings/AuthzAdminPanel.tsx

容器：Card:173。

| 行 | 控件 / 字段 | 状态 | 原因 |
| --- | --- | --- | --- |
| 296 | Textarea · {t("adminAccess.rawLabel")} | 保留 | 只读、受权限或状态约束的字段，保留原数据展示与禁用规则。 |

## packages/web/src/components/settings/CloudStorageGovernancePanel.tsx

容器：Card:203、Card:229。

| 行 | 控件 / 字段 | 状态 | 原因 |
| --- | --- | --- | --- |
| 278 | Input · "默认配额（GB）" | 保留 | 数值输入；共用 Input 提供合法范围内的原生预设，并保留自定义数值与 min/max/step。 |
| 289 | Input · "单用户上限（GB）" | 保留 | 数值输入；共用 Input 提供合法范围内的原生预设，并保留自定义数值与 min/max/step。 |
| 301 | NativeSelect · "申请审批方式" | 保留 | 少量固定枚举、分页大小、布尔策略或共用资源选择器的原生表单桥接，保留统一简单选择。 |
| 318 | Input · "自动审批上限（GB）" | 保留 | 数值输入；共用 Input 提供合法范围内的原生预设，并保留自定义数值与 min/max/step。 |
| 392 | Input · "搜索用户" | 保留 | 自由内容（名称、路径、命令、表达式、凭据或搜索查询），保持原提交与校验。 |
| 409 | ResourceSelectField · "分配给" | 已替换 | 共用 Radix Popover + cmdk / Dialog 资源选择器，沿用业务候选与 stable ID。 |
| 437 | Input · "总配额（GB）" | 保留 | 数值输入；共用 Input 提供合法范围内的原生预设，并保留自定义数值与 min/max/step。 |
| 446 | Input · "到期时间（可选）" | 保留 | 自由内容（名称、路径、命令、表达式、凭据或搜索查询），保持原提交与校验。 |

## packages/web/src/components/settings/ClusterFileRootsPanel.tsx

容器：Card:249。

| 行 | 控件 / 字段 | 状态 | 原因 |
| --- | --- | --- | --- |
| 305 | Input · "cluster-file-root-new-label" | 保留 | 自由内容（名称、路径、命令、表达式、凭据或搜索查询），保持原提交与校验。 |
| 320 | ResourceSelectField · "cluster-file-root-new-provider" | 已替换 | 共用 Radix Popover + cmdk / Dialog 资源选择器，沿用业务候选与 stable ID。 |
| 357 | Input · "cluster-file-root-new-path" | 保留 | 自由内容（名称、路径、命令、表达式、凭据或搜索查询），保持原提交与校验。 |
| 372 | Input · "cluster-file-root-new-capacity" | 保留 | 数值输入；共用 Input 提供合法范围内的原生预设，并保留自定义数值与 min/max/step。 |
| 422 | Input · {`cluster-file-root-label-${root.id}`} | 保留 | 只读、受权限或状态约束的字段，保留原数据展示与禁用规则。 |
| 445 | Input · {`cluster-file-root-path-${root.id}`} | 保留 | 只读、受权限或状态约束的字段，保留原数据展示与禁用规则。 |
| 458 | Input · {`cluster-file-root-capacity-${root.id}`} | 保留 | 数值输入；共用 Input 提供合法范围内的原生预设，并保留自定义数值与 min/max/step。 |
| 482 | input · {`cluster-file-root-enabled-${root.id}`} | 保留 | 勾选、单选、文件上传或隐藏表单值，保留原生语义。 |
| 591 | ResourceSelectField · {testId} | 已替换 | 共用 Radix Popover + cmdk / Dialog 资源选择器，沿用业务候选与 stable ID。 |
| 645 | Input · {t("settings.clusterFileRoots.searchOrganizations")} | 保留 | 自由内容（名称、路径、命令、表达式、凭据或搜索查询），保持原提交与校验。 |
| 671 | input · input | 保留 | 勾选、单选、文件上传或隐藏表单值，保留原生语义。 |

## packages/web/src/components/settings/ClusterStoragePolicyEditor.tsx

容器：继承父容器 / 无独立容器。

| 行 | 控件 / 字段 | 状态 | 原因 |
| --- | --- | --- | --- |
| 155 | LabeledInput · {defaultGb} | 保留 | 自由内容（名称、路径、命令、表达式、凭据或搜索查询），保持原提交与校验。 |
| 156 | LabeledInput · {maxGb} | 保留 | 自由内容（名称、路径、命令、表达式、凭据或搜索查询），保持原提交与校验。 |
| 159 | NativeSelect · {requestMode} | 保留 | 少量固定枚举、分页大小、布尔策略或共用资源选择器的原生表单桥接，保留统一简单选择。 |
| 169 | LabeledInput · {autoLimitGb} | 保留 | 只读、受权限或状态约束的字段，保留原数据展示与禁用规则。 |
| 226 | Input · {label} | 保留 | 数值输入；共用 Input 提供合法范围内的原生预设，并保留自定义数值与 min/max/step。 |

## packages/web/src/components/settings/CostRatesForm.tsx

容器：Card:69、Card:89、Card:176。

| 行 | 控件 / 字段 | 状态 | 原因 |
| --- | --- | --- | --- |
| 208 | Input · {`cost-rates-cluster-${idx}`} | 保留 | 费率配置按调度器 cluster 名称建键，可预设尚未接入的集群；在线 Agent/算网档案不是完整同义目录，保留合法自定义键。 |
| 218 | Input · {`cost-rates-rate-${idx}`} | 保留 | 自由内容（名称、路径、命令、表达式、凭据或搜索查询），保持原提交与校验。 |

## packages/web/src/components/settings/DesensitizeAdminPanel.tsx

容器：Card:144。

| 行 | 控件 / 字段 | 状态 | 原因 |
| --- | --- | --- | --- |
| 169 | input · "desensitize-global-enabled" | 保留 | 勾选、单选、文件上传或隐藏表单值，保留原生语义。 |
| 184 | NativeSelect · {t("settings.desensitize.scope")} | 保留 | 少量固定枚举、分页大小、布尔策略或共用资源选择器的原生表单桥接，保留统一简单选择。 |
| 198 | Input · {t("settings.desensitize.scopeId")} | 保留 | 只读、受权限或状态约束的字段，保留原数据展示与禁用规则。 |
| 205 | Input · {t("settings.desensitize.fieldPath")} | 保留 | 自由内容（名称、路径、命令、表达式、凭据或搜索查询），保持原提交与校验。 |
| 211 | NativeSelect · {t("settings.desensitize.action")} | 保留 | 少量固定枚举、分页大小、布尔策略或共用资源选择器的原生表单桥接，保留统一简单选择。 |
| 289 | Textarea · "desensitize-alias-ids" | 保留 | 自由内容（名称、路径、命令、表达式、凭据或搜索查询），保持原提交与校验。 |
| 336 | Textarea · {envelope.token} | 保留 | 自由内容（名称、路径、命令、表达式、凭据或搜索查询），保持原提交与校验。 |

## packages/web/src/components/settings/FederationClusterProfiles.tsx

容器：继承父容器 / 无独立容器。

| 行 | 控件 / 字段 | 状态 | 原因 |
| --- | --- | --- | --- |
| 64 | Input · {profile.name} | 保留 | 自由内容（名称、路径、命令、表达式、凭据或搜索查询），保持原提交与校验。 |
| 72 | NativeSelect · {profile.source.kind} | 保留 | 少量固定枚举、分页大小、布尔策略或共用资源选择器的原生表单桥接，保留统一简单选择。 |
| 95 | Input · {profile.source.commandParameter} | 保留 | 自由内容（名称、路径、命令、表达式、凭据或搜索查询），保持原提交与校验。 |
| 108 | Input · {profile.source.revisionId} | 保留 | 自由内容（名称、路径、命令、表达式、凭据或搜索查询），保持原提交与校验。 |
| 122 | NativeSelect · {JSON.stringify(profile.template)} | 保留 | 少量固定枚举、分页大小、布尔策略或共用资源选择器的原生表单桥接，保留统一简单选择。 |
| 143 | Input · {profile[key]} | 保留 | 自由内容（名称、路径、命令、表达式、凭据或搜索查询），保持原提交与校验。 |
| 164 | Input · {profile.maxAmount} | 保留 | 自由内容（名称、路径、命令、表达式、凭据或搜索查询），保持原提交与校验。 |
| 181 | Input · {profile.source.packageId ?? ""} | 保留 | 自由内容（名称、路径、命令、表达式、凭据或搜索查询），保持原提交与校验。 |
| 193 | Input · {profile.source.packageDigest ?? ""} | 保留 | 自由内容（名称、路径、命令、表达式、凭据或搜索查询），保持原提交与校验。 |
| 213 | Input · {profile.market?.policyId ?? ""} | 保留 | 自由内容（名称、路径、命令、表达式、凭据或搜索查询），保持原提交与校验。 |
| 229 | Input · {profile.market?.title ?? ""} | 保留 | 自由内容（名称、路径、命令、表达式、凭据或搜索查询），保持原提交与校验。 |
| 249 | textarea · {t("federation.clusters.outputMappings")} | 保留 | 自由内容（名称、路径、命令、表达式、凭据或搜索查询），保持原提交与校验。 |

## packages/web/src/components/settings/FederationClustersPanel.tsx

容器：Card:87、Card:239。

| 行 | 控件 / 字段 | 状态 | 原因 |
| --- | --- | --- | --- |
| 270 | Input · {draft.clusterName} | 保留 | 自由内容（名称、路径、命令、表达式、凭据或搜索查询），保持原提交与校验。 |
| 281 | NativeSelect · {draft.agreementRevisionId} | 保留 | 少量固定枚举、分页大小、布尔策略或共用资源选择器的原生表单桥接，保留统一简单选择。 |
| 298 | NativeSelect · {JSON.stringify(draft.executionTarget)} | 保留 | 少量固定枚举、分页大小、布尔策略或共用资源选择器的原生表单桥接，保留统一简单选择。 |
| 319 | Input · {draft.queueName} | 保留 | 自由内容（名称、路径、命令、表达式、凭据或搜索查询），保持原提交与校验。 |
| 327 | NativeSelect · {draft.schedulerType} | 保留 | 少量固定枚举、分页大小、布尔策略或共用资源选择器的原生表单桥接，保留统一简单选择。 |
| 370 | input · input | 保留 | 勾选、单选、文件上传或隐藏表单值，保留原生语义。 |
| 377 | Input · {t("federation.clusters.searchMembers")} | 保留 | 自由内容（名称、路径、命令、表达式、凭据或搜索查询），保持原提交与校验。 |
| 386 | input · input | 保留 | 勾选、单选、文件上传或隐藏表单值，保留原生语义。 |
| 413 | input · input | 保留 | 勾选、单选、文件上传或隐藏表单值，保留原生语义。 |
| 423 | input · input | 保留 | 勾选、单选、文件上传或隐藏表单值，保留原生语义。 |

## packages/web/src/components/settings/FederationPermissionsPanel.tsx

容器：Card:73、Card:186、DialogContent:327。

| 行 | 控件 / 字段 | 状态 | 原因 |
| --- | --- | --- | --- |
| 88 | Input · {t("federation.permissions.organizationSearch")} | 保留 | 自由内容（名称、路径、命令、表达式、凭据或搜索查询），保持原提交与校验。 |
| 440 | Input · {t("federation.permissions.memberSearch")} | 保留 | 自由内容（名称、路径、命令、表达式、凭据或搜索查询），保持原提交与校验。 |
| 509 | select · {`${fieldId}-capability`} | 保留 | 少量固定枚举、分页大小、布尔策略或共用资源选择器的原生表单桥接，保留统一简单选择。 |

## packages/web/src/components/settings/FederationStoragePanel.tsx

容器：Card:75、DialogContent:442。

| 行 | 控件 / 字段 | 状态 | 原因 |
| --- | --- | --- | --- |
| 214 | Input · {lookupId} | 保留 | 自由内容（名称、路径、命令、表达式、凭据或搜索查询），保持原提交与校验。 |
| 364 | Input · {`${fieldId}-incident`} | 保留 | 自由内容（名称、路径、命令、表达式、凭据或搜索查询），保持原提交与校验。 |
| 374 | Input · {`${fieldId}-stopped`} | 保留 | 自由内容（名称、路径、命令、表达式、凭据或搜索查询），保持原提交与校验。 |
| 385 | Input · {`${fieldId}-evidence`} | 保留 | 自由内容（名称、路径、命令、表达式、凭据或搜索查询），保持原提交与校验。 |
| 399 | input · {`${fieldId}-writers`} | 保留 | 勾选、单选、文件上传或隐藏表单值，保留原生语义。 |
| 412 | input · {`${fieldId}-drained`} | 保留 | 勾选、单选、文件上传或隐藏表单值，保留原生语义。 |

## packages/web/src/components/settings/FederationTrustForms.tsx

容器：继承父容器 / 无独立容器。

| 行 | 控件 / 字段 | 状态 | 原因 |
| --- | --- | --- | --- |
| 56 | Input · {`${fieldId}-siteName`} | 保留 | 自由内容（名称、路径、命令、表达式、凭据或搜索查询），保持原提交与校验。 |
| 66 | Input · {`${fieldId}-siteId`} | 保留 | 只读、受权限或状态约束的字段，保留原数据展示与禁用规则。 |
| 77 | Input · {`${fieldId}-endpoint`} | 保留 | 自由内容（名称、路径、命令、表达式、凭据或搜索查询），保持原提交与校验。 |
| 158 | Input · {`${fieldId}-keyId`} | 保留 | 自由内容（名称、路径、命令、表达式、凭据或搜索查询），保持原提交与校验。 |
| 168 | Textarea · {`${fieldId}-publicKey`} | 保留 | 自由内容（名称、路径、命令、表达式、凭据或搜索查询），保持原提交与校验。 |
| 182 | Input · {`${fieldId}-validFrom`} | 保留 | 自由内容（名称、路径、命令、表达式、凭据或搜索查询），保持原提交与校验。 |
| 192 | Input · {`${fieldId}-validUntil`} | 保留 | 自由内容（名称、路径、命令、表达式、凭据或搜索查询），保持原提交与校验。 |
| 206 | input · input | 保留 | 勾选、单选、文件上传或隐藏表单值，保留原生语义。 |
| 256 | Textarea · {`${fieldId}-certificatePem`} | 保留 | 只读、受权限或状态约束的字段，保留原数据展示与禁用规则。 |

## packages/web/src/components/settings/FederationTrustPanel.tsx

容器：Card:125、DialogContent:428。

已检查：无独立填写字段。复用共用组件或保留业务列表/展示、画布、权限及错误边界。

## packages/web/src/components/settings/FileTransferAuditConfigPanel.tsx

容器：Card:75、Card:93、Card:141。

| 行 | 控件 / 字段 | 状态 | 原因 |
| --- | --- | --- | --- |
| 181 | NativeSelect · "download-evidence-mode" | 保留 | 少量固定枚举、分页大小、布尔策略或共用资源选择器的原生表单桥接，保留统一简单选择。 |
| 222 | Textarea · "file-transfer-audit-change-reason" | 保留 | 只读、受权限或状态约束的字段，保留原数据展示与禁用规则。 |
| 284 | Input · {id} | 保留 | 数值输入；共用 Input 提供合法范围内的原生预设，并保留自定义数值与 min/max/step。 |

## packages/web/src/components/settings/OperationsAttentionCards.tsx

容器：继承父容器 / 无独立容器。

已检查：无独立填写字段。复用共用组件或保留业务列表/展示、画布、权限及错误边界。

## packages/web/src/components/settings/OperationsPage.tsx

容器：PageShell:65、PageShell:83、PageShell:91。

已检查：无独立填写字段。复用共用组件或保留业务列表/展示、画布、权限及错误边界。

## packages/web/src/components/settings/OperationsResources.tsx

容器：继承父容器 / 无独立容器。

已检查：无独立填写字段。复用共用组件或保留业务列表/展示、画布、权限及错误边界。

## packages/web/src/components/settings/OrganizationMembershipPanel.tsx

容器：Card:125、DialogContent:257、DialogContent:443。

| 行 | 控件 / 字段 | 状态 | 原因 |
| --- | --- | --- | --- |
| 149 | Input · {t("adminAccess.search")} | 保留 | 自由内容（名称、路径、命令、表达式、凭据或搜索查询），保持原提交与校验。 |
| 280 | Input · {t("adminAccess.findUser")} | 保留 | 只读、受权限或状态约束的字段，保留原数据展示与禁用规则。 |
| 290 | ResourceSelectField · "membership-user" | 已替换 | 共用 Radix Popover + cmdk / Dialog 资源选择器，沿用业务候选与 stable ID。 |
| 323 | Input · {t("adminAccess.findOrganization")} | 保留 | 只读、受权限或状态约束的字段，保留原数据展示与禁用规则。 |
| 333 | ResourceSelectField · "membership-org" | 已替换 | 共用 Radix Popover + cmdk / Dialog 资源选择器，沿用业务候选与 stable ID。 |
| 376 | NativeSelect · "membership-role" | 保留 | 少量固定枚举、分页大小、布尔策略或共用资源选择器的原生表单桥接，保留统一简单选择。 |

## packages/web/src/components/settings/PlatformBrandingForm.tsx

容器：Card:89、Card:109、Card:174。

| 行 | 控件 / 字段 | 状态 | 原因 |
| --- | --- | --- | --- |
| 211 | Input · {`platform-branding-${code}-${key}`} | 保留 | 自由内容（名称、路径、命令、表达式、凭据或搜索查询），保持原提交与校验。 |
| 240 | Input · "platform-branding-logo-url" | 保留 | 自由内容（名称、路径、命令、表达式、凭据或搜索查询），保持原提交与校验。 |
| 255 | Input · "platform-branding-favicon-url" | 保留 | 自由内容（名称、路径、命令、表达式、凭据或搜索查询），保持原提交与校验。 |

## packages/web/src/components/settings/PlatformUsersTable.tsx

容器：DialogContent:178。

| 行 | 控件 / 字段 | 状态 | 原因 |
| --- | --- | --- | --- |
| 66 | Input · {t("cp.users.searchLabel")} | 保留 | 自由内容（名称、路径、命令、表达式、凭据或搜索查询），保持原提交与校验。 |
| 191 | Textarea · "platform-user-status-reason" | 保留 | 自由内容（名称、路径、命令、表达式、凭据或搜索查询），保持原提交与校验。 |

## packages/web/src/components/settings/SSOConfigForm.tsx

容器：Card:182、Card:202、Card:308。

| 行 | 控件 / 字段 | 状态 | 原因 |
| --- | --- | --- | --- |
| 320 | input · "sso-enabled" | 保留 | 勾选、单选、文件上传或隐藏表单值，保留原生语义。 |
| 339 | Input · "sso-provider-display-name" | 保留 | 自由内容（名称、路径、命令、表达式、凭据或搜索查询），保持原提交与校验。 |
| 350 | Input · "sso-login-welcome-zh" | 保留 | 自由内容（名称、路径、命令、表达式、凭据或搜索查询），保持原提交与校验。 |
| 360 | Input · "sso-login-welcome-en" | 保留 | 自由内容（名称、路径、命令、表达式、凭据或搜索查询），保持原提交与校验。 |
| 380 | NativeSelect · "sso-provider" | 保留 | 少量固定枚举、分页大小、布尔策略或共用资源选择器的原生表单桥接，保留统一简单选择。 |
| 401 | Input · "sso-issuer-url" | 保留 | 自由内容（名称、路径、命令、表达式、凭据或搜索查询），保持原提交与校验。 |
| 417 | Input · "sso-client-id" | 保留 | 自由内容（名称、路径、命令、表达式、凭据或搜索查询），保持原提交与校验。 |
| 431 | Input · "sso-client-secret" | 保留 | 自由内容（名称、路径、命令、表达式、凭据或搜索查询），保持原提交与校验。 |
| 458 | Input · "sso-redirect-uri" | 保留 | 自由内容（名称、路径、命令、表达式、凭据或搜索查询），保持原提交与校验。 |
| 492 | Input · {`sso-group-key-${idx}`} | 保留 | 自由内容（名称、路径、命令、表达式、凭据或搜索查询），保持原提交与校验。 |
| 499 | NativeSelect · {`sso-group-role-${idx}`} | 保留 | 少量固定枚举、分页大小、布尔策略或共用资源选择器的原生表单桥接，保留统一简单选择。 |
| 536 | input · "sso-autocreate" | 保留 | 勾选、单选、文件上传或隐藏表单值，保留原生语义。 |

## packages/web/src/components/settings/SandboxAccountMappingsPanel.tsx

容器：Card:79。

| 行 | 控件 / 字段 | 状态 | 原因 |
| --- | --- | --- | --- |
| 109 | ResourceSelectField · {t("sandbox.accounts.candidate")} | 已替换 | 共用 Radix Popover + cmdk / Dialog 资源选择器，沿用业务候选与 stable ID。 |

## packages/web/src/components/settings/SandboxSecurityPanel.tsx

容器：Card:92。

| 行 | 控件 / 字段 | 状态 | 原因 |
| --- | --- | --- | --- |
| 269 | input · input | 保留 | 勾选、单选、文件上传或隐藏表单值，保留原生语义。 |

## packages/web/src/components/settings/SettingsPage.tsx

容器：Card:210、PageShell:328。

已检查：无独立填写字段。复用共用组件或保留业务列表/展示、画布、权限及错误边界。

## packages/web/src/components/settings/SshActiveSessions.tsx

容器：Card:74。

已检查：无独立填写字段。复用共用组件或保留业务列表/展示、画布、权限及错误边界。

## packages/web/src/components/settings/SshCredentialsForm.tsx

容器：Card:174。

| 行 | 控件 / 字段 | 状态 | 原因 |
| --- | --- | --- | --- |
| 254 | ResourceSelect · "ssh-agent-id" | 已替换 | 共用 Radix Popover + cmdk / Dialog 资源选择器，沿用业务候选与 stable ID。 |
| 272 | LabeledInput · "ssh-username" | 保留 | 自由内容（名称、路径、命令、表达式、凭据或搜索查询），保持原提交与校验。 |
| 278 | LabeledInput · "ssh-host" | 保留 | 自由内容（名称、路径、命令、表达式、凭据或搜索查询），保持原提交与校验。 |
| 284 | LabeledInput · "ssh-port" | 保留 | 自由内容（名称、路径、命令、表达式、凭据或搜索查询），保持原提交与校验。 |
| 291 | LabeledInput · "ssh-password" | 保留 | 自由内容（名称、路径、命令、表达式、凭据或搜索查询），保持原提交与校验。 |
| 306 | Textarea · "ssh-private-key" | 保留 | 自由内容（名称、路径、命令、表达式、凭据或搜索查询），保持原提交与校验。 |
| 317 | LabeledInput · "ssh-passphrase" | 保留 | 自由内容（名称、路径、命令、表达式、凭据或搜索查询），保持原提交与校验。 |
| 330 | LabeledInput · "ssh-host-key" | 保留 | 自由内容（名称、路径、命令、表达式、凭据或搜索查询），保持原提交与校验。 |
| 377 | Input · {id} | 保留 | 自由内容（名称、路径、命令、表达式、凭据或搜索查询），保持原提交与校验。 |

## packages/web/src/components/settings/SshRecordingPlayer.tsx

容器：Card:225。

| 行 | 控件 / 字段 | 状态 | 原因 |
| --- | --- | --- | --- |
| 284 | Input · "ssh-rec-agent" | 保留 | 录像按历史 Agent 标识查询；当前目录不能可靠枚举已移除节点，保留历史 ID 过滤。 |
| 298 | Input · "ssh-rec-session" | 保留 | 自由内容（名称、路径、命令、表达式、凭据或搜索查询），保持原提交与校验。 |

## packages/web/src/components/software/CatalogEmptyState.tsx

容器：继承父容器 / 无独立容器。

已检查：无独立填写字段。复用共用组件或保留业务列表/展示、画布、权限及错误边界。

## packages/web/src/components/software/EcosystemGovernancePanels.tsx

容器：继承父容器 / 无独立容器。

| 行 | 控件 / 字段 | 状态 | 原因 |
| --- | --- | --- | --- |
| 122 | Input · {t("software.license.subject")} | 保留 | 自由内容（名称、路径、命令、表达式、凭据或搜索查询），保持原提交与校验。 |
| 128 | NativeSelect · {t("software.license.entitlement")} | 保留 | 少量固定枚举、分页大小、布尔策略或共用资源选择器的原生表单桥接，保留统一简单选择。 |
| 141 | Input · {t("software.license.providerOrg")} | 保留 | 授权声明可引用当前成员目录之外的组织或声明主体；没有完整且获授权的只读候选目录，保留原标识及服务端校验。 |
| 147 | Input · {t("software.license.claimant")} | 保留 | 授权声明可引用当前成员目录之外的组织或声明主体；没有完整且获授权的只读候选目录，保留原标识及服务端校验。 |
| 153 | Input · {t("software.license.evidenceReference")} | 保留 | 自由内容（名称、路径、命令、表达式、凭据或搜索查询），保持原提交与校验。 |
| 159 | Textarea · {t("software.license.evidenceSummary")} | 保留 | 自由内容（名称、路径、命令、表达式、凭据或搜索查询），保持原提交与校验。 |
| 411 | ResourceSelectField · {t("cp.accounts.registration.agent")} | 已替换 | 共用 Radix Popover + cmdk / Dialog 资源选择器，沿用业务候选与 stable ID。 |
| 476 | ResourceSelectField · {t("software.license.runtimeProfile")} | 已替换 | 共用 Radix Popover + cmdk / Dialog 资源选择器，沿用业务候选与 stable ID。 |
| 538 | ResourceSelectField · {t("software.license.materialSoftware")} | 已替换 | 共用 Radix Popover + cmdk / Dialog 资源选择器，沿用业务候选与 stable ID。 |
| 591 | Input · {t("software.license.materialSelector")} | 保留 | 自由内容（名称、路径、命令、表达式、凭据或搜索查询），保持原提交与校验。 |
| 597 | Input · {t("software.license.materialVersion")} | 保留 | 材料的外部版本标识，与平台软件版本目录语义不同，没有权威候选来源。 |
| 603 | Input · {t("software.license.elements")} | 保留 | 自由内容（名称、路径、命令、表达式、凭据或搜索查询），保持原提交与校验。 |
| 609 | Input · {t("software.license.fingerprint")} | 保留 | 自由内容（名称、路径、命令、表达式、凭据或搜索查询），保持原提交与校验。 |

## packages/web/src/components/software/FormHeader.tsx

容器：继承父容器 / 无独立容器。

已检查：无独立填写字段。复用共用组件或保留业务列表/展示、画布、权限及错误边界。

## packages/web/src/components/software/MaterialCatalog.tsx

容器：继承父容器 / 无独立容器。

| 行 | 控件 / 字段 | 状态 | 原因 |
| --- | --- | --- | --- |
| 108 | Input · {`${id}-repository`} | 保留 | 自由内容（名称、路径、命令、表达式、凭据或搜索查询），保持原提交与校验。 |

## packages/web/src/components/software/MaterialEvidence.tsx

容器：继承父容器 / 无独立容器。

已检查：无独立填写字段。复用共用组件或保留业务列表/展示、画布、权限及错误边界。

## packages/web/src/components/software/MaterialLifecycle.tsx

容器：继承父容器 / 无独立容器。

| 行 | 控件 / 字段 | 状态 | 原因 |
| --- | --- | --- | --- |
| 80 | Input · {`${id}-repository`} | 保留 | 只读、受权限或状态约束的字段，保留原数据展示与禁用规则。 |
| 92 | Input · {`${id}-digest`} | 保留 | 只读、受权限或状态约束的字段，保留原数据展示与禁用规则。 |
| 167 | Textarea · {`${id}-reason`} | 保留 | 只读、受权限或状态约束的字段，保留原数据展示与禁用规则。 |
| 189 | input · input | 保留 | 勾选、单选、文件上传或隐藏表单值，保留原生语义。 |

## packages/web/src/components/software/MaterialLifecycleHistory.tsx

容器：继承父容器 / 无独立容器。

已检查：无独立填写字段。复用共用组件或保留业务列表/展示、画布、权限及错误边界。

## packages/web/src/components/software/MaterialManagementCatalog.tsx

容器：继承父容器 / 无独立容器。

| 行 | 控件 / 字段 | 状态 | 原因 |
| --- | --- | --- | --- |
| 137 | Input · {`${id}-repository`} | 保留 | 自由内容（名称、路径、命令、表达式、凭据或搜索查询），保持原提交与校验。 |
| 151 | NativeSelect · {`${id}-state`} | 保留 | 少量固定枚举、分页大小、布尔策略或共用资源选择器的原生表单桥接，保留统一简单选择。 |
| 170 | NativeSelect · {`${id}-limit`} | 保留 | 少量固定枚举、分页大小、布尔策略或共用资源选择器的原生表单桥接，保留统一简单选择。 |

## packages/web/src/components/software/MaterialManagementEditors.tsx

容器：继承父容器 / 无独立容器。

已检查：无独立填写字段。复用共用组件或保留业务列表/展示、画布、权限及错误边界。

## packages/web/src/components/software/MaterialPackImport.tsx

容器：继承父容器 / 无独立容器。

| 行 | 控件 / 字段 | 状态 | 原因 |
| --- | --- | --- | --- |
| 187 | Input · {`${id}-manifest`} | 保留 | 勾选、单选、文件上传或隐藏表单值，保留原生语义。 |
| 200 | Input · {`${id}-files`} | 保留 | 勾选、单选、文件上传或隐藏表单值，保留原生语义。 |
| 213 | Input · {`${id}-directory`} | 保留 | 勾选、单选、文件上传或隐藏表单值，保留原生语义。 |
| 347 | input · input | 保留 | 勾选、单选、文件上传或隐藏表单值，保留原生语义。 |

## packages/web/src/components/software/MaterialReleaseLookup.tsx

容器：继承父容器 / 无独立容器。

| 行 | 控件 / 字段 | 状态 | 原因 |
| --- | --- | --- | --- |
| 96 | Input · {`${id}-repository`} | 保留 | 自由内容（名称、路径、命令、表达式、凭据或搜索查询），保持原提交与校验。 |
| 108 | Input · {`${id}-digest`} | 保留 | 自由内容（名称、路径、命令、表达式、凭据或搜索查询），保持原提交与校验。 |

## packages/web/src/components/software/MaterialVisibility.tsx

容器：继承父容器 / 无独立容器。

| 行 | 控件 / 字段 | 状态 | 原因 |
| --- | --- | --- | --- |
| 54 | Input · {`${id}-repository`} | 保留 | 只读、受权限或状态约束的字段，保留原数据展示与禁用规则。 |
| 66 | Input · {`${id}-digest`} | 保留 | 只读、受权限或状态约束的字段，保留原数据展示与禁用规则。 |

## packages/web/src/components/software/MaterialVisibilityForm.tsx

容器：继承父容器 / 无独立容器。

| 行 | 控件 / 字段 | 状态 | 原因 |
| --- | --- | --- | --- |
| 59 | NativeSelect · {`${id}-mode`} | 保留 | 少量固定枚举、分页大小、布尔策略或共用资源选择器的原生表单桥接，保留统一简单选择。 |
| 89 | Textarea · {`${id}-${field.key}`} | 保留 | 只读、受权限或状态约束的字段，保留原数据展示与禁用规则。 |
| 119 | Textarea · {`${id}-reason`} | 保留 | 只读、受权限或状态约束的字段，保留原数据展示与禁用规则。 |
| 140 | input · input | 保留 | 勾选、单选、文件上传或隐藏表单值，保留原生语义。 |

## packages/web/src/components/software/MaterialVisibilityHistory.tsx

容器：继承父容器 / 无独立容器。

已检查：无独立填写字段。复用共用组件或保留业务列表/展示、画布、权限及错误边界。

## packages/web/src/components/software/OfflineDeliveryImport.tsx

容器：继承父容器 / 无独立容器。

| 行 | 控件 / 字段 | 状态 | 原因 |
| --- | --- | --- | --- |
| 123 | Input · {`${id}-plan`} | 保留 | 勾选、单选、文件上传或隐藏表单值，保留原生语义。 |
| 135 | Input · {`${id}-files`} | 保留 | 勾选、单选、文件上传或隐藏表单值，保留原生语义。 |

## packages/web/src/components/software/RecipeBundleImport.tsx

容器：继承父容器 / 无独立容器。

| 行 | 控件 / 字段 | 状态 | 原因 |
| --- | --- | --- | --- |
| 88 | Input · {fileInputId} | 保留 | 勾选、单选、文件上传或隐藏表单值，保留原生语义。 |
| 138 | Input · {t("recipes.namespace", { file: item.file.name })} | 保留 | 只读、受权限或状态约束的字段，保留原数据展示与禁用规则。 |

## packages/web/src/components/software/RecipeRepositoriesPanel.tsx

容器：继承父容器 / 无独立容器。

已检查：无独立填写字段。复用共用组件或保留业务列表/展示、画布、权限及错误边界。

## packages/web/src/components/software/RecipeRepositoryDetail.tsx

容器：DialogContent:232。

| 行 | 控件 / 字段 | 状态 | 原因 |
| --- | --- | --- | --- |
| 252 | input · input | 保留 | 勾选、单选、文件上传或隐藏表单值，保留原生语义。 |

## packages/web/src/components/software/RecipeSnapshotReport.tsx

容器：继承父容器 / 无独立容器。

已检查：无独立填写字段。复用共用组件或保留业务列表/展示、画布、权限及错误边界。

## packages/web/src/components/software/SandboxCodeEditor.tsx

容器：继承父容器 / 无独立容器。

已检查：无独立填写字段。复用共用组件或保留业务列表/展示、画布、权限及错误边界。

## packages/web/src/components/software/SandboxScriptCatalog.tsx

容器：PageShell:66。

| 行 | 控件 / 字段 | 状态 | 原因 |
| --- | --- | --- | --- |
| 103 | NativeSelect · "sandbox-language-filter" | 保留 | 少量固定枚举、分页大小、布尔策略或共用资源选择器的原生表单桥接，保留统一简单选择。 |

## packages/web/src/components/software/SandboxScriptStudio.tsx

容器：PageShell:430、DialogContent:479、Card:827。

| 行 | 控件 / 字段 | 状态 | 原因 |
| --- | --- | --- | --- |
| 203 | Textarea · {entrypoint \|\| t("sandbox.studio.entrypoint")} | 保留 | 自由内容（名称、路径、命令、表达式、凭据或搜索查询），保持原提交与校验。 |
| 515 | Input · {draft.name} | 保留 | 自由内容（名称、路径、命令、表达式、凭据或搜索查询），保持原提交与校验。 |
| 523 | Input · {draft.version} | 保留 | 发布或登记新版本的版本号，属于创建内容；已有版本引用在独立资源选择控件中处理。 |
| 532 | ResourceSelectField · {selectedRevision ?? ""} | 已替换 | 共用 Radix Popover + cmdk / Dialog 资源选择器，沿用业务候选与 stable ID。 |
| 552 | Textarea · {draft.inputsText} | 保留 | 自由内容（名称、路径、命令、表达式、凭据或搜索查询），保持原提交与校验。 |
| 562 | Textarea · {draft.outputsText} | 保留 | 自由内容（名称、路径、命令、表达式、凭据或搜索查询），保持原提交与校验。 |
| 593 | Input · {draft.changelog} | 保留 | 自由内容（名称、路径、命令、表达式、凭据或搜索查询），保持原提交与校验。 |
| 607 | NativeSelect · {draft.language} | 保留 | 少量固定枚举、分页大小、布尔策略或共用资源选择器的原生表单桥接，保留统一简单选择。 |
| 618 | ResourceSelectField · {draft.runtimeProfileId} | 已替换 | 共用 Radix Popover + cmdk / Dialog 资源选择器，沿用业务候选与 stable ID。 |
| 637 | Input · {draft.entrypoint} | 保留 | 自由内容（名称、路径、命令、表达式、凭据或搜索查询），保持原提交与校验。 |
| 703 | Textarea · {draft.fixturesText} | 保留 | 自由内容（名称、路径、命令、表达式、凭据或搜索查询），保持原提交与校验。 |
| 714 | Input · {mappingId} | 保留 | 自由内容（名称、路径、命令、表达式、凭据或搜索查询），保持原提交与校验。 |
| 745 | Input · {promptSource} | 保留 | 自由内容（名称、路径、命令、表达式、凭据或搜索查询），保持原提交与校验。 |
| 751 | Input · {promptTarget} | 保留 | 自由内容（名称、路径、命令、表达式、凭据或搜索查询），保持原提交与校验。 |
| 757 | Input · {promptUsecase} | 保留 | 自由内容（名称、路径、命令、表达式、凭据或搜索查询），保持原提交与校验。 |
| 772 | Textarea · {renderedPrompt} | 保留 | 自由内容（名称、路径、命令、表达式、凭据或搜索查询），保持原提交与校验。 |
| 799 | NativeSelect · {plannerMode} | 保留 | 少量固定枚举、分页大小、布尔策略或共用资源选择器的原生表单桥接，保留统一简单选择。 |

## packages/web/src/components/software/SmallEmpty.tsx

容器：继承父容器 / 无独立容器。

已检查：无独立填写字段。复用共用组件或保留业务列表/展示、画布、权限及错误边界。

## packages/web/src/components/software/SoftwareCard.tsx

容器：Card:52。

已检查：无独立填写字段。复用共用组件或保留业务列表/展示、画布、权限及错误边界。

## packages/web/src/components/software/SoftwareCardGrid.tsx

容器：继承父容器 / 无独立容器。

已检查：无独立填写字段。复用共用组件或保留业务列表/展示、画布、权限及错误边界。

## packages/web/src/components/software/SoftwareCreatePages.tsx

容器：PageShell:41。

已检查：无独立填写字段。复用共用组件或保留业务列表/展示、画布、权限及错误边界。

## packages/web/src/components/software/SoftwareDetailPages.tsx

容器：PageShell:67。

已检查：无独立填写字段。复用共用组件或保留业务列表/展示、画布、权限及错误边界。

## packages/web/src/components/software/SoftwarePage.tsx

容器：PageShell:570、SheetContent:1458、SheetContent:1699、SheetContent:2084、DialogContent:2111。

| 行 | 控件 / 字段 | 状态 | 原因 |
| --- | --- | --- | --- |
| 1553 | Input · {name} | 保留 | 自由内容（名称、路径、命令、表达式、凭据或搜索查询），保持原提交与校验。 |
| 1557 | Input · {version} | 保留 | 发布或登记新版本的版本号，属于创建内容；已有版本引用在独立资源选择控件中处理。 |
| 1563 | Input · {description} | 保留 | 自由内容（名称、路径、命令、表达式、凭据或搜索查询），保持原提交与校验。 |
| 1567 | Input · {tags} | 保留 | 自由内容（名称、路径、命令、表达式、凭据或搜索查询），保持原提交与校验。 |
| 1571 | Textarea · {yamlContent} | 保留 | 自由内容（名称、路径、命令、表达式、凭据或搜索查询），保持原提交与校验。 |
| 2195 | Input · {name} | 保留 | 自由内容（名称、路径、命令、表达式、凭据或搜索查询），保持原提交与校验。 |
| 2199 | NativeSelect · {`${id}-source`} | 保留 | 少量固定枚举、分页大小、布尔策略或共用资源选择器的原生表单桥接，保留统一简单选择。 |
| 2212 | Input · {description} | 保留 | 自由内容（名称、路径、命令、表达式、凭据或搜索查询），保持原提交与校验。 |
| 2216 | Input · {tags} | 保留 | 自由内容（名称、路径、命令、表达式、凭据或搜索查询），保持原提交与校验。 |
| 2385 | Input · {name} | 保留 | 自由内容（名称、路径、命令、表达式、凭据或搜索查询），保持原提交与校验。 |
| 2389 | Input · {version} | 保留 | 发布或登记新版本的版本号，属于创建内容；已有版本引用在独立资源选择控件中处理。 |
| 2395 | Input · {description} | 保留 | 自由内容（名称、路径、命令、表达式、凭据或搜索查询），保持原提交与校验。 |
| 2400 | Input · {commandFile} | 保留 | 自由内容（名称、路径、命令、表达式、凭据或搜索查询），保持原提交与校验。 |
| 2444 | Input · {inputDescriptor} | 保留 | 自由内容（名称、路径、命令、表达式、凭据或搜索查询），保持原提交与校验。 |
| 2453 | Input · {argumentFormat} | 保留 | 自由内容（名称、路径、命令、表达式、凭据或搜索查询），保持原提交与校验。 |

## packages/web/src/components/software/SoftwarePublisherRoute.tsx

容器：PageShell:25、PageShell:43。

已检查：无独立填写字段。复用共用组件或保留业务列表/展示、画布、权限及错误边界。

## packages/web/src/components/software/SpackCatalogPackageForm.tsx

容器：继承父容器 / 无独立容器。

| 行 | 控件 / 字段 | 状态 | 原因 |
| --- | --- | --- | --- |
| 88 | Input · {name} | 保留 | 自由内容（名称、路径、命令、表达式、凭据或搜索查询），保持原提交与校验。 |
| 100 | NativeSelect · {`${id}-source`} | 保留 | 少量固定枚举、分页大小、布尔策略或共用资源选择器的原生表单桥接，保留统一简单选择。 |
| 118 | Input · {description} | 保留 | 自由内容（名称、路径、命令、表达式、凭据或搜索查询），保持原提交与校验。 |
| 130 | Textarea · {`${id}-packageFile`} | 保留 | 自由内容（名称、路径、命令、表达式、凭据或搜索查询），保持原提交与校验。 |
| 161 | Input · {tags} | 保留 | 自由内容（名称、路径、命令、表达式、凭据或搜索查询），保持原提交与校验。 |

## packages/web/src/components/software/SpackCatalogPicker.tsx

容器：DialogContent:99。

已检查：无独立填写字段。复用共用组件或保留业务列表/展示、画布、权限及错误边界。

## packages/web/src/components/software/SpackInstallBindingEditor.tsx

容器：继承父容器 / 无独立容器。

| 行 | 控件 / 字段 | 状态 | 原因 |
| --- | --- | --- | --- |
| 54 | NativeSelect · {`${id}-scope`} | 保留 | 少量固定枚举、分页大小、布尔策略或共用资源选择器的原生表单桥接，保留统一简单选择。 |
| 72 | Input · {`${id}-spec`} | 保留 | 只读、受权限或状态约束的字段，保留原数据展示与禁用规则。 |

## packages/web/src/components/software/SpackInstallBindingForm.tsx

容器：继承父容器 / 无独立容器。

| 行 | 控件 / 字段 | 状态 | 原因 |
| --- | --- | --- | --- |
| 69 | NativeSelect · {`${id}-action`} | 保留 | 少量固定枚举、分页大小、布尔策略或共用资源选择器的原生表单桥接，保留统一简单选择。 |
| 93 | Input · {`${id}-${field.key}`} | 保留 | 只读、受权限或状态约束的字段，保留原数据展示与禁用规则。 |
| 126 | Textarea · {`${id}-reason`} | 保留 | 只读、受权限或状态约束的字段，保留原数据展示与禁用规则。 |
| 147 | input · input | 保留 | 勾选、单选、文件上传或隐藏表单值，保留原生语义。 |

## packages/web/src/components/software/SpackInstallBindingHistory.tsx

容器：继承父容器 / 无独立容器。

已检查：无独立填写字段。复用共用组件或保留业务列表/展示、画布、权限及错误边界。

## packages/web/src/components/software/SpackMaterialsPanel.tsx

容器：继承父容器 / 无独立容器。

已检查：无独立填写字段。复用共用组件或保留业务列表/展示、画布、权限及错误边界。

## packages/web/src/components/software/SpackOnlineImport.tsx

容器：继承父容器 / 无独立容器。

| 行 | 控件 / 字段 | 状态 | 原因 |
| --- | --- | --- | --- |
| 131 | input · {t(`spackOnline.${kind}Manifest`)} | 保留 | 勾选、单选、文件上传或隐藏表单值，保留原生语义。 |

## packages/web/src/components/software/SpackSpecPicker.tsx

容器：SheetContent:138。

| 行 | 控件 / 字段 | 状态 | 原因 |
| --- | --- | --- | --- |
| 164 | Input · "software-usecase-spec-version" | 保留 | 自由内容（名称、路径、命令、表达式、凭据或搜索查询），保持原提交与校验。 |
| 174 | Input · "software-usecase-spec-compiler" | 保留 | 自由内容（名称、路径、命令、表达式、凭据或搜索查询），保持原提交与校验。 |
| 184 | Input · "software-usecase-spec-module" | 保留 | 自由内容（名称、路径、命令、表达式、凭据或搜索查询），保持原提交与校验。 |
| 194 | Input · "software-usecase-spec-variants" | 保留 | 自由内容（名称、路径、命令、表达式、凭据或搜索查询），保持原提交与校验。 |
| 352 | Textarea · "software-usecase-compiler-source" | 保留 | 自由内容（名称、路径、命令、表达式、凭据或搜索查询），保持原提交与校验。 |

## packages/web/src/components/software/UsecasePackageForm.tsx

容器：继承父容器 / 无独立容器。

| 行 | 控件 / 字段 | 状态 | 原因 |
| --- | --- | --- | --- |
| 121 | Input · {name} | 保留 | 自由内容（名称、路径、命令、表达式、凭据或搜索查询），保持原提交与校验。 |
| 125 | Input · {version} | 保留 | 自由内容（名称、路径、命令、表达式、凭据或搜索查询），保持原提交与校验。 |
| 131 | Input · {description} | 保留 | 自由内容（名称、路径、命令、表达式、凭据或搜索查询），保持原提交与校验。 |
| 136 | Input · {commandFile} | 保留 | 自由内容（名称、路径、命令、表达式、凭据或搜索查询），保持原提交与校验。 |
| 186 | Input · {inputDescriptor} | 保留 | 自由内容（名称、路径、命令、表达式、凭据或搜索查询），保持原提交与校验。 |
| 195 | Input · {argumentFormat} | 保留 | 自由内容（名称、路径、命令、表达式、凭据或搜索查询），保持原提交与校验。 |

## packages/web/src/components/software/WorkflowTemplateForm.tsx

容器：继承父容器 / 无独立容器。

| 行 | 控件 / 字段 | 状态 | 原因 |
| --- | --- | --- | --- |
| 44 | Input · {name} | 保留 | 自由内容（名称、路径、命令、表达式、凭据或搜索查询），保持原提交与校验。 |
| 48 | Input · {version} | 保留 | 自由内容（名称、路径、命令、表达式、凭据或搜索查询），保持原提交与校验。 |
| 54 | Input · {description} | 保留 | 自由内容（名称、路径、命令、表达式、凭据或搜索查询），保持原提交与校验。 |
| 58 | Input · {tags} | 保留 | 自由内容（名称、路径、命令、表达式、凭据或搜索查询），保持原提交与校验。 |
| 62 | Textarea · {yamlContent} | 保留 | 自由内容（名称、路径、命令、表达式、凭据或搜索查询），保持原提交与校验。 |

## packages/web/src/components/ssh/SshTerminal.tsx

容器：继承父容器 / 无独立容器。

已检查：无独立填写字段。复用共用组件或保留业务列表/展示、画布、权限及错误边界。

## packages/web/src/components/terminal/AuditDrawer.tsx

容器：SheetContent:65。

| 行 | 控件 / 字段 | 状态 | 原因 |
| --- | --- | --- | --- |
| 130 | Input · "terminal-audit-search" | 保留 | 自由内容（名称、路径、命令、表达式、凭据或搜索查询），保持原提交与校验。 |

## packages/web/src/components/terminal/NewSessionDialog.tsx

容器：SheetContent:106。

| 行 | 控件 / 字段 | 状态 | 原因 |
| --- | --- | --- | --- |
| 142 | ResourceSelectField · "terminal-agent" | 已替换 | 共用 Radix Popover + cmdk / Dialog 资源选择器，沿用业务候选与 stable ID。 |
| 187 | ResourceSelectField · "terminal-user" | 已替换 | 共用 Radix Popover + cmdk / Dialog 资源选择器，沿用业务候选与 stable ID。 |

## packages/web/src/components/terminal/SessionPane.tsx

容器：继承父容器 / 无独立容器。

已检查：无独立填写字段。复用共用组件或保留业务列表/展示、画布、权限及错误边界。

## packages/web/src/components/terminal/TerminalPage.tsx

容器：PageShell:168。

已检查：无独立填写字段。复用共用组件或保留业务列表/展示、画布、权限及错误边界。

## packages/web/src/components/workflow/EdgeTypes.tsx

容器：继承父容器 / 无独立容器。

已检查：无独立填写字段。复用共用组件或保留业务列表/展示、画布、权限及错误边界。

## packages/web/src/components/workflow/FederationNodeFields.tsx

容器：继承父容器 / 无独立容器。

| 行 | 控件 / 字段 | 状态 | 原因 |
| --- | --- | --- | --- |
| 97 | Input · {`${id}-${name}`} | 保留 | 自由内容（名称、路径、命令、表达式、凭据或搜索查询），保持原提交与校验。 |
| 133 | NativeSelect · {`${id}-templateKind`} | 保留 | 少量固定枚举、分页大小、布尔策略或共用资源选择器的原生表单桥接，保留统一简单选择。 |
| 166 | NativeSelect · {`${id}-${name}`} | 保留 | 少量固定枚举、分页大小、布尔策略或共用资源选择器的原生表单桥接，保留统一简单选择。 |
| 181 | input · "marketEnabled" | 保留 | 勾选、单选、文件上传或隐藏表单值，保留原生语义。 |
| 199 | Textarea · {`${id}-description`} | 保留 | 自由内容（名称、路径、命令、表达式、凭据或搜索查询），保持原提交与校验。 |
| 213 | input · "arbitrationEnabled" | 保留 | 勾选、单选、文件上传或隐藏表单值，保留原生语义。 |

## packages/web/src/components/workflow/NodePalette.tsx

容器：继承父容器 / 无独立容器。

已检查：无独立填写字段。复用共用组件或保留业务列表/展示、画布、权限及错误边界。

## packages/web/src/components/workflow/NodeTypes.tsx

容器：继承父容器 / 无独立容器。

已检查：无独立填写字段。复用共用组件或保留业务列表/展示、画布、权限及错误边界。

## packages/web/src/components/workflow/PropertiesPanel.tsx

容器：继承父容器 / 无独立容器。

| 行 | 控件 / 字段 | 状态 | 原因 |
| --- | --- | --- | --- |
| 316 | Input · {when} | 保留 | 自由内容（名称、路径、命令、表达式、凭据或搜索查询），保持原提交与校验。 |
| 407 | Input · "rf-prop-id" | 保留 | 自由内容（名称、路径、命令、表达式、凭据或搜索查询），保持原提交与校验。 |
| 410 | Input · "rf-prop-type" | 保留 | 自由内容（名称、路径、命令、表达式、凭据或搜索查询），保持原提交与校验。 |
| 420 | Input · "rf-prop-name" | 保留 | 自由内容（名称、路径、命令、表达式、凭据或搜索查询），保持原提交与校验。 |
| 433 | Input · "rf-prop-when" | 保留 | 自由内容（名称、路径、命令、表达式、凭据或搜索查询），保持原提交与校验。 |
| 563 | ResourceSelect · "rf-prop-usecase-version-select" | 已替换 | 共用 Radix Popover + cmdk / Dialog 资源选择器，沿用业务候选与 stable ID。 |
| 593 | Input · "rf-prop-usecase-version-id" | 保留 | 嵌入编辑器未提供候选目录时的兼容分支；平台 Shell 已提供资源目录及当前图候选，运行时使用 ResourceSelect。SubWorkflow ByVersion 没有可验证的 workflowVersionId 目录，保留原 ID 输入。 |
| 609 | Input · "rf-prop-software-version-id" | 保留 | 嵌入编辑器未提供候选目录时的兼容分支；平台 Shell 已提供资源目录及当前图候选，运行时使用 ResourceSelect。SubWorkflow ByVersion 没有可验证的 workflowVersionId 目录，保留原 ID 输入。 |
| 628 | Input · {`rf-prop-req-${field}`} | 保留 | 数值输入；共用 Input 提供合法范围内的原生预设，并保留自定义数值与 min/max/step。 |
| 711 | NativeSelect · "rf-prop-script-source" | 保留 | 少量固定枚举、分页大小、布尔策略或共用资源选择器的原生表单桥接，保留统一简单选择。 |
| 730 | ResourceSelect · "rf-prop-script-runtime-select" | 已替换 | 共用 Radix Popover + cmdk / Dialog 资源选择器，沿用业务候选与 stable ID。 |
| 746 | Input · "rf-prop-script-runtime" | 保留 | 嵌入编辑器未提供候选目录时的兼容分支；平台 Shell 已提供资源目录及当前图候选，运行时使用 ResourceSelect。SubWorkflow ByVersion 没有可验证的 workflowVersionId 目录，保留原 ID 输入。 |
| 764 | Input · "rf-prop-script-identity" | 保留 | 自由内容（名称、路径、命令、表达式、凭据或搜索查询），保持原提交与校验。 |
| 776 | Input · "rf-prop-script-language" | 保留 | 自由内容（名称、路径、命令、表达式、凭据或搜索查询），保持原提交与校验。 |
| 786 | Textarea · "rf-prop-script-content" | 保留 | 自由内容（名称、路径、命令、表达式、凭据或搜索查询），保持原提交与校验。 |
| 845 | Input · "rf-prop-milestone-url" | 保留 | 自由内容（名称、路径、命令、表达式、凭据或搜索查询），保持原提交与校验。 |
| 858 | Textarea · "rf-prop-milestone-message" | 保留 | 自由内容（名称、路径、命令、表达式、凭据或搜索查询），保持原提交与校验。 |
| 963 | Input · {`rf-prop-switch-case-when-${index}`} | 保留 | 自由内容（名称、路径、命令、表达式、凭据或搜索查询），保持原提交与校验。 |
| 973 | ResourceSelect · {`rf-prop-switch-case-to-select-${index}`} | 已替换 | 共用 Radix Popover + cmdk / Dialog 资源选择器，沿用业务候选与 stable ID。 |
| 993 | Input · {`rf-prop-switch-case-to-${index}`} | 保留 | 自由内容（名称、路径、命令、表达式、凭据或搜索查询），保持原提交与校验。 |
| 1034 | ResourceSelect · {defaultTo} | 已替换 | 共用 Radix Popover + cmdk / Dialog 资源选择器，沿用业务候选与 stable ID。 |
| 1048 | Input · "rf-prop-switch-default" | 保留 | 自由内容（名称、路径、命令、表达式、凭据或搜索查询），保持原提交与校验。 |
| 1148 | NativeSelect · "rf-prop-loop-mode" | 保留 | 少量固定枚举、分页大小、布尔策略或共用资源选择器的原生表单桥接，保留统一简单选择。 |
| 1166 | Input · "rf-prop-loop-max-iterations" | 保留 | 自由内容（名称、路径、命令、表达式、凭据或搜索查询），保持原提交与校验。 |
| 1176 | Input · "rf-prop-loop-over" | 保留 | 自由内容（名称、路径、命令、表达式、凭据或搜索查询），保持原提交与校验。 |
| 1188 | Input · "rf-prop-loop-until" | 保留 | 自由内容（名称、路径、命令、表达式、凭据或搜索查询），保持原提交与校验。 |
| 1200 | NativeSelect · "rf-prop-loop-on-exhausted" | 保留 | 少量固定枚举、分页大小、布尔策略或共用资源选择器的原生表单桥接，保留统一简单选择。 |
| 1214 | Input · "rf-prop-loop-max-parallel" | 保留 | 数值输入；共用 Input 提供合法范围内的原生预设，并保留自定义数值与 min/max/step。 |
| 1289 | ResourceSelect · {fromLoop} | 已替换 | 共用 Radix Popover + cmdk / Dialog 资源选择器，沿用业务候选与 stable ID。 |
| 1302 | Input · "rf-prop-reduce-from-loop" | 保留 | 嵌入编辑器未提供候选目录时的兼容分支；平台 Shell 已提供资源目录及当前图候选，运行时使用 ResourceSelect。SubWorkflow ByVersion 没有可验证的 workflowVersionId 目录，保留原 ID 输入。 |
| 1315 | ResourceSelect · {fromOutput} | 已替换 | 共用 Radix Popover + cmdk / Dialog 资源选择器，沿用业务候选与 stable ID。 |
| 1333 | Input · "rf-prop-reduce-from-output" | 保留 | 嵌入编辑器未提供候选目录时的兼容分支；平台 Shell 已提供资源目录及当前图候选，运行时使用 ResourceSelect。SubWorkflow ByVersion 没有可验证的 workflowVersionId 目录，保留原 ID 输入。 |
| 1345 | NativeSelect · "rf-prop-reduce-ordering" | 保留 | 少量固定枚举、分页大小、布尔策略或共用资源选择器的原生表单桥接，保留统一简单选择。 |
| 1359 | NativeSelect · "rf-prop-reduce-output-kind" | 保留 | 少量固定枚举、分页大小、布尔策略或共用资源选择器的原生表单桥接，保留统一简单选择。 |
| 1374 | Input · "rf-prop-reduce-output-descriptor" | 保留 | 自由内容（名称、路径、命令、表达式、凭据或搜索查询），保持原提交与校验。 |
| 1451 | NativeSelect · "rf-prop-subworkflow-ref-kind" | 保留 | 少量固定枚举、分页大小、布尔策略或共用资源选择器的原生表单桥接，保留统一简单选择。 |
| 1469 | Input · "rf-prop-subworkflow-version-id" | 保留 | 嵌入编辑器未提供候选目录时的兼容分支；平台 Shell 已提供资源目录及当前图候选，运行时使用 ResourceSelect。SubWorkflow ByVersion 没有可验证的 workflowVersionId 目录，保留原 ID 输入。 |
| 1494 | Input · "rf-prop-subworkflow-max-depth" | 保留 | 数值输入；共用 Input 提供合法范围内的原生预设，并保留自定义数值与 min/max/step。 |
| 1507 | NativeSelect · "rf-prop-subworkflow-on-depth-exceeded" | 保留 | 少量固定枚举、分页大小、布尔策略或共用资源选择器的原生表单桥接，保留统一简单选择。 |
| 1555 | Input · "rf-prop-generate-output-descriptor" | 保留 | 自由内容（名称、路径、命令、表达式、凭据或搜索查询），保持原提交与校验。 |
| 1566 | NativeSelect · "rf-prop-generate-output-as" | 保留 | 少量固定枚举、分页大小、布尔策略或共用资源选择器的原生表单桥接，保留统一简单选择。 |

## packages/web/src/components/workflow/ReactFlowEditor.tsx

容器：继承父容器 / 无独立容器。

已检查：无独立填写字段。复用共用组件或保留业务列表/展示、画布、权限及错误边界。

## packages/web/src/components/workflow/WorkflowEditorShell.tsx

容器：继承父容器 / 无独立容器。

| 行 | 控件 / 字段 | 状态 | 原因 |
| --- | --- | --- | --- |
| 480 | NativeSelect · "rf-shell-flow-animation" | 保留 | 少量固定枚举、分页大小、布尔策略或共用资源选择器的原生表单桥接，保留统一简单选择。 |
| 523 | input · input | 保留 | 勾选、单选、文件上传或隐藏表单值，保留原生语义。 |

## packages/web/src/components/workflow/WorkflowSlotMappingDialog.tsx

容器：DialogContent:199。

| 行 | 控件 / 字段 | 状态 | 原因 |
| --- | --- | --- | --- |
| 276 | ResourceSelectField · {fromSlot} | 已替换 | 共用 Radix Popover + cmdk / Dialog 资源选择器，沿用业务候选与 stable ID。 |
| 305 | ResourceSelectField · {toSlot} | 已替换 | 共用 Radix Popover + cmdk / Dialog 资源选择器，沿用业务候选与 stable ID。 |
| 321 | NativeSelect · {transferType} | 保留 | 少量固定枚举、分页大小、布尔策略或共用资源选择器的原生表单桥接，保留统一简单选择。 |

## packages/web/src/components/workflows/DeleteWorkflowDraftDialog.tsx

容器：DialogContent:38。

已检查：无独立填写字段。复用共用组件或保留业务列表/展示、画布、权限及错误边界。

## packages/web/src/components/workflows/NewWorkflowPage.tsx

容器：DialogContent:829、DialogContent:866。

| 行 | 控件 / 字段 | 状态 | 原因 |
| --- | --- | --- | --- |
| 683 | input · "workflow-name-input" | 保留 | 自由内容（名称、路径、命令、表达式、凭据或搜索查询），保持原提交与校验。 |

## packages/web/src/components/workflows/ParsedStepsPreview.tsx

容器：继承父容器 / 无独立容器。

已检查：无独立填写字段。复用共用组件或保留业务列表/展示、画布、权限及错误边界。

## packages/web/src/components/workflows/TemplateGallery.tsx

容器：继承父容器 / 无独立容器。

已检查：无独立填写字段。复用共用组件或保留业务列表/展示、画布、权限及错误边界。

## packages/web/src/components/workflows/WorkflowCreationStepper.tsx

容器：继承父容器 / 无独立容器。

已检查：无独立填写字段。复用共用组件或保留业务列表/展示、画布、权限及错误边界。

## packages/web/src/components/workflows/WorkflowDagView.tsx

容器：Card:336、Card:361、DialogContent:443、Card:491、Card:507、Card:557、Card:571、Card:584、Card:629。

已检查：无独立填写字段。复用共用组件或保留业务列表/展示、画布、权限及错误边界。

## packages/web/src/components/workflows/WorkflowInputsStep.tsx

容器：Card:535、Card:614、Card:662。

| 行 | 控件 / 字段 | 状态 | 原因 |
| --- | --- | --- | --- |
| 559 | NativeSelect · {`workflow-value-${requirement.key}`} | 保留 | 少量固定枚举、分页大小、布尔策略或共用资源选择器的原生表单桥接，保留统一简单选择。 |
| 572 | Textarea · {`workflow-value-${requirement.key}`} | 保留 | 自由内容（名称、路径、命令、表达式、凭据或搜索查询），保持原提交与校验。 |
| 585 | Input · {`workflow-value-${requirement.key}`} | 保留 | 自由内容（名称、路径、命令、表达式、凭据或搜索查询），保持原提交与校验。 |
| 715 | input · "workflow-choose-local-file" | 保留 | 勾选、单选、文件上传或隐藏表单值，保留原生语义。 |
| 730 | input · "workflow-choose-local-folder" | 保留 | 勾选、单选、文件上传或隐藏表单值，保留原生语义。 |
| 893 | input · {`workflow-choose-local-file-${requirement.key}`} | 保留 | 勾选、单选、文件上传或隐藏表单值，保留原生语义。 |
| 915 | input · {`workflow-choose-local-folder-${requirement.key}`} | 保留 | 勾选、单选、文件上传或隐藏表单值，保留原生语义。 |
| 1153 | ResourceSelectField · {`workflow-dataset-select-${requirement.key}`} | 已替换 | 共用 Radix Popover + cmdk / Dialog 资源选择器，沿用业务候选与 stable ID。 |

## packages/web/src/components/workflows/WorkflowPickerDialogs.tsx

容器：DialogContent:100、DialogContent:322。

| 行 | 控件 / 字段 | 状态 | 原因 |
| --- | --- | --- | --- |
| 121 | ResourceSelectField · "workflow-template-tag-filter" | 已替换 | 共用 Radix Popover + cmdk / Dialog 资源选择器，沿用业务候选与 stable ID。 |
| 339 | NativeSelect · "workflow-usecase-runtime-filter" | 保留 | 少量固定枚举、分页大小、布尔策略或共用资源选择器的原生表单桥接，保留统一简单选择。 |
| 350 | NativeSelect · "workflow-usecase-input-filter" | 保留 | 少量固定枚举、分页大小、布尔策略或共用资源选择器的原生表单桥接，保留统一简单选择。 |

## packages/web/src/components/workflows/WorkflowResourcesStep.tsx

容器：Card:151、Card:242。

| 行 | 控件 / 字段 | 状态 | 原因 |
| --- | --- | --- | --- |
| 167 | NativeSelect · "workflow-resource-planner-mode" | 保留 | 少量固定枚举、分页大小、布尔策略或共用资源选择器的原生表单桥接，保留统一简单选择。 |
| 200 | Input · "workflow-placement-budget" | 保留 | 数值输入；共用 Input 提供合法范围内的原生预设，并保留自定义数值与 min/max/step。 |
| 269 | NativeSelect · "workflow-resource-node-strategy" | 保留 | 少量固定枚举、分页大小、布尔策略或共用资源选择器的原生表单桥接，保留统一简单选择。 |
| 293 | ResourceSelectField · "workflow-resource-target-queue" | 已替换 | 共用 Radix Popover + cmdk / Dialog 资源选择器，沿用业务候选与 stable ID。 |
| 316 | NativeSelect · "workflow-resource-data-movement" | 保留 | 少量固定枚举、分页大小、布尔策略或共用资源选择器的原生表单桥接，保留统一简单选择。 |

## packages/web/src/components/workflows/WorkflowReviewGraph.tsx

容器：继承父容器 / 无独立容器。

已检查：无独立填写字段。复用共用组件或保留业务列表/展示、画布、权限及错误边界。

## packages/web/src/components/workflows/WorkflowReviewStep.tsx

容器：Card:133。

已检查：无独立填写字段。复用共用组件或保留业务列表/展示、画布、权限及错误边界。

## packages/web/src/components/workflows/WorkflowRunGraph.tsx

容器：继承父容器 / 无独立容器。

已检查：无独立填写字段。复用共用组件或保留业务列表/展示、画布、权限及错误边界。

## packages/web/src/components/workflows/WorkflowScriptPickerDialog.tsx

容器：继承父容器 / 无独立容器。

| 行 | 控件 / 字段 | 状态 | 原因 |
| --- | --- | --- | --- |
| 52 | NativeSelect · "workflow-script-language-filter" | 保留 | 少量固定枚举、分页大小、布尔策略或共用资源选择器的原生表单桥接，保留统一简单选择。 |

## packages/web/src/components/workflows/WorkflowStartOverlay.tsx

容器：继承父容器 / 无独立容器。

已检查：无独立填写字段。复用共用组件或保留业务列表/展示、画布、权限及错误边界。

## packages/web/src/components/workflows/WorkflowsPage.tsx

容器：PageShell:166。

已检查：无独立填写字段。复用共用组件或保留业务列表/展示、画布、权限及错误边界。

## packages/web/src/components/workflows/WorkflowsTable.tsx

容器：继承父容器 / 无独立容器。

已检查：无独立填写字段。复用共用组件或保留业务列表/展示、画布、权限及错误边界。

## packages/web/src/routes/__root.tsx

容器：继承父容器 / 无独立容器。

已检查：无独立填写字段。复用共用组件或保留业务列表/展示、画布、权限及错误边界。

## packages/web/src/routes/agents.$agentId.software.tsx

容器：继承父容器 / 无独立容器。

已检查：无独立填写字段。复用共用组件或保留业务列表/展示、画布、权限及错误边界。

## packages/web/src/routes/agents.$agentId.ssh.tsx

容器：PageShell:30、PageShell:46。

已检查：无独立填写字段。复用共用组件或保留业务列表/展示、画布、权限及错误边界。

## packages/web/src/routes/agents.tsx

容器：继承父容器 / 无独立容器。

已检查：无独立填写字段。复用共用组件或保留业务列表/展示、画布、权限及错误边界。

## packages/web/src/routes/cp.accounts.tsx

容器：继承父容器 / 无独立容器。

已检查：无独立填写字段。复用共用组件或保留业务列表/展示、画布、权限及错误边界。

## packages/web/src/routes/cp.agent-registration.tsx

容器：继承父容器 / 无独立容器。

已检查：无独立填写字段。复用共用组件或保留业务列表/展示、画布、权限及错误边界。

## packages/web/src/routes/cp.agents.tsx

容器：继承父容器 / 无独立容器。

已检查：无独立填写字段。复用共用组件或保留业务列表/展示、画布、权限及错误边界。

## packages/web/src/routes/cp.audit.tsx

容器：继承父容器 / 无独立容器。

已检查：无独立填写字段。复用共用组件或保留业务列表/展示、画布、权限及错误边界。

## packages/web/src/routes/cp.data.tsx

容器：继承父容器 / 无独立容器。

已检查：无独立填写字段。复用共用组件或保留业务列表/展示、画布、权限及错误边界。

## packages/web/src/routes/cp.index.tsx

容器：继承父容器 / 无独立容器。

已检查：无独立填写字段。复用共用组件或保留业务列表/展示、画布、权限及错误边界。

## packages/web/src/routes/cp.infrastructure.tsx

容器：继承父容器 / 无独立容器。

已检查：无独立填写字段。复用共用组件或保留业务列表/展示、画布、权限及错误边界。

## packages/web/src/routes/cp.interconnect.tsx

容器：继承父容器 / 无独立容器。

已检查：无独立填写字段。复用共用组件或保留业务列表/展示、画布、权限及错误边界。

## packages/web/src/routes/cp.metering.tsx

容器：继承父容器 / 无独立容器。

已检查：无独立填写字段。复用共用组件或保留业务列表/展示、画布、权限及错误边界。

## packages/web/src/routes/cp.profile.tsx

容器：继承父容器 / 无独立容器。

已检查：无独立填写字段。复用共用组件或保留业务列表/展示、画布、权限及错误边界。

## packages/web/src/routes/cp.queues.tsx

容器：继承父容器 / 无独立容器。

已检查：无独立填写字段。复用共用组件或保留业务列表/展示、画布、权限及错误边界。

## packages/web/src/routes/cp.software.tsx

容器：继承父容器 / 无独立容器。

已检查：无独立填写字段。复用共用组件或保留业务列表/展示、画布、权限及错误边界。

## packages/web/src/routes/cp.tsx

容器：继承父容器 / 无独立容器。

已检查：无独立填写字段。复用共用组件或保留业务列表/展示、画布、权限及错误边界。

## packages/web/src/routes/cp.users.tsx

容器：继承父容器 / 无独立容器。

已检查：无独立填写字段。复用共用组件或保留业务列表/展示、画布、权限及错误边界。

## packages/web/src/routes/data-market.tsx

容器：继承父容器 / 无独立容器。

已检查：无独立填写字段。复用共用组件或保留业务列表/展示、画布、权限及错误边界。

## packages/web/src/routes/federation.tsx

容器：继承父容器 / 无独立容器。

已检查：无独立填写字段。复用共用组件或保留业务列表/展示、画布、权限及错误边界。

## packages/web/src/routes/files.tsx

容器：继承父容器 / 无独立容器。

已检查：无独立填写字段。复用共用组件或保留业务列表/展示、画布、权限及错误边界。

## packages/web/src/routes/index.tsx

容器：继承父容器 / 无独立容器。

已检查：无独立填写字段。复用共用组件或保留业务列表/展示、画布、权限及错误边界。

## packages/web/src/routes/interconnect.tsx

容器：继承父容器 / 无独立容器。

已检查：无独立填写字段。复用共用组件或保留业务列表/展示、画布、权限及错误边界。

## packages/web/src/routes/jobs.tsx

容器：继承父容器 / 无独立容器。

已检查：无独立填写字段。复用共用组件或保留业务列表/展示、画布、权限及错误边界。

## packages/web/src/routes/jobs_.$jobId.tsx

容器：PageShell:64、PageShell:79、PageShell:161。

已检查：无独立填写字段。复用共用组件或保留业务列表/展示、画布、权限及错误边界。

## packages/web/src/routes/login.tsx

容器：Card:153、Card:218。

| 行 | 控件 / 字段 | 状态 | 原因 |
| --- | --- | --- | --- |
| 228 | Input · "login-email" | 保留 | 只读、受权限或状态约束的字段，保留原数据展示与禁用规则。 |
| 249 | NativeSelect · "login-role" | 保留 | 少量固定枚举、分页大小、布尔策略或共用资源选择器的原生表单桥接，保留统一简单选择。 |

## packages/web/src/routes/operations.tsx

容器：继承父容器 / 无独立容器。

已检查：无独立填写字段。复用共用组件或保留业务列表/展示、画布、权限及错误边界。

## packages/web/src/routes/providers.tsx

容器：继承父容器 / 无独立容器。

已检查：无独立填写字段。复用共用组件或保留业务列表/展示、画布、权限及错误边界。

## packages/web/src/routes/settings.tsx

容器：继承父容器 / 无独立容器。

已检查：无独立填写字段。复用共用组件或保留业务列表/展示、画布、权限及错误边界。

## packages/web/src/routes/software.scripts.$scriptId.tsx

容器：继承父容器 / 无独立容器。

已检查：无独立填写字段。复用共用组件或保留业务列表/展示、画布、权限及错误边界。

## packages/web/src/routes/software.scripts.new.tsx

容器：继承父容器 / 无独立容器。

已检查：无独立填写字段。复用共用组件或保留业务列表/展示、画布、权限及错误边界。

## packages/web/src/routes/software.scripts.tsx

容器：继承父容器 / 无独立容器。

已检查：无独立填写字段。复用共用组件或保留业务列表/展示、画布、权限及错误边界。

## packages/web/src/routes/software.spack.$source.$name.tsx

容器：继承父容器 / 无独立容器。

已检查：无独立填写字段。复用共用组件或保留业务列表/展示、画布、权限及错误边界。

## packages/web/src/routes/software.spack.new.tsx

容器：继承父容器 / 无独立容器。

已检查：无独立填写字段。复用共用组件或保留业务列表/展示、画布、权限及错误边界。

## packages/web/src/routes/software.tsx

容器：继承父容器 / 无独立容器。

已检查：无独立填写字段。复用共用组件或保留业务列表/展示、画布、权限及错误边界。

## packages/web/src/routes/software.usecases.$usecaseId.tsx

容器：继承父容器 / 无独立容器。

已检查：无独立填写字段。复用共用组件或保留业务列表/展示、画布、权限及错误边界。

## packages/web/src/routes/software.usecases.new.tsx

容器：继承父容器 / 无独立容器。

已检查：无独立填写字段。复用共用组件或保留业务列表/展示、画布、权限及错误边界。

## packages/web/src/routes/software.workflow-templates.$templateId.tsx

容器：继承父容器 / 无独立容器。

已检查：无独立填写字段。复用共用组件或保留业务列表/展示、画布、权限及错误边界。

## packages/web/src/routes/software.workflow-templates.new.tsx

容器：继承父容器 / 无独立容器。

已检查：无独立填写字段。复用共用组件或保留业务列表/展示、画布、权限及错误边界。

## packages/web/src/routes/terminal.tsx

容器：继承父容器 / 无独立容器。

已检查：无独立填写字段。复用共用组件或保留业务列表/展示、画布、权限及错误边界。

## packages/web/src/routes/workflows/$runId.tsx

容器：继承父容器 / 无独立容器。

已检查：无独立填写字段。复用共用组件或保留业务列表/展示、画布、权限及错误边界。

## packages/web/src/routes/workflows/index.tsx

容器：继承父容器 / 无独立容器。

已检查：无独立填写字段。复用共用组件或保留业务列表/展示、画布、权限及错误边界。

## packages/web/src/routes/workflows/new.tsx

容器：PageShell:28、PageShell:47。

已检查：无独立填写字段。复用共用组件或保留业务列表/展示、画布、权限及错误边界。
