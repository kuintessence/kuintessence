# 普通用户站点容量、清理与状态恢复

现场命令在[站点工具包](../examples/slurm-user-site/README.md)目录执行，配置与两种网络模式见[初始化手册](../examples/slurm-user-site/SSH-TUNNEL.md)。

通过新版单文件入口运行，地址和目录仍来自现场私密 `site.env`。这些命令不需要云端连接。

```bash
bash -l bootstrap.sh "$PWD/site.env" maintain capacity
bash -l bootstrap.sh "$PWD/site.env" maintain plan --retention-days 30
```

容量报告使用文件系统的可用字节和 inode；不把共享盘挂载余量当作 Unix 用户配额。平台签名工具下载与共享 runtime 拷贝会为即将增加的字节预留空间；实际用户配额、站点清理策略仍须确认。`KQ_LOCAL_RESERVE_BYTES` 默认 1 GiB，`KQ_SHARED_RESERVE_BYTES` 默认 2 GiB，可按站点修改，不能小于 1 MiB。

遇到 `Site capacity reserve is insufficient (bytes or inodes)` 时，分别对实际 `$KQ_LOCAL` 和 `$KQ_SHARED` 执行 `df -B1`、`df -i`，并按站点方法查询用户配额。需要的空间包含剩余下载或原子复制的完整文件与保留余量；`stage` 下载成功不保证随后共享盘复制也有足够空间，两目录在同一文件系统时会消耗同一份余量。先保留当前/前一版与恢复证据，用下方 `maintain plan` 核对可清理内容，或申请更多空间，完成后重试原命令。不要删除数据库、checkpoint或运行中的发行来腾空间，也不要仅为通过检查降低余量。

## 保留策略

预览不删除文件。应用前停止 Agent，保留证据并确认平台暂停本站新派发：

```bash
systemctl --user stop kq-agent
KQ_MAINTENANCE_WINDOW=1 bash -l bootstrap.sh "$PWD/site.env" maintain gc --retention-days 30
systemctl --user start kq-agent
```

应用会同时取得 bootstrap 与 Agent 锁，核对 SQLite 完整性、在途执行/清理/消息账本、当前用户 Slurm 队列，以及构建作业终态。未知 schema、controller/accounting 查询不确定或仍有任务时停止，不抢锁。

清理对象为超出保留期、无 current/previous/staged/高水位/备份引用的工具发行，旧的完整内容寻址材料缓存，以及有明确 no-requeue 失败终态的过期构建临时目录。不会删除已安装软件 prefix、计算作业目录、未完成材料、传输 checkpoint、未对账构建、凭据或数据库。完整材料缓存可重新从平台按摘要拉取；清理不能触发第三方回源。

计划在删除前落盘；每次执行在 `$KQ_LOCAL/retention-receipts/` 保留独立记录，失败或崩溃后重试不会覆盖旧证据。最近完成记录在 `$KQ_LOCAL/retention-last.json`。清理过程中失败应先查看计划与实际剩余目录，不根据文件存在与否推断作业成功。

可选自动策略：`KQ_AUTOMATIC_GC=1` 后重新运行 `services`，启用每日检查、最多一小时随机延迟的主机绑定用户 timer。先核对本地账本与 Slurm，再向私密Unix socket申请有时限的原子维护许可；Agent封住新请求，确认内存中的文件传输、软件操作及作业同样空闲后才授予。无许可不停止Agent。收到许可后短暂停止Agent，再持锁重新核验、清理并启动同一Agent；失败也会恢复服务。默认关闭，不主动启用长期进程权限。

## 迁移前备份

升级到新 stateFormat 前暂停本站派发、排空软件操作及传输，停止 Agent，然后创建快照：

```bash
systemctl --user stop kq-agent
KQ_MAINTENANCE_WINDOW=1 bash -l bootstrap.sh "$PWD/site.env" maintain backup
```

JSON 输出中的 `snapshot` 是私密备份目录。保存一致的 SQLite backup、原发行摘要/stateFormat、原 Agent 配置、注册身份文件和持久传输 checkpoint。备份包含私钥，不回传、不放入公开证据。使用 SQLite backup API，避免裸复制运行中的 WAL 文件。备份引用的原发行受 GC 保护；证书仍需正常轮换。

## 跨格式恢复

普通 `rollback` 继续拒绝不兼容 stateFormat。若新版本只完成 schema 初始化、尚未产生任何新执行或传输状态，可按快照恢复：

```bash
systemctl --user stop kq-agent
KQ_MAINTENANCE_WINDOW=1 bash -l bootstrap.sh "$PWD/site.env" maintain restore \
  --snapshot "$KQ_LOCAL/backups/这里替换为实际快照目录名"
systemctl --user start kq-agent
```

恢复核对备份摘要、原发行文件、当前 Agent 身份、待交付结果与执行记录、传输 checkpoint及nonce防重放记录。迁移后新增空表可以恢复；新增/改变的作业、nonce或传输记录会拒绝，以免退回旧数据库时抹去新状态。注册身份或证书自备份后发生轮转也会拒绝自动恢复，保留当前证书，须先对账身份再选择恢复方案。此时应修复新版本或由有权限的操作者做逐条数据迁移，不能强制切旧二进制。

执行前还会保留迁移后数据库。先写 `restore-intent.json`，再恢复数据库并切换原发行。若中途断电或进程被强杀，launcher 会拒绝启动，避免用错误二进制打开数据库。保留该 intent 与 `before-restore-*.db`，核对快照和当前指针后重试同一个恢复；不要删除标记来强行启动。此恢复不回退反降级高水位，不自动回退平台 PostgreSQL，也不回退其他站点的状态。

能力与故障验收仍须通过真实站点执行；本说明不把实现和测试用例当成现场通过。
