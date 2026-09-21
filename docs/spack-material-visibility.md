# Spack 材料可见策略

## 授权边界

可见策略是每个不可变 release 的附加读取限制，不是跨组织分享。
最终读取需要同时满足当前 canonical 用户身份、namespace 权限、所有精确 recipe
snapshot 的读取约束、材料未下架，以及本页定义的 policy。
前端筛选、JWT 中自报 role/org、材料 digest 或旧下载 ticket 均不能代替这些检查。

策略不修改 manifest、recipe Git、源码 blob 或 release binding；
使用 PostgreSQL 独立 append-only journal、revision/CAS 与审计。
没有记录时为 `{"mode":"inherit"}`、revision `0`，沿用原权限。
限定范围为 `{"mode":"allowlist","userIds":[],"orgIds":[]}`：
当前用户命中 userIds，**或者**当前 canonical 组织成员关系命中 orgIds，才满足策略。
之后仍须满足原 namespace/recipe 权限，不因进入允许列表而取得新的权限。
每类最多 100 个唯一的小写 UUID，存储和响应按字典序排序；空允许列表拒绝所有普通读取。
不存在管理员下载豁免。

管理入口仍要求 namespace **read + write** 及每个 recipe 的读取权限，
不要求操作者被包含在允许列表中。受限或已下架项仍可从维护者目录发现并管理。
管理权不解除普通下载限制；生命周期恢复和重新导入也不会清除策略。
导入/发布与下载准入是不同操作：现有受信本地初始化或已授权的 Web 导入可以返回
已提交内容对应的 binding，不返回策略详情，也不因此获得 manifest/blob 下载权。
重复导入受限 release 不改写 policy journal；初始化身份没有下载豁免。

## 启用步骤

新增 schema 和检查代码不能自动证明旧实例已经被隔离。首次使用前：

1. 按批准的维护流程备份并应用本版本生成的 migration。
2. 按[Rollout 操作顺序](spack-material-rollout.md)执行 `inspect`、`pause`、
   停止并排空所有 Server/Registry、撤销旧访问、清点历史并 `reconcile`。
3. 使用下面的 `activate-policy`，替代该次普通 `activate`。
4. 为全部升级后实例配置同一 epoch 和新凭据，按站点流程重启。

```json
{
  "action": "activate-policy",
  "operatorId": "<current operator UUID>",
  "expectedRevision": 2,
  "epoch": "<epoch returned by pause>",
  "inventoryDigest": "sha256:<current reconciled inventory digest>",
  "evidence": {
    "legacyProcessesStoppedAndDrained": true,
    "legacyAccessRevoked": true,
    "legacyInventoryComplete": true
  }
}
```

从仓库根目录使用已有离线入口：

```text
bun packages/db/src/spack-material-rollout-cli.ts <absolute-command-json-path>
```

示例 revision 必须替换为最新值。最后一次动作必须为 `reconcile`，库存摘要和 epoch
精确匹配，不得有非终态 install 或孤儿引用；缺失策略表也不能激活。
数据库访问身份仍由受信任运维环境保证，`operatorId` 只用于审计，不能自报它取得权限。

成功后 phase 为 `policy-ready`；后续暂停为 `policy-paused`。
再次 `pause/reconcile/retire/activate` 始终保留 policy 阶段，不可退回普通 `ready`。
原先只识别 `paused/ready` 的 runtime 会拒绝这些新阶段，因此不能忽略策略继续服务。
**更旧、不检查 rollout 的代码仍须通过外部凭据/网络控制隔离。**
三项 evidence 只是运维确认，不自动执行停机、轮换或验证外部控制。
不得删除 journal、清空 epoch、直接改表或回退旧二进制来解除限制。

只有匹配 `policy-ready` epoch 时才能查询或修改策略；普通 `ready/observe` 不开放策略管理。
`policy-paused`、epoch 不匹配、DB 故障或无效状态拒绝准入。

## 管理 API

```text
GET  /api/spack/material-repositories/:repositoryId/releases/:manifestDigest/visibility
POST /api/spack/material-repositories/:repositoryId/releases/:manifestDigest/visibility
```

POST 沿用 Registry 写入认证与确认头，body 为：

```json
{
  "policy": {
    "mode": "allowlist",
    "userIds": ["00000000-0000-4000-8000-000000000001"],
    "orgIds": []
  },
  "expectedRevision": 0,
  "reason": "Limit this release to the acceptance account"
}
```

UUID 是虚构示例，使用实际用户或组织 ID。恢复继承时发送
`"policy":{"mode":"inherit"}`，仍需当前 revision 和原因。
原因 1–1000 字符，不允许首尾空白、控制字符；不要填写凭据、下载 URL 或内部诊断日志。

成功响应包含 `binding`、仓库名称、`revision`、`policy`、最新 100 项连续降序
`history` 和 `historyTruncated`。审计项记录策略、操作者、原因、epoch、rollout revision
和时间；更早记录不删除。policy revision 与 lifecycle revision 相互独立。
重复提交相同策略或旧 revision 返回 `409 MATERIAL_VISIBILITY_CONFLICT`，
不将重试当作幂等成功，不自动覆盖其他维护者的修改。

管理无权限返回 `403 MATERIAL_VISIBILITY_FORBIDDEN`，
输入无效为 `422 MATERIAL_VISIBILITY_INVALID`，
未启用、缺表或损坏状态为 `503 MATERIAL_VISIBILITY_UNAVAILABLE`。
普通目录隐藏策略不允许的项，普通 manifest/blob 读取以 404 隐藏材料是否存在；
存储故障不能伪装成成功的空目录。Server 对 Agent 保留受限的通用错误，不回传 DB 内容。

## 安装与撤销语义

Server 安装准备在签发 ticket 前检查当前策略，每次旧 ticket 下载 manifest/blob
也重新检查绑定、当前 requester 和策略。即使 operation reference 已存在，也不能
跳过检查；随后 Registry 再以 canonical requester 验证 namespace/recipe/policy。
Agent 只经 Server 获取材料，不获得 Registry 凭据或外部下载通道。

策略修改与新准入使用同一 lifecycle transaction lock 排序。允许收紧已配置或正在安装
的 release，这可能使正在安装的软件在下一次下载时失败；不为旧 ticket 保留例外。
不承诺取消已经运行的作业、追回已下载字节或清除 Agent cache。
已经准入的 stream 可以完成，数据库锁不跨网络传输持有。

## 门户与验证

平台与 CP 共用材料管理入口。查询策略后选择模式、填写允许列表和原因、确认提交；
写入使用刚读取的 revision。成功后使两个目录和原 manifest 展示失效。
身份、组织或能力变化清空私有状态，中止等待并忽略晚到响应。
写入或结果待确认时锁定管理选择，不能通过切换管理模式解除未知写入状态。
网络失败、取消或无效成功回执不代表事务回滚；重新查询当前状态和审计，不自动重试 POST。
移动端保留查询，写入遵循现有高风险操作限制。

验证包括真实 PostgreSQL policy/CAS/rollout、Registry 各读取入口、Server 旧 ticket、
门户状态与隔离 Chromium 交互；仅以对应 commit 的 GitHub Actions 结果为准。
这些回归不代表目标站点验收，也不代表 15 个科学工作流的材料或运行验收完成。
