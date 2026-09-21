# Spack recipe 管理面板

平台软件中心的 Spack 视图与 CP software 页面复用同一面板，不增加路由。
此面板只管理 Registry 的 recipe 快照和激活指针：不执行 concretization，
也不代表 Agent 已同步或消费 recipe。

## 导入

- 选择一个或多个非空 `.bundle` 文件。服务端要求含 HEAD 的完整、自包含 Git bundle，
  Web 以 `application/octet-stream` 发送原始 File，不接收远端 URL 或服务器本地路径。
- 每个文件都有独立的逻辑 repository 输入，支持 `public/<name>`、
  `org/<org-id>/<name>`；默认使用当前组织和文件名，没有当前组织时使用 `public`。
- 导入前可修改每个目标。相同目标会明确提示，它们会依次成为同一仓库的快照。
- 顺序上传，单项失败不阻断后续项；重试只发送失败项，已成功项不重复发送。
  再次选择相同文件可重新导入，是否产生新快照由后端幂等规则决定。
- 离开面板、切换组织或管理权限变化会停止尚未发送的队列项。
  已发送请求仍可能完成，回到原组织后应刷新确认。
- 导入不会自动激活。所有写操作以服务端返回的 `RecipeRepository` 更新列表和详情。

## 激活与历史

- 详情列出完整 commit、导入时间、导入者、根目录、API、文件数、字节数、
  bundle SHA-256 和静态诊断。诊断中的 warning 不等同于不可用结论。
- 激活必须单独勾选对可执行 Python recipe 的信任声明；静态检查不能证明安全性。
- 激活和回滚使用相同 PUT API，并携带用户确认时的 `expectedActiveCommit`。
- 停用使用 DELETE active API，携带当前 commit，仅清空激活指针，保留全部历史。
- 写失败后重新读取详情；冲突不会自动重试，必须重新发起操作和确认。
- 平台入口沿用 `software.publish`，CP 入口沿用 `workspace.provider.manage`。
  两个入口还会校验 capability 响应中的 `software.publish`、角色和组织成员信息；
  加载中或加载失败时不显示写操作，不使用浏览器缓存的角色授予权限。
- `public` 仅对 `platform_admin` / `super_admin` 显示写操作；非 `super_admin`
  仅可管理当前且已验证成员身份的组织 namespace，角色须为 `org_admin` 或
  `platform_admin`。`super_admin` 可管理其它组织。个人 namespace 在本面板保持只读。
- 上传目标与详情操作使用同一 namespace 检查；详情以实际读取的 namespace 为准。
  无可写 namespace 时隐藏上传入口。最终权限仍由 API 裁决。

## 会话隔离

- 面板订阅既有 auth 变化事件，不修改全局 auth 行为。列表和详情缓存键包含
  登录邮箱、session revision、角色、过期时间、capability 上下文和当前组织；
  不把 token 写入缓存键。匿名或缺少身份信息时不请求 recipe。
- 退出、切换账号、刷新 session 或权限上下文变化时重置选择和信任确认，
  移除旧 recipe 缓存并取消旧查询；其它模块的缓存不受影响。
- 上传队列在旧面板卸载后停止，旧请求的迟到结果不得恢复已清理的缓存。
  已发送的服务端操作仍可能完成，重新登录后需读取服务端当前状态。

## 验证

Vitest/Testing Library 使用独立 recipe client mock，不需要启动服务。
网络层测试检查鉴权、raw File、CAS、错误结构和共享 schema 响应校验；
面板测试覆盖逐项队列、部分失败、重复导入、只读、信任确认、回滚、停用、
组织切换、缓存竞态及中英文文案。既有软件中心和 CP 页面测试覆盖复用接入。
