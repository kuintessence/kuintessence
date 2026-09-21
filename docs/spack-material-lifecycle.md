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
`historyTruncated` 表示还有更早记录。完整历史留在数据库中，不自动过期。
普通材料目录隐藏下架项；本批尚无维护者专用的下架目录或 Web 控件，
运维应保留发布时的 binding。

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
本批没有 CP/Web 状态写控件、自定义可见范围、物理回收、受限安装包授权，
也不替代 15 个科学工作流的材料准备、安装和运行验收。
