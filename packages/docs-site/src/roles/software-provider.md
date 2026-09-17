# 软件开发者手册

Software Provider、领域软件维护者和 workflow template 作者可按以下流程创建、提交和维护软件资产。

## 入口

- 软件目录：`/software`
- 新建 Spack package：`/software/spack/new`
- 新建软件用例：`/software/usecases/new`
- 新建 workflow template：`/software/workflow-templates/new`
- 发布者工作台：`/software` 的 Publisher Workspace 区域

## 资产类型

平台统一用 software asset 管理以下内容：

- `spack-package`
- `usecase`
- `workflow-template`

每个 asset 都有 revision、source、visibility、lifecycle、trusted 状态和 ACL grants。兼容 API 的写入也会同步到 asset/revision。

## 创建 Spack Package

推荐流程：

1. 从 upstream package 克隆或粘贴 `package.py`。
2. 使用解析按钮提取 package 名、version、variant、depends、provides、maintainer、license。
3. 保存为 draft。
4. 在详情页确认依赖可以跳转到对应软件。
5. 发起 submit。
6. 等待平台 review 或 official fork。

CP 私有 package 默认 `source=cp-private`，只在 provider org 和自有 agent/cluster 内可信。跨平台共享必须走平台审核和 official fork。

## 创建软件用例

Usecase 定义 workflow 可引用的软件运行方式，包括：

- 输入/输出 slot。
- 绑定 package 或 variantRef。
- version、compiler、module、variants。
- 环境变量。
- material/template/collector/validator。

提交前检查下游 package ref 是否有 `use` grant。缺失时可通过 Governance 的 downstream grant 补齐流程处理。

Usecase 是不可变发布版本。修正命令、输入输出、软件绑定或说明时，应基于旧版本发布新的 package ID；旧版本继续供已有 Workflow 和 Job 解析。同一 namespace、owner、名称和版本只有在内容完全一致时才会幂等复用，否则必须使用新版本号。发布失败会保留表单，保存进行中不能重复提交或关闭编辑面板。

组织管理员发布 Usecase 或 vendor Spack package 前必须选择 active organization。目录只显示公共资产、当前组织资产和本人私有资产；服务端在 Job 与 Workflow 执行前还会检查当前组织和授权，切换组织或撤销授权后，旧 ID 不能绕过检查。编辑 vendor Spack package 不会改变其组织归属；组织迁移需按治理流程单独处理。

`/api/app-templates` 缺少可靠的组织归属字段，只允许平台管理员维护。组织软件提供者须通过 Usecase 与 Spack catalog 发布组织资产。

## 创建 Workflow Template

Workflow template 应引用 usecase/software version ref，而不是把软件安装逻辑硬编码在 shell 中。发布前检查：

- DSL 是否符合工作流控制流 Schema。
- `usecaseRefs` 和 `packageRefs` 是否完整。
- 运行用户是否有下游 `use` 权限。
- official fork 是否存在。
- placement preview 是否显示可运行节点。

Workflow template 面向全平台发布，仅 `platform_admin` / `super_admin` 可以发布。服务端会检查账号当前状态；账号降级、停用或删除后，即使持有旧 JWT 也无法发布。组织管理员可以维护组织软件资产和 usecase，但不能发布全平台可信模板。

发布时必须通过工作流 YAML Schema 与跨字段约束检查，不能跳过静态校验。校验失败后页面保留名称、版本和 YAML，修改后可直接重试。

已发布的 workflow template 是不可变版本。需要修正 YAML、说明、标签、名称或版本时，在目录中基于旧模板发布新的 template ID；原版本会保留，供 `SubWorkflow ByVersion` 和历史运行继续解析。相同 `name + version` 只有正文、说明和标签集合完全一致时才会幂等复用，其他情况必须改用新版本号。模板、Software Asset、revision 和公开 grant 原子提交；已发布模板不能删除，以免断开既有引用。

管理目录和模板选择器支持服务端搜索、标签筛选和分页，并显示总数；历史版本超过 100 条时，也可通过名称、版本或标签查找。标准 SemVer 默认建议下一 patch，自定义版本需手动填写。无效的历史版本可以查看或据此发布修正版，但不能加载到工作流编辑器。详情与 `SubWorkflow ByVersion` 按不可变 template ID 读取，不受目录分页影响。

## 提交审核

提交要求：

- 用户需要 `software_provider` capability，或具备平台管理员角色。
- 只能维护自己的 draft，平台管理员可维护所有资产。
- 提交后 lifecycle 进入 `submitted`，review state 进入 pending。

平台可执行：

- approve：审核通过。
- reject：驳回并写 reason。
- fork-official：生成 platform fork，作为运行默认可信内容。
- deprecate/revoke/archive：生命周期管理。

## Revision 与维护

每次修改应生成新 revision。被 official fork 后：

- 原 SP asset 保留 attribution。
- 用户运行默认解析到 official fork。
- SP 后续更新需要新 revision 和新一轮 review。

如果发现漏洞或错误，应提交修订并说明：

- 影响版本。
- 风险等级。
- 下游 usecase/workflow。
- 建议 deprecated 还是 revoked。

## Package.py 编写建议

当前页面提供 textarea 和解析功能，Monaco 与结构化侧栏尚未实现。编写时注意：

- 明确所有 source URL 和 checksum。
- 避免不可审计的动态下载。
- 把 variants、dependencies、conflicts 写完整。
- 对 MPI、CUDA、Python extension 等能力用 variants 表达。
- 不在 install hook 中访问未声明的外部资源。
