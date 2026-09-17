# Kuintessence 文档中心

Kuintessence 用于管理 Slurm、PBS Pro、Torque、Kubernetes 及云/边缘资源，提供作业调度、工作流、软件治理和数据管理功能。

按下方角色入口查找使用与运维说明。通用操作手册与配置说明保存在仓库 `docs/` 目录。

项目目前为 pre-release，部署要求见[当前实现状态与限制](./reference/current-status.md)。

## 按角色阅读

| 角色 | 主要问题 | 入口 |
|---|---|---|
| 普通用户 / Compute Consumer | 如何登录、提交作业、运行 workflow、查看文件和软件可用性 | [用户手册](./roles/user.md) |
| 算力提供者 / 集群管理员 | 如何接入 Agent、管理节点、软件策略、用户和计量 | [算力提供者手册](./roles/compute-provider.md) |
| 平台运营 | 如何管理租户、SSO、安全、软件审核、审计和发布 | [平台运营手册](./roles/platform-operator.md) |
| 软件开发者 / Software Provider | 如何维护 Spack package、用例、workflow template 并提交审核 | [软件开发者手册](./roles/software-provider.md) |

## 快速入口

- [快速开始](./guide/getting-started.md)
- [角色地图](./guide/role-map.md)
- [部署与环境](./operate/deployment.md)
- [软件治理](./operate/software-governance.md)
- [SOP 与综合手册](./operate/manuals.md)
- [标准操作流程（SOP）](./operate/sop.md)
- [故障排查](./operate/troubleshooting.md)
- [当前功能与实现状态](./reference/current-status.md)
- [命令速查](./reference/commands.md)

## 文档维护约定

- 用户文档默认使用中文。
- 命令、API、配置键、包名和标准技术名词保持英文。
- 代码、配置、schema、API、UI、部署或运行行为变更时，同步更新相关文档。
