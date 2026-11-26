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

容器：DialogContent:169。

已检查：无独立填写字段。复用共用组件或保留业务列表/展示、画布、权限及错误边界。

## packages/web/src/components/agents/AgentSiteOperations.tsx

容器：继承父容器 / 无独立容器。

已检查：无独立填写字段。复用共用组件或保留业务列表/展示、画布、权限及错误边界。

## packages/web/src/components/agents/AgentSoftwarePage.tsx

容器：继承父容器 / 无独立容器。

已检查：无独立填写字段。复用共用组件或保留业务列表/展示、画布、权限及错误边界。

## packages/web/src/components/agents/AgentUpdates.tsx

容器：继承父容器 / 无独立容器。

| 行 | 控件 / 字段 | 状态 | 原因 |
| --- | --- | --- | --- |
| 108 | Input · {`${id}-release`} | 保留 | 自由内容（名称、路径、命令、表达式、凭据或搜索查询），保持原提交与校验。 |
| 120 | textarea · {`${id}-message`} | 保留 | 自由内容（名称、路径、命令、表达式、凭据或搜索查询），保持原提交与校验。 |

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
| 200 | Input · "cp-audit-from" | 保留 | 自由内容（名称、路径、命令、表达式、凭据或搜索查询），保持原提交与校验。 |
| 212 | Input · "cp-audit-to" | 保留 | 自由内容（名称、路径、命令、表达式、凭据或搜索查询），保持原提交与校验。 |
| 224 | Input · "cp-audit-text" | 保留 | 自由内容（名称、路径、命令、表达式、凭据或搜索查询），保持原提交与校验。 |

## packages/web/src/components/cp/CpAccountsPage.tsx

容器：DialogContent:278。

| 行 | 控件 / 字段 | 状态 | 原因 |
| --- | --- | --- | --- |
| 224 | Input · {t("cp.accounts.search")} | 保留 | 自由内容（名称、路径、命令、表达式、凭据或搜索查询），保持原提交与校验。 |
| 232 | NativeSelect · {t("cp.accounts.backend")} | 保留 | 少量固定枚举、分页大小、布尔策略或共用资源选择器的原生表单桥接，保留统一简单选择。 |
| 242 | NativeSelect · {t("operations.users.status")} | 保留 | 少量固定枚举、分页大小、布尔策略或共用资源选择器的原生表单桥接，保留统一简单选择。 |

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

容器：Card:166、Card:201、Card:229。

已检查：无独立填写字段。复用共用组件或保留业务列表/展示、画布、权限及错误边界。

## packages/web/src/components/cp/CpDataPage.tsx

容器：PageShell:296。

| 行 | 控件 / 字段 | 状态 | 原因 |
| --- | --- | --- | --- |
| 310 | Input · {name} | 保留 | 自由内容（名称、路径、命令、表达式、凭据或搜索查询），保持原提交与校验。 |
| 342 | Input · {version} | 保留 | 发布或登记新版本的版本号，属于创建内容；已有版本引用在独立资源选择控件中处理。 |
| 353 | NativeSelect · {sourceKind} | 保留 | 少量固定枚举、分页大小、布尔策略或共用资源选择器的原生表单桥接，保留统一简单选择。 |
| 385 | Input · Input | 保留 | 勾选、单选、文件上传或隐藏表单值，保留原生语义。 |
| 397 | Input · {uploadSessionId} | 保留 | 只读、受权限或状态约束的字段，保留原数据展示与禁用规则。 |
| 408 | ResourceSelectField · "cp-data-agent-select" | 已替换 | 共用 Radix Popover + cmdk / Dialog 资源选择器，沿用业务候选与 stable ID。 |
| 433 | ResourceSelectField · "cp-data-root-select" | 已替换 | 共用 Radix Popover + cmdk / Dialog 资源选择器，沿用业务候选与 stable ID。 |
| 457 | Input · {relativePath} | 保留 | 自由内容（名称、路径、命令、表达式、凭据或搜索查询），保持原提交与校验。 |
| 720 | NativeSelect · {t("cp.data.replicaAgent")} | 保留 | 少量固定枚举、分页大小、布尔策略或共用资源选择器的原生表单桥接，保留统一简单选择。 |
| 736 | NativeSelect · {t("cp.data.replicaRoot")} | 保留 | 少量固定枚举、分页大小、布尔策略或共用资源选择器的原生表单桥接，保留统一简单选择。 |

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

容器：DialogContent:1049。

| 行 | 控件 / 字段 | 状态 | 原因 |
| --- | --- | --- | --- |
| 940 | Input · "cp-queues-search" | 保留 | 自由内容（名称、路径、命令、表达式、凭据或搜索查询），保持原提交与校验。 |
| 949 | ResourceSelectField · "cp-queues-agent-filter" | 已替换 | 共用 Radix Popover + cmdk / Dialog 资源选择器，沿用业务候选与 stable ID。 |
| 965 | NativeSelect · {t("cp.queues.col.publication")} | 保留 | 少量固定枚举、分页大小、布尔策略或共用资源选择器的原生表单桥接，保留统一简单选择。 |
| 977 | input · input | 保留 | 勾选、单选、文件上传或隐藏表单值，保留原生语义。 |
| 1057 | Input · "cp-queue-field-queue-id" | 保留 | 创建或登记调度器队列的外部标识/QoS/标签；不是选择现有平台队列，没有权威枚举来源。 |
| 1067 | Input · "cp-queue-field-name" | 保留 | 自由内容（名称、路径、命令、表达式、凭据或搜索查询），保持原提交与校验。 |
| 1080 | ResourceSelectField · "cp-queue-field-provider-org-id" | 已替换 | 共用 Radix Popover + cmdk / Dialog 资源选择器，沿用业务候选与 stable ID。 |
| 1098 | input · "cp-queue-field-provider-org-id" | 保留 | 勾选、单选、文件上传或隐藏表单值，保留原生语义。 |
| 1105 | ResourceSelectField · "cp-queue-field-agent-id" | 已替换 | 共用 Radix Popover + cmdk / Dialog 资源选择器，沿用业务候选与 stable ID。 |
| 1152 | input · "cp-queue-target-default" | 保留 | 勾选、单选、文件上传或隐藏表单值，保留原生语义。 |
| 1163 | input · "cp-queue-target-named" | 保留 | 勾选、单选、文件上传或隐藏表单值，保留原生语义。 |
| 1201 | ResourceSelectField · "cp-queue-field-queue-name" | 已替换 | 共用 Radix Popover + cmdk / Dialog 资源选择器，沿用业务候选与 stable ID。 |
| 1251 | Input · "cp-queue-field-qos" | 保留 | 创建或登记调度器队列的外部标识/QoS/标签；不是选择现有平台队列，没有权威枚举来源。 |
| 1259 | input · "cp-queue-field-enabled" | 保留 | 勾选、单选、文件上传或隐藏表单值，保留原生语义。 |
| 1278 | input · "cp-queue-field-visible-org-ids" | 保留 | 勾选、单选、文件上传或隐藏表单值，保留原生语义。 |
| 1294 | input · input | 保留 | 勾选、单选、文件上传或隐藏表单值，保留原生语义。 |
| 1315 | Input · "cp-queue-field-policy-tags" | 保留 | 创建或登记调度器队列的外部标识/QoS/标签；不是选择现有平台队列，没有权威枚举来源。 |

## packages/web/src/components/cp/DataDisclosurePolicyPanel.tsx

容器：继承父容器 / 无独立容器。

| 行 | 控件 / 字段 | 状态 | 原因 |
| --- | --- | --- | --- |
| 202 | Input · {`${formId}-expiry`} | 保留 | 只读、受权限或状态约束的字段，保留原数据展示与禁用规则。 |
| 216 | Input · {`${formId}-reason`} | 保留 | 只读、受权限或状态约束的字段，保留原数据展示与禁用规则。 |

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

容器：PageShell:200。

| 行 | 控件 / 字段 | 状态 | 原因 |
| --- | --- | --- | --- |
| 206 | NativeSelect · {t("cp.metering.exportFormat")} | 保留 | 少量固定枚举、分页大小、布尔策略或共用资源选择器的原生表单桥接，保留统一简单选择。 |
| 246 | NativeSelect · "metering-period" | 保留 | 少量固定枚举、分页大小、布尔策略或共用资源选择器的原生表单桥接，保留统一简单选择。 |
| 263 | NativeSelect · "metering-grouping" | 保留 | 少量固定枚举、分页大小、布尔策略或共用资源选择器的原生表单桥接，保留统一简单选择。 |
| 280 | Input · "metering-from" | 保留 | 自由内容（名称、路径、命令、表达式、凭据或搜索查询），保持原提交与校验。 |
| 292 | Input · "metering-to" | 保留 | 自由内容（名称、路径、命令、表达式、凭据或搜索查询），保持原提交与校验。 |

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
| 74 | ResourceSelectField · {t("cp.organizationSelector.ariaLabel")} | 已替换 | 共用 Radix Popover + cmdk / Dialog 资源选择器，沿用业务候选与 stable ID。 |

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

容器：SheetContent:495。

| 行 | 控件 / 字段 | 状态 | 原因 |
| --- | --- | --- | --- |
| 550 | NativeSelect · "cp-software-operation-action" | 保留 | 少量固定枚举、分页大小、布尔策略或共用资源选择器的原生表单桥接，保留统一简单选择。 |
| 563 | Input · "cp-software-operation-spec" | 保留 | 自由内容（名称、路径、命令、表达式、凭据或搜索查询），保持原提交与校验。 |
| 624 | NativeSelect · "cp-software-batch-action" | 保留 | 少量固定枚举、分页大小、布尔策略或共用资源选择器的原生表单桥接，保留统一简单选择。 |
| 637 | Textarea · "cp-software-batch-specs" | 保留 | 自由内容（名称、路径、命令、表达式、凭据或搜索查询），保持原提交与校验。 |
| 1010 | Input · {cores} | 保留 | 数值输入；共用 Input 提供合法范围内的原生预设，并保留自定义数值与 min/max/step。 |
| 1021 | Input · {minutes} | 保留 | 数值输入；共用 Input 提供合法范围内的原生预设，并保留自定义数值与 min/max/step。 |

## packages/web/src/components/cp/SoftwarePolicySummary.tsx

容器：继承父容器 / 无独立容器。

已检查：无独立填写字段。复用共用组件或保留业务列表/展示、画布、权限及错误边界。

## packages/web/src/components/cp/SoftwarePolicyTable.tsx

容器：PageShell:220、Card:369、Card:641、SheetContent:807。

| 行 | 控件 / 字段 | 状态 | 原因 |
| --- | --- | --- | --- |
| 657 | Input · "cp-software-preview-spec" | 保留 | 自由内容（名称、路径、命令、表达式、凭据或搜索查询），保持原提交与校验。 |
| 669 | Input · "cp-software-preview-usecase" | 保留 | 策略预览接受用例或版本标识/匹配模式；当前目录不能完整枚举策略对象，保留原查询契约。 |
| 681 | Input · "cp-software-preview-usecase-version" | 保留 | 策略预览接受用例或版本标识/匹配模式；当前目录不能完整枚举策略对象，保留原查询契约。 |
| 823 | ResourceSelectField · {draft.providerOrgId} | 已替换 | 共用 Radix Popover + cmdk / Dialog 资源选择器，沿用业务候选与 stable ID。 |
| 839 | NativeSelect · {draft.installMode} | 保留 | 少量固定枚举、分页大小、布尔策略或共用资源选择器的原生表单桥接，保留统一简单选择。 |
| 854 | input · input | 保留 | 勾选、单选、文件上传或隐藏表单值，保留原生语义。 |
| 862 | input · input | 保留 | 勾选、单选、文件上传或隐藏表单值，保留原生语义。 |
| 904 | input · input | 保留 | 勾选、单选、文件上传或隐藏表单值，保留原生语义。 |
| 990 | Textarea · {id} | 保留 | 自由内容（名称、路径、命令、表达式、凭据或搜索查询），保持原提交与校验。 |

## packages/web/src/components/cp/SpackCatalogPickerDialog.tsx

容器：DialogContent:153。

| 行 | 控件 / 字段 | 状态 | 原因 |
| --- | --- | --- | --- |
| 292 | ResourceSelectField · "cp-spack-catalog-version" | 已替换 | 共用 Radix Popover + cmdk / Dialog 资源选择器，沿用业务候选与 stable ID。 |
| 337 | NativeSelect · {variantInputId} | 保留 | 少量固定枚举、分页大小、布尔策略或共用资源选择器的原生表单桥接，保留统一简单选择。 |
| 358 | Input · {variantInputId} | 保留 | 自由内容（名称、路径、命令、表达式、凭据或搜索查询），保持原提交与校验。 |
| 398 | Input · "cp-spack-catalog-spec" | 保留 | 自由内容（名称、路径、命令、表达式、凭据或搜索查询），保持原提交与校验。 |

## packages/web/src/components/cp/UsersTable.tsx

容器：继承父容器 / 无独立容器。

| 行 | 控件 / 字段 | 状态 | 原因 |
| --- | --- | --- | --- |
| 97 | Input · "cp-users-search" | 保留 | 自由内容（名称、路径、命令、表达式、凭据或搜索查询），保持原提交与校验。 |
| 111 | input · input | 保留 | 勾选、单选、文件上传或隐藏表单值，保留原生语义。 |

## packages/web/src/components/dashboard/AgentsTable.tsx

容器：继承父容器 / 无独立容器。

已检查：无独立填写字段。复用共用组件或保留业务列表/展示、画布、权限及错误边界。

## packages/web/src/components/dashboard/AttentionOverviewCard.tsx

容器：Card:56。

已检查：无独立填写字段。复用共用组件或保留业务列表/展示、画布、权限及错误边界。

## packages/web/src/components/dashboard/Dashboard.tsx

容器：PageShell:115。

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

容器：PageShell:104、Card:293。

| 行 | 控件 / 字段 | 状态 | 原因 |
| --- | --- | --- | --- |
| 141 | Input · {t("dataMarket.search")} | 保留 | 自由内容（名称、路径、命令、表达式、凭据或搜索查询），保持原提交与校验。 |
| 186 | Input · "private-data-name" | 保留 | 自由内容（名称、路径、命令、表达式、凭据或搜索查询），保持原提交与校验。 |
| 195 | Input · "private-data-version" | 保留 | 发布或登记新版本的版本号，属于创建内容；已有版本引用在独立资源选择控件中处理。 |
| 204 | NativeSelect · {privateKind} | 保留 | 少量固定枚举、分页大小、布尔策略或共用资源选择器的原生表单桥接，保留统一简单选择。 |
| 217 | Input · {t("dataMarket.elements")} | 保留 | 自由内容（名称、路径、命令、表达式、凭据或搜索查询），保持原提交与校验。 |
| 225 | Input · {t("dataMarket.privateFile")} | 保留 | 勾选、单选、文件上传或隐藏表单值，保留原生语义。 |
| 335 | Input · {t("dataMarket.ownerEntitlementReason")} | 保留 | 自由内容（名称、路径、命令、表达式、凭据或搜索查询），保持原提交与校验。 |

## packages/web/src/components/federation/AgreementBacklog.tsx

容器：继承父容器 / 无独立容器。

已检查：无独立填写字段。复用共用组件或保留业务列表/展示、画布、权限及错误边界。

## packages/web/src/components/federation/AgreementExchangeStatus.tsx

容器：继承父容器 / 无独立容器。

已检查：无独立填写字段。复用共用组件或保留业务列表/展示、画布、权限及错误边界。

## packages/web/src/components/federation/AgreementFields.tsx

容器：继承父容器 / 无独立容器。

| 行 | 控件 / 字段 | 状态 | 原因 |
| --- | --- | --- | --- |
| 126 | NativeSelect · {String(value)} | 保留 | 少量固定枚举、分页大小、布尔策略或共用资源选择器的原生表单桥接，保留统一简单选择。 |
| 144 | Input · {path} | 保留 | 数值输入；共用 Input 提供合法范围内的原生预设，并保留自定义数值与 min/max/step。 |
| 186 | input · input | 保留 | 勾选、单选、文件上传或隐藏表单值，保留原生语义。 |

## packages/web/src/components/federation/AgreementImport.tsx

容器：继承父容器 / 无独立容器。

| 行 | 控件 / 字段 | 状态 | 原因 |
| --- | --- | --- | --- |
| 148 | Input · {`${fieldId}-file`} | 保留 | 勾选、单选、文件上传或隐藏表单值，保留原生语义。 |
| 176 | Textarea · {`${fieldId}-json`} | 保留 | 只读、受权限或状态约束的字段，保留原数据展示与禁用规则。 |
| 222 | Input · {t("federation.agreements.accountSearch")} | 保留 | 只读、受权限或状态约束的字段，保留原数据展示与禁用规则。 |
| 246 | input · {`${fieldId}-account`} | 保留 | 勾选、单选、文件上传或隐藏表单值，保留原生语义。 |

## packages/web/src/components/federation/AgreementPanel.tsx

容器：DialogContent:311、Card:383。

| 行 | 控件 / 字段 | 状态 | 原因 |
| --- | --- | --- | --- |
| 454 | Textarea · {t("federation.agreements.localSignature")} | 保留 | 自由内容（名称、路径、命令、表达式、凭据或搜索查询），保持原提交与校验。 |
| 473 | Textarea · {t("federation.agreements.counterpartySignature")} | 保留 | 自由内容（名称、路径、命令、表达式、凭据或搜索查询），保持原提交与校验。 |
| 482 | Textarea · {t("federation.agreements.counterpartySignature")} | 保留 | 只读、受权限或状态约束的字段，保留原数据展示与禁用规则。 |

## packages/web/src/components/federation/AgreementTerms.tsx

容器：继承父容器 / 无独立容器。

已检查：无独立填写字段。复用共用组件或保留业务列表/展示、画布、权限及错误边界。

## packages/web/src/components/federation/ArbitrationDecisionPanel.tsx

容器：DialogContent:593。

| 行 | 控件 / 字段 | 状态 | 原因 |
| --- | --- | --- | --- |
| 467 | Input · {`${id}-domain`} | 保留 | 只读、受权限或状态约束的字段，保留原数据展示与禁用规则。 |
| 518 | NativeSelect · {`${id}-outcome`} | 保留 | 少量固定枚举、分页大小、布尔策略或共用资源选择器的原生表单桥接，保留统一简单选择。 |
| 535 | NativeSelect · {`${id}-target`} | 保留 | 少量固定枚举、分页大小、布尔策略或共用资源选择器的原生表单桥接，保留统一简单选择。 |
| 557 | Input · {`${id}-amount`} | 保留 | 自由内容（名称、路径、命令、表达式、凭据或搜索查询），保持原提交与校验。 |
| 569 | Textarea · {`${id}-reason`} | 保留 | 自由内容（名称、路径、命令、表达式、凭据或搜索查询），保持原提交与校验。 |

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

容器：DialogContent:948。

| 行 | 控件 / 字段 | 状态 | 原因 |
| --- | --- | --- | --- |
| 655 | Input · {`${id}-file`} | 保留 | 勾选、单选、文件上传或隐藏表单值，保留原生语义。 |
| 692 | select · {`${id}-mode`} | 保留 | 少量固定枚举、分页大小、布尔策略或共用资源选择器的原生表单桥接，保留统一简单选择。 |
| 718 | select · {`${id}-record`} | 保留 | 少量固定枚举、分页大小、布尔策略或共用资源选择器的原生表单桥接，保留统一简单选择。 |
| 742 | Input · {`${id}-amount`} | 保留 | 只读、受权限或状态约束的字段，保留原数据展示与禁用规则。 |
| 757 | Textarea · {`${id}-reason`} | 保留 | 只读、受权限或状态约束的字段，保留原数据展示与禁用规则。 |

## packages/web/src/components/federation/CommercialDisputeProgress.tsx

容器：继承父容器 / 无独立容器。

已检查：无独立填写字段。复用共用组件或保留业务列表/展示、画布、权限及错误边界。

## packages/web/src/components/federation/CommercialEditor.tsx

容器：继承父容器 / 无独立容器。

| 行 | 控件 / 字段 | 状态 | 原因 |
| --- | --- | --- | --- |
| 153 | input · {`${id}-source`} | 保留 | 勾选、单选、文件上传或隐藏表单值，保留原生语义。 |
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

容器：DialogContent:773。

已检查：无独立填写字段。复用共用组件或保留业务列表/展示、画布、权限及错误边界。

## packages/web/src/components/federation/CommercialPaymentPanel.tsx

容器：DialogContent:795。

| 行 | 控件 / 字段 | 状态 | 原因 |
| --- | --- | --- | --- |
| 452 | Input · {`${id}-bill`} | 保留 | 只读、受权限或状态约束的字段，保留原数据展示与禁用规则。 |
| 465 | Input · {`${id}-amount`} | 保留 | 只读、受权限或状态约束的字段，保留原数据展示与禁用规则。 |
| 480 | Input · {`${id}-time`} | 保留 | 只读、受权限或状态约束的字段，保留原数据展示与禁用规则。 |
| 493 | Input · {`${id}-evidence`} | 保留 | 只读、受权限或状态约束的字段，保留原数据展示与禁用规则。 |
| 506 | Textarea · {`${id}-reason`} | 保留 | 只读、受权限或状态约束的字段，保留原数据展示与禁用规则。 |
| 539 | Textarea · {`${id}-json`} | 保留 | 只读、受权限或状态约束的字段，保留原数据展示与禁用规则。 |
| 692 | Textarea · {`${id}-signature`} | 保留 | 只读、受权限或状态约束的字段，保留原数据展示与禁用规则。 |

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

容器：DialogContent:669。

| 行 | 控件 / 字段 | 状态 | 原因 |
| --- | --- | --- | --- |
| 436 | Input · {`${id}-${index}-quantity`} | 保留 | 自由内容（名称、路径、命令、表达式、凭据或搜索查询），保持原提交与校验。 |
| 455 | Input · {`${id}-${index}-digest`} | 保留 | 自由内容（名称、路径、命令、表达式、凭据或搜索查询），保持原提交与校验。 |
| 478 | Textarea · {`${id}-reason`} | 保留 | 自由内容（名称、路径、命令、表达式、凭据或搜索查询），保持原提交与校验。 |
| 624 | Textarea · {t("federation.usage.signature")} | 保留 | 自由内容（名称、路径、命令、表达式、凭据或搜索查询），保持原提交与校验。 |

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
| 160 | Input · {`${id}-${key}`} | 保留 | 自由内容（名称、路径、命令、表达式、凭据或搜索查询），保持原提交与校验。 |

## packages/web/src/components/federation/FederationLayout.tsx

容器：继承父容器 / 无独立容器。

已检查：无独立填写字段。复用共用组件或保留业务列表/展示、画布、权限及错误边界。

## packages/web/src/components/federation/FederationMarketPanel.tsx

容器：DialogContent:843。

已检查：无独立填写字段。复用共用组件或保留业务列表/展示、画布、权限及错误边界。

## packages/web/src/components/federation/FederationPage.tsx

容器：PageShell:41。

| 行 | 控件 / 字段 | 状态 | 原因 |
| --- | --- | --- | --- |
| 118 | select · "federation-organization" | 保留 | 少量固定枚举、分页大小、布尔策略或共用资源选择器的原生表单桥接，保留统一简单选择。 |

## packages/web/src/components/federation/FederationSiteIdentity.tsx

容器：继承父容器 / 无独立容器。

已检查：无独立填写字段。复用共用组件或保留业务列表/展示、画布、权限及错误边界。

## packages/web/src/components/federation/FederationTaskCreate.tsx

容器：继承父容器 / 无独立容器。

| 行 | 控件 / 字段 | 状态 | 原因 |
| --- | --- | --- | --- |
| 188 | select · {`${id}-agreement`} | 保留 | 少量固定枚举、分页大小、布尔策略或共用资源选择器的原生表单桥接，保留统一简单选择。 |
| 249 | select · {`${id}-template`} | 保留 | 少量固定枚举、分页大小、布尔策略或共用资源选择器的原生表单桥接，保留统一简单选择。 |
| 279 | select · {`${id}-${kind}`} | 保留 | 少量固定枚举、分页大小、布尔策略或共用资源选择器的原生表单桥接，保留统一简单选择。 |
| 316 | Input · {group.descriptor} | 保留 | 自由内容（名称、路径、命令、表达式、凭据或搜索查询），保持原提交与校验。 |
| 322 | select · {t("federation.tasks.inputType")} | 保留 | 少量固定枚举、分页大小、布尔策略或共用资源选择器的原生表单桥接，保留统一简单选择。 |
| 339 | Input · {t("federation.tasks.inputPath")} | 保留 | 自由内容（名称、路径、命令、表达式、凭据或搜索查询），保持原提交与校验。 |
| 434 | Input · {`${id}-${field}`} | 保留 | 数值输入；共用 Input 提供合法范围内的原生预设，并保留自定义数值与 min/max/step。 |
| 453 | Input · {`${id}-amount`} | 保留 | 自由内容（名称、路径、命令、表达式、凭据或搜索查询），保持原提交与校验。 |

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
| 163 | select · {id} | 保留 | 少量固定枚举、分页大小、布尔策略或共用资源选择器的原生表单桥接，保留统一简单选择。 |
| 197 | select · {`${id}-request`} | 保留 | 少量固定枚举、分页大小、布尔策略或共用资源选择器的原生表单桥接，保留统一简单选择。 |

## packages/web/src/components/federation/MarketDemandForm.tsx

容器：继承父容器 / 无独立容器。

| 行 | 控件 / 字段 | 状态 | 原因 |
| --- | --- | --- | --- |
| 82 | Input · {`${id}-${field}`} | 保留 | 数值输入；共用 Input 提供合法范围内的原生预设，并保留自定义数值与 min/max/step。 |
| 108 | textarea · {`${id}-description`} | 保留 | 自由内容（名称、路径、命令、表达式、凭据或搜索查询），保持原提交与校验。 |

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
| 221 | Input · {`${id}-${name}`} | 保留 | 自由内容（名称、路径、命令、表达式、凭据或搜索查询），保持原提交与校验。 |
| 263 | select · {`${id}-subject`} | 保留 | 少量固定枚举、分页大小、布尔策略或共用资源选择器的原生表单桥接，保留统一简单选择。 |
| 368 | Input · {`${id}-file`} | 保留 | 勾选、单选、文件上传或隐藏表单值，保留原生语义。 |
| 403 | Textarea · {`${id}-reason`} | 保留 | 自由内容（名称、路径、命令、表达式、凭据或搜索查询），保持原提交与校验。 |

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
| 128 | select · {id} | 保留 | 少量固定枚举、分页大小、布尔策略或共用资源选择器的原生表单桥接，保留统一简单选择。 |

## packages/web/src/components/files/CloudPane.tsx

容器：继承父容器 / 无独立容器。

| 行 | 控件 / 字段 | 状态 | 原因 |
| --- | --- | --- | --- |
| 180 | input · "files-cloud-upload-input" | 保留 | 勾选、单选、文件上传或隐藏表单值，保留原生语义。 |
| 223 | Input · "files-cloud-search" | 保留 | 自由内容（名称、路径、命令、表达式、凭据或搜索查询），保持原提交与校验。 |
| 231 | NativeSelect · "files-cloud-sort" | 保留 | 少量固定枚举、分页大小、布尔策略或共用资源选择器的原生表单桥接，保留统一简单选择。 |

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

容器：PageShell:407。

已检查：无独立填写字段。复用共用组件或保留业务列表/展示、画布、权限及错误边界。

## packages/web/src/components/files/NewTransferSheet.tsx

容器：SheetContent:436。

已检查：无独立填写字段。复用共用组件或保留业务列表/展示、画布、权限及错误边界。

## packages/web/src/components/files/PathPickerSheet.tsx

容器：SheetContent:388。

| 行 | 控件 / 字段 | 状态 | 原因 |
| --- | --- | --- | --- |
| 821 | ResourceSelectField · "path-picker-agent-select" | 已替换 | 共用 Radix Popover + cmdk / Dialog 资源选择器，沿用业务候选与 stable ID。 |
| 844 | ResourceSelectField · "path-picker-cluster-root-select" | 已替换 | 共用 Radix Popover + cmdk / Dialog 资源选择器，沿用业务候选与 stable ID。 |

## packages/web/src/components/files/StorageQuotaRequestDialog.tsx

容器：DialogContent:152。

| 行 | 控件 / 字段 | 状态 | 原因 |
| --- | --- | --- | --- |
| 199 | Input · "storage-quota-gb" | 保留 | 数值输入；共用 Input 提供合法范围内的原生预设，并保留自定义数值与 min/max/step。 |
| 242 | Input · "storage-quota-expires-at" | 保留 | 自由内容（名称、路径、命令、表达式、凭据或搜索查询），保持原提交与校验。 |
| 262 | Textarea · "storage-quota-reason" | 保留 | 自由内容（名称、路径、命令、表达式、凭据或搜索查询），保持原提交与校验。 |

## packages/web/src/components/files/TransfersTray.tsx

容器：继承父容器 / 无独立容器。

已检查：无独立填写字段。复用共用组件或保留业务列表/展示、画布、权限及错误边界。

## packages/web/src/components/function-maps/FunctionMapRegion.tsx

容器：继承父容器 / 无独立容器。

已检查：无独立填写字段。复用共用组件或保留业务列表/展示、画布、权限及错误边界。

## packages/web/src/components/function-maps/FunctionMapView.tsx

容器：DialogContent:373。

已检查：无独立填写字段。复用共用组件或保留业务列表/展示、画布、权限及错误边界。

## packages/web/src/components/function-maps/FunctionMaps.tsx

容器：继承父容器 / 无独立容器。

| 行 | 控件 / 字段 | 状态 | 原因 |
| --- | --- | --- | --- |
| 187 | NativeSelect · {model.id} | 保留 | 少量固定枚举、分页大小、布尔策略或共用资源选择器的原生表单桥接，保留统一简单选择。 |

## packages/web/src/components/function-maps/MapPreferenceFields.tsx

容器：继承父容器 / 无独立容器。

| 行 | 控件 / 字段 | 状态 | 原因 |
| --- | --- | --- | --- |
| 24 | input · {id} | 保留 | 勾选、单选、文件上传或隐藏表单值，保留原生语义。 |
| 38 | NativeSelect · {values.includes(value.fixed) ? value.fixed : values[0]} | 保留 | 少量固定枚举、分页大小、布尔策略或共用资源选择器的原生表单桥接，保留统一简单选择。 |

## packages/web/src/components/function-maps/MapPreferencesPanel.tsx

容器：继承父容器 / 无独立容器。

| 行 | 控件 / 字段 | 状态 | 原因 |
| --- | --- | --- | --- |
| 43 | NativeSelect · {draft.appearance.flow ? "flow" : "static"} | 保留 | 少量固定枚举、分页大小、布尔策略或共用资源选择器的原生表单桥接，保留统一简单选择。 |
| 53 | NativeSelect · {draft.appearance.color} | 保留 | 少量固定枚举、分页大小、布尔策略或共用资源选择器的原生表单桥接，保留统一简单选择。 |
| 69 | input · {draft.appearance.lineWidth} | 保留 | 自由内容（名称、路径、命令、表达式、凭据或搜索查询），保持原提交与校验。 |
| 84 | input · {draft.appearance.duration} | 保留 | 只读、受权限或状态约束的字段，保留原数据展示与禁用规则。 |

## packages/web/src/components/function-maps/icons.tsx

容器：继承父容器 / 无独立容器。

已检查：无独立填写字段。复用共用组件或保留业务列表/展示、画布、权限及错误边界。

## packages/web/src/components/interconnect/InterconnectDashboard.tsx

容器：DialogContent:1186。

| 行 | 控件 / 字段 | 状态 | 原因 |
| --- | --- | --- | --- |
| 730 | Input · {t("interconnect.searchResources")} | 保留 | 自由内容（名称、路径、命令、表达式、凭据或搜索查询），保持原提交与校验。 |
| 742 | ResourceSelectField · {t("interconnect.organization")} | 已替换 | 共用 Radix Popover + cmdk / Dialog 资源选择器，沿用业务候选与 stable ID。 |
| 760 | NativeSelect · {t("interconnect.statusLabel")} | 保留 | 少量固定枚举、分页大小、布尔策略或共用资源选择器的原生表单桥接，保留统一简单选择。 |
| 775 | NativeSelect · {t("interconnect.connectionType")} | 保留 | 少量固定枚举、分页大小、布尔策略或共用资源选择器的原生表单桥接，保留统一简单选择。 |
| 792 | ResourceSelectField · {t("interconnect.filterCenter")} | 已替换 | 共用 Radix Popover + cmdk / Dialog 资源选择器，沿用业务候选与 stable ID。 |

## packages/web/src/components/interconnect/InterconnectMap.tsx

容器：继承父容器 / 无独立容器。

| 行 | 控件 / 字段 | 状态 | 原因 |
| --- | --- | --- | --- |
| 235 | NativeSelect · {t("interconnect.mapLevel")} | 保留 | 少量固定枚举、分页大小、布尔策略或共用资源选择器的原生表单桥接，保留统一简单选择。 |
| 245 | ResourceSelectField · {t("interconnect.province")} | 已替换 | 共用 Radix Popover + cmdk / Dialog 资源选择器，沿用业务候选与 stable ID。 |

## packages/web/src/components/interconnect/MetadataEditor.tsx

容器：DialogContent:70。

| 行 | 控件 / 字段 | 状态 | 原因 |
| --- | --- | --- | --- |
| 216 | Input · "name" | 保留 | 自由内容（名称、路径、命令、表达式、凭据或搜索查询），保持原提交与校验。 |
| 219 | NativeSelect · "status" | 保留 | 少量固定枚举、分页大小、布尔策略或共用资源选择器的原生表单桥接，保留统一简单选择。 |
| 234 | ResourceSelectField · "orgId" | 已替换 | 共用 Radix Popover + cmdk / Dialog 资源选择器，沿用业务候选与 stable ID。 |
| 252 | Input · "country" | 保留 | 自由内容（名称、路径、命令、表达式、凭据或搜索查询），保持原提交与校验。 |
| 259 | Input · "province" | 保留 | 自由内容（名称、路径、命令、表达式、凭据或搜索查询），保持原提交与校验。 |
| 266 | Input · "city" | 保留 | 自由内容（名称、路径、命令、表达式、凭据或搜索查询），保持原提交与校验。 |
| 271 | Input · "longitude" | 保留 | 数值输入；共用 Input 提供合法范围内的原生预设，并保留自定义数值与 min/max/step。 |
| 281 | Input · "latitude" | 保留 | 数值输入；共用 Input 提供合法范围内的原生预设，并保留自定义数值与 min/max/step。 |
| 296 | ResourceSelectField · {centerId} | 已替换 | 共用 Radix Popover + cmdk / Dialog 资源选择器，沿用业务候选与 stable ID。 |
| 315 | input · "computeTypes" | 保留 | 勾选、单选、文件上传或隐藏表单值，保留原生语义。 |
| 328 | Input · "cpuCores" | 保留 | 数值输入；共用 Input 提供合法范围内的原生预设，并保留自定义数值与 min/max/step。 |
| 338 | Input · "storageGiB" | 保留 | 数值输入；共用 Input 提供合法范围内的原生预设，并保留自定义数值与 min/max/step。 |
| 353 | Input · "storageTypes" | 保留 | 自由内容（名称、路径、命令、表达式、凭据或搜索查询），保持原提交与校验。 |
| 360 | Input · "applications" | 保留 | 自由内容（名称、路径、命令、表达式、凭据或搜索查询），保持原提交与校验。 |
| 377 | input · "agentIds" | 保留 | 勾选、单选、文件上传或隐藏表单值，保留原生语义。 |
| 403 | NativeSelect · {networkType} | 保留 | 少量固定枚举、分页大小、布尔策略或共用资源选择器的原生表单桥接，保留统一简单选择。 |
| 418 | ResourceSelectField · {zoneId} | 已替换 | 共用 Radix Popover + cmdk / Dialog 资源选择器，沿用业务候选与 stable ID。 |
| 442 | ResourceSelectField · {side === "from" ? fromClusterId : toClusterId} | 已替换 | 共用 Radix Popover + cmdk / Dialog 资源选择器，沿用业务候选与 stable ID。 |
| 467 | Input · "configuredBandwidthMbps" | 保留 | 数值输入；共用 Input 提供合法范围内的原生预设，并保留自定义数值与 min/max/step。 |
| 485 | Input · {name} | 保留 | 数值输入；共用 Input 提供合法范围内的原生预设，并保留自定义数值与 min/max/step。 |
| 498 | Input · "observedAt" | 保留 | 自由内容（名称、路径、命令、表达式、凭据或搜索查询），保持原提交与校验。 |
| 514 | Input · "source" | 保留 | 自由内容（名称、路径、命令、表达式、凭据或搜索查询），保持原提交与校验。 |

## packages/web/src/components/jobs/CommandWorkdirDialog.tsx

容器：DialogContent:262。

| 行 | 控件 / 字段 | 状态 | 原因 |
| --- | --- | --- | --- |
| 301 | Input · "command-workdir-cloud-search" | 保留 | 只读、受权限或状态约束的字段，保留原数据展示与禁用规则。 |
| 402 | Input · "command-workdir-new-folder-name" | 保留 | 自由内容（名称、路径、命令、表达式、凭据或搜索查询），保持原提交与校验。 |
| 429 | input · "command-workdir-upload" | 保留 | 勾选、单选、文件上传或隐藏表单值，保留原生语义。 |
| 510 | Input · {`command-workdir-rename-dir-${safeTestId(row.fullPath)}`} | 保留 | 自由内容（名称、路径、命令、表达式、凭据或搜索查询），保持原提交与校验。 |
| 555 | Input · {`command-workdir-stage-${row.entry.fileMetadataId}`} | 保留 | 自由内容（名称、路径、命令、表达式、凭据或搜索查询），保持原提交与校验。 |

## packages/web/src/components/jobs/ImportJobJsonDialog.tsx

容器：DialogContent:220。

| 行 | 控件 / 字段 | 状态 | 原因 |
| --- | --- | --- | --- |
| 232 | input · "import-job-json-file" | 保留 | 勾选、单选、文件上传或隐藏表单值，保留原生语义。 |

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

## packages/web/src/components/jobs/JobResourceMap.tsx

容器：继承父容器 / 无独立容器。

已检查：无独立填写字段。复用共用组件或保留业务列表/展示、画布、权限及错误边界。

## packages/web/src/components/jobs/JobResourcesTab.tsx

容器：继承父容器 / 无独立容器。

已检查：无独立填写字段。复用共用组件或保留业务列表/展示、画布、权限及错误边界。

## packages/web/src/components/jobs/JobsPage.tsx

容器：PageShell:109。

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

容器：SheetContent:1179、DialogContent:1947。

| 行 | 控件 / 字段 | 状态 | 原因 |
| --- | --- | --- | --- |
| 441 | ResourceSelectField · {`submit-usecase-dataset-select-${descriptor}`} | 已替换 | 共用 Radix Popover + cmdk / Dialog 资源选择器，沿用业务候选与 stable ID。 |
| 1335 | NativeSelect · {fieldId} | 保留 | 少量固定枚举、分页大小、布尔策略或共用资源选择器的原生表单桥接，保留统一简单选择。 |
| 1357 | Textarea · {fieldId} | 保留 | 自由内容（名称、路径、命令、表达式、凭据或搜索查询），保持原提交与校验。 |
| 1370 | Input · {fieldId} | 保留 | 数值输入；共用 Input 提供合法范围内的原生预设，并保留自定义数值与 min/max/step。 |
| 1530 | Textarea · "submit-job-command-input" | 保留 | 自由内容（名称、路径、命令、表达式、凭据或搜索查询），保持原提交与校验。 |
| 1593 | Input · "submit-job-name-input" | 保留 | 自由内容（名称、路径、命令、表达式、凭据或搜索查询），保持原提交与校验。 |
| 1610 | Input · "submit-job-cpus-input" | 保留 | 数值输入；共用 Input 提供合法范围内的原生预设，并保留自定义数值与 min/max/step。 |
| 1626 | Input · "submit-job-memory-input" | 保留 | 数值输入；共用 Input 提供合法范围内的原生预设，并保留自定义数值与 min/max/step。 |
| 1642 | input · "submit-job-placement-auto" | 保留 | 勾选、单选、文件上传或隐藏表单值，保留原生语义。 |
| 1656 | input · "submit-job-placement-default" | 保留 | 勾选、单选、文件上传或隐藏表单值，保留原生语义。 |
| 1670 | input · "submit-job-placement-named" | 保留 | 勾选、单选、文件上传或隐藏表单值，保留原生语义。 |
| 1742 | ResourceSelectField · "submit-job-queue-select" | 已替换 | 共用 Radix Popover + cmdk / Dialog 资源选择器，沿用业务候选与 stable ID。 |
| 1970 | NativeSelect · "submit-usecase-runtime-filter" | 保留 | 少量固定枚举、分页大小、布尔策略或共用资源选择器的原生表单桥接，保留统一简单选择。 |
| 1984 | NativeSelect · "submit-usecase-input-filter" | 保留 | 少量固定枚举、分页大小、布尔策略或共用资源选择器的原生表单桥接，保留统一简单选择。 |
| 1996 | Input · "submit-usecase-software-filter" | 保留 | 自由内容（名称、路径、命令、表达式、凭据或搜索查询），保持原提交与校验。 |

## packages/web/src/components/providers/ComputeProvidersPage.tsx

容器：PageShell:116、DialogContent:295、DialogContent:384。

| 行 | 控件 / 字段 | 状态 | 原因 |
| --- | --- | --- | --- |
| 129 | Input · "search" | 保留 | 自由内容（名称、路径、命令、表达式、凭据或搜索查询），保持原提交与校验。 |
| 435 | Input · {`${id}-name`} | 保留 | 只读、受权限或状态约束的字段，保留原数据展示与禁用规则。 |
| 448 | Textarea · {`${id}-${key}`} | 保留 | 只读、受权限或状态约束的字段，保留原数据展示与禁用规则。 |
| 458 | Input · {`${id}-${key}`} | 保留 | 只读、受权限或状态约束的字段，保留原数据展示与禁用规则。 |

## packages/web/src/components/scheduler/PlacementPipelineView.tsx

容器：继承父容器 / 无独立容器。

已检查：无独立填写字段。复用共用组件或保留业务列表/展示、画布、权限及错误边界。

## packages/web/src/components/scheduler/PlacementPreviewPanel.tsx

容器：继承父容器 / 无独立容器。

已检查：无独立填写字段。复用共用组件或保留业务列表/展示、画布、权限及错误边界。

## packages/web/src/components/settings/AgentCertsPanel.tsx

容器：Card:102。

| 行 | 控件 / 字段 | 状态 | 原因 |
| --- | --- | --- | --- |
| 108 | Input · "agent-certs-agent-id" | 保留 | 证书审计可查询历史或已撤销 Agent；当前在线目录不能覆盖全部有效查询对象，保留 ID 查询。 |

## packages/web/src/components/settings/AuditCapabilityPanel.tsx

容器：继承父容器 / 无独立容器。

| 行 | 控件 / 字段 | 状态 | 原因 |
| --- | --- | --- | --- |
| 78 | Input · "search" | 保留 | 自由内容（名称、路径、命令、表达式、凭据或搜索查询），保持原提交与校验。 |

## packages/web/src/components/settings/AuditLogPanel.tsx

容器：继承父容器 / 无独立容器。

已检查：无独立填写字段。复用共用组件或保留业务列表/展示、画布、权限及错误边界。

## packages/web/src/components/settings/AuthzAdminPanel.tsx

容器：Card:353。

| 行 | 控件 / 字段 | 状态 | 原因 |
| --- | --- | --- | --- |
| 406 | Textarea · {t("adminAccess.rawLabel")} | 保留 | 只读、受权限或状态约束的字段，保留原数据展示与禁用规则。 |

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

容器：Card:369、DialogContent:585、DialogContent:716。

| 行 | 控件 / 字段 | 状态 | 原因 |
| --- | --- | --- | --- |
| 447 | Input · "cluster-file-root-new-label" | 保留 | 自由内容（名称、路径、命令、表达式、凭据或搜索查询），保持原提交与校验。 |
| 462 | ResourceSelectField · "cluster-file-root-new-provider" | 已替换 | 共用 Radix Popover + cmdk / Dialog 资源选择器，沿用业务候选与 stable ID。 |
| 499 | Input · "cluster-file-root-new-path" | 保留 | 自由内容（名称、路径、命令、表达式、凭据或搜索查询），保持原提交与校验。 |
| 514 | Input · "cluster-file-root-new-capacity" | 保留 | 数值输入；共用 Input 提供合法范围内的原生预设，并保留自定义数值与 min/max/step。 |
| 547 | Input · {t("settings.clusterFileRoots.search")} | 保留 | 自由内容（名称、路径、命令、表达式、凭据或搜索查询），保持原提交与校验。 |
| 596 | Input · {`cluster-file-root-label-${root.id}`} | 保留 | 只读、受权限或状态约束的字段，保留原数据展示与禁用规则。 |
| 619 | Input · {`cluster-file-root-path-${root.id}`} | 保留 | 只读、受权限或状态约束的字段，保留原数据展示与禁用规则。 |
| 632 | Input · {`cluster-file-root-capacity-${root.id}`} | 保留 | 数值输入；共用 Input 提供合法范围内的原生预设，并保留自定义数值与 min/max/step。 |
| 654 | input · {`cluster-file-root-enabled-${root.id}`} | 保留 | 勾选、单选、文件上传或隐藏表单值，保留原生语义。 |
| 791 | ResourceSelectField · {testId} | 已替换 | 共用 Radix Popover + cmdk / Dialog 资源选择器，沿用业务候选与 stable ID。 |
| 845 | Input · {t("settings.clusterFileRoots.searchOrganizations")} | 保留 | 自由内容（名称、路径、命令、表达式、凭据或搜索查询），保持原提交与校验。 |
| 871 | input · input | 保留 | 勾选、单选、文件上传或隐藏表单值，保留原生语义。 |

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

容器：Card:70、Card:90、Card:189。

| 行 | 控件 / 字段 | 状态 | 原因 |
| --- | --- | --- | --- |
| 234 | ResourceSelectField · {`cost-rates-cluster-${idx}`} | 已替换 | 费率配置按调度器 cluster 名称建键，可预设尚未接入的集群；在线 Agent/算网档案不是完整同义目录，保留合法自定义键。 |
| 259 | Input · {`cost-rates-rate-${idx}`} | 保留 | 自由内容（名称、路径、命令、表达式、凭据或搜索查询），保持原提交与校验。 |

## packages/web/src/components/settings/DesensitizeAdminPanel.tsx

容器：Card:145。

| 行 | 控件 / 字段 | 状态 | 原因 |
| --- | --- | --- | --- |
| 173 | input · "desensitize-global-enabled" | 保留 | 勾选、单选、文件上传或隐藏表单值，保留原生语义。 |
| 188 | NativeSelect · {t("settings.desensitize.scope")} | 保留 | 少量固定枚举、分页大小、布尔策略或共用资源选择器的原生表单桥接，保留统一简单选择。 |
| 202 | Input · {t("settings.desensitize.scopeId")} | 保留 | 只读、受权限或状态约束的字段，保留原数据展示与禁用规则。 |
| 209 | Input · {t("settings.desensitize.fieldPath")} | 保留 | 自由内容（名称、路径、命令、表达式、凭据或搜索查询），保持原提交与校验。 |
| 215 | NativeSelect · {t("settings.desensitize.action")} | 保留 | 少量固定枚举、分页大小、布尔策略或共用资源选择器的原生表单桥接，保留统一简单选择。 |
| 293 | Textarea · "desensitize-alias-ids" | 保留 | 自由内容（名称、路径、命令、表达式、凭据或搜索查询），保持原提交与校验。 |
| 340 | Textarea · {envelope.token} | 保留 | 自由内容（名称、路径、命令、表达式、凭据或搜索查询），保持原提交与校验。 |

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

容器：Card:74、Card:186、DialogContent:326。

| 行 | 控件 / 字段 | 状态 | 原因 |
| --- | --- | --- | --- |
| 88 | Input · {t("federation.permissions.organizationSearch")} | 保留 | 自由内容（名称、路径、命令、表达式、凭据或搜索查询），保持原提交与校验。 |
| 439 | Input · {t("federation.permissions.memberSearch")} | 保留 | 自由内容（名称、路径、命令、表达式、凭据或搜索查询），保持原提交与校验。 |
| 508 | select · {`${fieldId}-capability`} | 保留 | 少量固定枚举、分页大小、布尔策略或共用资源选择器的原生表单桥接，保留统一简单选择。 |

## packages/web/src/components/settings/FederationStoragePanel.tsx

容器：Card:76、DialogContent:442。

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

容器：Card:126、DialogContent:428。

已检查：无独立填写字段。复用共用组件或保留业务列表/展示、画布、权限及错误边界。

## packages/web/src/components/settings/FileTransferAuditConfigPanel.tsx

容器：Card:75、Card:93、Card:141。

| 行 | 控件 / 字段 | 状态 | 原因 |
| --- | --- | --- | --- |
| 181 | NativeSelect · "download-evidence-mode" | 保留 | 少量固定枚举、分页大小、布尔策略或共用资源选择器的原生表单桥接，保留统一简单选择。 |
| 222 | Textarea · "file-transfer-audit-change-reason" | 保留 | 只读、受权限或状态约束的字段，保留原数据展示与禁用规则。 |
| 284 | Input · {id} | 保留 | 数值输入；共用 Input 提供合法范围内的原生预设，并保留自定义数值与 min/max/step。 |

## packages/web/src/components/settings/NotificationsPanel.tsx

容器：继承父容器 / 无独立容器。

| 行 | 控件 / 字段 | 状态 | 原因 |
| --- | --- | --- | --- |
| 53 | input · input | 保留 | 勾选、单选、文件上传或隐藏表单值，保留原生语义。 |
| 63 | Input · {url} | 保留 | 自由内容（名称、路径、命令、表达式、凭据或搜索查询），保持原提交与校验。 |
| 68 | Input · {secret} | 保留 | 自由内容（名称、路径、命令、表达式、凭据或搜索查询），保持原提交与校验。 |

## packages/web/src/components/settings/OperationsAttentionCards.tsx

容器：继承父容器 / 无独立容器。

已检查：无独立填写字段。复用共用组件或保留业务列表/展示、画布、权限及错误边界。

## packages/web/src/components/settings/OperationsPage.tsx

容器：PageShell:67、PageShell:85、PageShell:96。

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

容器：DialogContent:312。

| 行 | 控件 / 字段 | 状态 | 原因 |
| --- | --- | --- | --- |
| 230 | Input · {t("cp.users.searchLabel")} | 保留 | 自由内容（名称、路径、命令、表达式、凭据或搜索查询），保持原提交与校验。 |
| 241 | NativeSelect · {t("cp.users.col.role")} | 保留 | 少量固定枚举、分页大小、布尔策略或共用资源选择器的原生表单桥接，保留统一简单选择。 |
| 258 | NativeSelect · {t("operations.users.status")} | 保留 | 少量固定枚举、分页大小、布尔策略或共用资源选择器的原生表单桥接，保留统一简单选择。 |
| 345 | Input · {email} | 保留 | 自由内容（名称、路径、命令、表达式、凭据或搜索查询），保持原提交与校验。 |
| 357 | Input · {displayName} | 保留 | 自由内容（名称、路径、命令、表达式、凭据或搜索查询），保持原提交与校验。 |
| 367 | Textarea · "platform-user-status-reason" | 保留 | 自由内容（名称、路径、命令、表达式、凭据或搜索查询），保持原提交与校验。 |

## packages/web/src/components/settings/SSOConfigForm.tsx

容器：Card:182、Card:200、Card:304。

| 行 | 控件 / 字段 | 状态 | 原因 |
| --- | --- | --- | --- |
| 316 | input · "sso-enabled" | 保留 | 勾选、单选、文件上传或隐藏表单值，保留原生语义。 |
| 335 | Input · "sso-provider-display-name" | 保留 | 自由内容（名称、路径、命令、表达式、凭据或搜索查询），保持原提交与校验。 |
| 346 | Input · "sso-login-welcome-zh" | 保留 | 自由内容（名称、路径、命令、表达式、凭据或搜索查询），保持原提交与校验。 |
| 356 | Input · "sso-login-welcome-en" | 保留 | 自由内容（名称、路径、命令、表达式、凭据或搜索查询），保持原提交与校验。 |
| 376 | NativeSelect · "sso-provider" | 保留 | 少量固定枚举、分页大小、布尔策略或共用资源选择器的原生表单桥接，保留统一简单选择。 |
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

容器：Card:205、PageShell:332。

已检查：无独立填写字段。复用共用组件或保留业务列表/展示、画布、权限及错误边界。

## packages/web/src/components/settings/SshActiveSessions.tsx

容器：Card:75。

已检查：无独立填写字段。复用共用组件或保留业务列表/展示、画布、权限及错误边界。

## packages/web/src/components/settings/SshCredentialsForm.tsx

容器：Card:182。

| 行 | 控件 / 字段 | 状态 | 原因 |
| --- | --- | --- | --- |
| 262 | ResourceSelect · "ssh-agent-id" | 已替换 | 共用 Radix Popover + cmdk / Dialog 资源选择器，沿用业务候选与 stable ID。 |
| 280 | LabeledInput · "ssh-username" | 保留 | 自由内容（名称、路径、命令、表达式、凭据或搜索查询），保持原提交与校验。 |
| 286 | LabeledInput · "ssh-host" | 保留 | 自由内容（名称、路径、命令、表达式、凭据或搜索查询），保持原提交与校验。 |
| 292 | LabeledInput · "ssh-port" | 保留 | 自由内容（名称、路径、命令、表达式、凭据或搜索查询），保持原提交与校验。 |
| 299 | LabeledInput · "ssh-password" | 保留 | 自由内容（名称、路径、命令、表达式、凭据或搜索查询），保持原提交与校验。 |
| 314 | Textarea · "ssh-private-key" | 保留 | 自由内容（名称、路径、命令、表达式、凭据或搜索查询），保持原提交与校验。 |
| 325 | LabeledInput · "ssh-passphrase" | 保留 | 自由内容（名称、路径、命令、表达式、凭据或搜索查询），保持原提交与校验。 |
| 338 | LabeledInput · "ssh-jumps" | 保留 | 自由内容（名称、路径、命令、表达式、凭据或搜索查询），保持原提交与校验。 |
| 344 | LabeledInput · "ssh-host-key" | 保留 | 自由内容（名称、路径、命令、表达式、凭据或搜索查询），保持原提交与校验。 |
| 391 | Input · {id} | 保留 | 自由内容（名称、路径、命令、表达式、凭据或搜索查询），保持原提交与校验。 |

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

## packages/web/src/components/software/MaterialCatalog.tsx

容器：继承父容器 / 无独立容器。

| 行 | 控件 / 字段 | 状态 | 原因 |
| --- | --- | --- | --- |
| 110 | Input · {`${id}-repository`} | 保留 | 自由内容（名称、路径、命令、表达式、凭据或搜索查询），保持原提交与校验。 |

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
| 198 | Input · {`${id}-manifest`} | 保留 | 勾选、单选、文件上传或隐藏表单值，保留原生语义。 |
| 211 | Input · {`${id}-files`} | 保留 | 勾选、单选、文件上传或隐藏表单值，保留原生语义。 |
| 224 | Input · {`${id}-directory`} | 保留 | 勾选、单选、文件上传或隐藏表单值，保留原生语义。 |
| 358 | input · input | 保留 | 勾选、单选、文件上传或隐藏表单值，保留原生语义。 |

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
| 143 | Input · {`${id}-plan`} | 保留 | 勾选、单选、文件上传或隐藏表单值，保留原生语义。 |
| 155 | Input · {`${id}-files`} | 保留 | 勾选、单选、文件上传或隐藏表单值，保留原生语义。 |

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

容器：DialogContent:239。

| 行 | 控件 / 字段 | 状态 | 原因 |
| --- | --- | --- | --- |
| 259 | input · input | 保留 | 勾选、单选、文件上传或隐藏表单值，保留原生语义。 |

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

容器：继承父容器 / 无独立容器。

已检查：无独立填写字段。复用共用组件或保留业务列表/展示、画布、权限及错误边界。

## packages/web/src/components/software/SoftwareCardGrid.tsx

容器：继承父容器 / 无独立容器。

已检查：无独立填写字段。复用共用组件或保留业务列表/展示、画布、权限及错误边界。

## packages/web/src/components/software/SoftwareCreatePages.tsx

容器：PageShell:41。

已检查：无独立填写字段。复用共用组件或保留业务列表/展示、画布、权限及错误边界。

## packages/web/src/components/software/SoftwareDetailPages.tsx

容器：PageShell:71。

已检查：无独立填写字段。复用共用组件或保留业务列表/展示、画布、权限及错误边界。

## packages/web/src/components/software/SoftwarePage.tsx

容器：PageShell:570、SheetContent:1460、SheetContent:1703、SheetContent:2088、DialogContent:2116。

| 行 | 控件 / 字段 | 状态 | 原因 |
| --- | --- | --- | --- |
| 1555 | Input · {name} | 保留 | 自由内容（名称、路径、命令、表达式、凭据或搜索查询），保持原提交与校验。 |
| 1559 | Input · {version} | 保留 | 发布或登记新版本的版本号，属于创建内容；已有版本引用在独立资源选择控件中处理。 |
| 1565 | Input · {description} | 保留 | 自由内容（名称、路径、命令、表达式、凭据或搜索查询），保持原提交与校验。 |
| 1569 | Input · {tags} | 保留 | 自由内容（名称、路径、命令、表达式、凭据或搜索查询），保持原提交与校验。 |
| 1573 | Textarea · {yamlContent} | 保留 | 自由内容（名称、路径、命令、表达式、凭据或搜索查询），保持原提交与校验。 |
| 2210 | Input · {name} | 保留 | 自由内容（名称、路径、命令、表达式、凭据或搜索查询），保持原提交与校验。 |
| 2214 | Input · {`${id}-source`} | 保留 | 自由内容（名称、路径、命令、表达式、凭据或搜索查询），保持原提交与校验。 |
| 2219 | Input · {description} | 保留 | 自由内容（名称、路径、命令、表达式、凭据或搜索查询），保持原提交与校验。 |
| 2223 | Input · {tags} | 保留 | 自由内容（名称、路径、命令、表达式、凭据或搜索查询），保持原提交与校验。 |
| 2408 | Input · {name} | 保留 | 自由内容（名称、路径、命令、表达式、凭据或搜索查询），保持原提交与校验。 |
| 2412 | Input · {version} | 保留 | 发布或登记新版本的版本号，属于创建内容；已有版本引用在独立资源选择控件中处理。 |
| 2418 | Input · {description} | 保留 | 自由内容（名称、路径、命令、表达式、凭据或搜索查询），保持原提交与校验。 |
| 2423 | Input · {commandFile} | 保留 | 自由内容（名称、路径、命令、表达式、凭据或搜索查询），保持原提交与校验。 |
| 2467 | Input · {inputDescriptor} | 保留 | 自由内容（名称、路径、命令、表达式、凭据或搜索查询），保持原提交与校验。 |
| 2476 | Input · {argumentFormat} | 保留 | 自由内容（名称、路径、命令、表达式、凭据或搜索查询），保持原提交与校验。 |

## packages/web/src/components/software/SoftwarePublisherRoute.tsx

容器：PageShell:25、PageShell:43。

已检查：无独立填写字段。复用共用组件或保留业务列表/展示、画布、权限及错误边界。

## packages/web/src/components/software/SpackCatalogPackageForm.tsx

容器：继承父容器 / 无独立容器。

| 行 | 控件 / 字段 | 状态 | 原因 |
| --- | --- | --- | --- |
| 89 | Input · {name} | 保留 | 自由内容（名称、路径、命令、表达式、凭据或搜索查询），保持原提交与校验。 |
| 101 | NativeSelect · {`${id}-source`} | 保留 | 少量固定枚举、分页大小、布尔策略或共用资源选择器的原生表单桥接，保留统一简单选择。 |
| 119 | Input · {description} | 保留 | 自由内容（名称、路径、命令、表达式、凭据或搜索查询），保持原提交与校验。 |
| 155 | Input · {tags} | 保留 | 自由内容（名称、路径、命令、表达式、凭据或搜索查询），保持原提交与校验。 |

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

## packages/web/src/components/software/SpackSourceEditor.tsx

容器：继承父容器 / 无独立容器。

| 行 | 控件 / 字段 | 状态 | 原因 |
| --- | --- | --- | --- |
| 110 | Textarea · "software-spack-package-file" | 保留 | 自由内容（名称、路径、命令、表达式、凭据或搜索查询），保持原提交与校验。 |
| 131 | Input · {field.value} | 保留 | 自由内容（名称、路径、命令、表达式、凭据或搜索查询），保持原提交与校验。 |

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
| 119 | Input · {name} | 保留 | 自由内容（名称、路径、命令、表达式、凭据或搜索查询），保持原提交与校验。 |
| 123 | Input · {version} | 保留 | 自由内容（名称、路径、命令、表达式、凭据或搜索查询），保持原提交与校验。 |
| 129 | Input · {description} | 保留 | 自由内容（名称、路径、命令、表达式、凭据或搜索查询），保持原提交与校验。 |
| 134 | Input · {commandFile} | 保留 | 自由内容（名称、路径、命令、表达式、凭据或搜索查询），保持原提交与校验。 |
| 184 | Input · {inputDescriptor} | 保留 | 自由内容（名称、路径、命令、表达式、凭据或搜索查询），保持原提交与校验。 |
| 193 | Input · {argumentFormat} | 保留 | 自由内容（名称、路径、命令、表达式、凭据或搜索查询），保持原提交与校验。 |

## packages/web/src/components/software/WorkflowTemplateForm.tsx

容器：继承父容器 / 无独立容器。

| 行 | 控件 / 字段 | 状态 | 原因 |
| --- | --- | --- | --- |
| 42 | Input · {name} | 保留 | 自由内容（名称、路径、命令、表达式、凭据或搜索查询），保持原提交与校验。 |
| 46 | Input · {version} | 保留 | 自由内容（名称、路径、命令、表达式、凭据或搜索查询），保持原提交与校验。 |
| 52 | Input · {description} | 保留 | 自由内容（名称、路径、命令、表达式、凭据或搜索查询），保持原提交与校验。 |
| 56 | Input · {tags} | 保留 | 自由内容（名称、路径、命令、表达式、凭据或搜索查询），保持原提交与校验。 |
| 60 | Textarea · {yamlContent} | 保留 | 自由内容（名称、路径、命令、表达式、凭据或搜索查询），保持原提交与校验。 |

## packages/web/src/components/ssh/SshTerminal.tsx

容器：继承父容器 / 无独立容器。

已检查：无独立填写字段。复用共用组件或保留业务列表/展示、画布、权限及错误边界。

## packages/web/src/components/terminal/AuditDrawer.tsx

容器：SheetContent:70。

| 行 | 控件 / 字段 | 状态 | 原因 |
| --- | --- | --- | --- |
| 144 | Input · "terminal-audit-search" | 保留 | 自由内容（名称、路径、命令、表达式、凭据或搜索查询），保持原提交与校验。 |

## packages/web/src/components/terminal/NewSessionDialog.tsx

容器：SheetContent:100。

| 行 | 控件 / 字段 | 状态 | 原因 |
| --- | --- | --- | --- |
| 139 | ResourceSelectField · "terminal-agent" | 已替换 | 共用 Radix Popover + cmdk / Dialog 资源选择器，沿用业务候选与 stable ID。 |
| 198 | ResourceSelectField · "terminal-user" | 已替换 | 共用 Radix Popover + cmdk / Dialog 资源选择器，沿用业务候选与 stable ID。 |

## packages/web/src/components/terminal/SessionIdCopyButton.tsx

容器：继承父容器 / 无独立容器。

已检查：无独立填写字段。复用共用组件或保留业务列表/展示、画布、权限及错误边界。

## packages/web/src/components/terminal/SessionPane.tsx

容器：继承父容器 / 无独立容器。

已检查：无独立填写字段。复用共用组件或保留业务列表/展示、画布、权限及错误边界。

## packages/web/src/components/terminal/TerminalPage.tsx

容器：PageShell:184。

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
| 566 | ResourceSelect · "rf-prop-usecase-version-select" | 已替换 | 共用 Radix Popover + cmdk / Dialog 资源选择器，沿用业务候选与 stable ID。 |
| 596 | Input · "rf-prop-usecase-version-id" | 保留 | 嵌入编辑器未提供候选目录时的兼容分支；平台 Shell 已提供资源目录及当前图候选，运行时使用 ResourceSelect。SubWorkflow ByVersion 没有可验证的 workflowVersionId 目录，保留原 ID 输入。 |
| 612 | Input · "rf-prop-software-version-id" | 保留 | 嵌入编辑器未提供候选目录时的兼容分支；平台 Shell 已提供资源目录及当前图候选，运行时使用 ResourceSelect。SubWorkflow ByVersion 没有可验证的 workflowVersionId 目录，保留原 ID 输入。 |
| 631 | Input · {`rf-prop-req-${field}`} | 保留 | 数值输入；共用 Input 提供合法范围内的原生预设，并保留自定义数值与 min/max/step。 |
| 765 | ResourceSelect · "rf-prop-script-runtime-select" | 已替换 | 共用 Radix Popover + cmdk / Dialog 资源选择器，沿用业务候选与 stable ID。 |
| 780 | Input · "rf-prop-script-runtime" | 保留 | 嵌入编辑器未提供候选目录时的兼容分支；平台 Shell 已提供资源目录及当前图候选，运行时使用 ResourceSelect。SubWorkflow ByVersion 没有可验证的 workflowVersionId 目录，保留原 ID 输入。 |
| 800 | Input · "rf-prop-script-identity" | 保留 | 自由内容（名称、路径、命令、表达式、凭据或搜索查询），保持原提交与校验。 |
| 812 | Input · "rf-prop-script-language" | 保留 | 自由内容（名称、路径、命令、表达式、凭据或搜索查询），保持原提交与校验。 |
| 822 | Textarea · "rf-prop-script-content" | 保留 | 自由内容（名称、路径、命令、表达式、凭据或搜索查询），保持原提交与校验。 |
| 881 | Input · "rf-prop-milestone-url" | 保留 | 自由内容（名称、路径、命令、表达式、凭据或搜索查询），保持原提交与校验。 |
| 894 | Textarea · "rf-prop-milestone-message" | 保留 | 自由内容（名称、路径、命令、表达式、凭据或搜索查询），保持原提交与校验。 |
| 1000 | Input · {`rf-prop-switch-case-when-${index}`} | 保留 | 自由内容（名称、路径、命令、表达式、凭据或搜索查询），保持原提交与校验。 |
| 1010 | ResourceSelect · {`rf-prop-switch-case-to-select-${index}`} | 已替换 | 共用 Radix Popover + cmdk / Dialog 资源选择器，沿用业务候选与 stable ID。 |
| 1030 | Input · {`rf-prop-switch-case-to-${index}`} | 保留 | 自由内容（名称、路径、命令、表达式、凭据或搜索查询），保持原提交与校验。 |
| 1072 | ResourceSelect · {defaultTo} | 已替换 | 共用 Radix Popover + cmdk / Dialog 资源选择器，沿用业务候选与 stable ID。 |
| 1086 | Input · "rf-prop-switch-default" | 保留 | 自由内容（名称、路径、命令、表达式、凭据或搜索查询），保持原提交与校验。 |
| 1186 | NativeSelect · "rf-prop-loop-mode" | 保留 | 少量固定枚举、分页大小、布尔策略或共用资源选择器的原生表单桥接，保留统一简单选择。 |
| 1204 | Input · "rf-prop-loop-max-iterations" | 保留 | 自由内容（名称、路径、命令、表达式、凭据或搜索查询），保持原提交与校验。 |
| 1214 | Input · "rf-prop-loop-over" | 保留 | 自由内容（名称、路径、命令、表达式、凭据或搜索查询），保持原提交与校验。 |
| 1226 | Input · "rf-prop-loop-until" | 保留 | 自由内容（名称、路径、命令、表达式、凭据或搜索查询），保持原提交与校验。 |
| 1238 | NativeSelect · "rf-prop-loop-on-exhausted" | 保留 | 少量固定枚举、分页大小、布尔策略或共用资源选择器的原生表单桥接，保留统一简单选择。 |
| 1252 | Input · "rf-prop-loop-max-parallel" | 保留 | 数值输入；共用 Input 提供合法范围内的原生预设，并保留自定义数值与 min/max/step。 |
| 1327 | ResourceSelect · {fromLoop} | 已替换 | 共用 Radix Popover + cmdk / Dialog 资源选择器，沿用业务候选与 stable ID。 |
| 1340 | Input · "rf-prop-reduce-from-loop" | 保留 | 嵌入编辑器未提供候选目录时的兼容分支；平台 Shell 已提供资源目录及当前图候选，运行时使用 ResourceSelect。SubWorkflow ByVersion 没有可验证的 workflowVersionId 目录，保留原 ID 输入。 |
| 1353 | ResourceSelect · {fromOutput} | 已替换 | 共用 Radix Popover + cmdk / Dialog 资源选择器，沿用业务候选与 stable ID。 |
| 1371 | Input · "rf-prop-reduce-from-output" | 保留 | 嵌入编辑器未提供候选目录时的兼容分支；平台 Shell 已提供资源目录及当前图候选，运行时使用 ResourceSelect。SubWorkflow ByVersion 没有可验证的 workflowVersionId 目录，保留原 ID 输入。 |
| 1383 | NativeSelect · "rf-prop-reduce-ordering" | 保留 | 少量固定枚举、分页大小、布尔策略或共用资源选择器的原生表单桥接，保留统一简单选择。 |
| 1397 | NativeSelect · "rf-prop-reduce-output-kind" | 保留 | 少量固定枚举、分页大小、布尔策略或共用资源选择器的原生表单桥接，保留统一简单选择。 |
| 1413 | Input · "rf-prop-reduce-output-descriptor" | 保留 | 自由内容（名称、路径、命令、表达式、凭据或搜索查询），保持原提交与校验。 |
| 1490 | NativeSelect · "rf-prop-subworkflow-ref-kind" | 保留 | 少量固定枚举、分页大小、布尔策略或共用资源选择器的原生表单桥接，保留统一简单选择。 |
| 1508 | Input · "rf-prop-subworkflow-version-id" | 保留 | 嵌入编辑器未提供候选目录时的兼容分支；平台 Shell 已提供资源目录及当前图候选，运行时使用 ResourceSelect。SubWorkflow ByVersion 没有可验证的 workflowVersionId 目录，保留原 ID 输入。 |
| 1533 | Input · "rf-prop-subworkflow-max-depth" | 保留 | 数值输入；共用 Input 提供合法范围内的原生预设，并保留自定义数值与 min/max/step。 |
| 1546 | NativeSelect · "rf-prop-subworkflow-on-depth-exceeded" | 保留 | 少量固定枚举、分页大小、布尔策略或共用资源选择器的原生表单桥接，保留统一简单选择。 |
| 1594 | Input · "rf-prop-generate-output-descriptor" | 保留 | 自由内容（名称、路径、命令、表达式、凭据或搜索查询），保持原提交与校验。 |
| 1605 | NativeSelect · "rf-prop-generate-output-as" | 保留 | 少量固定枚举、分页大小、布尔策略或共用资源选择器的原生表单桥接，保留统一简单选择。 |

## packages/web/src/components/workflow/ReactFlowEditor.tsx

容器：继承父容器 / 无独立容器。

已检查：无独立填写字段。复用共用组件或保留业务列表/展示、画布、权限及错误边界。

## packages/web/src/components/workflow/WorkflowEditorShell.tsx

容器：继承父容器 / 无独立容器。

| 行 | 控件 / 字段 | 状态 | 原因 |
| --- | --- | --- | --- |
| 510 | NativeSelect · "rf-shell-flow-animation" | 保留 | 少量固定枚举、分页大小、布尔策略或共用资源选择器的原生表单桥接，保留统一简单选择。 |
| 553 | input · input | 保留 | 勾选、单选、文件上传或隐藏表单值，保留原生语义。 |

## packages/web/src/components/workflow/WorkflowSlotMappingDialog.tsx

容器：DialogContent:202。

| 行 | 控件 / 字段 | 状态 | 原因 |
| --- | --- | --- | --- |
| 280 | ResourceSelectField · {fromSlot} | 已替换 | 共用 Radix Popover + cmdk / Dialog 资源选择器，沿用业务候选与 stable ID。 |
| 309 | ResourceSelectField · {toSlot} | 已替换 | 共用 Radix Popover + cmdk / Dialog 资源选择器，沿用业务候选与 stable ID。 |
| 325 | NativeSelect · {transferType} | 保留 | 少量固定枚举、分页大小、布尔策略或共用资源选择器的原生表单桥接，保留统一简单选择。 |

## packages/web/src/components/workflows/DeleteWorkflowDraftDialog.tsx

容器：DialogContent:38。

已检查：无独立填写字段。复用共用组件或保留业务列表/展示、画布、权限及错误边界。

## packages/web/src/components/workflows/NewWorkflowPage.tsx

容器：DialogContent:844、DialogContent:881。

| 行 | 控件 / 字段 | 状态 | 原因 |
| --- | --- | --- | --- |
| 694 | Input · "workflow-name" | 保留 | 自由内容（名称、路径、命令、表达式、凭据或搜索查询），保持原提交与校验。 |

## packages/web/src/components/workflows/ParsedStepsPreview.tsx

容器：继承父容器 / 无独立容器。

已检查：无独立填写字段。复用共用组件或保留业务列表/展示、画布、权限及错误边界。

## packages/web/src/components/workflows/TemplateGallery.tsx

容器：继承父容器 / 无独立容器。

已检查：无独立填写字段。复用共用组件或保留业务列表/展示、画布、权限及错误边界。

## packages/web/src/components/workflows/WorkflowCreationLayout.tsx

容器：继承父容器 / 无独立容器。

已检查：无独立填写字段。复用共用组件或保留业务列表/展示、画布、权限及错误边界。

## packages/web/src/components/workflows/WorkflowCreationStepper.tsx

容器：继承父容器 / 无独立容器。

已检查：无独立填写字段。复用共用组件或保留业务列表/展示、画布、权限及错误边界。

## packages/web/src/components/workflows/WorkflowDagView.tsx

容器：Card:358、Card:383、DialogContent:465、Card:513、Card:529、Card:583、Card:597、Card:628、Card:671。

已检查：无独立填写字段。复用共用组件或保留业务列表/展示、画布、权限及错误边界。

## packages/web/src/components/workflows/WorkflowInputsStep.tsx

容器：DialogContent:1380。

| 行 | 控件 / 字段 | 状态 | 原因 |
| --- | --- | --- | --- |
| 561 | NativeSelect · {`workflow-value-${requirement.key}`} | 保留 | 少量固定枚举、分页大小、布尔策略或共用资源选择器的原生表单桥接，保留统一简单选择。 |
| 574 | Textarea · {`workflow-value-${requirement.key}`} | 保留 | 自由内容（名称、路径、命令、表达式、凭据或搜索查询），保持原提交与校验。 |
| 587 | Input · {`workflow-value-${requirement.key}`} | 保留 | 自由内容（名称、路径、命令、表达式、凭据或搜索查询），保持原提交与校验。 |
| 717 | input · "workflow-choose-local-file" | 保留 | 勾选、单选、文件上传或隐藏表单值，保留原生语义。 |
| 732 | input · "workflow-choose-local-folder" | 保留 | 勾选、单选、文件上传或隐藏表单值，保留原生语义。 |
| 898 | input · {`workflow-choose-local-file-${requirement.key}`} | 保留 | 勾选、单选、文件上传或隐藏表单值，保留原生语义。 |
| 920 | input · {`workflow-choose-local-folder-${requirement.key}`} | 保留 | 勾选、单选、文件上传或隐藏表单值，保留原生语义。 |
| 1158 | ResourceSelectField · {`workflow-dataset-select-${requirement.key}`} | 已替换 | 共用 Radix Popover + cmdk / Dialog 资源选择器，沿用业务候选与 stable ID。 |

## packages/web/src/components/workflows/WorkflowPickerDialogs.tsx

容器：DialogContent:104、DialogContent:334。

| 行 | 控件 / 字段 | 状态 | 原因 |
| --- | --- | --- | --- |
| 125 | ResourceSelectField · "workflow-template-tag-filter" | 已替换 | 共用 Radix Popover + cmdk / Dialog 资源选择器，沿用业务候选与 stable ID。 |
| 351 | NativeSelect · "workflow-usecase-runtime-filter" | 保留 | 少量固定枚举、分页大小、布尔策略或共用资源选择器的原生表单桥接，保留统一简单选择。 |
| 362 | NativeSelect · "workflow-usecase-input-filter" | 保留 | 少量固定枚举、分页大小、布尔策略或共用资源选择器的原生表单桥接，保留统一简单选择。 |

## packages/web/src/components/workflows/WorkflowResourcesStep.tsx

容器：继承父容器 / 无独立容器。

| 行 | 控件 / 字段 | 状态 | 原因 |
| --- | --- | --- | --- |
| 168 | NativeSelect · "workflow-resource-planner-mode" | 保留 | 少量固定枚举、分页大小、布尔策略或共用资源选择器的原生表单桥接，保留统一简单选择。 |
| 201 | Input · "workflow-placement-budget" | 保留 | 数值输入；共用 Input 提供合法范围内的原生预设，并保留自定义数值与 min/max/step。 |
| 267 | NativeSelect · "workflow-resource-node-strategy" | 保留 | 少量固定枚举、分页大小、布尔策略或共用资源选择器的原生表单桥接，保留统一简单选择。 |
| 291 | ResourceSelectField · "workflow-resource-target-queue" | 已替换 | 共用 Radix Popover + cmdk / Dialog 资源选择器，沿用业务候选与 stable ID。 |
| 314 | NativeSelect · "workflow-resource-data-movement" | 保留 | 少量固定枚举、分页大小、布尔策略或共用资源选择器的原生表单桥接，保留统一简单选择。 |

## packages/web/src/components/workflows/WorkflowReviewGraph.tsx

容器：继承父容器 / 无独立容器。

已检查：无独立填写字段。复用共用组件或保留业务列表/展示、画布、权限及错误边界。

## packages/web/src/components/workflows/WorkflowReviewStep.tsx

容器：继承父容器 / 无独立容器。

已检查：无独立填写字段。复用共用组件或保留业务列表/展示、画布、权限及错误边界。

## packages/web/src/components/workflows/WorkflowRunGraph.tsx

容器：继承父容器 / 无独立容器。

已检查：无独立填写字段。复用共用组件或保留业务列表/展示、画布、权限及错误边界。

## packages/web/src/components/workflows/WorkflowScriptPickerDialog.tsx

容器：继承父容器 / 无独立容器。

| 行 | 控件 / 字段 | 状态 | 原因 |
| --- | --- | --- | --- |
| 61 | NativeSelect · "workflow-script-language-filter" | 保留 | 少量固定枚举、分页大小、布尔策略或共用资源选择器的原生表单桥接，保留统一简单选择。 |

## packages/web/src/components/workflows/WorkflowStartOverlay.tsx

容器：继承父容器 / 无独立容器。

已检查：无独立填写字段。复用共用组件或保留业务列表/展示、画布、权限及错误边界。

## packages/web/src/components/workflows/WorkflowsPage.tsx

容器：PageShell:168。

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

容器：PageShell:21。

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

容器：PageShell:68、PageShell:83、PageShell:176。

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
