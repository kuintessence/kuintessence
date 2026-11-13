# 平台站点发行包准备与审核

`deploy/site-release/prepare.ts` 在平台构建机生成独立 Linux Agent、CLI、精确文件摘要和未签名 manifest。站点不需要 Bun。准备步骤不签名、不上传私钥、不发布通道、不安装或重启服务。

## 准备输入

在仓库根目录安装既有依赖并生成项目所需的 protobuf 后，编写请求文件。以下值只是格式示例，必须按已验证的目标站点替换：

```json
{
  "channel": "stable",
  "mode": "release",
  "sourcePolicy": "clean",
  "sequence": 12,
  "serverRevision": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  "stateFormat": "slurm-site-v5",
  "architecture": "x86_64",
  "minGlibc": "2.36",
  "cpuFlags": ["sse4_2", "ssse3", "popcnt"],
  "buildTarget": "bun-linux-x64-baseline",
  "redistribution": "unrestricted",
  "computeInventory": "reports/result.json",
  "requireSpack": false,
  "inputs": [
    {
      "path": "verified/runtime.sif",
      "name": "runtime.sif",
      "role": "runtime-sif",
      "size": 123456,
      "sha256": "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
      "executable": false
    }
  ]
}
```

- `channel` 是发布目标，不写入严格的下载 manifest；记录在 `prepare.json` 供审核。`sequence` 是该通道单调增长序号，不是软件版本。
- `serverRevision` 必须等于构建仓库当前完整 Git HEAD，且应与准备上线的平台 Server revision 一致。准备记录包含 `sourceDirty`；有未提交修改时可构建用于审核，但不能把该产物视为纯净 revision 的可复现构建。正式发布须显式使用 `mode=release`，选择干净提交或下文说明的完整 sealed 源码快照。
- `stateFormat` 是站点状态数据库兼容约定，由发行负责人验证；工具不会因版本字符串相同就推断迁移安全。
- `architecture` 与 `buildTarget` 必须对应：x86_64 可选 `bun-linux-x64` 或 `bun-linux-x64-baseline`，aarch64 选 `bun-linux-arm64`。Agent 沿用既有 `scripts/build-agent-bundle.cjs` 的 ssh2 portable external flags，避免捆入构建机原生扩展；生成文件也会核对 ELF 架构。
- `minGlibc`、`cpuFlags` 均为必填兼容性声明，必须有目标机器验证依据。baseline 不表示任意老 CPU 都兼容；普通 x64 Bun target 的 CPU 要求也不能照抄 baseline。工具不会从编译成功推断旧 glibc、CPU、调度器、SIF 或网络隔离可用。
- `computeInventory` 可省略；填写时必须是相对请求文件的 `modules-smoke.sh` 计算节点 `result.json` 路径。工具严格验证 v1 inventory、`ok=true`、OS信息、glibc、架构、Python探测及共享工作目录的写入/读回/删除证据；编译器/MPI的 `failed` 会拒绝，`not-tested` 保留未验证含义。仅支持当前 Linux/glibc 报告，不将 musl、缺失信息或其他格式解释为兼容。
- 有 inventory 时，`minGlibc` 不得高于实际观察值，发行声明的全部 `cpuFlags` 必须已观察到。还必须在 `cpuFlags` 明确声明 Bun target 的必要能力：x64 baseline 为 `sse4_2/ssse3/popcnt`，普通 x64 在此基础上增加 `avx/avx2`，arm64 为 `asimd`。不能用 baseline 名称代替 CPU 证据。报告只覆盖一次分配的节点，不能推断整个分区、MPI ABI、网络隔离、配额或实际 Agent/CLI 的运行成功。
- 缺省 `requireSpack=false`，保持仅 Agent/CLI 或旧请求兼容。设为 `true` 时必须恰好提供一个 `runtime-sif`、一个 `site-profile` 和一个可执行 `spack`。profile 的声明大小与实际 JSON 均不得超过 128 KiB（inventory 上限仍为 1 MiB）。profile 必须通过 Agent 的原生 `SpackInstallSiteProfileSchema`，保留 `sharedStoreConfirmed/compatibleComputeNodesConfirmed/trustedRecipesConfirmed/quotaEnforcedBySite` 四项显式 true 确认；其 `runtimeSifSha256` 必须等于可信 runtime 输入摘要。
- 完整 Spack 包还检查 profile 的 `linux-OS-target` CPU 家族与发行 architecture 一致，识别常见通用 target 与已知微架构（如 `x86_64_v3`、`haswell`、`zen2`、`aarch64`、`neoverse_n1`）。未知 target 会明确要求用 archspec 核实并补充映射，不能按字符串猜测家族；本检查不替代 Agent worker 对实际 archspec target、OS、runtime 和 lock 的最终匹配校验。
- `inputs` 可为空（仅 Agent/CLI 包），或包含事先验证过的 `runtime-sif`、`site-profile`、`spack`、`tool` 文件。路径相对请求文件解析。每项必须提供独立可信来源的预期 size/sha256；工具复制后再次核对。Spack artifact 必须为可执行文件；不打包目录、不自动制作 SIF、不下载未知文件。摘要核对不替代 SIF 签名、Spack/profile 兼容性和授权审核。
- 仅允许可自由再分发的内容。名称不得使用保留文件名，也不得同时存在 `name` 与 `name.part`，后者是站点断点下载的内部临时路径。

```sh
bun deploy/site-release/prepare.ts /path/to/request.json /tmp/kq-release-review
```

输出目录必须不存在，失败会清理本次目录，不覆盖既有产物。成功结构：

```text
kq-release-review/
  manifest.json
  prepare.json
  artifacts/
    kq-agent
    kq
    runtime.sif
```

`manifest.json` 直接使用平台 `/site-releases` 的格式：version/sequence/serverRevision/stateFormat/architecture/minGlibc/cpuFlags/redistribution/files。这里不是旧 `/agent-binaries` 的双架构 bundle manifest；不能互换。`prepare.json` 保存 channel、源码 revision/dirty、Bun版本、target、manifest摘要、`requireSpack` 和未签名/未发布标记。有 inventory 时记录 `compatibilityEvidence="inventory-checked"` 与原始 report 字节的 `computeInventorySha256`，不复制报告、不记录现场或平台本地路径；没有报告时明确标 `static-only`。这两种状态都不表示现场安装/运行成功。新增准备字段不进入严格的站点下载 manifest。

可以在兼容的构建机上执行 `artifacts/kq --help` 与 `artifacts/kq site --help` 验证独立 CLI；不要用 Agent main 做构建 smoke，因为它会尝试连接或启动 Agent 工作流。

## Portable Spack 入口与 CLI 库存

`deploy/site-release/spack-launcher.py` 可作为 `role=spack`、`name=spack`、`executable=true` 的发行输入；准备请求仍须填写审核后的实际 size/sha256。目标节点需要 `python3`（从已初始化的 module/PATH 选择）、`/usr/bin/apptainer`。该入口的固定布局为：

```text
<shared>/
  releases/<manifest-digest>/
    spack
    runtime.sif
  spack-cli/
    home/
    config/
    cache/
    store/
```

入口与 `runtime.sif` 必须直接位于同一发行目录，发行目录的父目录必须名为 `releases`。使用规范绝对路径，路径仅允许字母、数字、下划线、点、斜线与连字符；不通过符号链接运行入口或引用 runtime。CLI state 固定放在同一共享根的 `spack-cli`，不写入不可变发行目录，也不随通道切换或进程重启重置。启动时创建并检查 state 及四个子目录：必须是当前 uid 所有、权限 `0700` 的真实目录，拒绝符号链接及过宽权限，不自动修正已有目录。

launcher 保持 `--containall --userns --cleanenv --no-home --net --network none`，仅显式绑定 CLI state 到 `/kq/cli`，固定工作目录 `/kq/cli`、禁用 local config，设置容器内私有 HOME/config/cache，并通过 Spack 命令作用域把 install tree 固定到 `/kq/cli/store`、禁止 bootstrap。它不绑定 site profile 的 managed store，也不从 legacy CLI 数据库生成 managed 安装记录；managed 库存仍由匹配的验证报告与账本决定。

此 CLI store 是该 portable Spack 入口真实使用的 legacy 数据库，首次初始化后 `spack find --json` 可以真实返回 `[]`；launcher 不伪造 JSON，也不将读取失败转换为空库存。它不会自动发现或迁移另一宿主 Spack 分发的旧库存。目标节点验收须以 Agent 身份执行实际 `spack find --json`，检查冷启动与重启后的持久状态，再验 managed install/load/uninstall 的合并库存；legacy 查询失败仍使整体操作失败。不同 uid 不得共享同一个 `spack-cli`；需为它们分配独立共享根。

## 平台仍需准备的 Spack 材料

现场 inventory 是平台制作 runtime 和站点 profile 的输入证据。平台仍负责从可信材料构建/验证 SIF，准备与本站编译器、MPI、共享 store、hostFiles/external bindings 匹配的 profile，以及对应的精确 Spack lock 和离线源代码/镜像材料；提供独立可信的 size/sha256，并审核可再分发许可。`requireSpack=true` 仅防止遗漏三项发行附件和明显的绑定错误，不会创建这些材料，也不代表 Spack 入口携带了所需全部 recipes/source。

不得从一份 inventory 自动生成 lock、profile、OS文件摘要或四项确认；更不能将模块版本、CPU flags 或共享盘探测当作 SIF 隔离、MPI ABI 和配额能力的证明。发布前仍需按目标节点类型完成本站实际安装/验证与恢复演练。现场双文件工具包通过注册后生成的 `$KQ_SHARED/helpers/modules-smoke.sh` 输出 inventory；用户按随附站点工具包 README 在 cn 分区以 sbatch 提交，并取回共享工作目录中的 `result.json` 与 SHA-256。请随发行交付该 README。

## 审核后单独发布

人工审核 manifest、prepare记录、可信输入摘要、目标站点兼容性、发行许可和完整测试。准备工具不会调用发布器。审核通过后，在受控发布主机本地执行：

```sh
bun deploy/site-release/publish.ts \
  /tmp/kq-release-review/manifest.json \
  /tmp/kq-release-review/artifacts \
  /srv/kq-site-releases stable /private/signing-key.pem
```

发布器要求本机 Ed25519 私钥，复制并重验所有文件，生成签名，然后原子切换通道。私钥不会进入产物或上传。通道参数应与审核的 `prepare.json.channel` 一致。

每个通道用原子创建的 `channels/.CHANNEL.publish-lock` 目录互斥，序号校验在持锁后重读。并发发布同一通道会有一方明确拒绝，完成后可重试；不同通道互不阻塞。旧序号或相同序号的不同 manifest 都不能覆盖通道。锁中保留 `owner.json` 的 PID 与开始时间；发布进程崩溃会保留锁，必须在原发布主机核实相关发布器全部停止后由操作者调查处理。工具不自动抢锁或清理不明活锁。

## 正式发行的完整源码来源

缺省 `mode="review"` 保留开发准备流程，未提供正式来源记录的包只能发布到
`review`、`dev`、`test`、`preview` 及其 `-` 子通道。`stable` 和其他通道均为正式通道，
发布器在签名之前拒绝缺完整来源或源码摘要不匹配的发行。
正式请求显式增加：

```json
{ "mode": "release", "sourcePolicy": "sealed" }
```

`sourcePolicy="clean"` 为缺省值，要求干净 Git 工作树；当前有已审核但未提交源码时可以显式选
`sealed`，发行仍保留真实 `sourceDirty=true`，不能声称对应纯净 Git 提交。
`serverRevision` 继续要求等于当前完整 HEAD；它是基线，不能代替 dirty 源码快照。
正式输出必须在原仓库之外，工具拒绝注入替代 build callback。

正式 prepare 枚举 `git ls-files --cached --others --exclude-standard` 的全部可交付文件，
包含已修改和未跟踪源码、`bun.lock`、workspace package/config、补丁及 protobuf 输入，
记录每个文件的相对路径、可执行位、大小及 SHA-256。
`.git`、依赖安装目录、构建结果、缓存、运行数据库/SIF、凭据目录、私钥以及非 example 环境文件不进入快照；
非 example 的 `*.env`/`*.env.*`、标准 SSH/AWS/Kube/Docker 凭据目录、netrc/git-credentials 和认证 JSON 不进入档案；
`.npmrc` 或 bunfig 中的认证字段、带用户名密码的 registry URL，以及真实多行 PEM 私钥会使准备/恢复/发布失败。该排除规则不是通用 secret 扫描器，发行审核仍须检查源码中是否硬编码凭据。
快照仅接受普通文件，拒绝源码符号链接；缺少必需配置或补丁会在隔离构建中失败，不回用原工作树的文件。
单文件最多 64 MiB、源码合计最多 256 MiB、最多 100000 文件。

源码档案 `source-<sha256>.json` 是严格的 JSON archive，每项包含 base64 原始字节与摘要。
`source-provenance.json` 绑定档案 size/digest、完整文件清单、Git HEAD/dirty 指纹、源码总指纹、
Bun精确版本、packageManager、lock摘要、buf/protoc-gen-es观察版本和安装/codegen/编译命令；
还记录构建所用 Bun/Node 的规范路径与 SHA-256、Node观察版本、宿主 OS 信息摘要及显式 CA 文件路径/摘要。
两个文件均以 `role=tool` 写入下载 manifest，因此与 Agent/CLI 的实际二进制摘要一同参与既有 Ed25519 签名。
这两个名称占用正式输入的两个槽位，调用者最多提供124项附加输入。

构建使用档案恢复出的全新隔离目录：必须运行与 `packageManager=bun@版本` 完全相同的 Bun，
执行 `bun install --frozen-lockfile --ignore-scripts`，再显式执行
`bun run --filter @kuintessence/proto generate` 与已有 portable Agent/CLI compile 命令。
正式构建所有子进程使用显式环境白名单，私有 HOME/XDG config/cache/tmp 和空的用户/全局 npm 配置，
PATH 中的 Bun/Node 固定指向已记录摘要的工具；不会继承 NODE_OPTIONS、BUN_OPTIONS、NODE_PATH、动态库 preload、
代理、认证 token 或 SSH agent。protobuf plugin 需要系统 Node.js >=20（从固定系统工具目录解析），不临时下载另一个 Node。
系统默认 DNS 和 Bun/Node 的默认信任库继续可用；确需额外 CA 时只允许 `SSL_CERT_FILE`/`NODE_EXTRA_CA_CERTS` 的
受保护绝对普通文件，记录规范路径/摘要并在构建结束复核，不能继承任意 CA 目录。工具和 OS 信息同样复核摘要。
这隔离了环境及源码目录，未创建文件系统/网络沙箱；受信构建主机的系统动态库、系统工具和默认信任库仍是显式的宿主依赖，
不能宣称已达到字节级或恶意源码执行隔离。正式构建机不得携带发布私钥或生产凭据，签名仍在独立发布步骤进行。
原工作树 gitignored 的 protobuf 输出不进入档案，隔离目录使用锁定依赖重新生成；不借用原 node_modules。
构建结束检查完整源码清单、字节、执行位及 lock 未变化，原工作树源码指纹也须与构建前一致。
之后删除临时安装目录，仅保留签名需要的源码档案、来源记录和发行产物。
依赖的解析来源、版本和 integrity 随原始 bun.lock 保存；后续重建仍需要取得锁文件指定的依赖，档案不内嵌第三方依赖缓存。

审核签名并核对来源档案摘要后，可恢复源码供重建：

```sh
bun deploy/site-release/source-provenance.ts /verified/source-DIGEST.json /new/isolated-source
```

该命令只恢复普通文件，不自动安装依赖或构建；随后按来源记录使用相同 Bun、冻结安装、显式 codegen 和编译命令。
档案提供可审查的完整自有源码与锁定依赖来源，不承诺不同操作系统、工具链下载或未来依赖可用性下二进制 bit-for-bit 一致，
也不将构建成功解释为目标站点兼容或现场验收通过。本轮仅实现代码和测试场景，没有执行安装、生成、构建、检查或发布。
