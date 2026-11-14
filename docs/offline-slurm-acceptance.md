# 离线 Slurm 站点初始化与运行

站点先准备平台发行和材料，再初始化普通用户 Agent，最后开放队列与执行账号。地址和凭据填写在私密 site.env，不进入代码或公开文档。

## 平台准备

1. 根据实际登录与计算节点的 OS、架构、编译器和 MPI 建立目标 profile；异构分区分别登记。
2. 按[发行准备](site-release-preparation.md)生成并签名 CLI/Agent。Spack 发行还需可信 SIF、可执行入口和完整 recipe、source、lock 绑定。
3. 按[站点部署](offline-slurm-site.md)配置 TLS、反向代理、对象 origin、SSH 隧道或 CONNECT 代理。数据库迁移和 Server 发布沿用既有部署流程。
4. 为 Agent 创建并启用实际分区队列，设置允许组织 visibleOrgIds、account 和 QoS。注册与 queue inventory 不自动授予作业提交权限。

## 普通用户接入

只需搬运 bootstrap.sh 和站点配置示例。site.env 记录域名、端口、共享盘、用户独占持久本地盘、信任公钥和 Slurm 参数。先运行 check 进行只读预检，再执行 install 与 services；install 包含 doctor。初次保持 KQ_ENABLE_SPACK=0。

提交前等待 Agent、控制通道与 queue inventory 就绪，并确认 `/platform/api/agents/:agentId` 返回 `computeHealthStatus=ready`、观测时间距当前不足 60 秒、`computeHealthOperationalNodeCount>0`。未就绪时查询原状态，避免重复提交。

启用 Spack 前准备匹配的 runtime/profile、目标原生依赖锁和完整材料，在维护窗口设置 KQ_ENABLE_SPACK=1 并更新配置。source audit、隔离安装、独立校验和 managed load 分别执行；缺少隔离条件或目标依赖时停止安装。

## 日常恢复

| 情况 | 处理方式 |
|---|---|
| SSH 或 Agent 断开 | 恢复原连接与调度编号；提交结果未知时对账，不再次 sbatch |
| 输出采集失败 | 保留计算终态快照，存储恢复后归集原输出 |
| 材料或输入下载中断 | 按原摘要与偏移续传，票据续期后校验整件文件 |
| 输出上传中断 | 恢复原 transferId、uploadId 和文件编号；全部发布后释放工作目录 |
| 取消或撤权 | 等待原生调度器正向停止确认，恢复过程继续遵守授权 |
| 发行损坏或不兼容 | 保留当前版本，核对签名与状态格式后再切换 |

当前 stateFormat 为 `slurm-site-v5`，v4/v5 不支持原地激活或普通回滚。科学任务的中断续算依赖应用 checkpoint；Spack 重试仅复用验证完整的依赖，不恢复任意编译指令。详见[安装恢复](spack-install-recovery.md)、[分片恢复](offline-slurm-multipart-recovery.md)和[输出恢复](workflow-output-recovery.md)。

运行记录保存平台与 Agent revision、发行和材料摘要、KQ/Slurm Job ID、文件摘要及脱敏错误码。site.env、token、证书私钥和内部主机清单保存在独立受控目录。
