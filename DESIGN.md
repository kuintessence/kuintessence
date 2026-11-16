---
name: Kuintessence
description: "继承品牌蓝与系统字体的单层扁平资源工作台"
colors:
  "brand": "oklch(0.55 0.19 255)"
  "brand-foreground": "oklch(0.99 0 0)"
  "brand-soft": "oklch(0.94 0.04 255)"
  "background": "oklch(0.974 0.006 248)"
  "foreground": "oklch(0.18 0.02 260)"
  "muted": "oklch(0.945 0.012 252)"
  "muted-foreground": "oklch(0.5 0.015 260)"
  "card": "oklch(1 0 0)"
  "border": "oklch(0.895 0.01 252)"
  "input": "oklch(0.92 0.005 260)"
  "ring": "oklch(0.62 0.18 255)"
  "status-pending": "oklch(0.62 0.02 260)"
  "status-running": "oklch(0.49 0.17 255)"
  "status-succeeded": "oklch(0.46 0.13 150)"
  "status-failed": "oklch(0.5 0.19 25)"
  "status-cancelled": "oklch(0.55 0.01 260)"
typography:
  "headline":
    fontFamily: "\"Inter\", ui-sans-serif, system-ui, -apple-system, \"Segoe UI\", Roboto, \"Helvetica Neue\", Arial, \"Noto Sans SC\", \"Noto Sans CJK SC\", \"PingFang SC\", \"Microsoft YaHei\", \"WenQuanYi Zen Hei\", sans-serif"
    fontSize: "1.5rem"
    fontWeight: 600
    lineHeight: "2rem"
    letterSpacing: "-0.025em"
  "title":
    fontFamily: "\"Inter\", ui-sans-serif, system-ui, -apple-system, \"Segoe UI\", Roboto, \"Helvetica Neue\", Arial, \"Noto Sans SC\", \"Noto Sans CJK SC\", \"PingFang SC\", \"Microsoft YaHei\", \"WenQuanYi Zen Hei\", sans-serif"
    fontSize: "1rem"
    fontWeight: 600
    lineHeight: "1.5rem"
  "body":
    fontFamily: "\"Inter\", ui-sans-serif, system-ui, -apple-system, \"Segoe UI\", Roboto, \"Helvetica Neue\", Arial, \"Noto Sans SC\", \"Noto Sans CJK SC\", \"PingFang SC\", \"Microsoft YaHei\", \"WenQuanYi Zen Hei\", sans-serif"
    fontSize: "0.875rem"
    lineHeight: "1.25rem"
  "label":
    fontFamily: "\"Inter\", ui-sans-serif, system-ui, -apple-system, \"Segoe UI\", Roboto, \"Helvetica Neue\", Arial, \"Noto Sans SC\", \"Noto Sans CJK SC\", \"PingFang SC\", \"Microsoft YaHei\", \"WenQuanYi Zen Hei\", sans-serif"
    fontSize: "0.75rem"
    fontWeight: 500
    lineHeight: "1rem"
  "mono":
    fontFamily: "\"JetBrains Mono\", ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, \"Liberation Mono\", \"Courier New\", monospace"
rounded:
  "sm": "calc(0.625rem - 4px)"
  "md": "calc(0.625rem - 2px)"
  "lg": "0.625rem"
  "xl": "calc(0.625rem + 4px)"
spacing:
  "1": "0.25rem"
  "2": "0.5rem"
  "3": "0.75rem"
  "4": "1rem"
  "5": "1.25rem"
  "6": "1.5rem"
  "8": "2rem"
components:
  "button-primary":
    backgroundColor: "{colors.brand}"
    textColor: "{colors.brand-foreground}"
    typography: "{typography.body}"
    rounded: "{rounded.md}"
    height: "2.25rem"
    padding: "0.5rem 1rem"
  "button-secondary":
    backgroundColor: "{colors.muted}"
    textColor: "{colors.foreground}"
    rounded: "{rounded.md}"
    height: "2.25rem"
    padding: "0.5rem 1rem"
  "button-outline":
    backgroundColor: "{colors.card}"
    textColor: "{colors.foreground}"
    rounded: "{rounded.md}"
    height: "2.25rem"
    padding: "0.5rem 1rem"
  "button-ghost":
    backgroundColor: "transparent"
    textColor: "{colors.foreground}"
    rounded: "{rounded.md}"
    height: "2.25rem"
    padding: "0.5rem 1rem"
  "button-destructive":
    backgroundColor: "{colors.status-failed}"
    textColor: "{colors.background}"
    rounded: "{rounded.md}"
    height: "2.25rem"
    padding: "0.5rem 1rem"
  "button-link":
    backgroundColor: "transparent"
    textColor: "{colors.brand}"
    rounded: "{rounded.md}"
    height: "2.25rem"
    padding: "0.5rem 1rem"
  "input":
    backgroundColor: "{colors.card}"
    textColor: "{colors.foreground}"
    typography: "{typography.body}"
    rounded: "{rounded.md}"
    height: "2.25rem"
    padding: "0.25rem 0.75rem"
  "nav-tab":
    backgroundColor: "transparent"
    textColor: "{colors.muted-foreground}"
    typography: "{typography.label}"
    padding: "0.25rem 0.75rem"
  "status-badge":
    backgroundColor: "transparent"
    textColor: "{colors.status-running}"
    typography: "{typography.label}"
    padding: "0.125rem 0"
  "surface-region":
    backgroundColor: "transparent"
    textColor: "{colors.foreground}"
    rounded: "0"
    padding: "1rem"
  "surface-section":
    backgroundColor: "transparent"
    textColor: "{colors.foreground}"
    padding: "1rem"
---

# Design System: Kuintessence

## Overview

**Creative North Star: "Operate"**

本规范沿用用户已确认的 Operate 方向，记录严格的单层扁平容器约定，继承现有蓝白主题、品牌蓝、系统 sans 字体和 token 尺度。信息以标题、留白、行列和细分隔线组织；页面采用无卡片外框的平面区域；弹层或抽屉各保留一个最外层容器，内部模块透明且不再形成独立卡片。

工作流节点是需要独立识别、连线和选择的画布实体，允许必要的轮廓、底色与选中 ring；节点内部透明，继承节点底色。此例外不扩展到节点内部、属性面板或普通业务模块。名称、中英文文案与状态必须保持可辨认，不依赖颜色单独传达意义。

**Key Characteristics:**

- 单个区域只保留一层容器，内部依靠标题、间距和单向分隔线组织。
- 品牌蓝表达主操作、选中与焦点，状态色表达资源或任务状态。
- 复用 shadcn 风格基础组件、Radix、cmdk 与 TanStack，业务定义内容。

依据：`packages/web/src/styles/app.css`、`packages/web/src/components/ui/`、AppShell、作业/软件列表、资源选择器及工作流画布代码。品牌与权限边界参考 `packages/web/PRODUCT.md`。前面的 token 是默认亮色模式的抽取快照；运行时仍以 app.css 为唯一实现来源，暗色由其 `.dark` 同名变量切换，禁止另造一套色值。此文档记录已确认规范，不代表所有业务路径均已完成回归。

## Colors

延续冷浅灰画布、白色区域与克制的品牌蓝，保留源文件的 OKLCH 表达。

### Primary

- **品牌蓝**（`brand`）：主按钮、链接、选中项与活动导航。
- **品牌前景**（`brand-foreground`）：实心主按钮上的文字。
- **品牌浅色**（`brand-soft`）：既有语义 token；内部模块不因其存在而新增底色面板。
- **焦点蓝**（`ring`）：可见键盘焦点与必要的选择状态。

### Neutral

- **画布与区域**（`background`、`card`）：全局画布及最外层容器；内部模块透明继承所在区域。
- **正文与次要信息**（`foreground`、`muted-foreground`）：主内容与辅助文字。
- **弱化与边界**（`muted`、`border`、`input`）：既有交互反馈、分隔线和控件边界；不用整块底色代替布局。

状态 token 只表示排队、运行、成功、失败、取消等语义，配合状态文字或图标。Badge 显示文字与语义色，不绘制圆角底色。工作流运行节点可沿用状态轮廓与轻量状态底色，内部透明继承。

## Typography

正文使用 app.css 的 Inter / 系统 sans / 中文回退字体；代码与 ID 使用 JetBrains Mono / 系统等宽回退。保留既有字体，不引入展示字体。

- **Headline**：页面标题使用 headline token；半粗、紧字距，长名称可断行。
- **Title**：弹层标题等使用 title token。
- **Body**：表格、字段、按钮使用 body token。
- **Label**：辅助说明、表头与状态使用 label token；画布局部可沿用既有更小的 ID 文字，不将其提升为全站正文。
- **Mono**：命令、资源 ID、路径与日志保留等宽字体；数值按需使用等宽数字。

## Layout

**The Single Surface Rule.** 页面、Dialog 与 Sheet 内只保留一个区域外壳；嵌套模块不得再有完整边框、圆角背景、阴影或装饰 ring。输入控件、交互状态及画布节点的必要边界保留。

PageShell 负责页面内容间距，不绘制完整边框、圆角、底色或阴影；PageHeader 用底部分隔线划分标题与操作。Card 在页面与独立区域中均保持透明平面样式，在 SurfaceBoundary 内自动降为 section。Dialog 与 Sheet 各建立自己的区域边界，内部列表、表单、统计和错误状态不再绘制外壳。

间距沿用 Tailwind 的现有尺度。页面内边距为 spacing.4，sm 起为 spacing.5；主应用内容由 AppShell 限制最大宽度（80rem），按屏宽从 spacing.4 增至 spacing.8。常规控件高度使用既有按钮/输入 token，主要按钮可随操作行弹性伸展；固定图标按钮不拉长。

工具栏可换行，宽表只在自身横向滚动，页面不因表格变宽。普通多列表格有效数据的最小宽度沿用 DataTable（640px）；ResourcePickerDialog 的默认名称/描述紧凑表格在窄屏取消该最小宽度并允许文字换行，自定义宽列仍局部滚动；sm/md/lg 断点由 Tailwind 既有主题提供。弹层为视口留边，头尾操作固定于弹层结构，内容区独立滚动。

## Elevation & Depth

普通页面与内部模块严格扁平，无装饰阴影。容器以最外层边界和留白表达归属，内部只允许必要的单向分隔线。Radix Popover、Dialog、Sheet 属于覆盖交互层，可保留既有边界、遮罩与浮层阴影，不能将该样式复用为内部卡片。具体阴影实现记录在 `.impeccable/design.json`；`docs/ui/design-system.json` 保存相同内容的仓库副本，更新时保持同步。

动画复用 app.css 的进入、退出、浮层和侧栏 motion 变量。交互状态通过短时颜色、透明度或位移动画表达；`prefers-reduced-motion` 下停用相关动画，不给内部模块新增入场表演。

## Shapes

页面第一级区域与 Card 不使用圆角卡片外壳；按钮、输入和浮层沿用 rounded.md。内部 section 不保留圆角、背景、完整边框、阴影或装饰 ring。表格行、Tabs、搜索结果依靠细分隔线和文字选中态组织。

**The Functional Node Rule.** 工作流节点可保留遮挡连线的外层底色、类型或状态轮廓及选中 ring，内部模块保持透明，不套卡片。

端口、控制柄、选中标记、缩放与连线需要的形状属于画布交互，不视为新增内容容器。

## Components

### 基础组件与依赖

沿用仓库内 shadcn 风格的组件与 Tailwind token。Radix 提供 Dialog、Sheet、Popover、Tabs 和菜单的焦点、关闭与浮层能力；cmdk 提供 Command 搜索及键盘选项导航；TanStack Table 提供列、排序、过滤与分页。扩展现有 primitives，不另建同类基础库。

### Buttons / Inputs

Button 保留 default、secondary、outline、ghost、destructive、link 及现有尺寸。主操作用品牌色，次要操作选 outline/ghost；hover、focus-visible、disabled 都沿用当前实现。Input/Select 的边界用于标识可操作控件，错误用失败色和明确文案，禁用仍可辨认。可输入命令、说明、路径和合法自定义数值，不强迫自由内容变成资源选择。

### Cards / Containers / Navigation / Badges

Card 与嵌套 section 均采用透明平面样式。Tabs 使用底线和品牌色表达活动状态，不绘制独立的分段卡片。侧栏沿用现有工作区导航与移动端展开逻辑。Badge 使用透明背景的状态文字，不能套胶囊背景。

### CollectionView / DataTable

CollectionView 统一工具栏、搜索、加载/错误/空态与结果区域；业务提供稳定 getKey、TanStack columns 或 renderItem、筛选和操作。当前 API 通过 columns 或 renderItem 选择展示方式，不内置所有页面的视图切换、列设置或批量操作；这些能力按业务需要组合。DataTable 负责排序、过滤、分页、结果总数、列渲染与局部横向滚动，不另加内部卡片外框。

CollectionView、ResourceSelect 与 ResourcePickerDialog 显式使用 `queryMode="local" | "server"`，默认 local。受控的 search/onSearchChange 只决定状态归属，不隐式切换服务器模式；local 仍搜索完整传入集合。server 模式强制关闭本地过滤、排序与分页，由业务查询完整服务器结果，禁止仅操作当前页。CollectionView 通过 table，Picker 通过 tableQuery 接收受控 pagination/sorting/rowCount 与对应回调；ResourceSelect 将 queryMode/tableQuery 传入展开的 Dialog。异步请求、取消旧请求、查询条件变化时回到第一页与 URL 恢复由业务适配层管理。

最小接入示例（变量与状态由业务提供）：

```tsx
// 完整本地集合；即使受控搜索，默认 local 仍执行本地过滤。
<CollectionView
  data={allResources} columns={columns} getKey={(item) => item.value}
  search={search} onSearchChange={setSearch}
/>

// 服务器返回当前页，并接收 query/sorting/pagination 请求参数。
<ResourcePickerDialog
  open={open} onOpenChange={setOpen} title={title}
  options={serverPage} value={selectedIds} onConfirm={setSelectedIds}
  queryMode="server" search={search} onSearchChange={changeServerSearch}
  tableQuery={{ pagination, onPaginationChange: changeServerPage,
    sorting, onSortingChange: changeServerSorting, rowCount: serverTotal }}
/>
```

changeServerSearch/changeServerSorting 应在更新查询时重置页码；changeServerPage 触发服务器请求。直接使用 DataTable 时，业务显式设置对应 manual 标志与受控状态。

### ResourceSelect：方案 A，搜索下拉

目标明确时就地展开，选择后立即回填并关闭。基于 Radix Popover 与 cmdk，支持可选搜索、最近选择、次要信息/自定义渲染、清空及“展开选择”。`searchable` 默认开启，`recent`、`clearable`、`expandable` 默认关闭，必填字段不能清空。默认单选；最近记录按用户、组织、资源类型隔离，最多 5 个稳定 ID，展示前仅保留仍存在且可选的项，与全部列表去重。

键盘行为由 cmdk/Radix 处理，浮层使用 portal 与定位能力；Popover 保留可接收指针事件的内容层，并位于 Dialog 覆盖层之上，保证弹层内也能展开和选择。关闭焦点回到触发字段。服务端搜索需显式设置 `queryMode="server"` 并由受控回调接管，加载、错误和重试明确呈现。展开到方案 B 时带入当前搜索与选中值。ResourceSelectField 是迁移适配层，保留原生 change、FormData、required、disabled 与表单 reset 合约。

候选项只加载了服务器结果的一部分时，必须保留业务现有的外部服务器搜索与分页，将菜单内搜索和“展开选择”关闭，避免把已加载子集伪装成完整目录。只有完整候选集或具备对应远端查询适配时，才启用组件内部查询与对比；最近记录也仅展示当前候选集中仍有效的条目。

### ResourcePickerDialog：方案 B，弹层对比

候选项多或需要比较属性时使用 Dialog + ListToolbar + DataTable。列、筛选和禁选原因由业务提供；默认单选，需要时显式开启 multiple。选择仅修改 draft；确认后调用业务回调，取消、Esc 或关闭不写回原值。筛选、排序、翻页保留 draft，底部显示所选摘要。确认前确保选中项仍在候选集中且未禁用；异步权限与最新资源有效性由业务/服务端再次校验。忙碌时可锁定关闭和确认行为。

两种方式共用 ResourceOption 的 value/label/description/keywords/disabled/disabledReason 及数据来源，通过 presentation 明确选择或从 dropdown 展开为 dialog。父资源改变后，由业务清理失效的下游资源。完整远端分页、跨页选择、并发失效与辅助技术回归需要针对真实接入验证，不因 primitives 存在而视为已覆盖。

### 工作流资源引用与槽位映射

画布节点的内容仍按透明内部布局组织。槽位映射使用真实 descriptor 与槽位类型、批量属性校验兼容性；已有映射失效时显示反馈并禁止确认，不因名称相近自动接受。Reduce 的来源输出读取所选 Loop 的 `raw.outputs`，候选值为输出 descriptor；图内资源引用从当前图和真实目录取得，无可靠版本目录的字段保留原有受校验输入。这些业务约束由工作流适配层负责，不写入通用选择器模型。

**The Stable Identity Rule.** 显示友好名称与归属，提交稳定 ID；禁选原因可见，真实有效性与权限由业务和服务端校验。

## Do's and Don'ts

### Do:

- **Do** 新页面复用 PageShell、PageHeader、CollectionView 和现有 ui primitives，让业务仅定义列、条目与操作。
- **Do** 在最外层建立 SurfaceBoundary，内部采用透明布局、标题、留白和细分隔线。
- **Do** 为选择字段声明可访问名称、禁用原因、错误与恢复操作，并保留中英文文案。
- **Do** 明确本地或服务端查询模式，数据变化使用稳定 key；权限与失效校验保留在业务和服务端。

### Don't:

- **Don't** 在区域内部叠加卡片、带底色的小面板、装饰阴影或圆角背景标签。
- **Don't** 手写第二套 combobox、焦点陷阱、浮层定位或表格排序分页逻辑。
- **Don't** 将权限过滤、最近记录或前端选中状态当成服务端授权与资源有效性保证。
- **Don't** 把静态预览片段或旧审核原型当成完整交互实现，也不要为节点内部增加独立卡片。

## Organization Scope

算力中心与平台运营共用的组织范围选择器放在二级导航标题下方，跟随移动端导航抽屉；内容区不重复显示组织切换工具行。切换沿用既有组织状态与缓存刷新，业务表单中的组织字段保持各自用途。概览标题不展示自动刷新周期等技术提示；审批待办标题与图标垂直居中，数量使用品牌色与较大数字，并放在节点清单前。

### 展示文字与名称列表

纯展示标题、表头、字段名和品牌文字使用默认光标且不可选中，不显示交互悬停效果。按钮、链接继续保留悬停与键盘焦点；命令、日志、路径和业务数据仍可复制。文件及目录名称使用单行尾部渐隐，保留完整 title 和无障碍名称，不因长名称改变列表行高。数量摘要使用“在线数/总数 在线”或“可见数/总数 可见”，未知值保留破折号。
