# Spack 材料发布与 Agent 下载

## 当前状态

当前实现 **Registry 持久化材料与 lock 预检 → Server 授权转发 → Agent 校验缓存与 lock 预检
→ 可选的隔离 source audit**。
recipe 继续保存在本地 bare Git；源码及其他材料不进入 Git。
平台 Agent 不再接受直接联网的 `spack install` 或 buildcache 导入。

**Persistent installation 为实验性 opt-in，尚非生产就绪的离线安装器。**
默认只下载和静态预检，不运行 recipe、不解包 recipe archive。
显式启用 source audit 后才在固定 SIF 内展开 recipe，并调用 Spack native staging；
未启用 `AGENT_SPACK_INSTALL_ENABLED` 时，即使审计通过，安装操作仍返回 `rejected`，
不修改宿主 Spack 配置或安装账本。
现有安装软件的查询、卸载、load 和预装登记保留；独立 CLI/embedded 默认行为不变。
平台默认仍阻断新安装，不能按“安装功能已恢复”上线。

TypeScript 已接入固定 site profile digest、持久化安装账本和
**隔离 build → 独立 readonly verify → ready** 的编排。
`worker/install_worker.py` 已实现目标平台/compiler pins、native solver 对照、安装树和 load
校验，并以模拟 native API 的 fixture 验证；真实 Linux、Spack、Apptainer/SIF 与集群验收均未执行。
下载或 source audit 成功不等于 recipe 可信或软件已安装。
初始化材料 manifest 已接入，支持本地文件包批量导入和重启重试；不执行材料内容。
平台与 CP 门户支持同一材料包的 Web 导入、失败项重试、取消、权限过滤的发布目录及
按 binding 查阅发布清单。目录支持精确仓库筛选、刷新和本地分页，不要求预先知道 digest。
受限厂商安装包、许可证授权、buildcache 发布、HTTP/SOCKS 上游代理、大规模材料目录索引、
删除/可见范围变更、Range/恢复上传和垃圾回收尚未接入；15 个工作流的目标 Linux 材料、
lock、安装及运行验收仍未完成。

## 存储与边界

Registry 新增 `SPACK_MATERIAL_STORE_DIR`，例如 `/var/lib/kuintessence/registry/materials`：

```text
materials/
  blobs/<digest-prefix>/<sha256>
  receipts/<namespace-sha256>/<sha256>.json
  manifests/<namespace-sha256>/<manifest-sha256>.json
  staging/
```

blob 使用独立目录，不受 OCI 垃圾回收影响。每个 namespace 有自己的上传 receipt；
知道其他组织的 digest 不授予发布或下载权限。
release 不可变，包含精确 spec、Spack 版本、完整目标架构声明、lockfile digest、源码 mirror 路径、
源码 digest/大小、recipe commit、选用 roots 和 Registry 导出的 recipe tar digest/大小。
切换 recipe active ref 或修改 Server 的 release 映射不改变已签发任务的固定内容。

发布和读取沿用 Registry canonical 用户身份与 namespace RBAC。
引用的 recipe 必须可读，无阻断静态诊断，roots 必须存在；不能把私有 recipe 发布进
可见范围更大的 release。当前只接受运维明确声明 `redistribution: "unrestricted"`
的材料；这是发布者声明，不是平台对第三方许可证的自动鉴定。

Compose、scheduler、preview 的材料目录放在原 Registry 数据卷内；AIO 使用
`/data/registry/materials`；Helm 在启用 recipes 时使用现有 PVC 的 `materials` 子目录。
沿用单 Registry 写者。备份必须覆盖 recipe、material blobs、receipts、manifests 和数据库。
持久化目录须由服务账号独占，不得让普通用户或作业写入；配置路径不得指向公共临时目录。
目录扫描会拒绝 symlink 文件、异常类型和检测到的父目录身份变更；
这些检查用于发现部分损坏或并发路径变更，不提供原子路径解析，
也不构成对抗拥有本地写权限者的文件系统沙箱。持久化目录及其父目录链须受信任控制；
Registry 运行时不得外部改写、移动、替换、删除或恢复材料目录，先停止服务再做文件级维护。
停止 Registry 后可以清理遗留 `staging/`；不要手动删除 receipt 或被 release 引用的 blob。

## 初始化与本地批量导入

Registry 可通过 `SPACK_MATERIAL_BOOTSTRAP_MANIFEST` 读取管理员准备的 JSON 文件包。
默认不配置，不读取本地材料。首次部署可同时设置 `SPACK_RECIPE_BOOTSTRAP_MANIFEST`，
按 **recipe 导入完成 → 材料文件校验/上传 → release 发布** 的顺序执行；
已有 recipe 时只配置材料 manifest 即可。recipe bootstrap 失败则不执行材料导入。
此过程在启动后台运行，不阻塞 HTTP listener，也不改变 health/readiness 结果；
必须检查 bootstrap 日志，不能以 Registry 健康代表材料导入完成。

准备以下目录；源码内容原样保存，不需要由 Registry 解压：

```text
material-pack/
  manifest.json
  locks/root.lock
  blobs/source.tar.gz
```

`manifest.json` 示例。尖括号内的 ID、commit、digest、mirror 路径以及示例大小
均须替换为实际内容；以下只展示一项源码，不是完整工作流的材料清单：

```json
{
  "version": 1,
  "files": [
    {
      "path": "locks/root.lock",
      "blob": { "digest": "sha256:<lockfile sha256>", "size": 456 }
    },
    {
      "path": "blobs/source.tar.gz",
      "blob": { "digest": "sha256:<source sha256>", "size": 123 }
    }
  ],
  "releases": [
    {
      "version": 1,
      "repository": "org/provider-example/sources",
      "spec": "zlib@1.3.1",
      "spackVersion": "1.0.0",
      "target": "linux-ubuntu24.04-x86_64",
      "redistribution": "unrestricted",
      "recipes": [
        {
          "repositoryId": "<recipe repository id>",
          "commit": "<reviewed recipe commit>",
          "roots": ["repos/spack_repo/builtin"]
        }
      ],
      "sources": [
        {
          "path": "<path relative to the exported Spack mirror>",
          "blob": { "digest": "sha256:<source sha256>", "size": 123 }
        }
      ],
      "lockfile": { "digest": "sha256:<lockfile sha256>", "size": 456 }
    }
  ]
}
```

`files[].path` 是相对 manifest 所在目录的本地输入路径；
`releases[].sources[].path` 是 Agent 使用的 Spack mirror 内路径，两者可以不同。
不同 release 可以引用同一 digest；`files` 对每个 digest 只列一次，
并且必须恰好覆盖全部 release 的 lock/source 引用，不允许重复路径、重复 release、
缺件或未引用文件。每个 release 都必须有固定 recipe commit 和目标 Linux lock，
不以 recipe active ref 或 macOS 本机 lock 代替。

清单最多 2 MiB、200 个 release、20,000 个文件，去重后文件总大小最多 512 GiB；
单文件仍受 `SPACK_MATERIAL_MAX_BLOB_BYTES` 限制。所有输入为非空普通文件，
拒绝 URL、绝对文件引用、路径穿越、`.git`、symlink、hardlink 和 group/other 可写内容。
清单所在目录及包内目录也不可被 group/other 写入，绝对路径须规范化且无 symlink。
运维应控制整个父目录链，并在导入期间保持包不变；只读挂载不阻止宿主修改原文件。

将输入包与持久化输出目录分开挂载，例如容器内只读 `/material-bootstrap`，
配置 `SPACK_MATERIAL_BOOTSTRAP_MANIFEST=/material-bootstrap/manifest.json`。
不要把它挂到可写 `materials/` 上；Registry 服务 UID 须能读取全部文件。
Compose override 与 Helm 配置见 [Compose 部署](../deploy/compose/README.md) 和
[Helm 部署](../deploy/helm/kq-platform/README.md)。

导入先验证整包的 schema、文件类型和声明大小，再逐项流式读取并校验 SHA-256；
不调用 shell、不执行 recipe、不展开源码，不自动获取上游。内部使用固定 bootstrap
系统运维身份，仍保留 namespace 的 recipe 可见范围校验，不能把私有 recipe 发布到 public。
HTTP API 不接受服务器本地路径，此入口仅由管理员环境配置开启。

错误与重试：

- 清单、文件布局或预检查失败时，整批不上传。内容 checksum、lock 或发布校验失败
  按 release 报告，已成功项保留，并继续后续 release；整包不是原子事务。
- 启动日志 `report` 列出成功 binding 和失败的 repository/spec/target，
  状态为 `completed`、`partial` 或 `failed`，失败阶段为 `configuration`、`recipes` 或
  `materials`。错误不输出原始路径或底层异常。进程中断或整批超时时可能已有发布；
  日志未完成不表示内容已回滚。
- 取消在文件读取、发布校验和 manifest 原子提交前协作式检查；
  已启动的存储 I/O 或 Git archive 可能需要等待其自身超时。提交开始后的取消
  不回滚已落盘 release，但导入不会继续后续项，也不将整批报告为成功。
- 修正文件包后，在维护窗口重启 Registry 重新导入。会重新读取校验输入；
  同一内容在同 namespace 内复用不可变 blob/receipt/release，不覆写已有发布。
  失败可能留下已校验 blob/receipt，目前没有自动垃圾回收。
- 将成功项的 `{repositoryId, manifestDigest}` 显式填入 Server 的
  `SPACK_MATERIAL_RELEASES`，再按部署流程更新配置。导入不会自动激活 recipe、
  修改 Server 映射、下发 Agent 任务或恢复安装开关。

后续维护也可走下述 Web 导入或上传/发布 API，无需重启。
导入成功仅说明当前发布校验通过，不保证真实源码覆盖、solver、compiler 或集群安装成功。

## Web 材料导入与查阅

入口为软件中心的 Spack 页、CP 门户的软件页，使用同一个 **Spack 材料** 面板。
登录用户可以按 `{repositoryId, manifestDigest}` 查询自己可读的发布清单；
也可从 **材料目录** 打开已发布条目，按完整 namespace 仓库名称筛选并刷新结果。
上传同时受门户管理权限、`software.publish`、当前已验证组织及 Registry namespace
权限约束。非 super admin 的组织上传限定当前组织；平台管理员可发布 public 材料。
能力读取未完成或失败时不开放写入；本地模式不启用材料面板操作。
沿用移动端高风险写入限制，不因材料上传入口而绕过。

1. 先通过 recipe 面板导入所需 Git bundle，取得已审查的固定 commit 和 repository ID。
2. 选择上述格式的材料 JSON 清单；浏览器只读取最多 2 MiB 的清单，不执行内容。
3. 二选一：平铺路径的材料可多选文件；有子目录时选择 **清单所在的材料包目录**，
   保留 `files[].path` 的相对层级。目录选择只移除顶层目录名，不通过 basename 猜测文件。
   所选目录可以包含清单本身，不得包含额外文件、重复路径或缺件；再次选择替换此前选择。
4. 核对表格中的 namespace、spec、target，并确认材料允许再分发，再开始导入。
   整包的文件路径、声明大小及待发布 namespace 权限先通过预检，之后顺序上传。
   文件扩展名不代替内容鉴定；浏览器不扫描本地 symlink/hardlink 或 POSIX 权限，
   Registry 对实际收到的字节做大小/SHA-256 校验。该边界与服务器本地初始化读取不同。
5. 查看逐 release 结果。成功项可复制 binding，或直接打开固定清单查看 recipe commit/roots、
   lock 摘要和分页的源码 mirror 路径、digest、大小。原有发布也可手动输入 binding 查询。

浏览器将源码作为原始 `File` 请求体逐个发送，不在 JavaScript 中整块读取源码或解包、
不访问上游、不调用 Spack。所有请求固定经过同源 `/software/api/spack/material-repositories`
网关；禁止跟随重定向。单次运行在同 namespace 内复用已验证 receipt，不跨 namespace
借用授权。上传进度是已收到校验回执的文件数，不是网络发送字节百分比。

清单不合格或缺件时不发送材料；单项上传或明确拒绝发布时显示失败，后续项继续。
401/403、注销、切换组织/会话或失去发布能力时停止后续请求；切换上下文会清空本页的
文件句柄和私有结果，并中止在途请求。服务器始终独立核验当前身份及权限。
关闭页面、刷新或导航后，本次浏览器队列不保留，不将材料或凭据写入 localStorage。

点击“停止导入”不等于回滚。发布请求已经发出但响应丢失、超时或被取消时，
显示 **发布结果待确认**；服务端可能已经提交不可变 release。修复环境后显式点击
“重试未完成项”，会跳过本页已确认成功项，重新上传校验其余项，再复用不可变发布语义。
同一清单下重选文件保留已有成功 binding，并重新要求再分发确认；
此前的“待确认”不会被重试中的上传失败覆盖，只有确认发布成功后才解除。
重试不是断点续传；较大的文件会重新上传。重新打开页面后需重新选择完整材料包。

成功导入仍不自动修改 `SPACK_MATERIAL_RELEASES`、激活 recipe、部署软件或执行 recipe。
持久化导入任务、删除、可见范围调整和引用回收尚未实现；
不要直接删持久化卷上的 blob/receipt/manifest 来代替维护 API。

### 材料目录

目录从已原子发布的持久化 manifest 读取，不新增数据库或可变索引；
初始化、API 和 Web 导入的既有 release 在刷新后均可发现，Registry 重启后无需重建索引。
每条摘要只含 binding、repository、spec、Spack 版本、target、再分发声明、源码文件数
和材料总字节数。总字节数对同一 release 的 recipe archive、lock 和源码按 digest 去重，
不是整个材料卷的磁盘占用，也不是源码解包大小。

目录和下载使用相同的当前 namespace/recipe 授权检查。组织成员、个人 namespace、
super admin 等权限规则不变；platform admin 身份本身不授予所有组织的读取权限。
无权限或引用 recipe 已不存在的条目不展示，不返回隐藏条目数量。精确筛选无权限仓库
和不存在的仓库都返回空列表。读取失败或损坏不会伪装成成功的部分列表。

一次查询最多扫描 10,000 个目录项、读取 32 MiB manifest 元数据、返回 200 个可读 release；
忽略的临时文件也计入扫描项预算，每个 Registry 实例最多同时进行 2 次查询，
使用 10 秒协作式时间预算。取消/超时在文件与 recipe I/O 边界检查，
已经发出的 I/O 须等待其结束才释放并发槽位，不保证硬实时中断。
超过扫描、字节、时间或响应数量上限时返回 `503 MATERIAL_CATALOG_LIMIT`，没有部分结果；
可按完整仓库名称缩小查询。并发超限返回 `429`。
单个仓库仍超限时应继续按 binding 查阅；服务端游标分页和大规模索引尚未提供。

Web 每页显示 20 项，按仓库、spec、target、digest 稳定排序，不承诺发布时间顺序。
筛选、刷新失败或开始新请求时不保留旧列表；切换身份/组织/能力上下文时清空结果、
取消请求并忽略晚到响应。目录响应设置 `Cache-Control: private, no-store`。
并发发布期间目录是尽力一致的视图，不是事务快照；新条目通过刷新发现。
目录仅供发现和查阅，不证明材料已经安装、recipe 可信或目标 Linux 可运行。

## 运维 API

以下是 Registry `/api` 下的接口；经 Web 网关时前缀改为 `/software/api`。
写接口使用有相应 namespace 发布权限的登录 token；读接口使用有读取权限的登录 token。
不要把这些凭据交给 Agent。

| 方法与路径 | 用途 |
|---|---|
| `GET /spack/material-repositories?repository=...` | 权限过滤的材料目录；可省略 repository，或传入一个完整仓库名精确筛选 |
| `POST /spack/material-repositories/blobs?repository=...&digest=sha256:...` | 原始二进制上传，流式校验 digest |
| `POST /spack/material-repositories/lock-preflight` | 使用 release 请求体检查 lock，返回静态报告，不生成 archive 或发布 release |
| `POST /spack/material-repositories/releases` | 发布固定材料清单，返回 `repositoryId`、`manifestDigest` |
| `GET /spack/material-repositories/:id/releases/:digest` | 读取固定 manifest |
| `GET /spack/material-repositories/:id/releases/:manifestDigest/blobs/:digest` | 读取该 release 明确列出的 blob |

文件逐个上传，可用运维脚本循环上传批次。失败文件重新上传；成功 receipt 保留。
API 不接受上游 URL、本地服务端路径或客户端上传的 recipe tar；recipe tar 由 Registry
从已导入 Git 快照生成。上传 recipe 的步骤见 [Recipe 仓库](spack-recipe-repositories.md)。

例如上传已经合法取得的本地源码文件，`REGISTRY_API` 为实际 Registry `/api` 地址：

```bash
SOURCE=/srv/offline/source.tar.gz
REPOSITORY=org/provider-example/sources
DIGEST="sha256:$(shasum -a 256 "$SOURCE" | awk '{print $1}')"
curl --fail-with-body \
  -H "Authorization: Bearer $REGISTRY_TOKEN" \
  -H "Content-Type: application/octet-stream" \
  --data-binary "@$SOURCE" \
  "$REGISTRY_API/spack/material-repositories/blobs?repository=$REPOSITORY&digest=$DIGEST"
```

`provider-example` 必须替换为真实组织 ID。对 lockfile 和每个 source/patch/resource
重复上传，保存返回的 digest/size。然后按以下结构准备 JSON；示例中的 ID、commit、
digest 和大小必须替换为真实返回值，不可直接提交：

```json
{
  "version": 1,
  "repository": "org/provider-example/sources",
  "spec": "zlib@1.3.1",
  "spackVersion": "1.0.0",
  "target": "linux-ubuntu24.04-x86_64",
  "redistribution": "unrestricted",
  "recipes": [
    {
      "repositoryId": "<recipe repository id>",
      "commit": "<reviewed recipe commit>",
      "roots": ["repos/spack_repo/builtin"]
    }
  ],
  "sources": [
    {
      "path": "<path relative to the exported Spack mirror>",
      "blob": { "digest": "sha256:<source sha256>", "size": 123 }
    }
  ],
  "lockfile": { "digest": "sha256:<lockfile sha256>", "size": 456 }
}
```

可先通过 `POST .../lock-preflight`、`Content-Type: application/json` 提交同一请求体，
取得报告后再调用 `POST .../releases`。发布时独立复验，不信任此前的预检结果。
预检或发布都要求当前 namespace 的上传收据、发布权限，以及全部选定 recipe 的读取权限。

### Lock 预检

本批明确支持 **Spack 1.0.0 生成的 lock v6 / spec v5**。这是已核对的兼容组合，
不是自动支持所有 Spack 版本。其他版本仍可上传 blob，但当前不能发布新的安装 release。
已有不可变 manifest 不改写；Agent 在安装入口重新检查，不因它发布于旧版本而跳过。

- lock 限制为 16 MiB，必须是有效 UTF-8 JSON，重复键拒绝。
- 只接受一个 root，其 `spec` 字符串须与 release 的 spec 完全一致。
- 检查 DAG hash 字段、节点及依赖引用、循环和未被 root 引用的节点。
- `target` 必须等于 root 的 `platform-platform_os-target`，例如
  `linux-ubuntu24.04-x86_64`；不能只写 `x86_64` 或 `linux-x86_64`。
- 未支持的 included environments、开发路径及旧式 compiler 字段被拒绝。
- external、实际宿主与 compiler、源码覆盖和引擎级校验要求保留为 warning。

`lock-preflight` 对可读取的输入返回 HTTP 200，调用方必须检查 `valid`，
不能把 HTTP 200 当作预检通过；权限、缺少收据或超限仍使用相应非 2xx 状态。
`releases` 遇到不合格 lock 返回 HTTP 422，`error.lockPreflight` 携带同样的报告。
报告的 `validation` 始终为 `static-only`，不包含安装就绪承诺。

静态预检只证明已声明的图结构闭合，**不证明图包含 recipe 实际要求的全部依赖**；
root 字符串匹配不等于 concrete root 真正满足版本、variants 和 compiler 约束，
也未用 Spack 重算 DAG hash。源码、patch、resources、bootstrap 和 external 是否齐全，
recipe API 与引擎是否兼容，仍需在隔离运行时验证。跨 target 的依赖也需要进一步检查。

15 个工作流需要针对实际 Linux 集群、compiler/MPI/variants
分别生成和验证 lock，不能把 macOS 本机 concretization 当作 Linux 部署材料。
当前工作流文档中的抽象 spec 还不足以生成可靠的全量下载清单。

## Server 与 Agent 配置

Registry：

| 配置 | 说明 |
|---|---|
| `SPACK_MATERIAL_STORE_DIR` | 绝对持久化目录；需同时配置 recipe 和 OCI blob 存储 |
| `SPACK_MATERIAL_BOOTSTRAP_MANIFEST` | 可选本地材料清单绝对路径，默认关闭；在 recipe bootstrap 完成后导入 |
| `SPACK_MATERIAL_MAX_BLOB_BYTES` | 默认/最大 16 GiB；可降低 |
| `SPACK_MATERIAL_UPLOAD_TOTAL_TIMEOUT_MS` | 默认 30 分钟 |
| `SPACK_MATERIAL_UPLOAD_IDLE_TIMEOUT_MS` | 默认 30 秒 |

上传最多 4 个并发；发布与 lock 预检共用 4 个并发槽位，JSON metadata 上限 2 MiB。
lock 上限单独为 16 MiB，图限制 10,000 个节点与 100,000 条边，报告最多 100 条诊断。
在 JSON 解析前另行限制嵌套深度 128、容器数 100,000、键数 500,000 和 token 数
2,000,000（容器、字符串及原始值，不含标点）；这些独立预算也可能拒绝低于图限额的输入。
架构字段各最多 128 字符，报告最多列出 64 种架构；超过限制直接报错，不回显超长内容。
代理上传上限 16 GiB、超时 30 分钟；调整应用限额时同步检查外层网关。

Server：

| 配置 | 说明 |
|---|---|
| `SPACK_MATERIAL_DELIVERY_ENABLED` | 默认 `false`；未启用时拒绝平台安装，不回退旧链路 |
| `SPACK_REGISTRY_URL` | 固定 Registry HTTP(S) origin，不含路径、凭据、query |
| `SPACK_REGISTRY_ALLOW_INSECURE_HTTP` | 默认 `false`；仅在明确受信任的内部网络中允许非 loopback 明文 HTTP |
| `SPACK_REGISTRY_JWT_SECRET` | 与 Registry 的 JWT 校验密钥匹配，仅服务端持有 |
| `SPACK_REGISTRY_JWT_ISSUER` / `SPACK_REGISTRY_JWT_AUDIENCE` | 与 Registry 配置匹配 |
| `SPACK_MATERIAL_TICKET_SECRET` | 独立的至少 32 字符随机签名密钥，不能复用上述密钥或浏览器 JWT key |
| `SPACK_MATERIAL_RELEASES` | JSON：精确 spec → `{repositoryId, manifestDigest}`，默认 `{}` |

需要启用 `MTLS_MODE=direct` 或可信代理 mTLS；配置存在不替代握手验证。
Agent stream 必须实际验证证书，并声明 `spack_material_delivery_v1`。旧 Agent 或无
已验证身份的连接收不到材料 ticket。多 Server 部署须使用一致的 ticket key 与 Registry 配置。
Server 重新检查 operation 状态、用户是否停用、CP scope/SpiceDB 权限、软件策略、
Agent 当前 provider 和证书有效期/撤销状态；每个下载请求再检查一次。
任务结束、权限撤销或证书撤销后拒绝新请求；已开始的流不会实时查询撤销，最长 5 分钟。

Agent：

- `AGENT_SPACK_ENABLED=true`、`AGENT_SPACK_PATH` 指向已部署的 Spack。
- `SERVER_HTTP_URL` 是 Server HTTPS origin；只有 loopback 允许明文 HTTP。preview 的
  cookie 登录网关不适合作为 Agent 下载入口，应使用受控的 Server HTTPS 入口。
- `AGENT_SPACK_CACHE_DIR` 默认 `/var/lib/kuintessence/spack-materials`，需挂载独占持久卷。
  scheduler Compose 已放进现有 Agent state 卷；其他部署由运维挂载。

Server 的专用下载入口为 `/api/agent/spack/operations/:operationId/manifest` 和
`.../blobs/:digest`。Agent 仅持有 mTLS stream 下发的 15 分钟 operation ticket，
不是浏览器 session 或 Registry 管理凭据。Server 内部使用请求者的短期 JWT，
由 Registry 再解析 canonical 身份；不将任何 Registry、S3 或上游地址返回给 Agent。
Registry 默认要求 HTTPS（loopback 除外）。确需内部 HTTP 时，必须显式设置
`SPACK_REGISTRY_ALLOW_INSECURE_HTTP=true`，并由部署方隔离该网络；JWT 可重放，公网必须 TLS。

Agent 拒绝重定向，按大小和 SHA-256 流式校验，临时文件完成后原子发布；
复用缓存前重新校验内容与权限。cache 根目录和 digest 目录禁止 group/other 权限，
新文件发布为 `0400`；已有 `0755` 缓存目录会被拒绝，不自动修改运维目录的权限。
网络超时、缺件、篡改或版本不符均失败，保留之前已校验缓存，
不会回退公网。当前每请求最多 60 秒、整个准备过程最多 10 分钟，较大材料在慢链路上
可能失败；Range/续传和可配置长传输窗口尚待实现。ticket 过期后需重新发起新操作。
下载完成后，Agent 在安装入口核对所有缓存引用与固定 manifest 的对应关系，
并从同一文件描述符读取、重验和解析 manifest/lock；拒绝 symlink、内容或权限变化、
路径替换和不完整引用。此步骤不展开 recipe、不证明 source 覆盖完整，也不启动 Spack。
旧 release 的错误 lock 返回 `failed`；合法静态 lock 在未启用 source audit 时仍返回未启用离线执行的 `rejected`。

## 隔离 Source Audit

此功能默认关闭，只用于审计当前 release 的源码材料；单独启用它不会启用安装。
Server ticket、下载校验和静态预检仍然必须先通过；没有 runtime、隔离条件不成立、
缺少 source/resource/patch 或校验失败时返回 `failed`，不回退宿主执行或公网下载。

| Agent 配置 | 说明 |
|---|---|
| `AGENT_SPACK_AUDIT_ENABLED` | 默认 `false`；启用时同时要求 `AGENT_SPACK_ENABLED=true` |
| `AGENT_SPACK_AUDIT_APPTAINER_PATH` | 默认 `/usr/bin/apptainer`，绝对、规范化的真实文件路径 |
| `AGENT_SPACK_AUDIT_APPTAINER_SHA256` | 启用时必填；可信 Apptainer 文件的 64 位小写 hex，不含 `sha256:` |
| `AGENT_SPACK_AUDIT_SIF_PATH` | 启用时必填；运维预置可信 SIF 的绝对真实路径 |
| `AGENT_SPACK_AUDIT_SIF_SHA256` | 启用时必填；可信 SIF 的 64 位小写 hex，不含 `sha256:` |

运行前提由运维准备，不在 Agent 启动时自动安装或运行：

- Agent 必须运行在 Linux、使用非 root 专用 UID。Apptainer 与 SIF 必须 root 所有，
  父目录逐级 root 所有且 group/other 不可写，不允许 symlink。SIF 所有写位必须清除。
  每次审计重新校验两者 SHA-256，执行前再次复验；不能填写未知来源文件的 digest 来代替信任审核。
- runtime 的命令选项以 Apptainer 1.4.3 为兼容基线，SIF 固定包含 Spack 1.0.0，
  入口为 `/opt/spack/bin/spack`；包含其 Python 和本地 fetch 工具。镜像不含凭据、宿主配置、
  自动初始化脚本或需要在线 bootstrap 的运行依赖，recipe 必须由运维审核。
- SIF 预建 `/kq/input`、`/sys/fs/cgroup` 和空的 `/kq/work`。`/kq/work` 必须为实际 Agent UID 所有、
  模式 `0700`，允许该 UID 在 writable-tmpfs 内写入。不同站点 UID 可能需要不同镜像。
  镜像环境不得提前往该目录写文件。
- 要求 user/network/PID namespace、cgroup v2 及该 UID 的 rootless cgroup delegation；
  需要可用的用户 systemd/DBus 管理环境。当前固定限制为内存 2 GiB、memory+swap 2 GiB、
  PID 128、CPU 2、单次 30 分钟、合计 stdout/stderr 2 MiB，每个 Agent auditor 串行执行。
  worker 会检查 namespace、当前 network namespace 内仅有 loopback、NoNewPrivs 和实际 cgroup 限额，
  无法证明限额生效或不支持的 cgroup 布局都直接失败。
- 禁用默认宿主 `/sys` bind，仅挂载只读 `/sys/fs/cgroup` 视图用于限额核验，worker 拒绝可写视图。
  另以只读方式挂载本次 release 的材料、worker 和 namespace 绑定信息，不挂载整个缓存、ticket、
  Agent 证书或任何宿主可写目录。recipe、mirror 和 staging 都在容器临时工作区，
  不保留到宿主；Apptainer sessiondir 的 tmpfs 配额也必须由管理员正确设置。
  2 GiB 内存/临时空间不足时审计会失败，不降级为可写宿主磁盘。

审计先重验 manifest/全部 blob，再安全展开 recipe archive，拒绝路径穿越、链接、
特殊文件和超限归档。随后只用清单中的 repositories 和本地 mirror，关闭 bootstrap，
检查 native root 约束、声明节点/hash、recipe content hash，并用
`stage.fetch(mirror_only=True)` 和 checksum 校验 source、resources、URL patches；
FilePatch 由 native patch 解析核验。无法提供可校验 archive 的 VCS fetcher 目前拒绝；
需要展开才能验证内容 checksum 的压缩 URL patch 也明确拒绝，不能仅凭外层 archive checksum 通过。
不展开源码，不运行 build/install/concretize。

仅审计路径中，成功的结构化报告保存在原 operation 的 `stdout`，`validation` 为
`isolated-source-audit`，包含节点计数、已验证计数及 warning；
operation 仍为 `rejected`，不能显示为已安装。只有额外启用下述实验性安装开关，
审计通过后才会进入独立的安装编排。失败返回脱敏错误码；
异常不回传原始 runtime 日志、上游 URL 或凭据。

此报告只描述 **lock 已声明节点的材料检查**，不证明 recipe 所有依赖被正确 concretize，
不证明实际计算节点的 target、compiler、MPI 或 external 可用。external 仅报告 warning。
recipe 是可执行 Python，可以影响同进程的审计逻辑和输出，因此报告不是防恶意 recipe 的
信任证明，也不能取代代码审核、供应链验签或隔离安装阶段的独立验证。

## 实验性 Persistent Installation

本节描述当前 TypeScript 编排与 Python worker 的实验性实现，不是部署验收说明。
安装仍须通过 Server 授权、材料下载校验、lock 静态预检和隔离 source audit；
任何失败均不得回退宿主直接安装、公网下载或 buildcache 导入。

### 显式启用与固定 Site Profile

| Agent 配置 | 说明 |
|---|---|
| `AGENT_SPACK_INSTALL_ENABLED` | 默认 `false`；实验性 opt-in，同时要求 `AGENT_SPACK_ENABLED=true`、`AGENT_SPACK_AUDIT_ENABLED=true` 和完整固定 runtime 配置 |
| `AGENT_SPACK_INSTALL_SITE_PROFILE_PATH` | 启用时必填；运维预置 site profile JSON 的绝对路径 |
| `AGENT_SPACK_INSTALL_SITE_PROFILE_SHA256` | 启用时必填；profile 原始文件字节的 SHA-256，64 位小写 hex，不含 `sha256:` |

当前入口要求 `AGENT_SPAWNER_BACKEND=host`，拒绝 Kubernetes adapter；
不因此允许 recipe 在宿主直接执行。仍要求 Linux 非 root 专用 Agent UID，
并继承 source audit 的固定 Apptainer/SIF、namespace、cgroup、超时与输出预算。
SIF 必须预装 Spack 1.0.0 及可导入的 `clingo`/`clingo.ast`；
worker 禁止 solver bootstrap，不会自动下载或安装缺失的 solver。
安装/verify/load 命令使用只读 runtime、`--underlay` 和 `--scratch /kq/work`，
避免 Apptainer 1.4.3 默认产生 VFS 标记为可写的隐式 overlay；
不使用 `--writable-tmpfs` 或宿主 `--workdir`，不支持 underlay 的 runtime 会失败，
不会退回可写 overlay。worker 核验 `/kq/work` 为本次独立
`rw,tmpfs` mount、空目录且由 Agent UID 所有后，才将其权限收紧为 `0700`。
站点 Apptainer 必须启用 `user bind control`，`memory fs type` 必须为 `tmpfs`，
并按工作量配置 `sessiondir max size`，不能假设默认容量足够；
它仍受固定 memory cgroup 限制，不能借此放宽持久化 store 的站点 quota。

profile 为 `version: 1`，固定 `storeRoot`、完整 Linux `target`、
`runtimeSifSha256`、`osReleaseSha256`、`hostFiles` 的 path/SHA-256，
以及 `externals` 的 DAG hash/prefix。root 本身不能是 external。
profile 文件及宿主文件的解析链须 root 所有，目录和常规文件不可被 group/other 写入；
受保护的系统 symlink 链会逐级核验，不等于允许可写路径或任意 symlink。
加载时复验原始 profile digest、runtime SIF 绑定、宿主 `/etc/os-release` 和声明文件的摘要。
持久化 store 不得与私有材料 cache、profile、runtime 或受保护宿主文件路径重叠。

记录与 worker 报告固定 `siteProfileDigest`（`sha256:<digest>`）和 `manifestDigest`；
不重新序列化 JSON 来代替原始文件摘要。profile 内容变化须显式更新配置 digest，
不会自动迁移旧记录；不同 profile 的记录不进入当前 managed inventory，也不能直接 load。

以下字段必须由运维明确设为 `true`，但它们是**人工声明，不是自动验证结果**：

| 字段 | 站点责任 |
|---|---|
| `sharedStoreConfirmed` | 确认共享持久化存储在 Agent 与计算节点以相同绝对路径可见，且权限满足运行需求 |
| `compatibleComputeNodesConfirmed` | 确认实际计算节点的 CPU/OS、compiler、MPI、external 和 compute ABI 兼容 |
| `quotaEnforcedBySite` | 由站点对持久化 store 落实磁盘配额；cgroup 内存限额不等于磁盘 quota |
| `trustedRecipesConfirmed` | 确认 recipe 已审核可信；digest 和隔离不替代信任审核 |

本机文件摘要、容器内平台检查均不能证明远端共享存储、compute ABI 或 quota 已生效。
recipe 仍是可信任前提下执行的任意 Python；分开 verify 也不构成防恶意 recipe 的信任证明。
worker 实现固定材料复验、native solver 对照、安装树检查和 load 校验；
这些检查不能替代真实站点验收，也不能把静态预检报告升级成完整求解证明。
external 的求解配置从锁定 spec 的副本生成，不把 native `patches` 内部元数据当作
用户输入 variant；原 lock、recipe 校验和重新求解后的完整 DAG/hash 对照保持不变。
安装树使用 `read: world`、`write: user`，以便同站点计算任务读取；不开放 group/other 写入。
原生 compiler-wrapper 可以使用解析后仍留在本次事务 store 内的绝对或相对 symlink；
跨事务、未批准外部目标、scratch、悬空、循环链接和数据库内的链接仍被拒绝。

### 独占 Prefix 与状态流

每次新安装事务在共享持久化 `storeRoot` 下分配独占的
`releases/<installation-id>/`，该目录容纳本次 Spack store、数据库、root 和依赖 prefix。
共享指计算节点可读取，不是多个安装事务共用一个可写 prefix；
不复用其他事务的依赖树，不借用宿主全局 Spack 安装树。
同一 store 通过 `.writer-lock` 串行化受管操作，账本位于独立的 `records/`，
不会作为 recipe 的可写 bind 暴露。

1. 创建 `building` 记录和初始 `0700` 事务目录。隔离 build 只额外获得本次 store 的
   同路径 `rw` bind；材料和 profile 只读，recipe/mirror/staging 使用临时工作区。
2. build 报告须匹配固定 manifest、site profile、root 和 store，随后记录进入 `verifying`。
   再启动独立 runtime 进程执行 `verify`，将同一个持久化 store 以 `ro` bind 挂载。
   build 的成功退出或自报结果不能直接发布安装。
3. verify 报告须独立匹配事务，且 prefix、installed hashes 与 build 报告一致；
   再次复验 site profile 后才开放事务目录的读取/遍历权限并写入 `ready`。
   readonly 指 verify 的挂载边界，不表示发布后的整个安装树成为不可变文件系统。
4. build/verify 阶段失败不提升为 `ready`，编排记录 `failed` 并尝试清理本次目录。
   进程中断留下的记录、目录或 writer lock 不会自动成为成功安装；自动恢复尚不能据此宣称完成。
5. 已发布 release 的复验失败会进入 `unavailable`，保留目录供诊断，并从 Agent 后续心跳
   的 installed 清单撤下。当前保守处理包括临时 runtime 故障，不自动区分材料损坏；
   修复环境后须显式 `import_preinstalled` 复验，或对同一 release 发起安装以重新 verify，
   通过后才恢复 `ready`，不会重新构建或以 load 隐式恢复。

同一 spec/root 的既有 `ready` 记录只有 manifest 与 site profile 均一致才走重新 verify；
不同 release/profile 返回 `rejected`，要求显式卸载后再替换，不原地覆盖。

### Root-only Inventory、Load 与 Uninstall

这里的 root-only 指 **lock 的 DAG root**，不是操作系统 root 用户：

- managed inventory 只列出当前 site profile 下有匹配 verify 报告的 `ready` root；
  依赖留在本次独占 store 内，不作为独立可管理安装暴露。平台仍合并 legacy inventory，
  因而 root-only 不代表宿主已有软件被隐藏。
- load/uninstall 按受管 root 选择，使用精确 spec 或完整 `/DAG-hash`；
  唯一匹配的 root 包名也可用，歧义或不精确的同包 selector 返回 `rejected`。
  相同 spec 的旧失败记录不遮挡已成功重试的 `ready` 记录；
  Agent 另支持 `release:<installation-id>` 精确定位记录以清理失败残留。
  这些 selector 都需对照记录的完整 spec 通过 Agent allow/deny 校验，
  经门户/API 请求还须满足 Server 的入口策略，不因 hash 或 ID 绕过策略。
  不能把依赖当作该安装的独立 load/uninstall 对象。
- load 仅用于当前 profile 的 `ready` 记录，在独立 readonly runtime 内复验后返回一次性
  shell fragment，不自动注入未来作业环境。受管 `import_preinstalled` 是复验已有 root，
  不会把任意宿主 prefix 领养成受管安装。
- uninstall 按 `removing → removed` 清理该 root 所属的整个事务 store，包括私有依赖，
  不是在共享全局 Spack 树中逐个删除依赖。卸载前需由运维确认没有作业仍使用该 prefix。

inventory 读取账本和路径状态，不会每次执行完整 runtime verify；
load/复验仍依赖固定材料 cache 与 runtime，不能把安装目录视为可脱离它们管理的独立产物。
Agent 的软件请求从执行到 inventory 发布串行处理，避免较旧成功快照覆盖较新撤回；
卸载清理、legacy 刷新或写锁收尾失败也保留已确定的撤回信息。
`ready` 仅表示此受管事务满足当前编排的发布条件，不表示生产就绪或集群运行验收通过。

## 验证边界

材料链路单元测试使用 Hono 内存请求、临时目录、模拟 Agent channel 与材料 fixture，
不依赖容器、真实 Server listener、数据库服务、Spack 安装或集群作业。
source audit 测试使用模拟 Spack 模块、归档 fixture、模拟 runtime metadata 和无害子进程，
不能验证真实 Spack Python、Apptainer 或 SIF。Linux namespace/cgroup/镜像配置需站点联调；
通过单元测试不代表 runtime 已在真实集群验收。

安装事务、策略、故障清理、mount 参数和报告绑定采用临时文件、模拟 native Spack 模块及
TypeScript fixture 验证。真实 Linux 隔离 build、独立 readonly verify、
共享持久化 prefix 的计算节点读取/load/uninstall、compute ABI 与站点 quota 仍须独立验收。
初始化导入测试使用临时文件与合成 lock/source fixture 验证顺序、校验、权限、
部分失败、重试和读取期间文件变更，不替代真实部署卷及工作流材料包的导入验收。
Web 导入采用 mock HTTP/临时 File 的组件与队列测试，不替代真实网关、大文件上传、
生产浏览器兼容性和目标 Linux 安装验收。
受限包及许可证授权、HTTP/SOCKS 上游代理、材料删除/授权调整和 15 个工作流的完整材料准备及
端到端安装/运行验收仍未完成，不能将实验性 opt-in 描述为生产可用或安装功能已恢复。
