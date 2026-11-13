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
| `GET /api/federation/media/logistics-context` | 当前组织与本站 ID；返回 data |
| `GET /api/federation/media/transport-packages?limit=50&offset=0` | 当前组织已有导出/接收包摘要、两端站点名称、类型与撤销状态；返回 localSiteId / localOrgId / data / hasMore |
| `POST /api/federation/media/devices` | `{deviceId,name,assetTag,capacityBytes}` |
| `GET /api/federation/media/devices?limit=50&offset=0` | 当前组织介质和活动批次；返回 data / hasMore |
| `PATCH /api/federation/media/devices/:id` | `{expectedVersion,name,state,reason}`，state 为 active / retired / destroyed |
| `POST /api/federation/media/shipments` | `{shipmentId,name,deviceIds,packageIds}` |
| `GET /api/federation/media/shipments?limit=50&offset=0` | 当前组织批次；返回 data / hasMore |
| `GET /api/federation/media/shipments/:id?limit=50&offset=0` | 批次、介质及按版本倒序分页的交接历史 |
| `POST /api/federation/media/shipments/:id/handoffs` | `{eventId,expectedVersion,state,occurredAt,note,evidenceDigest}` |

部署须先运行由 Drizzle 生成的迁移 0166，再使用新 Server。无需 Fabric、链码或 Agent 升级；直接模式不创建链待办。旧 Server 不认识新增权限。回滚前先停止物流写入，备份授权名册并通过新版本权限管理撤销 media.logistics，再切换旧 Server；保留新表和历史，不能降级删表。恢复新版本后由管理员按原授权记录重新授予权限。

## Web 操作

“机构合作 → 介质运输”按当前登录机构展示“运输批次”和“介质”。需要管理员明确授予当前人员 `media.logistics`；没有权限时不读取清单。切换机构或登录会话会清空未提交表单；请求同时绑定机构与登录版本。

1. 在介质清单登记名称、资产编号和容量（GiB）。空闲且未销毁的介质可以修改名称或状态，并填写原因。
2. 新建批次时勾选已有介质和数据包。支持分页并保留跨页选择；已占用/停用介质不可选择，同一批次只能选择相同收发双方的数据包。已撤销包仍可用于补录保管事实，页面明确显示撤销状态。
3. 批次详情展示两端机构、介质、包摘要及交接时间线。交接只列出当前允许的后续状态；来源方不能从待发运直接跳到已收到。填写发生时间、说明及可选凭证摘要，留空时间按提交时刻记录。
4. 提交结果不确定时，表单保留原 UUID、时间及正文，重试发送原请求。可根据显示的记录 ID 查询；介质版本冲突需返回刷新后重新修改。请求在当前页面保留，离开页面或关闭浏览器不保证恢复未确认表单。

页面验证响应格式、机构、站点和记录身份，错误响应不会被当作保存成功。后台更新不因切回标签页清空正常内容；读取失败时隐藏旧清单。手工刷新可获得最新状态。

## CLI

先通过 `kq login` 登录，用 `federation organizations` 查看机构，必要时通过 `federation use` 显式切换。下列命令的 `--org` 只核对当前会话，不替用户切换机构。写操作从本地 JSON 文件读取原请求，不自动生成或更新 ID。

```bash
kq federation --org <orgId> media devices list --limit 20 --offset 0
kq federation --org <orgId> media devices register device.json
kq federation --org <orgId> media devices update <deviceId> device-update.json
kq federation --org <orgId> media packages --limit 20 --offset 0
kq federation --org <orgId> media shipments register shipment.json
kq federation --org <orgId> media shipments list
kq federation --org <orgId> media shipments show <shipmentId> --limit 20 --offset 0
kq federation --org <orgId> media shipments handoff <shipmentId> handoff.json
```

文件字段与上述 HTTP 表一致。`device.json` 的 capacityBytes 使用整数**字节**；`shipment.json` 引用查询所得原 deviceIds/packageIds；`handoff.json` 包含固定 eventId、最新 expectedVersion、ISO UTC occurredAt 和可空 evidenceDigest。首次创建 UUID 后保存原文件，重试不要替换 ID 或正文。介质更新是版本条件写入，不保证重复 PATCH 返回成功：原更新已经成功时，后续重试可能返回版本冲突，应查询确认。

根命令支持 `--lang zh|en` 和 `--json`。JSON 清单保留 hasMore；普通输出提示下一页，介质容量使用字节。CLI 核对本站/组织和写入确认；网络或确认内容异常会报告结果未确认，不自动重试。输入上限 600000 字节，响应中的密文私钥和原签名不会通过物流摘要接口提供。

## 验证与剩余工作

2026-11-09：两个临时 PostgreSQL 从空库迁移。接收侧 22 项通过，覆盖包登记、当前权限和组织隔离、并发排他、版本重放、返还/销毁分离、历史分页、审计回滚、摘要字段及实际响应 schema。来源侧真实 age 导出多包/多介质专项 1 项通过，验证导出摘要分页查询，不重跑未变化的 65 项出口用例。

CLI HTTP 40 项通过（含新增物流的分页、机构固定、PATCH、原事件重试和不一致响应）。Web/API 客户端 32 项通过，覆盖原请求重试、非法响应、机构权限、切换登录、分页保留选择及阻止误提交。浏览器使用真实 React 组件和受控 HTTP 响应，完成勾选→创建→查看交接；7 张桌面/手机、中英文/深色截图无页面异常或横向溢出。截图和日志保存在本机 temp/media-logistics-ui 与 temp/media-logistics-*.log，不纳入版本控制。

这轮页面和 CLI 已接通本站物流记录；跨站签名交接、完整导出/导入操作界面、任务私有包及副本删除生命周期仍待交付。测试注入绑定人员身份，不等于正式登录或 PR 预览验收，也不等于实际物理运输或跨主机交接。完整蓝图和 PR 预览目标保持不变，W07/W08/O05 不据此标记整体完成。

全仓 lint 通过（保留既有警告）；类型检查中新增测试代码的问题已修正，Web/Server 重查通过，其余包及 Fabric 实验脚本通过。178 个本地文档目标和差异格式检查通过；临时数据库与本轮浏览器测试服务已清理。
