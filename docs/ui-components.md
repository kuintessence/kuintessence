# Web 组件库与接入约定

采用 **Radix UI 交互基元 + 现有 shadcn/ui 风格公共组件 + TanStack Table**。
组件放在 `packages/web/src/components/ui/`，业务页面组合这些组件，颜色与明暗主题仍由 `app.css` 的语义 token 控制。

## 选型

| 方案 | 适合的场景 | 在 KQ 中的取舍 |
| --- | --- | --- |
| Ant Design | 希望直接使用完整后台表格、复杂表单和日期选择器的新项目 | 能减少复杂业务控件实现，但当前需要迁移已有 Tailwind、Radix 的样式与交互，或长期维护两套系统 |
| MUI | 采用 Material Design 的产品 | 组件丰富，当前 KQ 的界面语言与其不同，主题适配和迁移成本较高 |
| Radix UI + shadcn/ui 组合方式 | 已有 Tailwind 主题，按需组合无障碍交互组件 | 与当前结构一致，本次采用；焦点、键盘与弹层行为由 Radix 实现 |

shadcn/ui 是源码分发模式，不是安装后就完全免维护的运行时组件库。本项目已有相同架构的定制组件，本次沿用其接口，并不声称全部文件来自官方生成器。公共层只负责样式与产品约束；不要在页面重新实现菜单、焦点陷阱或方向键导航。

## 使用现成组件

| 场景 | 组件 | 使用边界 |
| --- | --- | --- |
| 操作和链接 | `Button` / `asChild` | 使用既有尺寸和语义变体；表单内非提交操作显式设置 `type="button"` |
| 页面骨架 | `PageShell`、`PageHeader` | 页面只传标题、说明和操作，复用间距、标题层级及窄屏折行 |
| 搜索框 | `SearchInput` | 组合现有 `Input` 与 Lucide 图标；`containerClassName` 控制外层宽度，`className` 控制输入框；保留原生事件、ref、name 和外部 label |
| 翻页按钮 | `PaginationControls` | 组合现有 `Button`；页面传入 `previous` / `next` 的禁用条件、点击回调及可选文案，继续管理服务端页码或游标 |
| 输入、多行文本 | `Input`、`Textarea` | 页面只提供布局、业务状态和必要的字体变体，错误时关联错误文本并设置 `aria-invalid` |
| 简单选择 | `NativeSelect` | 统一样式的原生 select，保留 `onChange`、空值、`optgroup`、`name`、required、FormData 和移动端系统选择器 |
| 单选按钮组 | Radix `ToggleGroup`、`ToggleGroupItem` | 作业、工作流、文件传输状态和外观选择采用 `type="single"`；非空选项忽略取消选择返回的空值；单选使用 `aria-checked` |
| 菜单、弹窗、侧栏、页签 | 现有 Radix `DropdownMenu`、`Dialog`、`Sheet`、`Tabs` | 复用现有业务关闭策略、焦点恢复和 reduced-motion 支持 |
| 客户端表格 | TanStack `DataTable` | 库负责排序、过滤和分页；排序按钮显示方向；多页时可调整每页条数；服务端列表仍由页面的服务端分页管理 |
| 工作流、图表、编辑器、终端 | React Flow、ECharts、Monaco、xterm | 继续使用现有专用库，不另造通用 UI 替代品 |

现有 94 个下拉框和 13 个原生多行文本框已迁入公共组件，覆盖登录、作业、工作流、文件、软件、算网、提供者控制台和设置。复选框、单选框、文件上传及画布内特殊输入保留既有语义；没有把所有原生 HTML 都包装一层。

`NativeSelect` 不实现搜索、多选标签或远端分页。业务确实需要此类交互时，再引入对应成熟组件；不要给普通下拉框编写自定义浮层。

Biome 的 `noLabelWithoutControl` 将 `Input`、`Textarea`、`NativeSelect` 识别为真实表单控件，规则仍为 error。浏览器 `color-scheme` 随主题变化，使原生选项和滚动条匹配明暗主题。

## 复用约定

14 处带图标搜索框使用 `SearchInput`，11 处列表翻页使用 `PaginationControls`，覆盖作业、工作流、软件目录、提供者和审计／成员列表。工作流与文件传输状态筛选使用现有 `ToggleGroup`，软件标签操作使用现有 `Button`；不要复制选中态、焦点样式和按钮尺寸。

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
