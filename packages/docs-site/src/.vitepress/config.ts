import { defineConfig } from "vitepress";

const rawBase = process.env.DOCS_BASE ?? "/";
const base = rawBase.startsWith("/") && rawBase.endsWith("/") ? rawBase : "/";

export default defineConfig({
  title: "Kuintessence 文档中心",
  lang: "zh-CN",
  description: "统一算力网络平台的用户、集群、平台和软件治理手册",
  base,
  cleanUrls: true,
  lastUpdated: true,
  ignoreDeadLinks: true,
  markdown: {
    lineNumbers: true,
  },
  themeConfig: {
    siteTitle: "Kuintessence 文档",
    sidebarMenuLabel: "文档目录",
    returnToTopLabel: "返回顶部",
    skipToContentLabel: "跳到正文",
    darkModeSwitchLabel: "外观",
    lightModeSwitchTitle: "切换到浅色模式",
    darkModeSwitchTitle: "切换到深色模式",
    docFooter: { prev: "上一篇", next: "下一篇" },
    lastUpdated: { text: "最后更新" },
    notFound: {
      title: "找不到此页",
      quote: "请检查文档地址，或从首页按角色查找手册。",
      linkLabel: "返回文档首页",
      linkText: "返回文档首页",
    },
    logo: `${base}logo.svg`,
    nav: [
      { text: "开始", link: "/guide/getting-started" },
      { text: "角色手册", link: "/roles/user" },
      { text: "运维", link: "/operate/deployment" },
      { text: "SOP 与手册", link: "/operate/manuals" },
      { text: "参考", link: "/reference/glossary" },
    ],
    socialLinks: [
      {
        icon: "github",
        link: "https://github.com/kuintessence/kuintessence",
        ariaLabel: "代码仓库",
      },
    ],
    sidebar: [
      {
        text: "入门",
        items: [
          { text: "文档首页", link: "/" },
          { text: "快速开始", link: "/guide/getting-started" },
          { text: "科学软件生态", link: "/guide/scientific-ecosystem" },
          { text: "Data Market 数据使用", link: "/guide/data-market" },
          { text: "联邦协同", link: "/guide/federation-collaboration" },
          { text: "角色地图", link: "/guide/role-map" },
        ],
      },
      {
        text: "角色手册",
        items: [
          { text: "用户 / Compute Consumer", link: "/roles/user" },
          { text: "算力中心 / 集群管理员", link: "/roles/compute-provider" },
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
      options: {
        translations: {
          button: { buttonText: "搜索", buttonAriaLabel: "搜索文档" },
          modal: {
            displayDetails: "显示搜索结果详情",
            resetButtonTitle: "清空搜索",
            backButtonTitle: "关闭搜索",
            noResultsText: "没有找到相关文档",
            footer: {
              selectText: "打开",
              selectKeyAriaLabel: "回车键",
              navigateText: "选择结果",
              navigateUpKeyAriaLabel: "向上键",
              navigateDownKeyAriaLabel: "向下键",
              closeText: "关闭",
              closeKeyAriaLabel: "退出键",
            },
          },
        },
      },
    },
    outline: {
      level: [2, 3],
      label: "本页章节",
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
