# Spack 材料第二批 Rollout

## 范围与前提

这是材料生命周期的**第二批升级屏障**，承接[持久化引用账本](spack-material-delivery.md)：
通过离线 DB API `SpackMaterialRollout.execute(command)` 执行
`inspect`、`pause`、`reconcile`、`activate`，将历史配置对账后显式启用 runtime。
不是完整生命周期管理：尚无 rollout HTTP API，也未开放材料下架、恢复、
ACL/可见范围变更或 GC。第三批另提供[离线配置绑定退役](spack-binding-retirement.md)，
复用本入口的 `retire` 动作，不删除历史或材料。`activate` 不执行安装、不激活 recipe，
不代表材料或安装器生产就绪。

先由维护者按批准流程准备并应用对应 additive migrations，核对目标数据库与完整备份。
持久化仍是 **PostgreSQL + recipe 本地 Git + 不可变源码文件系统**，不是把材料迁入数据库；
备份范围包括引用与 rollout journal、recipe Git、blobs、receipts 和 manifests。
保留既有 Registry 单写者、数据卷/PVC、目录权限及 Secret 管理方式。
本说明不提供自动恢复或逆向迁移流程。

部署静态测试 `scripts/spack-material-rollout-deployment.test.ts` 只检查配置接线、
持久化与 Secret 引用、命令示例和本地文档链接，不证明 DB 屏障或进程重建正确。
测试与运行态验收仅在 GitHub Actions 的隔离环境执行，须核对对应提交的结果，
包括 DB/CLI 门禁及 native/managed CI 的 pause、ready、recreate epoch 检查。
静态检查通过不等于运行态验收通过，旧提交结果也不能替代当前提交验收；
这些检查不代表生产站点验收。

## 离线入口与身份

离线 CLI 的约定入口如下，从仓库根目录执行，每次只提交一个命令文件：

```text
bun packages/db/src/spack-material-rollout-cli.ts <absolute-command-json-path>
```

`DATABASE_URL` 只从环境读取，不接受 CLI 参数或命令 JSON 中的连接串。
执行 shell 必须自身具备受信任的数据库访问权限；“离线”表示不经过平台 HTTP API，
不是无需连接 PostgreSQL。AIO 维护同样须保留可信 DB 访问，不能把整个容器关停后
假定该 CLI 仍可访问容器内数据库。

命令文件必须是绝对路径、普通 JSON 文件，最大 **2 MiB**，不允许 symlink；
其目录和父目录链由受信任运维控制，执行期间不得替换文件。
文件只含动作及其规定字段，不包含数据库口令、Registry 密钥或 ticket 密钥。
凭据不打印、不写入 journal，也不得进入版本控制；避免 shell tracing 和凭据回显。

`inspect` 不要求 `operatorId`，但仍依赖 shell 的 DB 权限。
所有 mutation 均要求 `operatorId` 为数据库内**当前未停用**的
`super_admin` 或 `platform_admin` 用户 UUID，并要求当前 `expectedRevision`。
**用户 ID 只用于操作归属记录，不是登录证明**；知道管理员 UUID 不授予 DB 访问权，
不得把这个入口包装成允许请求者自报 UUID 的未认证接口。

## 状态与运行门禁

| Journal / 配置 | 材料 runtime 行为 |
|---|---|
| 无 journal 且未配置 epoch | 仅 `observe` 兼容模式，不代表历史引用已对账 |
| 无 journal 但配置了 epoch | 拒绝准入；不能用自行生成的 UUID 跳过 rollout |
| `paused` | 拒绝准入，即使配置的 epoch 匹配 |
| `ready` 且配置 epoch 与当前 journal 完全一致 | 通过 rollout 门禁；原身份、权限及材料校验仍然有效 |
| `ready` 但 epoch 缺失或不匹配 | 拒绝准入，不回退到 observe |
| DB 不可用、读取失败或状态无效 | 拒绝准入，不将故障视为空 journal |

这些检查只控制**新请求/操作的准入**，不取消已经通过检查的在途 stream 或安装任务。
epoch 不能隔离不检查它的旧代码；`pause` 不是远程杀进程或全局连接断开命令。
不要以健康探针成功、引用计数为零或票据自然过期代替排空与旧访问撤销。

## 操作顺序

以下 JSON 是命令文件内容示例。尖括号内字段必须替换成实际值；
revision `0/1/2` 只展示首次无并发写入的顺序，实际每次使用最新返回值，
不能复制旧快照反复执行 mutation。

### 1. Inspect 与收集历史配置

```json
{ "action": "inspect" }
```

返回 `phase`、`revision`、`epoch`、`inventoryDigest` 以及
`bindingCount`、`operationReferenceCount`、`activeInstallCount`、
`orphanedOperationCount`，另有最后一次 journal `action`。
无 journal 时为 `observe`、revision `0`、epoch `null`；
`inspect` 不追加 journal，也不改变最后一次 mutation。
digest 是当前绑定、任务引用和退役库存的摘要，不是旧进程全部停止的证明。
`retiredBindingCount` 另报告已退役数量，`bindingCount` 保持历史总数语义。
整体库存快照对 binding、reference 和 retirement 分别进行 **每页最多 1,000 行的 keyset 扫描**，
按稳定顺序增量计算哈希，以分页限制内存占用，不把全部历史记录载入内存。
没有 100,000 行总量上限，不会仅因历史总行数增长而拒绝 pause 或其他 rollout 命令。
DB/query 错误仍使操作失败关闭，不返回截断快照，也不能据此激活；
不得通过删除历史绑定或引用来处理扫描失败。

收集所有历史 `SPACK_MATERIAL_RELEASES` 映射，包括已撤下部署、离线副本、
回滚版本及其部署配置。当前环境变量不代表历史全集；不能只导入当前活跃映射。
counts 不替代这项外部盘点。

### 2. Pause 并完成外部隔离

```json
{
  "action": "pause",
  "operatorId": "<current operator UUID>",
  "expectedRevision": 0
}
```

成功后追加 journal，返回新的 revision 与**全新 epoch**，phase 为 `paused`。
每一次新的 `pause` 都更换 epoch，包括已 paused 或 ready 的部署；没有自动回退。

在 `activate` 前，必须通过部署控制面和凭据管理系统完成以下外部操作：

- 停止接收新业务，排空所有在途安装、发布、上传与下载，再停止**所有 Server 和 Registry**。
  包括当前运行实例、旧版本、离线/缩容副本和可能重新启动的回滚副本；
  禁止自动重启、自动扩容或旧发布配置使它们重新接入。
- 撤销或轮换旧 DB 访问凭据、Registry 认证/签名凭据及材料 ticket 签名密钥，
  并更新访问控制与网络策略，确保旧进程、旧会话和离线回滚副本不能重新获得访问。
  必要时由 DBA 终止旧数据库会话；只换环境变量或密码不等于已经排空旧连接。
- 核实全部历史配置与任务记录已盘点。使用正常运维流程确认任务真实结束并反映到 DB，
  不通过删除引用、伪造终态或直接改表绕过门禁。

**epoch 本身不能 fence 不检查 epoch 的旧 Server/Registry 代码。**
上述停止、排空、撤销和访问/网络策略变更不是 CLI 自动执行的，
也不是把 evidence 三项设为 `true` 就已完成。

### 3. Reconcile 历史绑定

```json
{
  "action": "reconcile",
  "operatorId": "<current operator UUID>",
  "expectedRevision": 1,
  "epoch": "<epoch returned by pause>",
  "bindings": [
    {
      "zlib@1.3.1": {
        "repositoryId": "<historical namespace SHA-256 hash: 64 lowercase hex>",
        "manifestDigest": "sha256:<historical manifest digest>"
      }
    },
    {
      "zlib@1.3.1": {
        "repositoryId": "<another historical namespace SHA-256 hash: 64 lowercase hex>",
        "manifestDigest": "sha256:<another historical manifest digest>"
      }
    }
  ]
}
```

`bindings` 是旧 `SPACK_MATERIAL_RELEASES` **映射对象的数组**，不是 JSON 字符串数组，
也不是单个 binding 数组。同一 spec 的多个历史版本要分别保留。
`repositoryId` 是 namespace 的 SHA-256 ID，必须为 **64 位小写十六进制**，
不带 `sha256:` 前缀，**不是 UUID**；`operatorId` 和 epoch 仍为 UUID。
每次 reconcile 最多 **64 个配置映射**，展开后合计最多 **10,000 条 binding 行**，
命令文件仍不得超过 **2 MiB**，超限即失败关闭。
这些是单次命令的输入限制，不是 append-only 账本的历史总量上限。
对账只追加/幂等登记配置绑定，保留旧绑定和旧任务引用，不覆盖、删除或自动退役。
成功后仍为 `paused`，返回递增 revision、当前 epoch 和库存 digest/counts。

经外部核实确为全新空部署时允许显式 `"bindings": []`，但仍必须执行这次
`reconcile`，不能从 `pause` 直接 `activate`。空数组不是已有部署跳过历史盘点的办法。
补充历史映射时再次 reconcile，并使用新的返回值。

### 4. Activate

```json
{
  "action": "activate",
  "operatorId": "<current operator UUID>",
  "expectedRevision": 2,
  "epoch": "<epoch returned by pause>",
  "inventoryDigest": "sha256:<current reconciled inventory digest>",
  "evidence": {
    "legacyProcessesStoppedAndDrained": true,
    "legacyAccessRevoked": true,
    "legacyInventoryComplete": true
  }
}
```

要求最后一次 journal 动作为 `reconcile`，phase 仍为 `paused`，
revision、epoch 与当前状态精确匹配，`inventoryDigest` 必须同时等于
**最近一次 reconcile journal 中记录的 digest** 和 **当前 DB 库存快照的 digest**；
所有非终态 install operation 必须为零，**包括未登记材料引用的旧安装操作**，
且不能有孤儿引用。只有 `succeeded`、`failed`、`rejected` 是这里的终态；
离线、超时或其他状态不自动视为完成。

三项 evidence 必须全为 `true`，分别确认旧进程停止并排空、旧访问已撤销、
历史库存完整；这是运维确认记录，不是程序对外部隔离事实的自动鉴定。
成功后追加 `ready` journal。失败时保持关闭，重新 inspect、核实前置条件；
库存变化后必须重新 reconcile 并使用最新结果；仅 inspect 漂移后的新 digest
不会更新 reconcile journal，因此不能据此 activate。不要盲目重放旧 activate。

### 5. 配置统一 Epoch 后重启

在恢复任何升级后的 Server/Registry 前，为**所有升级实例**配置同一个、
由本次 `pause` 返回并经 `activate` 确认的 epoch，同时使用轮换后的凭据。
不得混用其他环境、历史 ready 或自行生成的 epoch。确认配置后按批准部署流程重启，
只恢复升级代码；此要求不表示 Server 已支持多实例协调。

| 部署 | 配置来源 |
|---|---|
| full（watch 继承）、scheduler、preview Compose | Server 和 Registry 均透传 `${SPACK_MATERIAL_EPOCH:-}` |
| AIO Compose | `kq.environment.SPACK_MATERIAL_EPOCH` 由 Server/Registry 两个子进程共享 |
| Helm | 共享 `spackMaterial.epoch`，非空时分别注入两个 Deployment 的 `SPACK_MATERIAL_EPOCH` |

配置默认留空，**没有默认 UUID**。Helm 运维 values 可写
`spackMaterial: { epoch: "<epoch returned by pause>" }`，须替换占位符；
不要分别配置互相矛盾的 Server/Registry epoch。epoch 不是凭据，原有
`secrets.existingSecret`、DB Secret 引用及 Registry/ticket 密钥管理仍须保留。
rollout 不改变 Agent 下载路径与安装开关。

## 失败处理与历史保留

rollout journal 为 **append-only**。不要删除、truncate 或改写历史；
删除历史可能把无 epoch 的进程不安全地重置为 observe 兼容模式。
不得用清表、删卷、清空 epoch 或回退旧二进制来解除屏障。
mutation 超时或响应丢失时先 inspect，不假定事务已回滚，也不盲目再次 pause。
新的 pause 会使旧 epoch 失效；需要再次完成对账、外部确认和显式 activate，
不会自动恢复前一个 epoch 或 ready 状态。

部署入口见[部署指南](deployment.md)，材料存储与授权见
[材料发布与下载](spack-material-delivery.md)，能力边界见[当前状态](status/current-state.md)。
