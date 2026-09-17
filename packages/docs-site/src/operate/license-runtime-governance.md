# License、Runtime 与受限材料治理

## License policy

每个生态资产带有结构化 `LicensePolicy`：

- `classification`：`open-source`、`source-available`、`proprietary` 或 `unknown`。
- SPDX 或自定义 identifier、官方 terms/notice URL 和 provenance。
- acceptance、provider source/install、consumer use entitlement。
- redistribution 和 auto-install 策略。

License 要求从 software 继承到 usecase，再继承到 workflow。`unknown` 与 `auto-install=denied` 不允许自动安装。

## 授权声明与审核

组织管理员在 `/software` 提交授权声明。只填写以下 metadata：证据引用、非敏感摘要、主体、授权范围和有效期；不得上传合同、license key、POTCAR 或任何受限 bytes。

平台管理员在同一页审核 pending 声明，可批准、拒绝或撤销。批准结果在 availability、usecase 提交和 workflow 提交时同时生效；过期或撤销立即失效。

## Sandbox runtime binding

首个逻辑 contract 为 `python-3.12-stdlib-v1`。CP 在 `/cp/software` 的“受管 Runtime 与受限材料”填写 provider org、Agent、已签名 runtime profile ID 和 digest。

未绑定时脚本仍可浏览，提交会返回 `RUNTIME_CONTRACT_UNBOUND`。绑定被撤销或签名不匹配时也会拒绝提交。

## VASP POTCAR 映射

CP 将 POTCAR 文件保存在 Agent 的受限本地目录，在 `/cp/software` 登记 selector、版本、元素集合和 fingerprint。界面和数据库只保存这些 metadata。

VASP placement 同时要求：

1. provider source/install entitlement 已批准。
2. consumer use entitlement 已批准。
3. selector 属于当前 provider 和 Agent，且元素集合完整。

条件不满足时，页面会提示处理方法，例如配置对应 Agent 的本地映射，或选择包含全部所需元素的 selector。
