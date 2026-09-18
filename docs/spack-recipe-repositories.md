# Spack Recipe 仓库

## 当前范围

Registry 提供空内容 recipe 仓库，由运维导入官方或自定义 Git bundle。
本地 bare Git 保存完整目录及历史，快照以 commit 固定；初始化和 Web 共用导入逻辑。
导入不会执行 Python、concretize、编译或安装软件，也不会自动激活。

现有 Spack catalog 继续兼容保留。目录中的 metadata 不证明 recipe、源码或安装环境已存在。
本功能与现有软件资产授权并行：recipe namespace 不会自动授予软件使用权或创建 trusted asset。

本阶段支持：

- 含 `HEAD`、自包含的 SHA-1 Git bundle，不支持增量 bundle、远端 URL 或 Web 指定服务端路径。
- 原生仓库的完整文件、patch 和辅助模块，不只保存 `package.py`。
- `repo.yaml` 显式声明 `api: v2.0`、`v2.1` 或 `v2.2`，原样保留声明；
  未知 API 或缺失 API 记录为阻断诊断。静态结构识别不代表目标 Spack 引擎已兼容。
- Git 对象、路径、大小、仓库结构和 literal dependency 线索检查。
- 单个或多个 bundle 的 Web 顺序上传、失败项重试、初始化 manifest 批量导入、历史查看、
  显式激活、回滚、停用和固定快照导出。

尚未完成：

- 跨 recipe 仓库组合、目标环境的实际依赖 concretize，以及完整 Python 语义验证。
- 下载和校验已接入 [材料发布与 Agent 下载](spack-material-delivery.md)，但尚不解包或执行安装。
- 源码/厂商二进制/buildcache 的统一手动导入、恢复上传与 Spack 专用代理。
- 按具体用户授权或在 namespace 间迁移；本阶段沿用 Registry public/org/user 的权限矩阵。
- 物理删除 Git 历史和垃圾回收。停用不删历史，不自动卸载已安装软件。

## 存储与持久卷

```text
$SPACK_RECIPE_STORE_DIR/
  repositories/<repository-id>.git/
    refs/kq/snapshots/<commit>
    refs/kq/active
    refs/kq/audit/head
    kq-repository.json
  manifests/<repository-id>/<commit>.json
  staging/
```

`repository-id` 是逻辑 namespace 的 SHA-256，不使用用户输入作为物理路径。
Git tree、commit 与 snapshot refs 保持不变。激活使用 Git ref transaction，同时推进 audit commit 链；
每个事件记录前后版本、操作者、时间和前一个事件，顺序不依赖时间戳精度。
停用删除 active ref，但 audit commit 链和 snapshot manifests 保留。

源码压缩包、厂商安装包和 buildcache 不放进 recipe Git。
建议持久卷分别预留 recipe、blob、bootstrap 导入目录，并按组织限制可写权限。

| 部署方式 | 默认 recipe 目录 | 持久化 |
|---|---|---|
| Compose | `/var/lib/kuintessence/registry/recipes` | 已有 `registry-data` |
| scheduler Compose | `/var/lib/kuintessence/registry/recipes` | 已有 scheduler Registry 卷 |
| preview | `/var/lib/kuintessence/registry/recipes` | 已有 preview Registry 卷 |
| AIO | `/data/registry/recipes` | 已有 `/data` 卷 |
| Helm | `<registry.persistence.mountPath>/recipes` | 已有 Registry PVC |

本地模式要求同一个存储目录只有一个 Registry 写者。Helm 启用 recipes 时校验
`registry.replicas=1`、开启持久化，并使用 `Recreate`。需要多副本时先拆出独立写入服务，
不能直接把同一个 PVC 挂给多个 Registry 写者。关闭 recipes 不删除 PVC。

备份和恢复必须覆盖整个 recipe 根目录，不只备份 Git objects。暂停写入后执行一致性备份，
保留 manifests、refs、reflogs、仓库身份与 Git `info/attributes`。
容器重建不能以镜像中的初始目录覆盖挂载卷。
正常请求结束会清理 staging；进程异常退出可能留下临时文件，只能在停止 Registry 后清理
`staging/`，不得删除 repositories 或 manifests 目录来释放空间。
Git objects/ref 与 manifest 不属于同一个文件系统事务；异常退出中断导入时，重新上传
同一个 bundle 可补齐导入记录。普通失败会撤销本次新建的 snapshot ref，不删除旧快照。

## 配置

| 配置 | 默认值 | 说明 |
|---|---|---|
| `SPACK_RECIPE_STORE_DIR` | 未设置 | 绝对路径；未配置时 recipe API 返回 503，不回退内存 |
| `SPACK_RECIPE_BOOTSTRAP_MANIFEST` | 未设置 | 管理员挂载的本地 JSON manifest；空字符串视为未配置 |
| `SPACK_RECIPE_MAX_BUNDLE_BYTES` | 128 MiB | 每个上传 bundle 的流式大小上限 |
| `SPACK_RECIPE_MAX_EXPANDED_BYTES` | 512 MiB | Git 历史对象总大小及当前 tree 大小上限 |
| `SPACK_RECIPE_MAX_FILES` | 100000 | 当前 tree 文件数上限 |

Git 每次调用有 120 秒超时和受限输出缓冲，POSIX 超时终止整个 Git 进程组；
单文件上限 16 MiB，参与静态文本检查的
`repo.yaml/package.py` 上限 1 MiB。每个 Registry 最多同时接收 4 个 recipe 导入，
上传空闲 30 秒或总耗时达到 5 分钟时终止。Git 校验和诊断写操作串行化。
固定快照导出最多同时 4 个，下载流存活最多 5 分钟；完成、取消或过期后清理临时 tar。
部署方仍需配置容器 CPU/内存、卷容量和网关请求限额；内容级限制不是操作系统资源隔离。
反向代理上传限制和超时需与 bundle 上限、全量索引耗时匹配。
Web、AIO 和 preview 的 recipe import 路径单独配置 128 MiB 上传上限、900 秒代理超时，
并关闭请求体缓冲；其他 API 路径维持原配置。提高 Registry 限额时同步调整这些配置及外层
Ingress/网关。watch 模式将同源会话 cookie 转换成发往固定 Registry upstream 的 Bearer，
已有 Authorization 优先，跨站请求不转换。

Git fetch 前预检 pack 校验和、对象数量和压缩边界，同时将 delta 指令及重建目标大小计入
展开预算。复杂且无法直接解析的 REF delta 链采用深度 64 的保守上界，可能拒绝合法的
复杂历史；此时应从新建的当前 tree 快照仓库生成低 delta bundle，不绕过资源校验。
预检不替代后续 Git 对象及引用完整性验证。

## 离线打包

在能取得官方或自定义 recipe 的电脑上，先选择可信的固定 commit。
不要把源码安装包、凭据、私钥、用户的 `.spack` 配置或科研数据混入 recipe 仓库。

在已有 recipe Git 仓库中导出：

```bash
git -C /srv/spack-packages rev-parse HEAD
git -C /srv/spack-packages bundle create /srv/offline/builtin.bundle HEAD
git -C /srv/spack-packages bundle list-heads /srv/offline/builtin.bundle
```

输出应包含 `HEAD`。bundle 必须自包含；依赖接收端已有 commit 的增量 bundle 会被拒绝。
保留原仓库完整目录，导出本身不修改上游工作树。

完整官方 Git 历史可能超过导入限额。此时在另一个临时目录准备所选版本的完整文件快照，
建立独立的根 commit 再导出，不要在原仓库改写历史。提交说明记录上游仓库和原始 commit：

```bash
git -C /srv/recipe-snapshot init
git -C /srv/recipe-snapshot add .
git -C /srv/recipe-snapshot \
  -c user.name="Offline Recipe Import" \
  -c user.email="operator@example.invalid" \
  commit -m "Recipe snapshot from the reviewed upstream revision"
git -C /srv/recipe-snapshot -c pack.window=0 \
  bundle create /srv/offline/builtin.bundle HEAD
```

上述 `/srv/recipe-snapshot` 必须是运维已准备好的完整快照目录，不是空目录。
这类 bundle 的 commit 是本地快照 commit，而非上游原始 commit；平台不会将其自动认证为官方。
新建快照仓库使用 `pack.window=0` 避免生成 delta；直接对已有 packed 仓库使用同一参数，
仍可能复用既有 delta，不能作同样保证。
有 symlink、submodule 或非法路径的 tree 会被拒绝，需运维明确处理后重新打包。

## 首次初始化导入

把 bundle 与 manifest 挂载到 Registry 的只读目录，例如 `/imports`：

```json
{
  "version": 1,
  "repositories": [
    {
      "repository": "public/builtin",
      "bundlePath": "builtin.bundle"
    },
    {
      "repository": "org/provider-example/site-recipes",
      "bundlePath": "site-recipes.bundle"
    }
  ]
}
```

`provider-example` 仅为示例，部署时填写实际组织 ID。
相对 `bundlePath` 相对于 manifest 所在目录；绝对本地路径也可用，URL 不允许。
设置 `SPACK_RECIPE_BOOTSTRAP_MANIFEST=/imports/manifest.json`。
具体只读挂载示例见 [Compose](../deploy/compose/README.md) 和 [Helm](../deploy/helm/kq-platform/README.md)。

首次导入成功后仍为未激活，需要运维查看诊断并确认信任。
重启时已存在且具有快照的仓库会跳过，不追加新版，不更改当前 active commit。
后续更新通过 Web/API 导入；不要依赖修改 bootstrap 文件自动更新运行中的仓库。
一个条目失败时停止当前初始化批次，日志记录失败；此前成功的条目保留，重启重试时跳过它们。

## Web 与权限

平台 Spack 软件视图和 CP 软件页提供 recipe 管理面板。
平台管理员可维护 `public/<name>`，CP 组织管理员维护 `org/<org-id>/<name>`。
身份、publisher role 和 namespace 权限在每个请求中重新检查；
不可见的历史、诊断和 tar 下载同样受到保护，不只是隐藏列表。

上传可选择一个或多个 `.bundle`，逐项设置对应 namespace，按顺序导入并保留各项结果；
部分失败不撤销已成功的条目，可重试失败项。完成后查看 commit、repo root 和静态报告。
同一 commit 重复上传幂等复用首次导入记录；新 commit 默认未激活。
激活需确认 recipe 的可执行性质，并提交页面读取时的 `expectedActiveCommit`；
期间有人切换版本则返回 409，须刷新后重新确认。选择旧快照激活即为回滚。
停用只清除 active 指针。

| API（Registry 前缀 `/api`） | 作用 |
|---|---|
| `GET /spack/recipe-repositories` | 当前身份可读仓库 |
| `POST /spack/recipe-repositories/import?repository=...` | `application/octet-stream` 原始 bundle |
| `GET /spack/recipe-repositories/:id` | 快照与静态诊断 |
| `PUT /spack/recipe-repositories/:id/active` | 显式确认信任并 CAS 激活/回滚 |
| `DELETE /spack/recipe-repositories/:id/active` | CAS 停用 |
| `GET /spack/recipe-repositories/:id/snapshots/:commit/archive` | 完整固定 tree 的 tar |

Web 网关对应 `/software/api`。API 不提供 Git smart HTTP，也不接受任意 ref、远端 URL 或服务端目录。
下载 tar 是运维人工交付接口，不是 Agent 下载入口；激活不表示 Agent 已应用此仓库。
Agent 下载使用独立的 Server operation ticket 入口，不能用 Agent 直连 Registry 代替；
具体已实现内容和安装阻断状态见 [材料发布与 Agent 下载](spack-material-delivery.md)。

## 诊断解释

阻断诊断包括无 repo、YAML 错误、重复 namespace、不支持的 API、非法 packages 目录、
缺少 `package.py` 和超出静态文本大小限制。
导入成功但有这些诊断的快照可查看，不可激活。

v2 package 目录沿用 Spack 的小写 Python module 命名规则：`py_numpy` 对应
`py-numpy`，`_7zip` 对应 `7zip`，Python 关键字转义 `_global`、`_pass`
分别对应 `global`、`pass`，依赖匹配使用还原后的包名。未转义的关键字、
任意前导下划线、双下划线和大写 package 目录不符合该规则。

`dependency-not-in-bundle` 仅代表 literal 依赖线索在本包中未找到。
它可能来自其他仓库、条件分支或 virtual provider，不能直接认定软件包有 bug。
报告始终标为 `static-only`，不证明 Python 语法、所有 variants、MPI/compiler 组合或安装可行。
最多返回 500 条诊断，优先保留 error，其余以截断计数提示。
静态检查额外限制 128 个 repo root、100000 个 tree 文件和 128 MiB 累计检查工作量
（路径、metadata 与派生名称）；达到预算会返回阻断诊断，不当作已完成检查。

15 个科学计算工作流应后续分别形成固定版本的 environment 和 `spack.lock`，
再由隔离 Spack worker 验证具体依赖。工作流数据、赝势和受限材料仍按原有数据治理处理，
不随 recipe 镜像自动导入。
