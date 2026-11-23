# 工作流现行指南

Kuintessence 工作流使用控制流 DSL，由 Server 编排，Agent 向目标 scheduler 提交叶子作业。
本文说明 DSL 写法、提交方式、数据流和故障处理。平台运行要求见[当前状态](../status/current-state.md)。

| 入口 | 内容 |
|---|---|
| [DSL](#dsl) | 文档结构、表达式、输入绑定、控制流与执行限制 |
| [执行](#execution) | Web / CLI / HTTP、资源配置、权限与异步生命周期 |
| [物化](#materialization) | 用例解析、命令、文件、Dataset 与类型化输出 |
| [运维](#operations) | 取消、Server / Agent 恢复与失败分诊 |
| [示例](#examples) | YAML 结构示例、VASP mock 和相关源码入口 |

配套 YAML：

- [workflow-schema.yaml](./workflow-schema.yaml)：Draft 2020-12 JSON Schema 的 YAML 表达。
- [workflow-schema-spec.yaml](./workflow-schema-spec.yaml)：四组结构示例，提交前需替换资产引用并核对节点限制。

计算节点可使用成对的用例与软件版本 UUID，或成对的命名资产选择器。选择器在提交时解析为固定修订。
提交时由 shared Zod Schema、静态校验器和 Server 预检共同校验。
Server 的 `/api/dsl/schema/workflow` 提供机器可读 Schema；各字段的执行支持情况见下文。

<a id="dsl"></a>
## DSL

### 文档与作用域

顶层必填 `name`、`spec`；可选 `id`、`description`、`logo`、
`parameters`、`advanced`。`spec` 包含 `nodeDrafts` 和 `nodeRelations`。
以下是无需能力包的最小结构示例：
```yaml
name: "最小工作流"
parameters: []
spec:
  nodeDrafts:
    - type: NoAction
      id: ready
      name: "就绪"
  nodeRelations: []
```

- 节点必填 `type`、`id`、`name`。`id` 匹配 `^[a-zA-Z_][a-zA-Z0-9_]*$`，在当前 scope 唯一。
- 可选 `externalId` 是 UUID，用于业务追踪；连线、表达式与输出引用均使用内部 `id`。
- `Loop.body`、`SubWorkflow.ref.body` 各自形成 `WorkflowSpec` scope，不在 body 声明顶层参数。
- 基础图必须是 DAG；循环与递归用块构造表达，不通过回边表达。
- 静态校验检查重名、引用、插槽、参数和 DAG；能静态推导输出时还检查 descriptor。
- `advanced.skipStaticValidation: true` 仅跳过跨字段静态检查，不跳过 Zod、权限、Dataset 预检或运行期错误。

`parameters[].type` 支持 `bool/int/double/string/bytes/json/timestamp/duration`，
以及 `{ list: <type> }`、`{ map: <type> }`。非空 default 按声明类型转换，非法值失败；
无 default 的参数在 engine 中为 `null`。`workflow submit` 直接提交 YAML，
不会交互询问 `required` 参数，需事先填写 default 或输入绑定。

### 表达式

表达式为 `{ expr: "..." }`，使用 CEL 风格子集，支持标量、列表和字符串键映射字面量、字段访问、索引、算术、比较、逻辑、三元运算，
以及成员运算 `in`、字符串方法 `contains/startsWith/endsWith` 和 `size()`、`has()`、`string()`；不支持任意 I/O、自定义函数或完整 CEL 标准库。
列表支持 `map(x, expression)` 与 `filter(x, predicate)`，过滤条件须为布尔值。数学函数支持 `math.abs/floor/ceil/round/sqrt/pow/min/max`。每条表达式共享一百万步预算，嵌套宏、字符串操作及返回值展开后的元素和字符串长度计入预算。条件只有求值为布尔 `true` 才成立。

| 上下文 | 含义 |
|---|---|
| `params.<name>` | 当前工作流参数 |
| `nodes.<id>.values.<descriptor>` | 当前 scope 已执行节点的值或文件引用 |
| `nodes.<id>.status` | 节点状态，如 `Succeeded`、`Skipped` |
| `loop.item`、`loop.index` | ForEach 当前元素与从 0 开始的序号 |
| `loop.iteration` | While 当前轮次，从 0 开始 |
| `loop.previous.values.<descriptor>` | While 上一轮经 Loop outputs 映射后的值 |
| `loop.carry.<input>` | While 本轮携带的输入 |

`nodes` 不跨 body scope 自动继承；父级数据经 carry 或 SubWorkflow inputs 显式传入。
`ctx.*` 和 `nodes.<id>.outputs.*` 命名空间不可用。
守卫、选择器或循环表达式出错时，节点失败并返回诊断信息。

### 输入与依赖

输入以 descriptor 绑定；每个 slot 只能选用 `from`、`sources`、`contents` 中一种来源形态。
```yaml
inputSlots:
  - type: Text
    descriptor: temperature
    from: { param: temperature }
  - type: File
    descriptor: restart
    isBatch: false
    from: { node: solve, output: checkpoint }
```

- `from` 接受 `{ param }`、`{ node, output }` 或 `{ expr }`。
- `Text` 运行输入接受 string、number、bool 标量，不接受 list、map、File 或 File[]。
- `File.contents` 是 NetDrive metadata 数组，含 `fileMetadataId/fileMetadataName/hash/size`；
  单文件使用第一项，批量需 `isBatch: true`。文件来源可以是上游 `FileValue` / `FileValue[]`。
- Dataset 使用专用 immutable 引用，限制见[物化](#materialization)。
- `nodeRelations` 定义执行顺序，`slotRelations` 描述插槽映射和 `Network/Disk` transfer strategy。
  手写 YAML 时同时填写消费端 `from/sources` 与执行依赖。
- engine 的拓扑顺序由显式关系和 Switch 控制边决定；普通 `from`、表达式和 Reduce 引用不自动补依赖。

分支汇合使用非空 `sources`，`select` 必须与 `sources` 一起出现：
```yaml
inputSlots:
  - type: File
    descriptor: result
    isBatch: false
    sources:
      - { node: small, output: result }
      - { node: large, output: result }
    select: FirstAvailable
```

`FirstAvailable` 按顺序选第一个 `Succeeded` 且输出存在的来源；缺省选择策略相同。
`RequireExactlyOne` 要求恰好一个可用来源；`{ expr: "..." }` 必须返回有效的 0-based source index。
`Failed/Cancelled/Skipped` 节点残留的 values 不可选；非法索引或显式选中 absent 来源会失败。

任一显式前驱 `Skipped` 会先使下游 `Skipped`，
前驱 `Failed/Cancelled` 会使下游 `Cancelled`，发生在消费侧选择之前。
因此，将互斥分支同时设为汇合节点的硬前驱，会使该节点在 `FirstAvailable` 选择前被跳过。
多分支汇合需按这一传播规则设计依赖。
`when=false` 的节点、关系或 slot relation 会跳过目标；必填直接绑定缺失也会跳过节点。

### 节点与控制流

| 类型 | 当前行为 |
|---|---|
| `SoftwareUsecaseComputing` | 解析用例与软件版本，物化并提交 Job，回收值和文件 |
| `Script` | 经受管 Sandbox 执行；需要脚本 revision、runtime、身份、签名与目标能力 |
| `NoAction` | no-op 成功，返回空 values，不自动透传输入 |
| `Milestone` | 向提交人记录站内通知，按个人设置排队发送邮件和 Webhook。若声明 URL，必须匹配提交人登记的 Webhook。受限联邦工作流禁止外发。 |
| `Generate` | 在 Server 内生成列表，不提交 scheduler job |
| `Switch` | 按 cases 顺序选择第一个 `when=true` 的目标，否则选 default；无命中且无 default 时跳过所有目标 |
| `Loop` | ForEach 并发迭代或 While 有界迭代，body 为子图 |
| `Reduce` | 对 Loop 聚合结果执行 Collect、Concat、ExtractTable、Statistics |
| `SubWorkflow` | 执行 Inline body 或按 ByVersion 解析 template |

Script 使用两组独立的必选二选一：`source/scriptRef` 与 `runtimeProfileId/runtimeContractRef`。
`source` 可为 `AssetRevision`（assetId、正整数 revision、64 位小写 SHA-256，可选 assetRevisionId）
或 `Inline`（language 为 python/nodejs/bash，携带 content）。两者均受部署策略限制。
`scriptRef` 为 named asset selector，`runtimeContractRef` 为 `{ name, version }`；
UUID `runtimeProfileId` 与 named `runtimeContractRef` 均为有效引用形式，二选一。
`inputs/outputs` 是 descriptor 到 manifest 的映射，类型为 `Text/JSON/File/FileBatch`；
outputs 还可配置 validator、locality、durability、sizeHint。运行绑定放在 `inputSlots`。
可选执行字段包括 executionIdentity、schedulingStrategy、requirements、placementConstraint；
缺省身份为 Inherit、调度为 Auto，具体授权与 runtime 可用性由 Sandbox 检查。

Generate 支持 `Enumeration/Range/Linspace/FixedCount/CartesianProduct/Zip/Sampling`。
Range 包含起点和步长可达的终点，step 不得为 0；Zip 各轴必须等长。
复合 axes 不得为空，FixedCount 的 Enumeration filler 不得为空；
Range、Linspace、FixedCount 和 CartesianProduct 的规模计算设有百万项限制；大列表会增加 Server 内存占用。
`Sampling` 支持 Random、LatinHypercube、Sobol 和 Grid，可选择 Uniform、Normal、Choice 分布。Random 与 LatinHypercube 默认使用种子 0；Sobol 省略种子时使用标准序列，指定种子时使用数字移位。Grid 取网格单元中点。每次最多生成一百万个坐标值。
`FromFile` 读取当前提交人拥有的固定版本文件，最大 8 MiB，校验摘要后解析 UTF-8 CSV、JSON 数组或 JSONL。来源可选上游节点输出或 `source: upload`（工作流参数 `upload` 中的单文件引用）。`mapping` 的键为输出字段名，值为源列名。
本地工作流的 `output.as: BatchFiles` 将每一项保存为独立 JSON 文件，在 NetDrive 的 `workflows/<runId>/generated/` 下可下载。每批最多 256 个文件，共 8 MiB；全部对象校验后在同一事务中发布文件引用和访问权限。

ForEach 的 `over` 必须求值为列表；长度超过 `maxIterations` 时失败，空列表成功并返回空聚合。
`maxParallel` 为正整数；省略时并发度可达列表长度。叶子 Job 仍受 scheduler 配额限制。
每轮 body 输出按原始 index 顺序聚合，声明输出缺失会使 Loop 失败。
`aggregate: Collect` 按迭代顺序保留值，`Concat` 将标量依次拼成文本。ForEach 默认 Collect，While 默认返回最后一轮的值。统计与表格使用独立 Reduce 节点。

While 每轮先执行 body，再计算 `until`；`maxIterations` 必须解析为正整数。
达到上界默认失败，`onExhausted: SucceedWithLast` 返回最后一轮输出。
`carry.initial` 从父 scope 取得初值，随后 `carry.from` 取上一轮 body 输出，
并给 body 中同 descriptor、未显式绑定的 input 自动挂接 `loop.carry`。
显式 initial 或上一轮来源缺失时失败；首轮没有 previous，引用前应作存在性判断。

Reduce 的 `from` 指向 Loop 与其输出 descriptor；Collect 返回列表，空列表有效。
Concat 只接受标量并拼接文本；ExtractTable 按迭代生成 CSV 文本，至少声明一列；
Statistics 至少指定一个 metric，输入必须是非空有限数值序列。
`Value` 将聚合值传给下游节点。本地持久工作流的 `SingleFile` 返回可下载的 NetDrive 文件引用。字符串按 UTF-8 写入，结构化值按 JSON 写入，单个文件引用按其固定版本复制字节。`OrderedFolder` 接受列表，在同一目录中按迭代顺序生成带序号的文件并返回引用数组。`fileName` 可指定文件名，每批最多 256 个文件、8 MiB。
`Command` 以 `items` 接收 Loop 的有序列表，执行结果取自 `output.descriptor` 指定的输出。用例通过 `usecaseRef.usecaseVersionId` 与 `softwareVersionId` 指定修订，`items` 为 JSON 编码的 Text 输入。Sandbox 脚本通过 `script.source` 指定固定修订或内联内容，并选择 `runtimeProfileId` 或 `runtimeContractRef`；脚本从 `/kq/inputs/items` 读取 JSON，将 JSON 结果写到对应的 `/kq/outputs/<descriptor>`。

签名目录中的用例汇总同时填写 `reducer.usecaseRef` 和 `reducer.softwareRef` 两个名称选择器。脚本汇总填写 `reducer.script.scriptRef`、`runtimeContractRef` 和 `executionIdentity: { type: MappedAuto }`。发布时校验配对关系，修订目录时同步更新名称与版本，提交工作流时固定为具体修订。执行器沿用节点的作业身份和调用记录。受限联邦工作流中的脚本须继承协议身份（`Inherit`），其软件、脚本与运行环境由接收方按绑定复核。
Collect 聚合得到的 `FileValue[]` 可用于 `isBatch: true` 的 File 输入。

SubWorkflow 的 `maxDepth` 为调用深度上界；ByVersion 在 Server 中按 `workflow_templates.id` 读取 YAML。
输入经 `inputs[].to.param/from` 显式传入，ByVersion 先加载子工作流参数 default；
显式输入为 absent 或表达式错误时失败。输出通过 `workflowOutput` 查找子节点 values，
应使用唯一 descriptor；运行期缺失或歧义输出可能被省略，此时子节点未必失败。
`onDepthExceeded: SucceedWithLast` 超限时成功但返回空 values，并不保留上次结果。
Web 的 ByVersion readiness 会拒绝无法解析或成环的模板，提交时也需通过这项检查。

同一作用域按拓扑顺序执行节点。ForEach 可以并发执行多个迭代，外部 Job 的执行时限由调度器控制。

并发 ForEach 的直接用例节点落在同一 Slurm Agent 时，Agent 会把 25 毫秒内准备就绪、队列与资源指令相同的 2 至 6 个作业作为一个 job array 提交。各项沿用自己的工作目录、输入、环境、日志和退出码。数组下标只标识这次提交中的成员，工作流仍按原迭代顺序收集结果。独立运行、不同节点及嵌套循环的不同调用分别分组。

使用受管 Spack 软件的普通用例须有相同的 spec 才能合批。携带软件锁定信息（pin）的成员还须有完全一致的 pin，与只指定 spec 的成员分开提交。软件操作队列和站点策略一致时，同组并发成员可以共用一次进行中的环境加载，各自执行自己的命令。加载结束、其间插入其他软件操作或策略变更后，到达的成员重新核验环境。单个成员取消或超时后，其余成员可以继续加载。

只有一个成员、使用 Sandbox 或联邦授权、要求受限网络、携带受管数据交付或许可材料挂载时，Agent 逐项提交。含自定义 `#SBATCH` 指令或单项生成脚本超过 16 KiB 的作业也单独提交。嵌入式运行器共用工作目录，有输入文件需要复制或有输出文件需要采集的用例也逐项提交。Slurm 明确拒绝数组格式时，Agent 改为逐项提交。`sbatch` 回执丢失时，服务模式的 Agent 按持久记录、调度器注释中的作业 UUID 及数组下标找回对应成员；身份无法确认时保留待核对记录。取消仍折叠在父记录中的成员时，Agent 先按下标请求 hold，确认成员拥有独立记录后再取消。

<a id="usecase-hooks"></a>
#### 用例的前处理与后处理

在工作流 YAML 的 `SoftwareUsecaseComputing` 节点上声明 `hooks.pre` 或 `hooks.post`。下面的节点把参数 `raw` 交给前处理脚本，将脚本的 `normalized` 输出作为用例的同名输入，再将主作业的 `result` 文件交给后处理脚本。下游通过 `{ node: solve, output: summary }` 读取最终结果。示例 ID 和摘要须替换为站点的真实修订。

```yaml
type: SoftwareUsecaseComputing
id: solve
name: Solve
usecaseVersionId: 10000000-0000-4000-8000-000000000010
softwareVersionId: 10000000-0000-4000-8000-000000000011
inputSlots:
  - { type: Text, descriptor: raw, from: { param: raw } }
outputSlots:
  - { type: File, descriptor: result, isBatch: false, origin: UsecaseOut }
hooks:
  pre:
    source: { type: AssetRevision, assetId: 10000000-0000-4000-8000-000000000012, revision: 1, sha256: aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa }
    runtimeProfileId: 10000000-0000-4000-8000-000000000001
    inputs: { raw: { type: Text } }
    outputs: { normalized: { type: Text } }
  post:
    source: { type: AssetRevision, assetId: 10000000-0000-4000-8000-000000000013, revision: 2, sha256: bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb }
    runtimeProfileId: 10000000-0000-4000-8000-000000000001
    inputs: { result: { type: File } }
    outputs: { summary: { type: Text } }
```

签名生态模板的前后处理可以引用同一发布清单中的脚本。例如，前处理使用以下写法：

```yaml
hooks:
  pre:
    scriptRef: { source: platform-fork, name: Normalize input, version: "2" }
    runtimeContractRef: { name: python-3.12-stdlib-v1, version: "1" }
    executionIdentity: { type: MappedAuto }
    inputs: { raw: { type: Text } }
    outputs: { normalized: { type: Text } }
```

每个钩子选择一对引用：固定的 `source` 与 `runtimeProfileId`，或命名的 `scriptRef` 与 `runtimeContractRef`。Registry 导入时核对脚本名称、版本与运行时契约。Server 在创建运行前检查提交人对脚本的使用权。对于生态发布的脚本，Server 从当前已验签的发布中冻结修订 ID 和内容摘要。

解析器在放置与执行之前把钩子展开为普通 Script 节点。前处理接收用例节点的 `inputSlots`，它声明的输出构成主作业的输入。后处理按自己的输入声明读取主作业的同名输出，文件和文件批次须在主作业 `outputSlots` 中声明。最后一个阶段提供该节点对下游的输出。

例中的三个执行 ID 依次为 `solve__pre`、`solve__main`、`solve`。单独配置前处理时，主作业保留 `solve`。工作流内的条件和分支选择作用于首个阶段，失败会取消后续阶段。每个阶段继承用例节点的调度策略与资源要求，有独立的执行与恢复记录。提交体中的逐节点放置约束使用展开后的 ID。每个钩子均可声明 `executionIdentity`，默认继承运行身份。

<a id="execution"></a>
## 执行与配置

### 提交入口

Web `/workflows/new` 使用“工作流编辑 → 输入文件/参数配置 → 算力资源配置 → 预览并提交”。
从空白或 Registry template 开始，用例来自已发布目录，转换脚本来自受管 Sandbox revision。
连线需确认 I/O 映射；节点 `id` 与引用保持英文机器值，显示名称可用中文。
Script 的输出描述符定义在 `outputs` manifest 中，无需重复声明同名 `outputSlots`。

保存写入 owner-scoped draft，不创建 run，也不占用队列；从 `/workflows` 可继续编辑或删除。
输入配置只上传已关联的本地文件，并把 NetDrive metadata、参数与 Dataset 引用写回 canonical YAML。
提交前重新解析最终 YAML；空画布、必填缺失、文件未确认、Dataset 无权限或 queue 不可见均应先处理。
ByVersion 内的 Dataset 不能由父页面直接改写，需先更新被引用模板或改成 Inline。

CLI 命令：
```bash
kq dsl validate workflow.yaml
kq dsl schema -o workflow.json
kq workflow submit workflow.yaml
kq workflow status <runId>
kq workflow list
kq workflow cancel <runId>
```

`dsl validate` 是离线检查；`dsl schema` 访问 Server。`submit` 返回 run handle，用 `status` 查看结果。
CLI 当前没有独立的参数覆盖或 planner flags，额外 placement 配置使用 Web 或 HTTP。

### HTTP API

所有路径均包含 `/api` 前缀，需要已绑定的认证 principal。
| 方法与路径 | 行为 |
|---|---|
| `POST /api/workflows` | 异步提交；接受 JSON `{ yaml, ... }` 或 `application/yaml` 原文 |
| `GET /api/workflows` | 分页列表：`limit` 1–100，默认 25；`offset` 默认 0；可传 `q`、`status` |
| `GET /api/workflows/:runId` | run detail，含 graph、stepJobs、result 与错误诊断 |
| `POST /api/workflows/:runId/cancel` | 请求取消，返回 `{ runId, status }` |
| `GET/POST /api/workflows/drafts` | 列出或创建自己的草稿 |
| `GET/PUT/DELETE /api/workflows/drafts/:draftId` | 读取、更新或删除自己的草稿 |
| `GET /api/workflows/:runId/placement-plans` | 查看 placement plans |
| `POST /api/workflows/:runId/replan` | 请求重新规划 |
| `POST /api/workflows/:runId/placement-plans/:planId/approve` | 审批计划并恢复排队 |

列表 `status` 可为 `active/completed/failed/cancelled`。
canonical submit 正常返回 `202` 和 `{ runId, name, status: "submitted" }`；
需要预算审批时返回 `status: "awaiting_approval"`，批准后才开始执行。
JSON 提交体还可传：
```json
{
  "yaml": "<完整 workflow YAML>",
  "plannerMode": "Global",
  "defaultExecutionIdentity": { "type": "MappedAuto" },
  "budgetCap": null,
  "placementConstraint": null,
  "subgraphPlacementConstraints": {},
  "nodePlacementConstraints": {}
}
```

`plannerMode` 可为 `Global/Lookahead/Greedy`，默认 Global；budgetCap 为非负数或 null。
这些是提交配置，不是 Workflow 顶层字段；原文 YAML 请求无法携带它们。
draft 请求体为 `{ name, yaml, placementConfig }`，其嵌套配置键为
`runConstraint/subgraphConstraints/nodeConstraints`，与提交体的外部命名不同。

`POST /api/workflows/run` 仅为同步调试入口：非 production 启用，
production 需显式 `WORKFLOW_SYNC_ENABLED=true`。它在请求内同步执行，
不支持异步路径中的预算审批、Script 执行、取消与重启恢复流程。

### 生命周期与权限

canonical 路径先解析 YAML、冻结 named references、校验组织成员身份与 Dataset，
再持久化 run、登记权限、准备 placement，之后由 Server 进程内后台 worker 执行。
授权或 placement 准备失败使 run 标记 failed 并返回错误；预算批准后重新校验提交者和数据访问。

run 状态包括 `submitted/queued/awaiting_approval/running/cancelling/completed/failed/cancelled`。
节点状态与 run 状态不同：结果中使用 `Succeeded/Failed/Skipped/Cancelled` 等名称。
`stepJobs` 记录执行节点到 Server Job 的映射，scheduler job ID 在对应 Job 中；
失败诊断可保留 Job ID、exit code、内层节点与迭代上下文。

本地权限模式下非管理员仅访问自己的 run；enforce 模式按 `workflow#view/cancel` 授权。
replan 和 approve 使用 cancel 权限；叶子 Job 仍接受 queue、软件、数据及组织治理检查。
Server 通过数据库租约恢复运行中的工作流，并复用执行日志中已完成的节点和作业。当前 Helm 部署使用单实例，Agent 会话与调度任务的跨实例接管仍待验收。

### 资源与环境

`schedulingStrategy` 的队列 ID 复用 queue registry 的 `QueueIdSchema`：1–255 字符的不透明字符串，
允许命名 ID（例如 `cloud-lab-bootstrap`）及 UUID，不要求 UUID 格式；空字符串或超过 255 字符会被拒绝。
`Manual.queues` 必须恰好一个队列 ID，作为硬 queue 选择；
`Prefer.queues` 至少一项，作为软偏好，可跳过不可用项并 fallback；`Auto` 由 placement 选择。
queue registry 提供 partition/QoS，仍受可见性、启用状态、`queue#submit`、用户偏好和可用资源约束。
无可用 Agent、通道关闭或 stage-in 失败会回传失败，不自动等待 Agent 重连重试提交。

用例节点 `requirements.cpuCores` 映射 Job cpus，`maxWallTime` 映射 wallTimeSec，单位为秒。
`nodeCount` 指实际分配的节点数。Slurm、PBS Pro 和 Torque 将作业总 CPU 与内存分配到各节点，资源总量须能被节点数整除。节点和用例均省略 CPU 时，每节点申请一个核。Kubernetes Job 和受管 Sandbox 限单节点。
`maxCpuTime` 以秒限制整个作业的累计 CPU 时间，由 PBS Pro 或 Torque 的 `cput` 执行。
`stopTime` 为 UTC Unix 秒，配合 `maxWallTime` 生成 Slurm 的 `--deadline`。超过截止时间或后端无法落实声明的约束时，放置会拒绝该候选。
工作流从用例包继承 CPU、内存、GPU 和墙钟时间。节点可覆盖 CPU 与墙钟时间。
未声明时保持 1024 MiB 默认值；未声明 CPU 时使用 1 CPU。

| 配置 | 作用与注意事项 |
|---|---|
| Server `WORKFLOW_RUN_BASE` | 设置后每个 Job 工作目录为 `<base>/<jobId>`，统一 stage-in、cwd 与相对输出路径；文件链路应明确配置 |
| Server `NETDRIVE_ENABLED` 与存储配置 | 启用 NetDrive 输入与输出 artifact；须保证 Agent 到对象存储可达 |
| Server `SERVER_JOB_COMPLETION_TIMEOUT_SEC` | 等待 Agent 终态的超时，默认 604800 秒；不是 scheduler walltime |
| Agent `AGENT_SPAWNER_BACKEND` | `host` 或 `container`，默认 host |
| Agent `AGENT_SLURM_CONTAINER_ID` | container backend 必填，指向已配置容器，不会替使用者创建环境 |

普通 Slurm 作业的 stdout/stderr 写入 Agent 的共享 scheduler 日志目录，
与作业 `workingDir` 分离；host backend 使用 `AGENT_JOB_WORK_ROOT/.scheduler-logs`。
该目录必须对执行节点可见并持久保存，才能在 Slurm 作业记录清理及 Agent 重启后
按 Job ID 回读日志。Sandbox 仍使用自身执行目录，不写入普通作业的共享日志目录。
这不改变 stage-in、cwd 或相对输出文件的解析位置，也不提供日志自动归档或保留期限管理。

QoS 拒绝规则取决于目标 Slurm accounting 配置。Web 显示预计时间和费用，实际用量由站点计量。

<a id="materialization"></a>
## 用例物化与数据流

### 版本解析与命令

计算节点使用成对的 `usecaseVersionId/softwareVersionId`，或成对的 `usecaseRef/softwareRef`，
二者互斥。named selector 包含 `source/name/version`，可选 `providerOrgId`；
`cp-private` 必须指定 providerOrgId。Server 解析 active identity，并把冻结结果写入持久化 YAML。
`frozenAssetRevisions` 保留 revision 来源；Job 中 canonical usecase package ID 与 software asset ID 分开保存。

当前 Server governed resolver 要求可执行的治理能力包（`GovernedUsecasePackage`），
通过 `softwareRef` 结构识别，并校验其 software selector 与冻结 revision 一致。
Spack 用例读取已冻结软件修订中的 `defaultSpec`。签名目录可为 Spack 软件使用不同于实际包名的展示名称。此时 `softwareRef.name` 使用目录名称，Server 核对激活发布的签名和修订，再按修订中的 Spack spec 生成作业。本地治理工作流和用例作业也支持站点预装的 Bare 程序和 Singularity SIF 镜像。二者使用已激活签名生态包中的 `site-runtime` 软件修订，`softwareRef.source` 为 `platform-fork`。

例如，Bare 软件的发布条目可使用以下 payload。示例摘要需替换为计算节点上文件的实际 SHA-256。

```yaml
kind: site-runtime
siteIds: [example-site]
runtime:
  kind: Bare
  path: /opt/site/solver/1.0/solve
  sha256: "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"
```

Bare 用例的 `commandFile` 填写程序的文件名或完整路径。对于 SIF，填写 `runtime.kind: Singularity`，`path` 指向 SIF 文件，`sha256` 取该文件的摘要。`runtime.image` 和 `runtime.tag` 须与用例声明一致。签名清单包含站点 ID、软件身份、版本和许可证。Server 解析修订和筛选站点时使用 `ECOSYSTEM_RELEASE_TRUSTED_KEYS` 验签，核对当前激活的修订、站点范围和使用权限；这些预装资产用于本地执行。站点管理员负责安装程序和镜像。

站点管理员须在所列站点的作业执行环境提供不可变、作业用户只读的程序或镜像路径，升级时发布新路径和摘要。计算节点须有 GNU `/usr/bin/sha256sum` 和 `/usr/bin/env`。作业脚本启动应用前校验文件内容，文件缺失或摘要不符时作业失败。SIF 通过站点的 `/usr/bin/apptainer exec --cleanenv --no-eval` 启动，应用环境变量传入容器。
```text
节点输入 + 冻结能力包
  → resolvePackage → materialize → wrapCommand
  → Job 持久化与权限检查 → placement → stage-in → DispatchJob
  → Agent / scheduler → 输出收集 → artifact 发布 / extractValues
  → nodes.<id>.values → 后续控制流
```

`materialize()` 是无 I/O 的转换；产物包括 `facility/argv/envVars/inputStaging/expectedOutputs/stdinText`。
控制流、资源映射、调度、文件传输和结果提取由调用层承担。

| 材料引用 | 物化结果 |
|---|---|
| `ArgRef` | Argument `valueFormat` 先按空白切 token，再替换 `{}`，按 sort 排入 argv |
| `EnvRef` | 按 Environment key 与 valueFormat 生成 envVars |
| `FileInputRef` | 生成 fileMetadataId 到相对 stagePath 的暂存计划 |
| `StdinRef` | 单个文本标准输入；多个 StdinRef 会失败，不支持二进制 stdin |
| `FilesomeOutput` | Normal 文件路径或 Batched glob，生成 expectedOutputs |

输入暂存和输出路径须通过安全相对路径约束，不能借 `..` 访问工作目录外。
嵌入式运行器的 `wrapCommand()` 对 argv 逐项做 shell quoting。Spack 使用 `spack load --sh` 激活，Singularity 使用 `apptainer exec`，Bare 直接运行。
软件 spec、镜像与 commandFile 由发布者审核，其中的 shell 内容可直接影响执行命令。

shared 提供独立的 `${...}` CEL 模板渲染函数，表达式结果须为标量。用例节点支持的输入文件通过 `FileInputRef` 声明。
用例 `outputs[].validators` 与 Sandbox `outputs.<descriptor>.validator` 支持 `{kind: finite}` 和 `{kind: cel, expr: "value >= 0"}`。
用例校验提取后的值或文件引用；Sandbox 校验文本、JSON 或文件的 `sha256/sizeBytes/members`，整批校验通过后开始登记产物。
环境材料的键使用 shell 变量名，值中的空白原样传递。
输入文件渲染和复杂验证需使用受管 Script 或已发布用例。

单作业接口独立于工作流：`POST /api/jobs/usecase/materialize` 返回物化结果，
`POST /api/jobs/usecase/preview-placement` 预览放置，
`POST /api/jobs/usecase` 提交作业。它们仍执行各自的权限、软件与数据预检。

### 文件与 Dataset

NetDrive metadata 标识输入文件。Server 为 stage-in 准备传输，Agent 将文件写入 Job 工作目录。
单文件输出必须在 DSL `outputSlots` 显式声明，并与能力包的输出 descriptor 对应。
Server 通过 cluster-to-cloud 传输发布 artifact，再把 FileValue 写入节点 values，
下游 FileInputRef 使用该引用重新 stage-in，文件按二进制传输。

批量输入要求 `File.isBatch: true` 与 `FilesomeInput.fileKind.kind: Batched` 配合，
每个文件生成独立暂存记录。Batched glob 的相对路径 metadata 用于逐个发布输出，
最终得到 `FileValue[]`；空 glob 保留为 `[]`，是合法的空批次，不是 missing output。
声明的文件输出缺失或 normal/batch 形状错误会使节点失败。
需要提取值时采集文件内容；仅作为 artifact 的输出可只回传路径。

Dataset 支持 `SoftwareUsecaseComputing` 和 `Script` 的静态 node-level Data Market binding。
Script 必须在 `inputs` 中将同名 descriptor 声明为 `FileBatch`：
```yaml
inputSlots:
  - type: Dataset
    descriptor: reference_data
    contents:
      source: data-market
      assetId: 11111111-1111-4111-8111-111111111111
      versionId: 22222222-2222-4222-8222-222222222222
      manifestDigest: "sha256:<实际 immutable manifest digest>"
      selectedEntries: [reference/coefficients.csv]
      targetPath: inputs/reference-data
```

使用时替换示例 UUID 与 digest。Dataset 不支持 `from/sources/select`、
NetDrive source、上游动态输出，也不适用于 NoAction。
Script 将完整引用冻结到 Job 的 `dataInputs`，继续使用数据市场授权、受限 placement 和只读交付；
声明 Dataset 不授予访问权，也不会把受限文件转换为普通暂存文件。
不同节点同名 descriptor 可绑定不同版本；Web 保存 draft 时持久化完整引用。
Server 在创建 run 前递归预检顶层、Loop 和 Inline/ByVersion SubWorkflow，
冻结提交组织；审批恢复、可恢复排队及叶子 Job 再按该组织校验权限、digest 和 typed constraints。
补齐 target path 后进入 `jobDataBindings`、placement 与 delivery；版本撤回或权限变化必须阻断执行。

### 类型化输出与失败

能力包 `valueOutputs` 从 collected 文本中用 `Whole/Regex/JsonPath` 提取类型化值。
节点设置 `valueOutputsOverride` 时整组替换能力包规则。
```yaml
valueOutputsOverride:
  - descriptor: residual
    type: double
    from: { collectedOutDescriptor: metrics }
    extract: { kind: Regex, pattern: "residual=([0-9.eE+-]+)", group: 1 }
    onMissing: Fail
```

string 只接受标量；int 必须为整数；double 必须有限；bool 接受布尔或 `"true"/"false"`。
list/map 递归转换；`onMissing: Default` 必须显式提供 default，且 default 也须符合声明类型。
`Text`、模板与 value extraction 的输入需符合声明类型，对象或缺失值需先转换或处理。

Agent 在 Job 成功后 best-effort 采集最近 stdout 到 `collected.stdout`，同名文件输出优先。
stdout 日志采集失败仅降级记录，但 required value extractor 缺值仍可导致 workflow 节点失败；
因此，scheduler 已 completed 的 Job 仍可能对应 Failed 节点。
终态输出收集异常会回传 failed；排障时分别检查执行、采集、发布和提取过程。

文件服务配置、multipart 与排障见 [NetDrive / RustFS](../storage.md#transfers)；
Script 身份、runtime、安全隔离和 artifact 生命周期见 [Sandbox](../software.md#sandbox)。

<a id="operations"></a>
## 取消与恢复

### 取消运行

使用 `kq workflow cancel <runId>` 或 `POST /api/workflows/:runId/cancel`，
然后轮询 run detail；`cancelling` 表示仍在等待取消和清理完成。
未启动且无 stepJobs 的 run 可直接收敛为 cancelled；已有 Job 的 run 进入清理流程。

Server 从 `stepJobs` 找到已提交 Job，对尚未 completed/failed 的 Job 持久化取消状态，
通过 cancellation outbox 向 Agent 发送撤销并等待 acknowledgement，
随后释放节点完成等待；全部清理成功后 run 才收敛为 `cancelled`。
清理失败会保留 `cancelling`，日志为 `Workflow cancellation remains pending for recovery`。
重复取消可重试待清理 run；对已终态 run 返回当前状态。

取消后核对 run、Server Job 和目标 scheduler 的状态。
使用 Slurm 时，由站点管理员确认关联作业已终止、资源已释放。
已完成或失败的作业保留原终态；对仍在排队或运行的作业，核对取消结果。

### Server 重启

Server 将新提交的普通和联邦工作流写入 PostgreSQL 执行日志。恢复器取得 run 租约后重新校验提交身份和组织范围，再按原工作流定义继续执行。

| 重启时状态 | 恢复行为 |
|---|---|
| `queued` | 重新领取已授权的 run |
| `running` | 读取已完成节点与循环迭代的检查点，已有作业按持久调用标识恢复等待或归集 |
| `awaiting_approval` | 保留审批状态，批准后进入队列 |
| `cancelling` | 继续取消已提交作业并等待确认 |

检查点冲突需要人工核对。计算程序中途退出后的续算由应用本身提供的 checkpoint 决定。

### Agent 重启

Agent 从本地 SQLite active job 记录恢复已有 `schedulerJobId` 的轮询，不重复 submit。
已撤销或有 revocation tombstone 的 Job 不恢复执行；
孤立 cleanup intent 会尝试按 Kuintessence Job ID 查找 scheduler 作业并取消、清理交付。
查找或清理失败时保留 intent，供后续重试。

这依赖持久化的 Agent 状态、scheduler 可查询性与执行身份仍然有效；
本地状态丢失、提交落盘期间故障或网络分区后，需要人工核对调度器记录。
Agent 恢复 Job 轮询后，已经 interrupted 的 Server 工作流仍按上一节的规则处理。

### 失败分诊

| 现象 | 优先检查 |
|---|---|
| API 401/403/404 | 登录 principal、owner/admin 范围、`workflow#view/cancel`；本地隐藏 run 可返回 404 |
| 提交失败但已有 run | 检查 run 的 `WORKFLOW_AUTHORIZATION_FAILED` 或 `WORKFLOW_PLACEMENT_FAILED` |
| Job 未派发 | queue 可见性/启用状态、授权、软件可用性、Agent stream、stage-in 错误 |
| run 长期 cancelling | stepJobs、cancellation outbox acknowledgement、Agent 连接与 scheduler cancel/清理错误 |
| Server Job cancelled 但远端仍运行 | 撤销下发与确认是否完成；由站点管理员检查，必要时按站点流程人工取消 |
| Server 重启后未成为 failed | running run 可能仍在取消清理；先看 errorCode 和待确认撤销 |
| Agent 重启后无法恢复 | SQLite active records、cleanup intents、revocation 状态与 scheduler 查询权限 |
| scheduler completed 但节点 Failed | output collection、artifact metadata、value extractor、必需输出及类型错误 |
| Web 状态未更新 | 先查 `GET /api/workflows/:runId`，再核对前端轮询/订阅 |

重启会影响同一 Server/Agent 上的其他作业，恢复演练需安排维护窗口或使用隔离环境。
取消会停止后续执行，但保留已产生的外部改动。

<a id="examples"></a>
## 示例与源码入口

### YAML 示例

`workflow-schema-spec.yaml` 是以 `example_*` 为键的示例集合，
提交时须取其中一个完整文档，不能把整个集合直接交给 `workflow submit`。
示例含占位 UUID、Dataset digest 与能力包描述符；需要按已发布资产和运行期约束重新绑定。
其中 scatter 示例把 map 送入 Text、把 Reduce 文本接入 File，Switch 示例有硬前驱汇合限制；
运行前需修正这些类型绑定和依赖关系。

### VASP mock 流程

[workflow-vasp-pipeline.test.ts](../../test/e2e/workflow-vasp-pipeline.test.ts)
提供 `textValueWorkflow()` 和 `fileArtifactWorkflow()`，用于阅读三段式链路：
```text
VASP mock 计算 → 转换用例 mock → VASP mock 计算
```

[mock-vasp fixtures](../../test/e2e/fixtures/mock-vasp/) 使用文本占位文件，
包括占位文件 `POTCAR.mock`；进行 VASP 计算需另行准备获授权的程序和科学输入。
转换环节使用 mock usecase。

在测试环境中适配此示例：
1. 按 fixture 准备 mock 输入归档，通过 NetDrive upload-url、presigned upload、files commit 得到 metadata。
2. 参考 fixture 的命令与输出声明，准备当前 governed resolver 接受的已发布用例与冻结软件 revision。
3. 标量路径由 metrics 提取 energy，再经 Text 绑定传入下游；能力包使用 governed resolver 支持的 Spack 类型。
4. 文件路径显式声明 `relaxedArchive`，下游以 File `from` 绑定并 stage-in 为 `upstream.tar.gz`。
5. 提交后查询 run 与 stepJobs，区分 Job 执行成功、文件发布成功、最终值提取成功。

fixture 的预期值用于检查编排和数据传递。
文件 artifact 应保持二进制内容；批量文件的同类入口见
[workflow-batch-files.test.ts](../../test/e2e/workflow-batch-files.test.ts)。

### 阅读索引

E2E fixture 会按场景启动 PostgreSQL、RustFS、Slurm、Server、Agent 等组件，运行前准备独立测试环境。

| 主题 | 入口 |
|---|---|
| DSL / 静态校验 / CEL | [workflow-dsl](../../packages/shared/src/workflow-dsl/) |
| 控制流、绑定与输出语义 | [engine.ts](../../packages/shared/src/workflow/engine.ts)、[usecase-executor.ts](../../packages/shared/src/workflow/usecase-executor.ts) |
| 能力包与命令物化 | [usecase](../../packages/shared/src/usecase/)、[package-resolver.ts](../../packages/server/src/workflow/package-resolver.ts) |
| API 与后台生命周期 | [workflows.ts](../../packages/server/src/routes/workflows.ts)、[async-runner.ts](../../packages/server/src/workflow/async-runner.ts) |
| Server 服务接线与取消确认 | [index.ts](../../packages/server/src/index.ts)、[run-registry.ts](../../packages/server/src/workflow/run-registry.ts) |
| Agent 恢复与清理 | [stream.ts](../../packages/agent/src/stream.ts) |
| 控制流示例场景 | [workflow-control-flow.test.ts](../../test/e2e/workflow-control-flow.test.ts) |
| stdin / stdout 与采集失败 | [workflow-stdio.test.ts](../../test/e2e/workflow-stdio.test.ts)、[workflow-output-collection-failure.test.ts](../../test/e2e/workflow-output-collection-failure.test.ts) |
| 取消 / 重启场景 | [workflow-resilience.test.ts](../../test/e2e/workflow-resilience.test.ts) |
| queue / 授权场景 | [workflow-scheduling-failure.test.ts](../../test/e2e/workflow-scheduling-failure.test.ts)、[workflow-authz-spicedb.test.ts](../../test/e2e/workflow-authz-spicedb.test.ts) |
