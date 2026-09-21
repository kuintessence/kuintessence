# Spack 配置绑定退役

这是材料生命周期的第三批前置能力，仅向可信离线 DB 运维提供 `retire`。
它终止一个精确的 `(spec, repositoryId, manifestDigest)` 配置绑定的后续使用，
**不是下架材料、撤回 recipe、删除源码、卸载软件或修改可见范围**。
同一 release 的其他 spec 绑定不受影响；直接 Registry 材料读取仍按现有授权规则处理。
本批没有退役恢复接口、HTTP 管理接口或 CP/Web 写入口。

## 不可逆与保留

- 退役向 `spack_material_binding_retirements` 追加 tombstone，保留原绑定、
  历史任务引用、rollout journal 和全部 recipe Git/材料字节。
- tombstone 记录绑定 ID、epoch、revision、当前管理员、原因与四项运维确认；
  外键限制删除原绑定。API 不提供更新、删除或自动过期。
- Server 注册配置时遇到退役绑定即拒绝整个配置批次，不会静默跳过。
  安装引用获取时再次检查退役状态，包括已有引用的重试。
- `reconcile` 可以盘点包含已退役绑定的历史配置，但不会恢复其有效性。
  重启、重新导入同一 release、移除再添加环境变量都不能解除退役。
- 退役前必须确认不再需要原精确绑定。后续如需替代，应发布并审核新的不可变
  manifest binding，不能删除 tombstone、伪造任务状态或手动改表恢复旧绑定。
  将来材料下架后的恢复与配置绑定退役是不同操作。

## 前置条件

先阅读[离线 Rollout](spack-material-rollout.md)，按批准流程备份并应用生成的 migration，
备份范围新增退役表。CLI、命令文件、DB 环境变量与身份规则不变：

```text
bun packages/db/src/spack-material-rollout-cli.ts <absolute-command-json-path>
```

执行权限来自可信 shell 的 DB 凭据；`operatorId` 是归属记录而非登录证明。
退役只接受数据库中当前未停用的 `super_admin` / `platform_admin`。
CP 对材料的发布权不意味着具有全平台配置退役权。

退役只允许处于 `paused`、最近动作是 `reconcile` 的状态。
必须使用最新 revision、当前 epoch，以及同时匹配最近 reconcile journal 和当前库存的 digest。
程序在共享 lifecycle 事务锁内检查这些条件，并对 `software_operations` 加锁；
所有非终态 install（包括未登记引用的旧任务）必须为零，所有孤儿引用必须为零。
其他 release 的未完成安装也会阻止退役，这是维护窗口操作，不是在线局部强制删除。

在执行退役前，必须由运维完成并确认：

1. 所有旧 Server/Registry、安装与在途传输已停止或排空，包括离线和回滚副本。
2. 旧 DB、Registry、ticket 访问已撤销，旧连接和会话不能继续使用。
3. 全部历史绑定和任务库存已盘点并 reconcile。
4. 待退役的精确绑定已从**所有**部署、自动重启、扩容、离线与回滚配置中移除。

包括“已经支持 epoch、但还没有退役检查”的旧版本也必须隔离，不能只修改它们的 epoch。
四项 `true` 只是运维声明，CLI 不会自动停止进程、轮换凭据或修改部署配置。

## 操作顺序

按 `inspect → pause → 外部排空/撤销访问/移除旧配置 → reconcile → retire
→ reconcile → activate → 配置统一 epoch 并重建服务` 执行。
不能从 `retire` 直接 activate；重新 reconcile 后，需再次按 Rollout 文档核对启用条件。

以下是 `retire` 命令文件内容。字段值为占位符，必须替换；revision `2`
仅表示一次无并发写入的首次操作示例，不可假定实际 revision：

```json
{
  "action": "retire",
  "operatorId": "<current operator UUID>",
  "expectedRevision": 2,
  "epoch": "<epoch returned by pause>",
  "inventoryDigest": "sha256:<current reconciled inventory digest>",
  "bindings": [
    {
      "hello@2.12.1": {
        "repositoryId": "<historical namespace SHA-256 hash: 64 lowercase hex>",
        "manifestDigest": "sha256:<historical manifest digest>"
      }
    }
  ],
  "reason": "旧部署配置已退役，全部回滚配置已移除该绑定",
  "evidence": {
    "legacyProcessesStoppedAndDrained": true,
    "legacyAccessRevoked": true,
    "legacyInventoryComplete": true,
    "bindingConfigurationsRemoved": true
  }
}
```

`bindings` 使用与 reconcile 相同的映射数组格式；最多 64 个映射，展开后
**1–1000 个不同的精确绑定**。原因须为 1–1000 字符的非空字符串，不允许首尾空白、
换行或 ASCII 控制字符。命令文件总量仍限制为 2 MiB。
原因不得包含凭据、token、内部地址或受限材料内容；它会持久保存于审计记录。
未知绑定、重复绑定、已退役绑定、过期状态或任何 DB 错误都会使**整批回滚**，
不存在“成功一半”的 API 结果。

成功后仍为 `paused`，追加一条 `retire` journal 并返回新的 revision/digest/counts。
`bindingCount` 始终是保留的历史绑定总数，`retiredBindingCount` 是已退役数量；
不能把历史绑定总数误认为当前有效绑定数，也不能用任一计数替代事务内授权。
CLI 不输出原因、绑定列表、凭据或 DB 异常。
响应丢失时先 inspect，不盲目重放；它不是幂等的“强制退役”命令。
若需逐条核对退役归属，当前仅限具备 DB 权限的运维查询审计表，尚无 Web 审计列表。

库存 digest 现在覆盖 bindings、references 和 retirements，均按 keyset 分页读取。
升级后不能复用旧版本存档的 digest；必须重新 inspect/reconcile。
保留旧 journal 的原 digest，不回写历史。当前 release 的历史任务引用不因绑定退役删除。

## 验证范围

新增回归覆盖真实 PostgreSQL 的 CAS/权限/活跃任务/孤儿引用、重复和未知绑定、
跨页批次回滚、退役库存分页摘要、已有引用重试及旧配置拒绝。
native/managed GNU Hello 的隔离 Actions 案例追加一条不曾实际部署的历史测试绑定，
在维护窗口内退役，再重建 Server/Registry，核对 tombstone、旧配置拒绝和实际 Hello
绑定仍可用。该案例不代表生产隔离已完成，不替代真实业务部署及 15 个工作流验收。
测试结果只以当前提交的 GitHub Actions 为准，不在本地运行测试或容器。
