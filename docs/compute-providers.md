# 算力提供者资料

平台管理 → 算力提供者（`/providers`）提供查询、分页、详情、新增、修改和删除；算力提供方 → 提供方资料（`/cp/profile`）提供当前授权组织的查询和资料修改。

提供者沿用现有组织（`orgs`）作为身份与资源归属单位，不另建一套提供者 ID；平台目录列出现有组织，新建提供者即创建组织。名称是组织统一名称，修改后组织选择器、算网一览使用新名称。资料包含简介、联系人、邮箱、电话、地址、网站；旧组织缺失字段留空，不猜测联系方式。

目录中的算力中心、Agent 和成员数量分别按所属组织统计，空组织显示 0；中心数与同一组织的算网一览一致，不混入其他组织的资源。

平台管理员可新增、修改和删除；普通平台运营者只读。提供方 owner/admin 可修改本组织资料，operator 只读，多组织用户须选定组织后再修改。新增组织后，平台管理员通过现有组织成员管理将用户加入组织并授予组织管理员角色。平台级、组织级角色和 SpiceDB 权限共同生效，资料编辑不能改角色、成员或资源归属。在线撤销权限或切换组织会关闭旧编辑器并清除未保存草稿。

仅允许删除没有关联数据的空组织。删除前锁定组织并检查所有数据库外键引用，包括原本会级联删除或置空的成员、资源和历史业务数据；存在关联则返回 409，不删除成员、集群、任务和历史记录。新增、修改、删除均记入平台审计。

## API

需要登录，前缀 `/api/compute-providers`；提供方使用 `X-KQ-Active-Organization`。

| 方法 | 路径 | 用途 |
| --- | --- | --- |
| GET | `/:view/list?search=&page=1` | 名称搜索，20 条/页，返回资料、中心/Agent/成员数、总数和 canManage |
| POST | `/operator/organizations` | 平台新增 |
| PUT | `/:view/organizations/:id` | 修改授权范围内的组织资料 |
| DELETE | `/operator/organizations/:id` | 平台删除空组织 |

`view` 为 `operator` 或 `provider`。写入结构 `{ name, profile: { description, contactName, email, phone, address, website } }`，严格拒绝额外字段、非法邮箱及非 HTTP(S) 网站地址。

迁移 `0072_odd_thunderbolt` 为 orgs 增加 profile 和 updated_at，旧行 profile 默认为空对象；原有组织 ID、成员与资源关系保持不变。通过标准 `bun run db:migrate` 执行。

“算网一览”英文为 “Compute & Network Overview”，现有 `/interconnect` 和 `/cp/interconnect` 地址保持兼容。
