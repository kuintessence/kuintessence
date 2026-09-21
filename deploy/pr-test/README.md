# PR 调度器测试

这是可销毁的测试环境，不是公网 preview，也不复用现有 scheduler 开发栈。
专用配置：[docker-compose.pr-test.yml](../compose/docker-compose.pr-test.yml)。

## 镜像和网络

构建依赖为：

```text
scheduler-base (现有 base/Dockerfile, Spack 1.0.0, Bun 1.4.2)
  ├─ scheduler-runtime (现有 slurm 或 pbs Dockerfile)
  └─ test-workspace (当前代码、锁定依赖、生成的 protobuf)
       └─ scheduler (scheduler-runtime + test-workspace)
```

现有 base 已包含 Spack，默认 `v1.0.3`。本配置只将 PR 构建参数设为 `v1.0.0`，
与当前材料 lock 预检协议一致，不修改开发栈默认版本。
镜像构建需要访问 Ubuntu apt、GitHub、Bun/npm registry 和 Docker registry；
不是离线构建。可用 `KQ_PR_APT_MIRROR` 配置现有 base 的 apt mirror 参数，
不等同于 Spack 专用 HTTP/SOCKS 代理。依赖在 build 时安装，运行时不安装依赖、
不挂载宿主源码或 Docker socket、不提供 Web、SSO、SpiceDB、RustFS 或 tunnel。

Server 和 Registry 共用本次测试数据库；scheduler 与 Server 位于独立 control 网络，
Registry/数据库在 backend 网络，两个网络均为 `internal`。
Agent 不与 Registry 共享网络，没有 Registry URL 或凭据。
Registry 的 recipe Git、materials、blobs 分目录存入命名卷；Agent 数据和 scratch
也使用本次 project 的独立卷，不读取宿主机 recipe 或源码材料。

仅 PBS 容器启用 `privileged`，用于现有 OpenPBS 测试镜像启动；不要在生产主机或
承载其他敏感容器的共享 daemon 上运行。优先使用临时 GitHub-hosted Linux runner。
当前不覆盖 K3s、Torque 或跨架构仿真。

## 执行

要求 Docker daemon、Docker Compose 2.20+（支持 build `additional_contexts`）、
BuildKit、Bash 和 OpenSSL。从仓库根目录运行：

```bash
# 只解析配置，不需要 daemon，不构建、不启动、不清理容器
bash deploy/pr-test/run.sh slurm --config
bash deploy/pr-test/run.sh pbs --config

# 构建、启动、测试，然后自动清理本次临时环境
bash deploy/pr-test/run.sh slurm
bash deploy/pr-test/run.sh pbs
```

入口生成独立随机 `kq-pr-test-*` project、数据库密码和 JWT secret，忽略根 `.env`
及调用者的 Compose project/file/profile；不使用平台或预览 secret。成功、失败和
可捕获的中断均清理本次容器、网络、卷和专用镜像，不执行全局 `prune`；
构建缓存和共享上游镜像保留。`SIGKILL`、daemon 宕机无法保证清理，
应确认残留的 `kq-pr-test-*` project；不要清理其他项目。

不直接调用 `docker compose up`，也不要在现有部署上叠加此配置。
入口在所有 Compose 调用中保留 `images` profile，确保构建上下文引用可解析；
启动时使用 `--no-build` 并显式选择 `scheduler registry`，不启动构建辅助服务。
入口不会将包含临时注册凭据的容器日志输出或上传为 artifact。
构建/启动/测试失败保留非零退出码；清理失败同样报错。

## 检查范围

容器内以 `kq` 身份检查：

1. 实际 `spack --version` 和 `bun --version`、测试代码 TypeScript 检查。
2. Server 登录、Agent 自动注册及在线 control channel，等待心跳上报可用的 queue
   inventory 和接受提交的目标队列后，创建本次测试 queue；超时或请求失败均报错。
3. 通过 Server/Agent 提交真实 echo 作业，检查终态和 Server 返回的 stdout。
4. 提交 sleep 作业，等待运行后取消，同时检查 Server 和原生调度器终态。
5. 未配置材料分发时，Spack 安装请求必须被 Server 拒绝，不能落入直连上游安装。
6. 进程内 Spack lock、Git recipe、材料导入/目录/下载、Agent 缓存/预检及运行脚本回归。

Recipe bundle 导入和快照导出使用 base 镜像自带的 Git 验证，覆盖实际运行环境的
命令兼容性；快照按明确的 commit/ref 读取，不依赖 `FETCH_HEAD`。

第 6 项使用 fixture/替身；不是真实 Registry → Server → Agent 的网络材料交付验收。
这套测试未配置 mTLS 材料票据、Apptainer/SIF/site profile 或真实材料包，
`SPACK_MATERIAL_DELIVERY_ENABLED` 和 `AGENT_SPACK_INSTALL_ENABLED` 保持关闭。
**通过本套测试也不能宣称受管离线安装、15 个科学工作流或生产部署已验收。**

## GitHub Actions

独立工作流 [PR scheduler tests](../../.github/workflows/pr-scheduler-tests.yml)
对目标 `main` 的可信同仓库非草稿 PR 自动执行 Slurm/PBS matrix，也可手动触发。
不使用 `pull_request_target`、生产 environment、发布权限、仓库 secret 或持久 runner。
每个 job 有独立 project 和总超时；失败不取消另一个调度器的诊断。
取消时脚本尽力清理，runner 回收是强制中断的最终隔离边界。

现有 `Preview` 工作流保持独立；`preview-paused` 只暂停公网预览，不暂停本测试工作流。
实际构建与运行结果以对应提交的 GitHub Actions 或上述命令结果为准。
配置解析或 fixture 检查通过不代表 PR runtime 已通过。

## GNU Hello 单步案例

独立的 [Spack case overlay](../compose/docker-compose.pr-spack-case.yml) 扩展上述基础环境，
由同一 Actions 工作流中的 `Spack GNU Hello single-step case` job 执行：

```bash
bash deploy/pr-test/run.sh slurm --spack-case
```

该模式只支持 Slurm，不替代默认 Slurm/PBS 回归。它使用 Spack 1.0.0、
固定 builtin recipe commit 和 GNU Hello 2.12.1 源码；材料准备在镜像构建阶段联网，
生成真实 Linux lock、源码 mirror 和自包含 Git bundle，不使用手写 DAG/hash。
Hello 的 CI recipe 使用 GNU 官方列表中的 Berkeley HTTPS 镜像，避免单独依赖
`ftp.gnu.org` 的 runner 可达性；版本和独立固定 SHA-256 不变，下载或校验失败仍退出。
此上游地址只供联网材料准备使用，Agent 与离线 worker 仍只消费 Server 交付的材料。
上游 recipe 使用固定 commit 的 shallow Git checkout，核对固定 tree 后从本地
Git object 元数据逐一校验文件模式、长度和 blob hash，不依赖匿名 GitHub tree API。
材料不提交 Git，不进入 scheduler 镜像；只保留可复现准备脚本及自有 recipe。
编译器和基础工具使用镜像中的 external，不代表完全从源码自举工具链。

检查步骤：

1. 每次生成独立 CA 和 Server TLS 证书，真实注册 Agent；control stream 使用 direct mTLS。
2. 运维容器通过 Registry HTTP API 导入 recipe bundle、lock 和源码，发布固定 release；
   Server 重启加载本次 binding。Agent 无 Registry 网络、URL、管理凭据或 CA 私钥。
3. 通过 Server 的软件操作 API 下发安装请求；空缓存 Agent 只从 Server HTTPS 下载，
   逐个校验 manifest/blob。预检完成后操作必须停在关闭的 managed-install gate，返回 `rejected`。
4. 测试工具只将已校验的材料复制给非 root `kq` 用户。独立 native 容器使用
   `network_mode: none`、只读 rootfs、禁止提权和资源限制，只挂载只读材料卷及输出
   scratch 卷，不挂载 Agent 状态或证书。确认仅有 loopback、无默认路由、
   不能访问上游或 Registry，再运行 native Spack 的源码校验与离线编译。
5. 通过 Server 提交一个执行编译产物 `hello` 的 Slurm 作业，要求真实作业完成，
   并从 Server 日志接口读到 `Hello, world!`。
6. 重启 Server、Registry 和 scheduler，重新导出 Git recipe snapshot、下载全部材料 blob 并逐一
   校验 size/SHA-256，再提交同一单步作业验证持久化安装产物。

引用账本检查由 `spack-case/references.ts` 在 Server 的可信 workspace 容器内执行，
仅使用 Server 已有的 `DATABASE_URL`；不向 Agent/native 容器传递 PostgreSQL 凭据，
不改变 Compose 网络或凭据边界。脚本只读 PostgreSQL，不自行注册 binding 或构造
operation 引用：

- 启动后检查 `spack_material_bindings` 恰有一条与本次配置的 spec、repositoryId、
  manifestDigest 精确匹配的记录，尚无 operation 引用。
- native 的真实安装请求到达关闭的 managed-install gate 并返回 `rejected` 后，
  检查 `spack_material_operation_references` 恰有一条记录，精确关联该 install
  operation 的 ID、Agent、请求人、spec 与 release binding。
- 通过 `SpackMaterialReferences.listReleaseReferences` 检查终态后的
  `bindingCount=1`、`activeOperationCount=0`、`orphanedOperationCount=0`；
  历史 operation 引用仍保留，不能仅凭 active count 为零判定成功。
- Server 重启重新注册相同配置后重复检查，确认 binding 和 operation 引用均未重复，
  且重启前的记录仍然存在。重启前后的记录指纹保存在 Server 私有临时文件中，
  不输出记录原值，随本次容器清理。

引用断言仅打印固定 stage/code 与计数，不输出 SQL、连接串、异常详情或 Agent 原始日志。
这只覆盖持久引用账本，不启用材料下架、删除或新增 ACL，也不将 native 的 `rejected`
解释为受管安装成功；新增断言是否通过以当前提交的 GitHub Actions 结果为准。

### Runtime Rollout Fence 回归

`--spack-case` 和 `--spack-managed` 均在各自原有案例及全部引用断言完成后，
追加 `spack-case/rollout.ts` 的真实 runtime fence 回归。脚本只在 Server 的可信
workspace 内运行，要求 `KQ_PR_TEST=1`、无 `AGENT_ID`、材料分发开启，并严格检查
本次 GNU Hello fixture、唯一配置 binding、唯一真实安装历史引用和零 active/orphan
计数。不向 Agent 提供 DB 或 Registry 凭据；Rollout 本身仍无管理 HTTP endpoint。
在 ready epoch 重建后的验证阶段，还会通过 Registry 的材料 lifecycle API
检查真实 Hello release 为 available/revision 0，尝试下架必须返回
`MATERIAL_RELEASE_REFERENCED`，随后状态与 manifest 均保持不变。
这验证实际服务接线及有效绑定保护，不代表成功下架/恢复或生产环境验收；
成功转换、权限和并发由独立的 PostgreSQL/HTTP 回归覆盖。

1. `activate` 使用现有 API helper 登录仍在运行的 Server，并从 DB 获取已播种的
   canonical admin ID。先验证 Registry manifest GET 为 200 且 size/SHA-256 精确匹配，
   追加一条从未用于部署的 `hello@0.0.0` 历史测试绑定，
   确认 journal 为初始 observe，再按 revision CAS 执行 pause。
2. 暂停后，同一个无 epoch 的 `SpackMaterialReferences` 实例即使注册空配置也必须被拒绝，
   真实 Registry manifest GET 必须返回 503。随后用 `/case-control/bindings.json`
   的实际配置 reconcile，再按 revision、epoch、inventoryDigest 退役测试绑定，
   重新 reconcile（仍包含该历史绑定以验证不会恢复）后执行 activate。
   journal ready 后，仍未配置 epoch 的旧 Registry 必须继续返回 503。
3. `activate` 的 stdout 仅返回 ready UUID；固定 stage/code 进度及脱敏错误写入 stderr。
   入口通过 command substitution 捕获 UUID，以锚定 Bash UUID regex 验证后导出
   `KQ_PR_MATERIAL_EPOCH`。入口启动时先清除此宿主变量，禁止继承已有部署的 generation。
4. Compose 将 epoch 同时注入 Server/Registry 的 `SPACK_MATERIAL_EPOCH`，使用
   `up --force-recreate --no-build --wait --wait-timeout 300 server registry` 强制重建，
   保留本次 project 的 DB、Registry 和 control 卷。不是只重启进程，也不重新发布材料。
5. 新容器内 `verify` 检查 Server HTTP health/login 成功、环境 epoch 等于 DB ready epoch，
   使用该 epoch 再注册实际 bindings 后保留两条历史 binding（其中一条已退役）
   和一条原历史引用，尝试重新登记退役绑定必须失败。
   当前 inventoryDigest 必须等于最后一条持久 journal 的 inventoryDigest，active/orphan
   计数保持零，Registry manifest GET 恢复 200 且 digest 精确匹配。

两个脚本模式各有 50 秒总 deadline；外层 `timeout` 为 60 秒并保留强制终止后备。
recreation 会丢弃容器 `/tmp`，本阶段不使用临时 baseline，身份与库存校验依赖实际
operation/reference 和持久 journal。新 epoch 后的检查只读 Registry manifest；
此前的 Agent 材料交付、真实 Hello 作业及 native/managed 断言仍是各自独立的前提。

本次 evidence 的确认值（退役另含配置移除确认）仅声明 `run.sh` 创建的全新、隔离、只运行当前 checkout
镜像且无 legacy 部署或凭据的临时拓扑；**脚本不是生产 legacy drain 或凭据撤销的
attestation verifier**。这项回归不证明生产 legacy 凭据已撤销，不提供 drain 机制，
也不代表 15 个科学工作流验收。通过范围只以对应当前提交的 Actions 结果为准，
不能由旧提交的成功记录或新增脚本本身推断。

**这是材料交付 + 手动 native 离线编译 + 单步作业验收，不是自动受管安装验收。**
Agent 的 audit/install 开关仍关闭，不跳过或放松产品安装器的任何安全门槛。
native 测试使用 Docker 隔离网络及已审核 recipe，不调用 Apptainer/SIF 安装 worker，
不写 managed installation 账本，不把返回的 `rejected` 改成 `succeeded`。
通过此案例不能宣称 Apptainer/cgroup/site profile、计算节点共享存储/ABI、15 个工作流
或生产安装功能已经验收。测试输出只报告实际完成的阶段；缺件或构建失败即非零退出。

## 实验性受管安装案例

`--spack-managed` 是独立的 GitHub Actions 专用案例，保留上述 native 案例。
只有可信同仓库非草稿 PR 或维护者手动触发才运行，不用于部署或本地执行。
对应 overlay 为 `deploy/compose/docker-compose.pr-spack-managed.yml`。

测试环境使用带 systemd 的临时 privileged scheduler 容器，为非 root `kq` Agent
提供用户 DBus 和 cgroup delegation。外层特权仅用于这台临时测试节点；
容器使用 private cgroup namespace，不挂载宿主 cgroup、Docker socket 或宿主目录。
Agent 无 sudo 权限；产品 Apptainer/SIF、只读输入、隔离网络和资源限额检查保持不变。
仅 scheduler 镜像预建默认 legacy store 的 `.spack-db/lock`，目录 `0755`、锁文件
`0644` 且均由 root 所有，并检查 `kq` 可读但不可写；不修改 SIF 或 managed store。
这是空 legacy 库存读取的前提，不允许 Agent 写入全局 Spack 分发目录。
启动前以 Agent 的身份、注册环境和工作目录执行一次限时 `find --json` 诊断，
每流最多 64 KiB，只保留固定错误类别及 JSON 形状；诊断不能覆盖后续 API 失败。
运行前先调用产品的 runtime boundary verifier，失败即停止，不能降级成 native 案例。
Ubuntu 24.04 Actions 宿主为固定路径的非 setuid Apptainer starter 临时加载
基于 Apptainer 1.4.3 官方配置的 AppArmor `userns` profile，job 结束后移除；
不关闭宿主全局 AppArmor/user namespace 限制。

Apptainer 固定为 1.4.3，下载 deb 校验固定 SHA-256；SIF 从同一 Ubuntu 20.04
scheduler 工具链构建，不携带 recipe、源码或 Agent 凭据。实际生成的 SIF 和 site profile
按字节固定 digest。安装 store 位于独立 2 GiB ext4 文件系统，backing file 使用临时
named volume 持久化；Agent 和 Slurm 在同一节点以相同路径访问，不代表跨节点 ABI 验收。
独立 source audit 使用生产的 2 GiB 内存预算，managed worker 使用独立 4 GiB
内存硬上限，均禁止 swap，不改变 CPU/PID、网络或挂载隔离。

目标检查链为：Server API 安装、隔离 source audit、build、独立 readonly verify、
`ready`、load、真实 Slurm Hello、源码缓存缺失/篡改后的撤回与显式恢复、
重启后复验/运行、卸载及库存撤回。

受管案例复用上述 Server 侧引用检查：`install` 阶段完成后要求真实安装 operation
为 `succeeded` 且存在精确材料引用；Server、Registry、scheduler 重启后以及
`uninstall` 阶段完成后，重复检查原配置 binding 与安装历史引用仍保留且没有重复，
active/orphaned operation count 均为零。卸载安装产物不等于下架材料 release。

2026-09-20，提交 `c4987cf` 的
[PR scheduler tests](https://github.com/kuintessence/kuintessence/actions/runs/35514084225)
通过 Slurm、PBS、native Hello 和此受管案例；同一提交的
[完整 CI](https://github.com/kuintessence/kuintessence/actions/runs/35514099810)
五项检查均通过。受管日志分别确认 `missing-source`、`corrupt-source` 负例与恢复成功，
以及 `install`、`restart`、`uninstall` 三阶段成功。失败的 load 是完整性负例的预期结果，
恢复材料后必须显式复验，不会仅凭恢复文件重新发布可用库存。
该记录证明此提交在临时单节点 Slurm 环境完成上述检查链，不证明后续提交、跨节点共享
存储、compute ABI、生产站点或 15 个工作流通过验收。

等待测试队列时最多记录八次状态变化，仅输出 schema 校验后的枚举和布尔值；
失败后用现有 Slurm adapter 查询一次原生队列对照，不输出原始 CLI 内容或队列清单，
不改变原等待时限和失败结果。
API 安装失败时，测试可在相同隔离条件下调用未修改的 worker 检查来定位错误，
只报告固定错误类型、白名单 worker/Spack 模块行号、求解错误类别和挂载类别；
同时报告进程退出码、报告类型、固定阶段的进程 RSS 峰值以及测试 user cgroup 的 OOM kill 计数差值，
不可读时明确标记 unavailable；不输出异常消息、原始路径或 native 日志。
Compiler 诊断只观察原有探测调用的结果、候选计数和固定求解错误类别，不额外运行探测，
也不输出原始 external spec、compiler flags 或错误参数。
Target 诊断只比较已生成的候选与错误模型，报告是否包含 profile target、
gmake 是否具有 target 及是否匹配；无法读取时报告 unavailable，不输出 target 原值。
错误模型最多读取 65,536 个 symbol；另以固定类别区分读取异常、格式不符和超限，
只报告受限计数及发生位置，超限不解释为 target 不匹配。
External target 错误额外报告精确值或范围模式，以及与 profile target 的文本相等性；
范围模式的相等性不代表范围包含关系，不额外解析 spec 或执行求解。
原生 lock 绑定失败时，最多比较 64 个已求解节点与原 lock，输出固定包名类别及字段
匹配布尔值；同名歧义或读取异常明确报告，不输出 spec、hash、flags 或 external 原值。
`parameters` 合并比较 variants 与 flags；依赖比较也包含子节点 hash，不匹配不等于边结构改变。
比较不重新求解，也不替代原绑定检查或吞掉原异常。
安装失败诊断使用独立临时 store，不写安装账本，清理异常也只输出固定代码；
即使诊断成功也保持原 API 案例失败，不作为安装成功的替代路径。
load 失败诊断改为只读复验匹配本次 release/site profile 的原安装目录，
不重新构建、不修改或删除该目录，不把 `unavailable` 记录恢复为 `ready`。
完整性负例失败时仅报告固定 `substage` 与最后观测的 schema-validated 安装状态，
区分本地不可用状态等待、门户库存撤回和恢复复验，不输出 spec 或原始响应。
实际通过范围必须以当前提交的 Actions 结果为准；新增测试定义本身不构成验收通过，
也不覆盖生产环境、PBS 受管安装或 15 个科学工作流。

## samtools 单软件垂直切片

此案例是独立的 GitHub Actions 专用入口，保留 GNU Hello native/managed 案例和
默认 Slurm/PBS 回归。仅在可信、可销毁的 Actions 环境中执行，不用于本地运行或部署：

```bash
bash deploy/pr-test/run.sh slurm --spack-samtools
```

固定 Spack 1.0.0、官方 `spack/spack-packages` commit
`32c54f0906004d7fd1f72fd1b5970bf2bf094e26`，对应 tree
`f117b6bf72ee6d9c2951922f4afd31f461b02b0d`。参考目标为 Ubuntu 20.04 x86_64
Linux 单节点 Slurm，不是 Actions 宿主 OS 的兼容性承诺。请求 spec 为：

```text
samtools@1.19.2 ^htslib@1.19.1~libcurl~libdeflate ^zlib@1.3.1 ^ncurses+symlinks %pkgconf
```

上述 spec 是求解输入，不是已成功 concretize 的证明。新增 samtools 案例的
通过范围须核对对应提交的 Actions；现有 Hello 通过记录不适用于该案例。
材料准备需在隔离镜像构建阶段联网，产生真实单 root Linux lock、完整源码 mirror
和自包含 recipe bundle；使用实际 bundle snapshot commit，不把新快照 commit
冒充上游 commit。Agent 仍只从 Server 下载，不获得 Registry 凭据或上游访问路径。
ncurses 的官方 `+symlinks` 与 `pkgconf` provider 是双方共有的 spec 约束，
用于避免硬链接产物；不通过私有 recipe patch 或放宽 worker 规则来接受它们。
`%pkgconf` 明确 ncurses 的直接构建依赖，不是 root 级间接 `^pkgconf` 约束。

目标检查链沿用受管安装的 source audit、断网 build、独立 readonly verify、
`ready`、managed load 和真实 Slurm 作业。作业使用独立临时目录中的合成 SAM，
不含个人基因组数据，检查精确 executable 路径/版本、SAM→BAM、坐标排序、
BAM quickcheck、BAI 索引、区域计数以及非法输入非零退出。完整性负例、重启复验、
卸载与引用检查的实际结果也必须以对应提交 Actions 为准。
资源与隔离约束不因增加软件而豁免；实际 DAG 超限或材料不完整均应失败。

samtools 只是 15 个工作流中变异检测链路的一个软件，不包含 fastp、BWA-MEM2、
bcftools、Python 分析或完整 VCF truth 校验，不代表 MPI、PBS 受管安装、跨节点
共享存储或生产站点验收。后续软件各自使用独立单 root lock/release，按步骤隔离
环境，不能把多个 load shell 堆叠为一个未经验证的运行环境。

15 项候选包、外部数据、许可自审、target/MPI 风险及 macOS 文件交付步骤见
[科学工作流材料指南](../../docs/spack-workflow-materials.md)。
当前没有通用材料生成器，也没有可直接下载的完整材料 artifact；运行入口不承诺
导出可供 Web 上传的材料包。macOS 仅用于获取、校验和搬运，Linux lock/source
闭包须从经授权且实际成功的目标 Linux 准备任务取得，再按既有 bootstrap/Web
格式手工组包导入。

失败诊断不输出原始 Agent 日志、注册响应或任意安装路径。基础 PR 镜像的 PBS
入口观察器仅报告失败行号和退出码，未修改生产 scheduler 入口；受管安装的
输出树诊断仅报告文件类型、受限 link count 和固定文件名枚举。诊断不得替代
安装结果，依赖 hash 不一致、特殊文件或不受支持的硬链接仍按 worker 规则拒绝。
