import { defineConfig } from "vitepress";

const rawBase = process.env.DOCS_BASE ?? "/";
const base = rawBase.startsWith("/") && rawBase.endsWith("/") ? rawBase : "/";

export default defineConfig({
  title: "Kuintessence 文档中心",
  description: "统一算力网络平台的用户、集群、平台和软件治理手册",
  base,
  cleanUrls: true,
  lastUpdated: true,
  ignoreDeadLinks: true,
  markdown: {
    lineNumbers: true,
  },
  themeConfig: {
    logo: `${base}logo.svg`,
    nav: [
      { text: "开始", link: "/guide/getting-started" },
      { text: "角色手册", link: "/roles/user" },
      { text: "运维", link: "/operate/deployment" },
      { text: "SOP 与手册", link: "/operate/manuals" },
      { text: "参考", link: "/reference/glossary" },
      { text: "代码仓库", link: "https://github.com/kuintessence/kuintessence" },
    ],
    sidebar: [
      {
        text: "入门",
        items: [
          { text: "文档首页", link: "/" },
          { text: "快速开始", link: "/guide/getting-started" },
          { text: "科学软件生态", link: "/guide/scientific-ecosystem" },
          { text: "Data Market 数据使用", link: "/guide/data-market" },
          { text: "角色地图", link: "/guide/role-map" },
        ],
      },
      {
        text: "角色手册",
        items: [
          { text: "用户 / Compute Consumer", link: "/roles/user" },
          { text: "算力提供者 / 集群管理员", link: "/roles/compute-provider" },
          { text: "平台运营", link: "/roles/platform-operator" },
          { text: "软件开发者 / Software Provider", link: "/roles/software-provider" },
        ],
      },
      {
        text: "运维",
        items: [
          { text: "部署与环境", link: "/operate/deployment" },
          { text: "软件治理", link: "/operate/software-governance" },
          { text: "Data Market CP 运维", link: "/operate/data-market" },
          { text: "License、Runtime 与受限材料", link: "/operate/license-runtime-governance" },
          { text: "生态 Release 导入与回滚", link: "/operate/ecosystem-release" },
          { text: "手册包与 SOP", link: "/operate/manuals" },
          { text: "标准操作流程（SOP）", link: "/operate/sop" },
          { text: "故障排查", link: "/operate/troubleshooting" },
        ],
      },
      {
        text: "参考",
        items: [
          { text: "当前功能与状态", link: "/reference/current-status" },
          { text: "命令速查", link: "/reference/commands" },
          { text: "术语表", link: "/reference/glossary" },
        ],
      },
    ],
    search: {
      provider: "local",
    },
    outline: {
      level: [2, 3],
    },
    editLink: {
      pattern:
        "https://github.com/kuintessence/kuintessence/edit/main/packages/docs-site/src/:path",
      text: "编辑此页",
    },
    footer: {
      message: "Kuintessence 文档采用 AGPL-3.0-only，由 VitePress 生成。",
      copyright: "Copyright © 2026 Kuintessence contributors",
    },
  },
});
