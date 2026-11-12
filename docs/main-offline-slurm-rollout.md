# main 离线 Slurm 接入部署

`main` 推送会构建四个生产镜像，全部成功后由 `deploy/main/remote.sh`
核对镜像的架构、source 和精确 revision，再经 SSH 调用站点的
`/opt/deploy/run.sh deploy --expected-revision <main SHA>`。
站点工具和私有配置不由该工作流覆盖。

保留已有 Agent 的站点应在私有 `/opt/deploy/settings.json` 设置
`"deployment_mode": "platform-only"`。只接受 `full` 和 `platform-only`；
省略时为 `full`，沿用平台加已有 Agent 更新及部署后验收流程。
设置前须备份工具与配置，并验证站点工具已实现此契约；此设置不属于仓库 Compose 环境变量。

`platform-only` 保留节点和 worker 预检、部署锁、精确镜像版本校验、Agent
bundle 校验、数据库备份、迁移、平台启动和健康检查；不向已有 Agent
stage、安装或重启，不提交跨调度器验收任务。发布记录保存已有 Agent 的
`MainPID`、`ExecStart`、`NRestarts`、`ActiveState` 部署前状态，完成前必须逐项一致。
同 revision 重试只核对完成状态和 Agent 状态；显式 `acceptance` 也拒绝执行。
数据库迁移失败后的阻断及人工恢复要求保持不变，不保证自动回滚数据库。

平台模式从已完成发布的 Compose 中保留 Server/Registry 的站点数据挂载，
以及 `SITE_RELEASES_*`、`SPACK_*`、`REGISTRY_*`、`OFFLINE_DELIVERY_*`
配置，覆盖旧 `site-base.json` 和交付模板中的同名值。这样可保留 signed release
只读目录、材料票据密钥、Registry/OCI 鉴权和材料存储配置；私密值不得写入报告。
部署前需离线解析候选 Compose，确认这些配置与现有运行配置一致。

镜像中的 Agent bundle 与独立 signed site release 是两条发布路径。
合并 main 不会自动重新签名或切换站点 channel。需要证明 Agent 来自 main 时，
应以精确 main SHA 的干净源码重新 prepare、核对 provenance 与全部产物摘要，
使用现有信任链签名并发布递增 sequence；不要复用旧序号或把旧 dirty snapshot
标注为 main。新站点接入验证使用独立 Agent 身份与目录，不激活已有四个 Agent。
