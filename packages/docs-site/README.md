# Kuintessence 文档站

文档站面向用户、算力提供者、平台运营和软件发布者，使用 VitePress 将 Markdown 生成为静态页面。

## 本地命令

```bash
bun run docs:dev
bun run docs:build
bun run docs:preview
```

也可以在 package 内运行：

```bash
bun run --filter @kuintessence/docs-site build
```

## 发布

在 GitHub Actions 中手动运行 **Docs Site**，选择 `main` 分支。
该 workflow 构建 `packages/docs-site/src/.vitepress/dist`，并发布到 `gh-pages` 分支；
提交文档或配置变更不会自动发布。

首次发布后，在仓库的 **Settings → Pages** 中选择从分支部署，来源设为 `gh-pages` 的根目录。
Workflow 已按仓库名称设置 `DOCS_BASE`。

GitHub Pages project site 需要设置 base path：

```bash
DOCS_BASE="/kuintessence/" bun run docs:build
```

## 维护约定

- 用户文档默认使用中文。
- 命令、API、配置键、包名和标准技术名词保持英文。
- 代码、配置、schema、API、UI、部署或运行行为变更时，同步更新相关文档。
- 实现状态与限制维护在[当前功能与使用边界](../../docs/status/current-state.md)；
  [站点功能概览](src/reference/current-status.md)提供简要说明。
