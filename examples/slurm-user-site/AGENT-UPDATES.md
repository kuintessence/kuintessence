# Agent 更新与通知

普通用户站点通过 `run-agent.sh` 启动 Python supervisor，由它下载、校验发行，在安全空闲点退出旧 Agent，再启动新版。tmux 和 user-systemd 都使用同一个启动器。直接执行 Agent 二进制不提供自动替换能力。

## 开关与首次启用

在私有 `site.env` 中设置，两个开关独立且默认关闭：

```bash
# 每次启动 supervisor 时检查已配置的 KQ_RELEASE_CHANNEL。
export KQ_AGENT_AUTO_UPDATE=1
# 允许平台或所属算力中心请求更新到指定发行。
export KQ_AGENT_REMOTE_UPDATE=1
```

隧道已由 tmux 或 user-systemd 运行时，先核实端口归属，再在 `site.env` 设置 `KQ_REUSE_TUNNEL=1`，供更新下载复用。

开关在 supervisor 启动时读取；修改后需重启启动器。关闭自动检查不会禁止已允许的远程请求；关闭远程更新时，Agent 回报 `disabled`。平台通知只保存在平台界面，不触发站点执行。

已有站点需先交付新版 `bootstrap.sh` 和支持 `agent_update_v1` 的签名 Agent 发行，并在维护窗口完成一次人工升级：暂停平台派发，确认作业、传输、软件安装和回执已结束，停止旧启动器，保留身份与状态目录，再按 [SSH 手册](SSH-TUNNEL.md#6-更新与回滚)的 `stage`、`activate` 流程生成新启动器。首次迁移不能靠旧 Agent 接收新版命令完成。

使用 [tmux](SHARED-HOME.md#用-tmux-启动)时启动原有 `run-agent.sh` 即进入 supervisor。更新过程中 supervisor 留在同一会话，Agent 子进程退出并由它重启。节点重启后的恢复仍由站点负责。user-systemd 的 `kq-agent.service` 同样监督这个启动器；原六小时 timer 继续只暂存发行。

启动检查的下载共用 60 秒预算（隧道建立、签名验证和本地哈希另计），网络失败后继续运行已安装版本，未完成产物可在后续检查断点续传。启动前应用待处理发行时也限制下载预算。运行期间收到的远程请求在旧 Agent 继续工作时下载，沿用正常下载的超时与重试策略。

## 平台与算力中心操作

平台 Agent 卡片及算力中心 Agent 列表提供“Agent 更新”：填写已发布的 manifest SHA-256、可选说明，再提交。

- 平台 operator、platform_admin、super_admin 可以发送更新通知和请求更新。
- 所属算力中心 org_admin 可以查看通知、使用通知中的发行并请求更新；不能操作其他中心或冒充平台发送通知。
- 站点开关拥有最终执行权。离线请求持久保存，支持此能力的 Agent 在心跳中重新接收；旧 Agent 不会收到未知命令。

接口沿用平台登录与资源授权：`GET /api/agents/:id/updates` 返回最近 20 条记录及当前连接是否支持更新；`POST` 接受：

```json
{
  "requestId": "00000000-0000-4000-8000-000000000001",
  "kind": "update",
  "release": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  "message": "请在安全空闲后更新"
}
```

`kind=notice` 仅发送平台通知。同一 `requestId` 与相同请求内容重试保持幂等；更改内容或已有未结束更新时返回 409。通知可以独立存在。接口只接受平台发行目录内摘要和 schema 均有效的清单，最终签名与兼容性仍由站点核验；不接受 URL、二进制上传或远程 shell。

## 安全切换与结果

更新按下列顺序执行：

1. 校验站点信任公钥的签名、每个产物的 SHA-256、ABI、Server 协议范围和 sequence 高水位。仅支持相同 `stateFormat`，不自动迁移数据库或存储模式。
2. 等待 Agent 执行、传输、安装及持久回执均空闲。私有 Unix socket 的短租约阻止切换期间接收新工作；繁忙时释放租约、继续工作并重试。
3. 再核验 Server 兼容性，通过租约请求 Agent 正常停止，等旧进程退出，再核验数据库、独占锁和 Slurm worker，切换二进制与配置。
4. 保留 Agent ID、注册证书和数据库，启动新版。只有运行中的目标发行收到 Server 的有效心跳确认，再回报结果后，平台才记为成功。

| 状态 | 含义 |
|---|---|
| requested | 平台已记录，等待 Agent 接收或 supervisor 处理 |
| waiting | 等待空闲、控制 socket 或写入者退出 |
| applying | 已取得空闲许可，准备切换 |
| restarting | 已选择目标发行，等待目标进程确认在线 |
| succeeded | 目标进程已收到有效心跳确认并回报成功 |
| failed | 校验或切换失败，需要查看现场日志 |
| disabled | 站点开关不允许执行此请求 |

不会取消 Slurm 作业或对 Agent 使用 SIGKILL。繁忙时不会持续封锁派发，因此连续高负载可能一直等待；需要尽快升级时先在平台停止派发并等待现有工作完成。更新期间的断流是预期行为，断线不能单独作为升级成功的证据。

新版在确认在线前退出时，supervisor 尝试在空闲、同格式及身份校验通过后回退上个发行的二进制和保存配置，保留数据库，不恢复旧数据库快照。不能证明安全时停止自动回退。新版一直存活但未连通平台时保持 `restarting`，需检查现场连接和日志，不自动强杀。回退不会降低 sequence 高水位，重新发布修复版需使用更高 sequence。

现场排查可查看 tmux 输出或 `journalctl --user -u kq-agent`，以及 `$KQ_LOCAL/status.json`、`$KQ_LOCAL/state/update-request.json`。不要删除锁、journal、证书或数据库；Unix socket 绝对路径须短于 Linux 的 108 字节地址限制，使用较短的 `KQ_LOCAL`。

这些能力已由本地模拟通道、签名发行和进程切换测试覆盖；真实 HPC 的网络中断、NFS 故障和生产角色组合仍须现场验收。Server 上线前需要应用新增的 PostgreSQL 更新请求表迁移。本手册不执行部署或迁移。
