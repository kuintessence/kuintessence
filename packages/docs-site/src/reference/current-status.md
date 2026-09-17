# 当前功能与使用边界

Kuintessence 当前为 pre-release，包含 Server、Agent、Registry、Web、CLI、TUI 和本地 GUI。

## 部署前核对

- Server 目前只支持单实例运行，配置 Redis 后也不能跨实例共享运行状态。
- 配置正式 SSO、传输层信任、访问控制及备份，不使用 demo 初始化凭据。
- 为 Agent 配置调度器及其运行权限。
- 提交前分别检查软件目录、节点安装状态与第三方许可。
- NetDrive、SSH 录屏等能力需要对应存储和运行配置。

详细限制见[仓库当前状态](https://github.com/kuintessence/kuintessence/blob/main/docs/status/current-state.md)。
部署操作见[部署与环境](../operate/deployment)、[角色手册](../guide/role-map)及[操作手册](../operate/manuals)。
