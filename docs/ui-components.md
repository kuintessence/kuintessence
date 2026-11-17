# Web 组件库与接入约定

Web 使用 Radix UI 交互基元、shadcn/ui 风格公共组件和 TanStack Table。
组件放在 `packages/web/src/components/ui/`，业务页面组合这些组件，颜色与明暗主题仍由 `app.css` 的语义 token 控制。

## 选型

| 方案 | 适合的场景 | 在 KQ 中的取舍 |
| --- | --- | --- |
| Ant Design | 希望直接使用完整后台表格、复杂表单和日期选择器的新项目 | 能减少复杂业务控件实现，但当前需要迁移已有 Tailwind、Radix 的样式与交互，或长期维护两套系统 |
| MUI | 采用 Material Design 的产品 | 组件丰富，当前 KQ 的界面语言与其不同，主题适配和迁移成本较高 |
| Radix UI + shadcn/ui 组合方式 | 已有 Tailwind 主题，按需组合无障碍交互组件 | 与现有 Tailwind 主题兼容；Radix 处理焦点、键盘与弹层 |

shadcn/ui 通过源码分发，公共组件由项目维护，沿用已有接口。公共层只负责样式与产品约束；不要在页面重新实现菜单、焦点陷阱或方向键导航。

## 使用现成组件

| 场景 | 组件 | 使用边界 |
| --- | --- | --- |
| 操作和链接 | `Button` / `asChild` | 使用既有尺寸和语义变体；表单内非提交操作显式设置 `type="button"` |
| 页面骨架 | `PageShell`、`PageHeader` | 页面只传标题、说明和操作，复用间距、标题层级及窄屏折行 |
| 搜索框 | `SearchInput` | 组合现有 `Input` 与 Lucide 图标；`containerClassName` 控制外层宽度，`className` 控制输入框；保留原生事件、ref、name 和外部 label |
| 翻页按钮 | `PaginationControls` | 组合现有 `Button`；页面传入 `previous` / `next` 的禁用条件、点击回调及可选文案，继续管理服务端页码或游标 |
| 输入、多行文本 | `Input`、`Textarea` | 页面只提供布局、业务状态和必要的字体变体，错误时关联错误文本并设置 `aria-invalid` |
| 资源选择 | `ResourceSelect` / `ResourcePickerDialog` / `ResourceSelectField` | 使用 Radix Popover + cmdk 或 Dialog；业务提供稳定 ID、标签、禁选原因和候选；支持自定义条目或表格列 |
| 统一列表 | `CollectionView` / `DataTable` / `Table` | 共用工具栏、状态、计数和表格视觉；显式区分本地完整集合与服务端查询 |
| 简单选择 | `NativeSelect` | 统一样式的原生 select，保留 `onChange`、空值、`optgroup`、`name`、required、FormData 和移动端系统选择器 |
| 单选按钮组 | Radix `ToggleGroup`、`ToggleGroupItem` | 作业、工作流、文件传输状态和外观选择采用 `type="single"`；非空选项忽略取消选择返回的空值；单选使用 `aria-checked` |
| 菜单、弹窗、侧栏、页签 | 现有 Radix `DropdownMenu`、`Dialog`、`Sheet`、`Tabs` | 复用现有业务关闭策略、焦点恢复和 reduced-motion 支持 |
| 客户端表格 | TanStack `DataTable` | 库负责排序、过滤和分页；排序按钮显示方向；多页时可调整每页条数；服务端列表仍由页面的服务端分页管理 |
| 工作流、图表、编辑器、终端 | React Flow、ECharts、Monaco、xterm | 继续使用现有专用库，不另造通用 UI 替代品 |

公共控件覆盖登录、作业、工作流、文件、软件、算网、算力中心控制台和设置。当前资源选择、固定枚举及自由输入的逐项状态见[迁移清单](ui/migration-inventory.md)。复选框、单选框、文件上传及画布内特殊输入保留既有语义；没有把所有原生 HTML 都包装一层。

`NativeSelect` 用于少量固定枚举。资源候选使用 `ResourceSelect` 或 `ResourcePickerDialog`；不要在业务页重新编写搜索浮层或焦点管理。`ResourceSelectField` 为已有 select 表单保留原生提交、事件与校验契约。

Biome 的 `noLabelWithoutControl` 将 `Input`、`Textarea`、`NativeSelect`、`ResourceSelect`、`ResourceSelectField` 识别为真实表单控件，规则仍为 error。浏览器 `color-scheme` 随主题变化，使原生选项和滚动条匹配明暗主题。

## 资源选择与查询模式

方案 A 使用 Popover + Command，搜索、最近、次要信息、清空、展开由业务按需启用。最近最多五条，按用户/组织/资源类型隔离且重新校验候选。方案 B 使用 Dialog 和统一表格，选择暂存在弹层中，确认后回填；取消保持原值。自定义内容用 `renderOption` / `renderSelected` 或 `columns`，不覆盖公共键盘及焦点逻辑。

`queryMode` 默认 `local`，只有完整候选集合才允许本地搜索、排序及分页；受控 `search` / `onSearchChange` 不隐式改变查询模式。服务器分页必须用 `server`：CollectionView 的 `table` 或选择器的 `tableQuery` 接收受控 sorting/pagination/rowCount 及回调，业务发起查询并在条件变化时复位页码。服务器页内不再次过滤、排序或分页。加载失败显示重试，不能把失败当空列表。部分候选目录继续使用外部服务器搜索和翻页，关闭菜单内搜索/展开，防止只搜当前页。

## 单层容器

普通业务功能区使用平面布局；Dialog/Sheet 自身是外壳，里面使用透明 section、间距、文字层级和 1px 分隔线。不得用普通 div、底色、圆角或阴影拼回内层卡片。Card 的 Surface 上下文防止跨组件组合生成第二层装饰容器；静态检查同时检查普通结构元素。输入框、按钮保留必要边界和焦点；React Flow 节点保留必要外轮廓及选中提示。工作流创建和编辑使用独立 `WorkflowCreationLayout`／`WorkflowPanel`，步骤导航、输入、资源、预览和画布保持任务面板边界，不受通用 Card 扁平化影响。详见 [DESIGN.md](../DESIGN.md) 与[验收记录](ui/verification.md)。

## 复用约定

带图标搜索框使用 `SearchInput`，列表翻页使用 `PaginationControls`，覆盖作业、工作流、软件目录、算力中心和审计／成员列表。工作流与文件传输状态筛选使用现有 `ToggleGroup`，软件标签操作使用现有 `Button`；不要复制选中态、焦点样式和按钮尺寸。

搜索框必须提供可见 label、`aria-label` 或 `aria-labelledby`。公共组件不添加防抖、不转换搜索词、不发起请求；清空搜索和重置页码仍由业务处理。分页按钮固定为 `type="button"`，避免嵌在表单中意外提交；总数、页码、每页条数等通过组合展示，公共控件不推断能否翻页。

```tsx
<SearchInput
  aria-label={t("jobs.searchPlaceholder")}
  value={search}
  onChange={(event) => setSearch(event.target.value)}
  containerClassName="w-full sm:max-w-80"
/>
<PaginationControls
  previous={{ disabled: page === 1 || loading, onClick: () => setPage(page - 1) }}
  next={{ disabled: !hasNext || loading, onClick: () => setPage(page + 1) }}
/>
```

先查找 `components/ui/` 和同业务目录的现有组件。只提取已经重复出现、语义一致的组合；步骤导航、画布交互和卡片选择按各自语义处理，避免为统一外观引入万能表单或万能列表配置。

## 验证

运行 `bun run lint`、`bun run typecheck` 和 `bun run test:web`。
组件浏览器检查使用离线夹具，加载真实组件与构建 CSS，所有数据明确标注为演示；不启动业务服务或提交计算任务：

```sh
cd packages/web
bun run build
bunx --no-install patchright test --config=e2e/ui-components.config.ts
```

可通过 `KQ_UI_CHROMIUM_EXECUTABLE` 指定本机 Chromium。测试覆盖桌面、平板、窄屏和明暗主题，验证排序、分页、键盘选择、原生表单及空状态的横向溢出。截图输出到 `packages/web/test-results/ui-components/`。

## 业务组合与响应式页面

- `ListToolbar` 组合现有 `SearchInput`、筛选内容和操作区，已用于作业、工作流及软件目录。通过 `search` 传输入框属性，筛选传 `children`，按钮传 `actions`；查询、清空、重置页码和权限判断由页面负责。
- `FormField` 统一 label、说明和错误布局，用于软件创建和版本表单。子函数接收自动生成的 `id`、`aria-describedby`、`aria-invalid`，展开到已有 `Input`、`Textarea` 或 `NativeSelect`；需要稳定 ID 时传 `id`。校验规则仍在业务表单中。
- `LoadingState`、`ErrorState`、`EmptyState` 统一列表状态，分别提供 status、alert 和空状态标题／说明／操作组合。`CatalogEmptyState` 只保留软件目录的创建链接语义，视觉复用公共空状态。
- `SoftwareCardGrid` 按实际内容区宽度排列透明条目，每列至少 20rem；窄于 20rem 时占满容器。模板、Spack 目录、脚本目录共用，不根据整个视口盲目增加列数。
- 手机只读策略生效时，算力中心软件页优先显示策略、Agent 状态和配置摘要。运行环境及材料映射保留 Agent 筛选和现有记录，省去禁用的编辑表单；材料管理区默认折叠，仍可展开查询。允许写入的桌面视图保留编辑流程。

```tsx
<FormField label={t("software.manage.templateName")} description={help} error={error}>
  {(field) => <Input {...field} value={name} onChange={onNameChange} />}
</FormField>
```

## 换行后的比例布局

公共 `kq-fill-row` 样式用于筛选、状态选项和操作组：每行控件按内容基础宽度分摊剩余空间，最后一行同样填满容器。组内控件按内容分配宽度。`Button size="icon"` 保持固定宽度；需要独立尺寸的子项可用 `flex-none`，组内搜索可用 `basis-full` 独占一行。

`ListToolbar`、`PageHeader` 按实际容器宽度决定筛选和操作区何时换行。`PaginationControls` 在手机上占满宽度，状态组和标签页逐行平铺。软件目录与版本／编译器／来源筛选、算力中心搜索、文件传输按钮、终端审计筛选、互联筛选、卡片操作和弹窗／侧栏底部按钮共用该样式。静态徽章、正文、表格和图标内部布局保持各自语义，不应用伸展规则。

浏览器检查在 320 / 360 / 390 / 480 / 640 / 768 / 1024 / 1280px 测量换行后每行的左右边界，同时验证菜单点击与键盘选择；作业空列表截图覆盖搜索、筛选、主操作及分页。

## CI 截图回归

CI 的 Static checks 在每个 PR 上构建真实 Web 样式并执行 `e2e/ui-components.config.ts`。已有组件交互测试与关键页面截图一起执行；作业、软件、工作流页面覆盖 320 / 768 / 1280px 和明暗主题，算力中心运行环境摘要覆盖手机明暗主题。

页面夹具挂载真实页面组件，查询缓存预填固定演示数据，不连接业务服务。左侧仅模拟导航占用的宽度，导航本身由预览运行检查覆盖。固定时间、时区和测试字体，截图基线保存在 `packages/web/e2e/snapshots/ui/`；字体约束只用于测试。CI 上传截图差异及失败 trace，保留 7 天。没有基线或像素差异超过 1% 时检查失败。

布局／主题有意修改后，在 Linux、对应版本 Chromium 和 `fonts-noto-cjk` / `fonts-liberation` 环境更新基线，并人工审阅图片：

```sh
cd packages/web
bun run build
bunx --no-install patchright test --config=e2e/ui-components.config.ts --update-snapshots
```

普通验证不加 `--update-snapshots`；不要用更新基线掩盖非预期变化。预览站仍需检查登录、真实接口、权限和筛选，这些不由离线截图替代。

## 工作区与作业交互

页面第一级采用无圆角卡片外壳的平面区域。算力中心及有运营权限的平台管理共用组织选择器，放在二级导航标题下；组织范围的权限和查询失效行为保持统一。

`ResourceSelect` 在 Dialog/Sheet 中仍使用文档级 Portal，搜索框接收真实键盘输入，Escape 只关闭最上层。Popover 固定为与现有 Dialog/Menu 共用 focus-scope、dismissable-layer 的 1.1.15 版本；升级 Radix 时需要一起验证这些模块的版本及嵌套交互，避免多个独立焦点栈争夺焦点。

作业用例同时展示执行输入槽和类型化声明，按类型渲染数字、枚举、布尔及文件控件，读取标量默认值并检查格式、范围与必填状态。没有声明输入的用例显示明确空态；缺少执行材料绑定的输入显示发布错误并阻止提交，不把未绑定参数当作执行参数。输入值继续沿用服务端的字符串/文件引用契约，Dataset 使用独立的数据选择与授权检查。

提交前保留按需“检查可用资源”，不在表单中常驻空的调度流水线；用例物化失败在本地检查区域显示错误。作业概览复用平面示意图，展示已记录的集群、Agent、软件、输入输出及申请资源，集群信息只来自匹配的持久选址记录，缺失值显示未记录。图在手机宽度隐藏，节点详情使用受视口约束的弹窗。

本地夹具与浏览器检查（虚构数据，不连接平台）：

```sh
bun node_modules/vite/bin/vite.js build --config packages/web/visual/function-maps.config.ts
bun packages/web/visual/verify-job-controls.mjs
```

### 示意图展示与统一偏好

`FunctionMapRegion` 管理已有位置的双视图或折叠状态，`FunctionMaps` 继续负责权限、节点定位及原入口导航。双视图保留挂载状态，折叠保留标题与恢复按钮；共同筛选、重要异常及业务表单留在外侧。`MapPreferencesPanel` 集中在个人中心「外观与界面」配置连线效果与默认规则，每页「视图设置」提供页面覆盖。偏好按账号保存在当前浏览器，不跨设备同步；三个模式、URL 优先级及模块清单见[功能示意图说明](architecture/function-maps.md)。

浏览器夹具 `e2e/map-workflow.spec.ts` 使用正式组件和构建 CSS，离线检查工作流编辑、输入、资源、预览四步，以及示意图弹窗、视图切换、折叠和全局外观；不启动平台服务或提交业务变更。
