# Workflow 输出发布恢复

科学作业的真实 `completed` 与输出文件发布是两个阶段。普通 Workflow 提交 job 时，在同一数据库事务内写入 `workflow_output_publication_intents`，保存原始 run 绑定；同步 Workflow 的 run 为空。该内部选项不接受客户端请求字段，也不用于 restrictedNoEgress 或 Sandbox 作业。

完成后，Server 从持久 job 行读取原始输出声明、路径元数据、采集结果、工作目录及 owner/agent，写入 `workflow_output_publications`，绑定逐文件 transferId，再开始上传。即使 Server 在 completed 与输出事实提交后、publication 入库前崩溃，也能从 intent 重建发布。enqueue 成功后才删除 intent；中间崩溃重复 enqueue 会保留首次入库的 transferId。此机制不涉及用户手动 NetDrive transfer，也不重新提交 `sbatch` 或执行 DAG。

Server 启动时及每 30 秒先扫描最多 25 条到期且 job 已完成的 intent。坏路径、缺失元数据或临时故障按每条记录独立退避，间隔从 30 秒翻倍至最多 300 秒，不阻挡本批后续记录。intent 恢复只创建发布记录，不上传或释放目录；上传及授权仍经过现有 publisher。

每个文件先创建持久 `file_transfers` 行，再进入现有 `TransferRunner`，因此 multipart session 的 uploadId 与完成请求有实际持久落点。上传失败后保留同一 transferId；下一次重试通过 session store 复用原 uploadId/完成请求。已成功的 transfer 行及 publication 文件映射直接复用，不随机另起传输。启动上传前，queued/failed 行经绑定校验和 CAS 转为 running；取消与最终提交沿现有终态保护串行，提交已开始时取消返回 409，不能把已提交对象伪装成取消成功。Server 启动先完成旧传输清扫，再启动恢复与监听，避免新传输被重启扫尾误标失败。

Server 启动时及每 30 秒扫描待发布记录，同时最多处理 4 个恢复任务。任务有 15 分钟租约，每 30 秒续租，租约是否过期按数据库时钟判断；失租后停止等待并禁止续租复活、保存结果或释放目录；释放 outbox 的创建在同一数据库事务内锁定 publication 再核验 token、租约与所有输出已发布，防止旧 worker 释放目录。单次文件等待有 6 小时上限。超时只终止当前等待，不删除 multipart 恢复凭据；底层传输仍遵循现有 TransferRunner 超时机制。结果提交回调只有在当前等待有效时才更新 transfer 行。恢复时继续使用真实已完成计算的输出，不向调度器提交新计算。

只有所有声明输出都持久发布成功，才发送原有工作目录释放 outbox。上传失败、后端不可用、路径元数据错误或无权访问时均保留工作目录。发布后释放指令失败只重试释放，不重传已发布文件。恢复诊断使用固定文本，不持久保存 transport 错误中的签名 URL 或票据。

发布前及每个文件间均重新检查：job 仍为真实 completed、owner/agent 绑定有效、用户未停用、组织成员身份仍有效、run 未处于 cancelling/cancelled，并沿现有 job view 授权入口校验。DAG 因 Server 重启变为 failed/WORKFLOW_INTERRUPTED 后，已完成 job 的结果仍可独立补传；这不修改或恢复 DAG 状态。显式取消、撤权后不自动绕过授权继续上传。

声明路径必须规范化后严格位于 job 工作目录内。单文件路径元数据必须精确匹配声明；batch 路径必须匹配声明 glob。损坏 JSON、非字符串路径、重复 descriptor 或发布目标碰撞直接拒绝，不清理目录。新 pathsOnly 文件声明必须有 Agent 路径验证元数据；旧非 pathsOnly 文本输出仅兼容其精确声明的目录内路径，自动采集的 stdout 日志不能替代文件路径证明。空 batch 声明保留为空数组。

`GET /jobs/:id/output-publication` 沿现有 job view 授权返回脱敏状态、文件计数、已发布文件映射和 transferId，不启动恢复，也不返回 source、owner、内部路径或票据。publication 尚未建立时可能暂时返回 404，后台仍可能通过 intent 重建。

## 现场核对步骤

先部署 0075/0076/0077 migration 与新版 Server，再升级 Agent。通过已经登录的平台控制端发起带文件输出的 Workflow，保留 run ID、实际 job ID 和 Slurm ID。原生 modules smoke 只返回文本时，不产生文件上传；无文件的 publication 仍可用于安全释放工作目录。

1. 在计算完成、文件仍在上传时，通过当前认证 API 会话读取 `GET /platform/api/jobs/<jobId>/output-publication`。预期 `state=pending`、`publishedFiles <= totalFiles`；保存 transferIds，勿将签名下载 URL 作为诊断证据。
2. 中断 SSH 后恢复同一隧道，或在受控验收环境重启 Server。让 Agent 重新上线；每 30 秒的后台扫描会重试已入库 publication，无需再次提交 Workflow。
3. 再查同一接口，确认 transferIds 不变，已发布的文件映射保持相同 file ID，最终 `state=published` 且计数相等。到云盘读取对应 file ID，核对大小、SHA-256 和真实内容，并确认原工作目录随后才被释放。
4. 对照 `squeue/sacct` 与现场日志，确认恢复期间没有新增该计算的 `sbatch`。DAG 可能仍显示 failed；文件发布成功不改变 DAG 终态。
5. 若接口返回 404，不能认定上传成功，也不能盲目重提计算。先确认 job ID/授权、数据库迁移和 intent/publication 记录；新作业在 enqueue 前崩溃可等待后台重建，元数据不完整时保留共享工作目录并由运维对账。

`state=published` 表示文件均已提交；目录清理可能仍在重试。撤权、取消或源文件丢失时，恢复必须停止或保留待处理状态，不能以重算绕过。单独的用户 NetDrive transfer 仍使用其 `/files/transfers/<id>/resume` 恢复入口。

## 当前边界

- 本次只生成 migration `0075_workflow_output_publications.sql`、待处理记录局部索引 `0076_workflow_output_publication_pending_index.sql` 及 `0077_workflow_output_publication_intents.sql`，没有执行数据库迁移；部署前需要走现有迁移流程。
- 新版普通 Workflow 的恢复保证从 job 与 intent 原子提交开始。升级前没有 intent 的旧作业不能自动获得此保证；没有 publication 时需保留目录并人工对账，不能推断或补造原 run 绑定。
- Workflow DAG 重启续跑不在此机制内。DAG 可能因输出上传异常或 Server 重启而失败；publication 后台仍可补传并供查询，但不会自动推进后续节点。
- Agent 尚未成功采集并上报的输出，不由 Server publication outbox 证明完成。它仍依赖 Agent 的调度器恢复和输出采集路径。
- Sandbox artifact service 的独立持久化路径不经过此普通 Workflow 文件输出 outbox；两者共用先持久传输行、再上传、最后持久完成回执的 helper。Sandbox 按 artifact/replica 固定传输 ID，另校验实际文件大小和摘要。
- 已被外部管理员删除的工作目录、被外部删除的对象或撤销的权限不能通过重新计算自动补救。

本地统一验证已通过磁盘 fake store、纯 publisher/input/intent 测试，覆盖重建 publisher 后恢复、部分成功复用、续租与失租、无回调超时、取消/撤权、路径边界、脱敏查询，以及 intent 重启、重复 enqueue、坏记录退避、同步 Workflow 和批量上限。真实 PG 原子提交/回滚与 completed 后恢复用例已编写，尚未执行。没有执行真实 Slurm、对象存储上传、PG 验收或数据库迁移。
