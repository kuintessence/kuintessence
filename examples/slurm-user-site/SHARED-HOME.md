# 共享 HOME 与 tmux

自动检查、平台通知及运行中安全切换见 [Agent 更新](AGENT-UPDATES.md)。两个更新开关默认关闭，已有站点需先人工升级启动器。

仅有共享 HOME 的站点可显式选择回滚日志模式，将状态放在 HOME 的独立私有子目录，并在一个固定登录节点运行 Agent。默认本地盘/WAL 模式不变。本模式不提供跨登录节点同时访问、自动接管或节点重启后自启动。

## 发行与文件系统要求

需要包含 `AGENT_SQLITE_JOURNAL_MODE=delete` 支持的新版 Agent，以及 `stateFormat=slurm-site-v5-shared-home-v1` 的签名发行。安装器在注册前拒绝旧 WAL 发行；不能将旧二进制仅换一个发行标签后使用。发布方须验证实际产物的回滚日志行为和 Server 协议兼容性。

新版签名发行通过 `serverProtocolRange` 声明兼容的 Server 协议范围；Server 的实时 `siteProtocolVersion` 落在范围内时，Git revision 可以不同。采用此规则须先升级 Server，再交付新版 bootstrap 与重新签名的发行。没有范围的历史发行仍严格匹配 revision；不能手工改原清单绕过签名。详见[站点发行准备](../../docs/site-release-preparation.md)。

状态目录须由当前用户所有、权限 0700，不含符号链接，位于 HOME 下但与 `KQ_SHARED` 分离。支持可写本地文件系统或 NFS/NFS4；NFS 必须保留锁，拒绝 `nolock`、`soft`、`softerr` 和只读挂载。`local_lock=none` 表示不使用仅客户端本地的锁，不等于禁用了 NFS 锁。

数据库使用 SQLite DELETE journal、synchronous=EXTRA 和有界 busy timeout。提交依赖文件系统实际提供的锁、fsync 和目录同步语义；本地回归测试不代替本站 NFS 断线/重连验收。不要在网络异常时手工删除 journal、锁或数据库。维护和备份使用原有的停止写入、SQLite backup 与完整性检查流程。

## 配置与安装

在私有 `site.env` 中选择：

```bash
export KQ_STATE_STORAGE=shared-home
export KQ_LOCAL="$HOME/.local/state/kq-agent"
export KQ_SHARED="$HOME/kq-test"
export KQ_ENABLE_SPACK=0
```

先按主手册核验 ABI、签名、公钥、TLS 和 SSH 转发配置，再执行 `check`、`install` 和 `doctor`。安装器首次写入时保存主机绑定；另一主机上的 bootstrap 和生成的 Agent 启动器会拒绝启动。已有无绑定数据库不能直接纳入此模式。

本地盘模式与共享 HOME 模式具有不同 stateFormat，已有站点不会通过普通发行切换自动迁移。已有 WAL 数据库须单独停止全部写入者、备份并核验后制定迁移流程；不能在运行期间切换 journal 模式或复制打开的数据库。

## 用 tmux 启动

成功安装后会生成私有 `run-tunnel.sh` 和 `run-agent.sh`。它们使用已核验的 SSH 参数、主机绑定和 Agent 独占锁。`install` 不自动启动常驻进程。

在安装时的同一个登录节点执行，已有同名会话时先查看它，不重复启动：

```bash
source ./site.env
tmux new-session -d -s kq-tunnel bash "$KQ_LOCAL/run-tunnel.sh"
tmux new-session -d -s kq-agent bash -l "$KQ_LOCAL/run-agent.sh"
tmux list-sessions
```

用 `tmux attach-session -t kq-agent` 查看连接与初始化结果，按 Ctrl-b d 分离；隧道会话同理。tmux 会话存在不证明 Agent 在线或隧道就绪，仍须检查平台连接与诊断。隧道与 Agent 进程退出后须调查原因并手动恢复，tmux 不自动重启子进程。

不需要为本轮 tmux 运行启用 linger。节点重启或站点清理用户会话后需在同一节点手动恢复，保留原证书、Agent ID、目录和数据库。迁移到另一登录节点前必须确认原节点全部写入者已停止、检查数据库及备份，再单独制定重新绑定流程；不要直接删除 `state-hostname`。

首轮只验证 modules 作业。计算节点的 user-manager、scratch、隔离和可信 SIF 未通过时，不启用托管 Spack 安装；tmux 不替代这些能力检查。
