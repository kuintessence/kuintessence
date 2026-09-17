# 角色地图

Kuintessence 的权限和业务职责分为两层：技术角色与业务角色。

## 技术角色

| 角色 | 典型职责 |
|---|---|
| `super_admin` | 平台最高权限，管理所有组织、资源、配置和审核 |
| `platform_admin` | 平台运营权限，处理 SSO、软件审核、审计、全局设置 |
| `org_admin` | 组织管理员，管理本组织用户、资源授权和 CP 控制台范围 |
| `user` | 普通用户，提交作业、运行 workflow、申请软件权限 |
| `guest` | 只读或受限访问 |

## 业务角色

| 角色 | 说明 |
|---|---|
| Compute Consumer / CC | 使用算力、工作流、文件和软件能力的科研用户 |
| Compute Provider / CP | 提供集群、节点、队列、软件环境和计量数据的一方 |
| Software Provider / SP | 发布 Spack package、软件用例和 workflow template 的软件维护者 |
| Platform Operator | 负责平台治理、审核、安全、发布和观测的运营团队 |

同一个人可以同时拥有多个业务角色。例如，一个集群管理员通常既是 `org_admin`，也是 CP；一个科研团队 PI 可能既是 CC，也是 SP。

## 权限链路

用户运行 workflow 时，系统会同时校验：

1. 用户是否能看到并使用 workflow template。
2. workflow 下游 usecase/package 是否具备 `use` 权限。
3. 目标 CP 的 software policy 是否允许安装或运行。
4. 目标 Agent 是否在线、具备调度器能力和软件环境。
5. lifecycle 是否允许运行；`deprecated` 只提示，`revoked` 会阻断。

缺少软件 `view/use/install` 权限时，用户可以发起 access request，由平台或资产管理员审批。
