# 固定案例材料导出

## 范围

`Spack material artifacts` 是手动 GitHub Actions 工作流，只支持 `hello` 和 `samtools`
两个固定案例。复用既有准备器的 Spack 1.0.0、官方 recipe pin、Ubuntu 20.04 x86_64
参考工具链、单 root lock 与资源预算，不接受任意 spec、上游 URL 或浮动版本。

每次先准备一套 recipe/source，再从同一次准备结果生成可导入目录；不重新制作
recipe bundle、不改写原生 lock、不重打源码归档。导出的材料仍通过既有 Registry
和 Server 使用，Agent 不新增 Registry 或上游下载路径。

此工作流验证**导出、初始化导入、真实 Web 导入和持久化回读**，不执行受管安装或
科学作业。既有 Hello/samtools 受管安装案例的通过，不能替代另一份新生成材料的
安装验收，更不能证明 15 个科学工作流或生产目标站点可用。

## 发布前提

- 发布者逐项审核 recipe、源码、传递依赖、patch 和辅助材料的再分发要求，
  保留必要的版权、许可与声明。未知或受限内容不得进入此下载流程。
- `acknowledge_redistribution` 是发布者确认，不是自动许可鉴定；
  `redistribution: "unrestricted"` 的 schema 值也不是审核证据。
- GitHub artifact 的下载访问由 GitHub 仓库权限决定，不继承平台内材料 visibility。
  把目标 namespace 写成 `org/...` 不会使 Actions artifact 自动成为该组织私有。
- 不在输入中填写凭据、内部主机、个人路径或科学受限数据。工作流不上传环境文件、
  数据库、运行目录、安装树、原始日志、浏览器认证 trace、HAR 或 storageState。

## 触发参数

在 GitHub Actions 选择 `Spack material artifacts`，使用已审阅的 `main`。
专用开发分支 `feat/spack-material-artifacts` 仅用于本功能的隔离验收。

| 参数 | 内容 |
|---|---|
| `case` | `hello` 或 `samtools`，每次一个案例 |
| `recipe_repository` | 必填的 `public/<name>` 或 `org/<owner>/<name>` |
| `material_repository` | 必填，与 recipe 使用同一 namespace owner |
| `publish_artifact` | 默认 `false`，仅验证，不提供下载材料 |
| `acknowledge_redistribution` | 默认 `false`；上传前须完成审核并显式确认 |

namespace 决定导入位置，recipe repository ID 由其完整规范名称的 SHA-256 推导。
不能在导入时随意换名，否则材料引用的 recipe repository ID 不再匹配。
当前 Web 导入不支持 `user/...`，因此本导出入口也不接受。

建议为 recipe 使用版本化名称，避免在已有仓库上误以为初始化会覆盖内容。
不要用 `.git`、路径遍历或 URL 代替逻辑仓库名。

只有所有导入和回读检查成功，且两个上传开关均为 `true`，才会上传 artifact。
默认保留 7 天，名称包含 case、代码 SHA 与 run ID。验证失败、输出缺失或仅开启
验证时没有可下载材料，不能把 workflow 存在视为已产生 artifact。

新工作流尚未进入主线时，通过已有 `CI` 的 `run_runtime_checks=true` 验证两个案例。
该调用强制 `publish_artifact=false`，不会在 PR 验证中发布源码下载。

## 下载与校验

每个 artifact 是独立交付，不混用其他 run 的 bundle、lock 或 source：

```text
recipe-pack/
  manifest.json
  recipes.bundle
material-pack/
  manifest.json
  blobs/<sha256-hex>
checksums.txt
provenance.json
README.md
```

解压到新的、由运维控制的工作目录。macOS 可在该目录核对完整校验清单：

```bash
shasum -a 256 -c checksums.txt
```

同时核对预先取得的 run/代码 SHA、case、recipe pin、目标环境和发布者审核记录。
同一个下载包里的 checksum 只能检查内部字节一致性，不能独立证明来源可信。
不要重新格式化 lock、改变 payload、追加 `.DS_Store` 或把说明文件放进
`material-pack`。文件应为普通独立文件，不使用 symlink/hardlink。

`material-pack/files[].path` 对应去重后的物理 blob，release 的 `sources[].path`
仍保留完整 native mirror 路径。多个 mirror alias 可指向同一个 blob，
不能按 basename 合并不同源码。snapshot commit 是本次 bundle 的 HEAD，
不是官方上游 commit；最终 release binding 由目标 Registry 导入后返回，
不是导出器预造。

## 首次初始化

1. 将 `recipe-pack` 和 `material-pack` 与 Registry 的持久化输出目录分离，
   只读挂载到 `/imports/recipes`、`/imports/materials`。
2. 按既有部署配置设置：

   ```text
   SPACK_RECIPE_BOOTSTRAP_MANIFEST=/imports/recipes/manifest.json
   SPACK_MATERIAL_BOOTSTRAP_MANIFEST=/imports/materials/manifest.json
   ```

3. 仅在授权部署窗口启动，逐项检查 bootstrap 报告与实际 release；health 成功
   不代表后台导入完成。路径链由管理员控制，服务 UID 可读，文件和目录不可被
   group/other 写入，读取期间不能在宿主修改。
4. 已有任意 snapshot 的 recipe 仓库会跳过初始化，不会替换成包中快照。
   后续新快照通过 Web/API 显式导入，或使用新的版本化仓库名。

批量导入不是跨包原子事务，部分失败不会自动撤销已导入内容。
具体部署选项见[Recipe 仓库](spack-recipe-repositories.md)及
[材料发布与导入](spack-material-delivery.md)。

## 后续 Web 导入

1. 在软件中心 Spack 页或 CP 软件页，选择 `recipe-pack/recipes.bundle`，
   填入 recipe manifest 中的精确仓库名，导入并检查 commit/roots 和诊断。
2. 选择 `material-pack/manifest.json`，再选择整个 `material-pack` 目录。
   不选择 artifact 顶层目录；它包含不属于材料 manifest 的 recipe 和说明文件。
3. 核对 namespace、spec、target 和再分发声明，确认导入，检查逐 release 的结果。
4. 保存成功返回的 `{repositoryId, manifestDigest}`。响应丢失显示结果待确认时，
   先查目标仓库，不假设失败或取消等于回滚。

此过程不自动激活 recipe、配置 Server binding、放开 visibility/rollout 门禁，
也不触发安装。后续安装仍须匹配可信 runtime、external、site profile 和目标节点，
遵守[受管材料交付](spack-material-delivery.md)的既有约束。

## 隔离验证

手动工作流在临时 Actions runner 中：

1. 用固定准备器生成一次材料，导出并校验身份、路径、类型、预算和摘要。
2. 在全新的 PostgreSQL 与 Registry store 上通过真实启动配置导入。
3. 等待预期 release 可查询，逐个校验 manifest、recipe snapshot/archive 和所有 blob；
   重启后重新验证。
4. 清理该随机测试项目的数据库与持久化卷，重新创建空状态。
5. 通过真实应用页面登录、上传 recipe 和材料目录；浏览器不伪造 API 响应。
6. 校验 UI 返回 binding、两条导入路径的内容身份及重启持久化；
   缺件、额外文件、未授权发布、缺失 recipe 和损坏 blob 应被拒绝。
7. 再次核对待上传目录的 checksum，成功后才允许执行可选 artifact 上传。

测试栈只绑定 runner 的 loopback，不启动 Agent、scheduler、公网 preview 或生产部署。
Server/Registry 额外连接本次项目的非 internal bridge，供 Docker 发布 loopback 端口；
数据库仍只连接 internal backend。该 bridge 允许服务出站，不是网络断网验收；
Registry 上游导入保持关闭，导出容器使用 `network_mode: none`。
失败只输出固定阶段标记，不上传临时认证状态。所有通过结论须核对对应提交的 Actions，
不以配置、单元测试或文件存在代替真实导入结果。
