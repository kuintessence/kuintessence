# Kuintessence 文档

快速开始见[仓库 README](../README.md)，功能与部署要求见[当前状态](status/current-state.md)。
按角色查操作步骤，按主题查配置和实现细节。

## 角色手册

| 读者 | 文档 |
|---|---|
| 科研计算用户 | [用户手册](manuals/user-manual.md)：登录、作业、工作流、文件与结果 |
| 算力提供方 | [CP 手册](manuals/compute-provider-manual.md)：节点、账号、队列和软件运营 |
| 平台运营 | [运营手册](manuals/platform-operator-manual.md)：观察、审批、审计和事件处置 |
| 系统运维 | [运维手册](manuals/system-operations-manual.md)：发布、备份、回滚和恢复 |

各手册包含日常操作流程。组件兼容性与发布顺序见
[发布契约](manuals/release-contract.json)，提交格式见
[最小作业示例](manuals/examples/job-smoke.json)。

## 专题指南

| 主题 | 内容 |
|---|---|
| [部署与调度](deployment.md) | Compose、反向代理、队列 Registry、观测和故障排查 |
| [身份与安全](security.md) | 会话、OIDC、SpiceDB、mTLS、Agent 注册、SSH |
| [存储与计量](storage.md) | NetDrive、multipart、集群传输、Data Market 对象、配额、审计 |
| [软件与 Sandbox](software.md) | 资产发布、授权、Spack、签名生态、受限数据和隔离运行 |
| [Spack 受控上游导入](spack-upstream-import.md) | Registry 专用代理、HTTPS 白名单、recipe/material JSON 导入及维护边界 |
| [Spack 固定案例材料导出](spack-material-artifacts.md) | Actions 成套材料、校验、初始化和真实 Web 导入 |
| [客户端](clients.md) | CLI/TUI、本地工作流、GUI 与 Tauri |
| [工作流](workflow-schema/README.md) | 控制流 DSL、物化、执行、取消与恢复 |
| [前端维护](frontend.md) | 工作区导航、权限投影和共享动效约定 |
| [术语表](terminology-glossary.md) | 中英术语与角色定义 |

## 示例与维护

- [Workflow 示例](../examples/workflows/)：DSL 写法与节点连接示例。
- [本地工作流](clients.md#local-workflows)：配套 YAML 位于 `examples/all-in-one/`。
- [VitePress 文档站](../packages/docs-site/)：面向用户的浏览与导航入口。

文档默认使用中文，保留命令、API、配置键和标准技术名词。
示例使用虚构账号和站点；凭据与内部部署资料保存在仓库外。
新增内容归入对应手册或专题。运行 `bun scripts/check-doc-links.ts` 检查本地文档链接。
