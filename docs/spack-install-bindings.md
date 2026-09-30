# Spack 安装绑定管理

安装绑定决定“给定精确 spec 的新安装使用哪一个 immutable release”。
材料上传、发布与绑定是两次独立操作：导入成功不会自动替换任何安装映射。
本功能不启用 Agent 安装开关、不部署软件，也不代表材料已经通过目标站点验收。

## 使用范围

平台与 CP 软件页共用安装绑定编辑器。选择作用域、输入完整 spec 和材料
`repositoryId` / `manifestDigest`，查询当前 revision 后填写原因并确认保存。
也可以停用某个精确 spec，阻止该作用域后续的新安装。
更换材料时先核对 manifest 的 spec、target、recipe 快照和 lock，不能只比较软件名称。

- 平台管理员可管理平台默认或指定组织；CP 仅能管理当前拥有管理权的组织。
- CP 的组织管理权来自当前数据库中的 `owner` / `admin` membership。
  只有不存在任何 CP 角色 membership 时，才兼容旧 `org_admin` 的组织成员范围；
  已有具体组织 CP 身份不能借全局角色修改其他普通成员组织的绑定。
- Web/API 平台默认只能指向 `public/` 材料；组织绑定可指向公开材料或该组织材料，
  不能指向个人或其他组织材料。
- 管理权不豁免材料及 recipe 的 canonical 读取权限或可见策略。
- Web 写入必须处于匹配 epoch 的 `ready` / `policy-ready`，`observe` 不接受
  自助写入。首次启用先完成[离线 Rollout](spack-material-rollout.md)。
- 移动端保持既有高风险写入限制；切换身份、组织或权限后清空编辑状态。

## API 与并发

Registry 提供两个需要 canonical 身份的 JSON API，Web 经现有 Registry 代理访问：

| 方法及路径 | 请求 |
|---|---|
| `POST /api/spack/install-bindings/inspect` | `scope`、`spec` |
| `POST /api/spack/install-bindings` | `scope`、`spec`、`action`、`expectedRevision`、`reason`；`bind` 另需 `binding` |

`scope` 为 `platform` 或组织 UUID；spec 按字符串精确匹配，最长 500 字符，
不做 Spack 求解、别名或模糊匹配。`action` 为 `bind` 或 `disable`。
不存在的映射 revision 为 0，首次写入使用 `expectedRevision: 0`。
每次成功写入追加新 revision、操作者、原因、epoch 和 rollout revision。
查询返回最多最近 100 条记录，并用 `historyTruncated` 明示更早历史未返回；
数据库不删除更早审计记录。本切片按精确 spec 查询，不提供全局模糊目录或批量改绑。

并发修改返回 409，必须重新查询后再决定是否提交。超时、断网或无效收据
可能发生在提交之后；界面显示结果待确认，不自动重放写请求。
停用不需要材料仍可读取，因此材料权限变化后仍可阻止新安装。

## 启动配置兼容性

`SPACK_MATERIAL_RELEASES` 继续向既有保护账本登记全部配置绑定。
Server 随后仅为**尚无任何平台映射记录**的 spec 初始化平台默认。
已有 Web 更新、停用记录或其他 Server 初始化的默认均不会被覆盖。
空配置不会删除映射；修改环境变量也不再替换已初始化的默认，后续变更通过
Web/API 明确提交。首次多 Server 配置不一致时，首个成功初始化的版本生效，
其他版本仅留在保护账本，必须在上线前统一配置并检查实际生效记录。
旧配置仅含 hash，不推断 namespace；兼容初始化的默认若指向组织材料，安装时仍须
通过原 manifest 的提供者范围检查，不会因此变为跨组织可用。后续宜显式设置组织映射。

新安装选择顺序：

1. 该 operation 已有固定引用：继续使用原 release，并重新检查权限与准入条件。
2. 提供者组织存在映射：使用它；停用、已退役、下架或不可访问时直接拒绝。
3. 组织从未配置过该 spec：使用持久化的平台默认。
4. 无可用映射：拒绝安装，不直接读取环境变量作为备用来源。

组织映射不能通过删除“恢复默认”；本切片没有删除或恢复继承入口。
可显式绑定同一份公开材料。停用也不撤销在途下载或已派发任务。

## 历史保护与重启

当前选择保存在 `spack_install_binding_events`；旧的
`spack_material_bindings` 仍是追加式保护账本，不能用它的最后一行推断生效版本。
选择与固定 operation 引用在共用 lifecycle 事务锁下执行；签发票据前必须
完成材料校验。Web 更换映射不更新旧引用、任务或已安装库存。
重启后从数据库读取选择，无需重放导入。

更新或停用映射不会自动退役旧 binding，也不会减少旧材料的保护引用。
下架仍受原 lifecycle 检查约束；解除旧 binding 保护仍需
[离线退役](spack-binding-retirement.md)。退役 tombstone 不会被 Web 重新绑定
或启动配置覆盖。配置里仍有已退役 binding 时，Server 登记仍会失败，须按退役
流程移除全部旧配置。

Rollout inventory digest 纳入安装选择及其审计历史。不要通过清表、回滚旧代码
或移除 epoch 绕过屏障。既有全量停止、凭据轮换和网络隔离要求仍有效。

## 验证边界

新增合同、真实 PostgreSQL 并发/历史引用、Registry 权限和 Web 状态测试；
结果以对应提交的 GitHub Actions 为准。数据库 migration 仅由 Actions 的
`Generate database migrations` job 生成，审阅 artifact 后原样纳入版本控制。
不在本机执行生成、测试、格式化、构建或浏览器验收。

该切片不包含 Server-only buildcache 二进制安装、Agent OS/真实站点兼容性，
也不代表 15 项科学工作流已全部验收。
