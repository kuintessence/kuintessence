# 介质与运输记录

这是本站运维登记功能，关联已登记的来源导出或接收包。运维人员填写的“已寄出”“已收到”是交接声明，不是另一机构的签名确认，也不证明密文已经完整复制。实际导入仍以 [加密包校验](media-package.md)、[导入签名回执](media-receipts.md)和[来源使用许可](dataset-use.md)为准。

## 权限与数据范围

新增独立 `media.logistics` 权限。平台角色、`asset.map`、`media.export`、`media.import` 不自动获得此权限；服务账号和自动化会话不能登记运输事实。权限管理页已提供中英文说明。每次操作在事务内重新核对当前人员、组织成员关系及权限。

所有数据按本站和当前组织隔离。包必须已存在于本组织的导出清单或接收登记中，且同一批次的全部包具有相同发送站和接收站；不允许通过一个批次转交第三方。保存包 ID、不可变清单 SHA-256 和协议修订引用，不复制密钥、明文清单、个人身份或原始签名到物流记录。文件级 SHA-256、许可证和 provenance 保留在原签名包清单中。

运输记录是独立历史。包或使用授权撤销后，仍可记录已发生的到达、退回或丢失事实；这些记录不能重新授权导出、密钥领取、导入、数据使用、作业执行或副本删除。不得把登记接口作为实际导出授权接口。

## 介质与批次

介质包含随机 deviceId、名称、组织内唯一资产标签、字节容量、状态、版本和记录人。容量是登记值，不代表实测剩余空间或本批次密文已经适配；实际导出/导入继续进行自己的空间校验。资产标签、容量和 ID 固定，名称、停用及销毁状态通过版本检查更新并审计；需要替换物理介质时登记新 ID。已销毁不可恢复，所有历史保留，不提供物理删除接口。

批次登记固定 shipmentId、名称、介质 ID 集合和包集合，数组顺序不影响重试。相同 ID 与相同正文返回原记录，不同正文冲突。每批次最多 100 个介质、100 个包。介质行按 ID 顺序加锁，数据库部分唯一索引保证每个介质最多参与一个未结束批次；非可用或正在运输的介质不可再分配。改变正在运输的介质元数据或将其销毁会被拒绝。

交接以随机 eventId、原版本、状态、实际发生时间、说明及可选佐证 SHA-256 追加保存；同时保留本站记录时间和人员。佐证摘要由登记人声明，接口不接收或验证佐证文件。时间不能晚于服务器当前时间，历史补录不伪造本站记录时间。两个操作并发修改同一版本只允许一个推进；同一 eventId 的原文重试不新增记录，也不会再次释放或停用后来复用的介质。

| 当前状态 | 可登记下一状态 |
| --- | --- |
| prepared | dispatched、cancelled；本站为接收方时还可直接 received |
| dispatched | received、lost、damaged |
| received | returning、closed |
| returning | returned、lost、damaged |
| returned / closed / cancelled / lost / damaged | 已结束，保留原文重试，不再推进 |

`closed` 表示本次交付的介质管理结束，可保留介质；不声明已经归还、擦除或销毁。终态释放本批次介质占用，lost/damaged 同时停用全部关联介质，找到或修复后需授权人员明确恢复，留下原因和审计。returned 仅说明介质退回，destroyed 仅为物理销毁登记，均不删除目标站数据副本或导入回执。实际擦除、销毁及物流动作由授权运维执行；软件不会调用外部承运服务或擦盘命令。

状态、占用、交接事件和审计在同一事务中写入；任何一项失败全部回滚。交接与元数据修改均使用当前版本，不按时钟或超时抢占其他运输任务。

## HTTP 接口

均位于现有认证 API，下列响应设置 `Cache-Control: no-store`。注册及交接需要客户端固定 UUID，网络响应不确定时重试同一请求。更新元数据出现版本冲突时重新读取，不覆盖其他人的修改。

| 方法与路径 | 内容 |
| --- | --- |
| `POST /api/federation/media/devices` | `{deviceId,name,assetTag,capacityBytes}` |
| `GET /api/federation/media/devices?limit=50&offset=0` | 当前组织介质和活动批次；返回 data / hasMore |
| `PATCH /api/federation/media/devices/:id` | `{expectedVersion,name,state,reason}`，state 为 active / retired / destroyed |
| `POST /api/federation/media/shipments` | `{shipmentId,name,deviceIds,packageIds}` |
| `GET /api/federation/media/shipments?limit=50&offset=0` | 当前组织批次；返回 data / hasMore |
| `GET /api/federation/media/shipments/:id?limit=50&offset=0` | 批次、介质及按版本倒序分页的交接历史 |
| `POST /api/federation/media/shipments/:id/handoffs` | `{eventId,expectedVersion,state,occurredAt,note,evidenceDigest}` |

部署须先运行由 Drizzle 生成的迁移 0166，再使用新 Server。无需 Fabric、链码或 Agent 升级；直接模式不创建链待办。旧 Server 不认识新增权限。回滚前先停止物流写入，备份授权名册并通过新版本权限管理撤销 media.logistics，再切换旧 Server；保留新表和历史，不能降级删表。恢复新版本后由管理员按原授权记录重新授予权限。

## 验证与剩余工作

两个隔离 PostgreSQL 从空库迁移，22 项测试通过，覆盖接收方真实签名包关联、并发排他与重放、组织/当前权限隔离、返还与销毁分离、历史分页、审计失败回滚，以及不修改原导入许可和数据位置。来源方另复用真实 age 的签名清单准备验证多包/多介质登记；测试注入已绑定的人员身份，未覆盖正式登录；这不代表实际运输或跨主机交接已经验收。

Web 运输操作页、CLI、跨站交接签名交换与副本删除生命周期尚未接通。现有权限管理中的新权限不是完整物流界面。完整蓝图和 PR 预览目标保持不变，W07/W08/O05 不据此标记整体完成。

最终全仓 lint/typecheck、352 个本地文档目标与 diff 检查通过。测试日志保存在本机 temp/media-logistics-pg.log 与 temp/media-logistics-source-pg.log，不纳入版本控制；临时数据库均已关闭并删除。
