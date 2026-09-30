# Spack 安装绑定编辑器

平台与 CP 共用 `SpackMaterialsPanel` 内的独立编辑器，不增加页面路由。
编辑器维护“作用域 + 精确 spec → 固定材料发布项”，不是安装执行入口。
绑定保存成功不代表材料已完成真实安装、科学运行或目标平台兼容性验收。

## 使用与权限

- 默认选中当前 active organization；没有组织时使用 platform。
  只有 capability 响应确认的 `platform_admin` / `super_admin` 可选择平台默认。
  组织管理员只能选择当前且经 capability context 验证的组织，不能输入任意组织。
- 绑定管理独立于材料发布及生命周期管理，不要求 `software.publish`。
  沿用门户的 `canManage` 和 session guard；平台管理按真实 capability 响应中的
  平台管理员角色判断。组织入口要求当前组织的已验证 context：
  非平台管理员还须有 `workspace.provider.manage`，且该组织 membership 为
  owner/admin，全局 `role=user` 也可管理。
- 全局 `org_admin` 仅在所有组织 context 均无 owner/admin/operator membership
  时允许 legacy fallback；当前组织仍须有已验证 context 和 provider manage capability。
  其他组织的 admin 身份不能用于管理当前组织。DB scope 始终负责最终鉴权。
  不使用浏览器保存的角色授予权限；匿名、本地模式及能力未就绪时关闭入口。
- 先输入精确 spec 并查询，再选择绑定或停用。spec 不做 trim、缩写或自动猜测。
  材料目录 selection 可预填 repository ID 和 manifest digest；不会隐式保存，
  后续使用新 selection 须点击复制按钮，并重新确认。
- 每次保存必须填写 reason 并勾选确认。修改目标、操作或原因会清除确认。
  保存携带查询得到的 expectedRevision，不允许未查询就提交。
- 移动端 observe-approve 模式允许查询，禁止保存。材料/recipe 权限、材料可见性、
  生命周期、退役和 rollout 门禁最终均由服务端检查，Web 不提供绕过开关。
- 展示当前固定发布项及最近最多 100 条审计事件，每页 10 条；截断时明确标记。

## API 与错误处理

使用 `requestSoftwareJson` 访问同源 Registry proxy：

- `POST /spack/install-bindings/inspect`，body 为 `{scope, spec}`。
- `POST /spack/install-bindings`，body 为 bind/disable 合同及 expectedRevision、reason。
- 两者直接返回 `SpackInstallBindingView`，不能包在 `data` 内。

client 校验共享 strict schema、请求 scope/spec 回显、状态与 binding 一致性、
连续倒序的 history revision、当前事件与快照一致性及截断标记。
写回执还必须满足 revision 恰好递增 1、state/binding/reason 与提交一致，
且最新事件 source 为 web、operatorId 非空。

冲突或明确拒绝后清空快照，必须重新查询并确认。
网络错误、错误回执、写请求超时或停止等待均显示结果待确认，不能假定已回滚。
此时锁定原 scope/spec，成功查询前不能再写；不会自动重试或自动读取。
所有请求有 30 秒等待上限，迟到结果不恢复旧状态。

登录身份、session revision、active organization 或 capability 变化时，
父面板重建独立会话，取消请求并清空 spec、binding、reason、确认与历史。
取消请求不撤销服务端可能已提交的操作，返回原身份后仍须重新查询。

## 集成边界

- 依赖 `shared/browser` 导出的 SpackInstallBinding query/change/view schemas 与 types。
- `software-client.ts` 仅对精确的 POST inspection 路径豁免移动端写限制；
  保存、其他路径、尾斜杠和 query string 不在豁免内。
- Web 不导入启动配置，也不修改已有 operation/job/installation。
  启动配置初始化规则、作用域优先级、停用不回退与历史固定由后端负责。
- 当前 client 要求 history 是最近连续的最多 100 条事件，与当前 DB 返回模式一致；
  若后端将来改变分页或过滤协议，应同步修改合同和 client，不得返回伪完整历史。

## 验证

新增 client、editor 和 session 风险测试，涵盖回执错误、冲突、未知结果、
中止/超时、重复提交、身份/组织/能力切换、选中材料预填和移动端限制。
本次仅编写测试及进行文本审阅，未在本机运行 tests、lint、typecheck、
formatter、build、安装、浏览器或脚本。实际验证留给 GitHub Actions。
