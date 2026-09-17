# 科学软件生态使用

Registry 通过已签名 release 发布软件、软件用例、Sandbox script 和 workflow template。浏览目录不会下载科学数据、安装 Spack 软件或执行脚本。

## 使用步骤

1. 在 `/software` 选择目标软件或软件用例，确认固定版本、License、输入输出和可用节点。
2. 若详情页或提交页显示 License 阻断，组织管理员在 `/software` 的“License 授权声明”提交证据引用和非敏感摘要。
3. 在 `/workflows/new` 选择模板，上传自己的输入文件并完成参数、文件和队列配置。
4. 在预览步骤确认节点、I/O 与资源估算后提交。平台会再次校验 License、runtime binding 和受限材料；任一条件不满足都会拒绝提交。

## 资产引用与可复现性

生态 workflow 使用 `source/name/version` 引用资产。提交时 Server 将其解析为唯一 asset/revision 并保存到 run；后续 release 更新不会改变历史 run 的引用。

找不到资产或匹配到多个资产时，提交会被拒绝。引用 CP 私有资产还必须提供 `providerOrgId`，以确定提供方。

## 数据与受限内容

平台不内置或镜像示例科学数据。请根据软件官方文档自行获得并上传可再分发的输入文件。

VASP POTCAR 等受限材料不会上传到 Server、Registry 或 NetDrive，也不会出现在 job output 或公共下载。任务只能通过提供方 Agent 上配置的本地 selector 临时挂载。

## Data Market 与数据亲和

科学数据不随 Registry release 或 bundle 分发。workflow 可使用 Data Market 的 `DataAsset`、指定的 `DataAssetVersion` 与 immutable manifest，或使用用户自己的 NetDrive 输入。CP-local 数据只能在拥有 `available` replica 的中心运行，scheduler 会据此筛选中心。下载、派生和跨中心复制需要各自的权限，不能仅凭目录可见性操作。

用户私有上传依次经过 upload session、浏览器 PUT 和 SHA-256 commit，资产保持 `private`，不会自动共享。POTCAR 支持两种本地受管来源：Agent 本地 selector/fingerprint/element set，以及 entitlement 校验后的运行时解析。两种方式都不传输受限文件内容。
