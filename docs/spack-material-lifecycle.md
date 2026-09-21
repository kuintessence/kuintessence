# Spack 材料下架与恢复

第四批提供 Registry 的 release 状态 API。它只控制后续材料准入，
**不删除 recipe Git、源码、manifest 或历史引用，不卸载已安装软件**。
下架与[配置绑定退役](spack-binding-retirement.md) 是不同操作：
下架针对整个 `(repositoryId, manifestDigest)`，退役针对其中一个精确 spec 绑定。
恢复材料不会恢复任何已退役绑定。

## 升级前置条件

应用生成的数据库 migration，备份范围包含 `spack_material_lifecycle_events`。
该表按 release 追加状态事件；没有事件的 release 为 `available`、revision `0`。
表不存在、查询失败或 rollout 不匹配都不能视为空状态。
最新状态跨 epoch 保留，重启、重建服务和重新导入不会清除下架记录。

管理 API 要求[Rollout](spack-material-rollout.md) 已显式进入 `ready`，
Server 与 Registry 配置同一个 `SPACK_MATERIAL_EPOCH`。
没有 journal 的 observe 兼容模式只能使用既有读取/发布能力，不允许管理状态。
升级第四批前仍须执行 pause、外部排空、撤销旧访问、reconcile 和 activate：
**已支持 epoch 或绑定退役、但不检查 release 状态的旧版本同样必须被隔离**。
只更换它们的 epoch 不构成安全升级。

门禁检查的是新请求准入，不追溯取消已经准入的下载流、已缓存材料或已完成安装。
撤回已有安装的使用权、清除 Agent cache、撤销许可证和终止在途作业不在本 API 范围。

## 权限与接口

接口位于 Registry，使用现有认证；Agent 不使用这些管理接口，仍只从 Server 拉取内容。

```text
GET  /api/spack/material-repositories/:id/releases/:digest/lifecycle
POST /api/spack/material-repositories/:id/releases/:digest/lifecycle
```

`:id` 是 namespace 仓库名称的 SHA-256，`:digest` 是完整 `sha256:...` manifest digest。
GET 供维护者检查状态、revision 和最近 100 条审计记录，按 revision 降序返回；
GET/POST 的成功响应同时包含不可变 `repository` 仓库名称和
`binding: {repositoryId, manifestDigest}`。这些字段只有 canonical 授权成功后才返回，
失败响应不附带发布身份或历史；既有状态字段保持原语义。
`historyTruncated` 表示还有更早记录。完整历史留在数据库中，不自动过期。
普通材料目录隐藏下架项；维护者可使用下述管理目录发现下架发布项，
也可保留发布时的 binding，通过 Web 生命周期入口精确查询。

GET 和 POST 先有界读取不可变 manifest 和指定 commit 的 recipe metadata，
不扫描 recipe 历史、不运行 Git。最多同时处理两项管理请求，每个 snapshot 最多 2 MiB、
manifest 最多引用 32 项，并使用 10 秒协作式 deadline；未完成的磁盘 I/O 保留其名额，
但不会持有数据库全局锁。请求取消后不继续进入管理事务。
随后在 PostgreSQL 事务内重新读取并锁定当前用户及已有组织成员关系，
执行 namespace 的 **read 和 write** 权限检查，并验证引用 recipe 的读取上限、
commit、roots 和静态诊断。锁内没有文件 I/O；不能在服务运行时外部改写这些不可变 metadata。
不信任请求 body 中的角色、组织或 operator ID。
`platform_admin` 的组织写权限不赋予任意组织的读取权；
供给方沿用现有组织发布者身份与 `REGISTRY_PUBLISHER_ROLES`，不新增越权通道。
用户已停用、组织成员关系撤销或 recipe 不再可读时，不能读取管理历史或改变状态。

POST 只接受以下三个字段，无 query 参数：

```json
{
  "action": "withdraw",
  "expectedRevision": 0,
  "reason": "该发布已停止提供，相关配置绑定已完成退役"
}
```

恢复使用 `"action": "restore"`，`expectedRevision` 取最新 GET 返回值。
原因必须为 1–1000 字符，不含首尾空白、换行或 ASCII 控制字符。
原因和操作者会永久进入审计，不得写入凭据、内部地址或受限材料内容。

revision 是 **release revision**，不是 rollout revision。每次成功操作追加一个 revision；
相同状态、过期 revision 或重复提交返回冲突，不默认为幂等成功。
响应丢失时先 GET 核对最新状态和历史，再决定是否继续，不盲目重试。
响应均为 `Cache-Control: private, no-store`。

## 引用与并发

### 维护者目录

```text
GET /api/spack/material-repositories/management?repository=public/materials&state=all&limit=10
```

`repository` 必填，且只能指定一个完整 namespace 仓库名称。
`state` 可为 `all`（默认）、`available` 或 `withdrawn`；
`limit` 是每页扫描候选数，默认 10，范围 1–20。响应为
`{releases, nextCursor}`；每项在普通目录摘要上增加 `state` 和 `revision`，
不返回审计原因、操作者、recipe 路径或下载内容。

查询先检查 canonical namespace **read 和 write**，然后有界读取候选 manifest
和精确 commit 的 recipe snapshot，最后在数据库事务内再次检查用户、组织和
recipe 权限并读取状态。即使仓库为空，也要求 ready epoch 和当前管理权限。
无权访问或缺失 recipe 的候选不会出现在结果中；损坏的材料不作为成功的部分目录返回。
管理目录不调用普通 manifest 下载，也不解除下架或放宽任何 namespace/recipe 权限。

存在后续候选时，将 `nextCursor` 原样作为下一请求的 `after`，同时保持其他筛选条件。
游标经过认证加密，绑定用户、仓库、状态与页大小，15 分钟后过期；
不能从中读取被过滤候选的 digest，也不能用它绕过重新授权。
Registry 使用 `REGISTRY_JWT_SECRET` 派生独立用途的游标密钥，
管理目录要求该值至少 32 字符。副本使用相同密钥即可继续翻页；
密钥轮换或游标过期后应重新查询第一页，不更换密钥以修复某个游标。

每页按 manifest digest 排序。**空结果页仍可能有下一页**，因为状态或权限过滤
发生在候选分页之后；不返回隐藏项总数。每页重新读取状态，不保证跨页快照一致性，
新发布和下架/恢复期间需要刷新第一页以查看完整的当前结果。

每次最多枚举 10,000 个目录项（含临时文件），读取 32 MiB manifest metadata，
保留 32 个独立 recipe snapshot（每项最多 2 MiB）；最多并发两次扫描，
使用 10 秒协作式 deadline。扫描超限时返回 `MATERIAL_CATALOG_LIMIT`，
可减少页大小；原始目录项超限则需拆分材料仓库，而非无限翻页规避预算。
等待中的 I/O 未结束前不释放名额；recipe 和文件读取不占用数据库授权事务锁。

下架在与 Server 安装准入相同的事务锁内执行，且锁住任务状态写入，
以下任一条件都会拒绝下架：

- 存在未退役的配置绑定，包括其他 spec 对同一 release 的绑定。
- 该 release 存在非终态任务引用。
- 该 release 存在任务记录已缺失的孤儿引用。

只有 `succeeded`、`failed`、`rejected` 的任务属于终态。
已退役绑定和终态任务引用仍完整保留，但不单独阻止下架；
`listReleaseReferences().bindingCount` 是历史总数，不能用作下架前的授权判断。
不得清表、伪造终态或删除引用来绕过冲突。先调查占用，
必要时按离线流程完成绑定退役和重新启用 rollout。

下架与配置登记/任务引用获取相互串行化：下架先成功则后续准入失败；
引用先成功则下架失败。旧票据的后续下载仍会重新检查引用及材料状态。
Registry 的目录、直接 manifest/blob 下载和重新发布同一内容均检查状态；
重新导入可复用不可变字节，但会报告下架而不是把该 release 恢复。
恢复只改变准入状态，不证明材料完整、recipe 可信或安装可用；
既有 digest、recipe 和下载完整性校验继续执行。

## 错误与边界

| HTTP | Code | 处理 |
|---|---|---|
| 403 | `MATERIAL_LIFECYCLE_FORBIDDEN` | 当前用户、namespace 或 recipe 权限不允许管理 |
| 409 | `MATERIAL_LIFECYCLE_CONFLICT` | 重新 GET，核对 revision 与目标状态 |
| 409 | `MATERIAL_RELEASE_REFERENCED` | 调查绑定/活动任务/孤儿引用，不强制删除 |
| 422 | `VALIDATION_ERROR` | 修正请求字段、格式或大小 |
| 503 | `MATERIAL_LIFECYCLE_UNAVAILABLE` | 检查 migration、数据库、ready epoch、metadata、并发预算与超时；不能按可用处理 |

直接下载下架材料返回普通 404，不向无权限调用者公开管理历史或占用细节。
Server 继续使用原有通用引用错误，对 Agent 不暴露数据库异常或查询参数。

回归包含真实 PostgreSQL 的事务、CAS、权限快照、缺表和审计回滚，以及 Registry HTTP
目录/下载/恢复/重导入一致性。所有验证只在 GitHub Actions 执行；
结果须对应当前提交，不沿用旧版本的绿色 CI。
本批没有自定义可见范围、物理回收、受限安装包授权，
也不替代 15 个科学工作流的材料准备、安装和运行验收。

## 平台与 CP 门户

软件中心的 Spack 页和 CP 软件页共用材料面板中的 **发布项生命周期**。
此入口查询管理 API，不依赖普通 manifest 下载，因此下架后仍可按精确 binding 恢复。
从材料目录或导入结果查阅发布项时会预填 binding，但不会自动发起管理请求。
已下架项不出现在普通目录中。可在维护者目录输入完整仓库名称并筛选状态，
选中发布项后进入生命周期查询；此选择不会触发普通 manifest 下载。
也可直接填写保留的仓库 ID 和完整清单摘要。

1. 填写仓库 ID 与 `sha256:...` 清单摘要，点击“查询材料状态”。
2. 核对返回的仓库、状态、release revision 与审计历史；历史每页 10 条，
   最多查看最近 100 条，更早事件不从数据库删除。
3. 输入审计原因并确认下架或恢复。原因修改后必须重新确认，
   操作始终使用刚读取的 revision，不自动更新 revision 重试。
4. 成功响应经身份、revision、目标状态和原因校验后才显示变更已确认，
   同时使普通目录、维护者目录和旧 manifest 展示失效。恢复不解除绑定退役。

前端还会校验仓库名称的 SHA-256 与 repository ID 一致，以及响应 binding
与请求一致。校验需要浏览器的安全上下文 Web Crypto；生产应通过 HTTPS 使用门户。
旧后端若不返回完整管理身份，前端拒绝该响应，不据不完整数据开放写入。
前端只收窄操作范围，服务端仍独立执行完整 canonical 权限与引用检查。
身份、当前组织、发布能力和门户管理能力任一变化都会清空私有状态和确认，
中止请求并忽略晚到结果。非 super admin 的组织写入仍限当前已验证组织。
移动端保留状态/历史读取，遵守现有高风险写入限制；本地模式不提供此入口。

引用冲突、CAS 冲突或权限拒绝后不保留可继续提交的旧状态，须重新查询。
网络中断、超时、取消等待或无效成功响应可能发生在提交之后，
显示 **变更结果待确认**，不会自动重试 POST，也不宣称回滚。
重新查询成功只确认当前状态，操作是否提交须结合审计历史判断。
查询失败时继续保留待确认提示，不恢复先前状态或写入按钮。
写入及结果待确认期间，普通目录、维护者目录和导入结果不能切换正在管理的发布项；
重新查询确认当前状态后解除限制，也可显式编辑 binding 开始另一项查阅。
页面关闭、身份切换或重新选择 binding 不撤销服务器上已提交的操作；
页面不将原因、历史或待确认队列保存到本地持久存储。

组件的真实浏览器回归覆盖桌面/移动端布局与交互，API 使用隔离的模拟响应；
它不代替真实 Registry/PostgreSQL 权限和并发测试，也不是生产部署验收。
