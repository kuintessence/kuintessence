# 三机构 AIO 离线交付

三台新增虚拟机运行独立 A/B/C 平台、Fabric 和容器测试集群，A/B 使用 Slurm，C 使用 PBS；R 按需在 A 主机运行独立项目。现有集群不变，主平台只新增第四个 Orderer。完整范围见[实施清单](../../../docs/design/federation/aio-delivery.md)。

当前固定候选 `038aa6f` 的 21 镜像归档已完成交付和身份核对，三个独立平台均通过受限启动、真实 SSO 和机构读取权限检查；未启用调度器或 Agent，Peer／Orderer 尚未加入通道。其中一个平台验收后停止，保留容器与卷，恢复该机原 CI Runner。镜像使用 Spack 1.0.3，兼容规则见[多版本严格绑定](../../../docs/spack-compatible-versions.md)。旧 `b54743b` 的两类 target／runtime 入口和 GNU Hello 原生检查保留为历史证据，不追改旧镜像。正式托管、三机构联合交易、SmartBFT、容量准入及科研验收仍待完成，PR 未合并；后续源码修复未自动进入该固定归档。

## 本机构建与导出

东京构建机已有 K3s/containerd，不要求 Docker Engine。预先准备校验过的 nerdctl、BuildKit 和 rsync；工具不自动安装或接管服务。BuildKit 使用独立 root/socket，containerd worker 的 address 和 namespace 必须与 nerdctl 一致，namespace 固定为 `kq-federation-build` 或其带后缀的名称，禁止使用 `k8s.io`。

专用 BuildKit 配置示例：

```toml
root = "/var/lib/kuintessence-buildkit"
[grpc]
  address = ["unix:///run/kuintessence-buildkit/buildkitd.sock"]
[worker.oci]
  enabled = false
[worker.containerd]
  enabled = true
  address = "/run/k3s/containerd/containerd.sock"
  namespace = "kq-federation-build"
  platforms = ["linux/amd64"]
  max-parallelism = 1
  gc = false
```

该配置限制 Dockerfile 内部构建并发，不仅限制镜像之间的顺序；不自动回收构建缓存。当前已使用校验过的 nerdctl 2.4.2、BuildKit 0.34.2 完成本机构建／导出；摘要校验不等于已验证发行者签名。

要求干净且已提交的固定 Git revision。默认构建预留 40 GiB 是保守预算，不是实测下限；不足时拒绝且不自动清理。Casdoor 输入必须是经确认的 digest，不能用 latest 代替验证。

```sh
python3 deploy/federation/offline.py \
  --image-engine nerdctl --containerd-address /run/k3s/containerd/containerd.sock \
  --namespace kq-federation-build \
  --buildkit-host unix:///run/kuintessence-buildkit/buildkitd.sock \
  build --revision <完整提交> --spack-version 1.0.0 --casdoor-image casbin/casdoor@sha256:<已确认摘要>

python3 deploy/federation/offline.py \
  --image-engine nerdctl --containerd-address /run/k3s/containerd/containerd.sock \
  --namespace kq-federation-build \
  export --revision <完整提交> --casdoor-image casbin/casdoor@sha256:<同一已确认摘要> \
  --output /交付盘/指定版本
```

`--spack-version` 默认为 1.0.0，可显式选择表内的 1.0.3 候选；这不代表新版本已通过原生安装验证。最终 Slurm/PBS 镜像版本须一致，导出清单保存 `spackVersion` 和共享兼容表，缺失或混用时拒绝。新版工具需连同表使用，交付包已包含该文件。

原生 Docker 构建机可省略 engine 等全局选项。镜像串行构建，包含九类 KQ 镜像、两个内置编译 Agent 的调度器、经批准的登录镜像及第三方运行镜像。一个 gzip 归档保存全部镜像；manifest 记录 Git revision、架构、镜像 ID、来源 repo digest、文件大小与 SHA-256。

导出再次显式提供同一已批准的 Casdoor source ref。工具核对该不可变引用与交付别名的镜像 ID；别名被替换时拒绝导出。可信 manifest 保存 `casdoor.source` 与对应镜像 ID，接收方校验时拒绝缺失、可变引用或与交付别名身份不一致的声明。此检查不会替部署方批准版本，也不会让目标拉取该引用；目标仍只加载归档并核对镜像 ID。

包内同时携带本 README、AIO／平台／联邦 `env.example` 和联邦部署说明，逐文件记录 SHA-256 供初始化参考。示例中的占位值须在包外合并为各机构独立的私有配置；实际 `.env`、密码、业务私钥和管理员批准材料不放入通用包。README 作为普通文件参与摘要，不在自身正文生成交付摘要。

保留工具输出的 manifest 摘要，通过独立受控通道交付接收方；随包校验和不是签名。本工具不生成机构授权或科研材料；材料、许可证、provenance、recipe 和 native lock 由既有 `kq-bundles` 兼容交付另行提供并关联，镜像包不是科学软件离线包。

调度器封装时核对 Server 产出的 Agent manifest、同提交 revision、实际二进制长度和 SHA-256；不能仅给旧 Agent 镜像贴上新标签。OpenPBS 默认单进程编译。构建结束重新检查工作树；导出在生成最终 manifest 前复查源版本及镜像 ID，发现漂移不发布 ready 清单。压缩失败或磁盘写入失败会终止并回收导出进程，保留失败目录供核对，不自动删除原材料。

## CI 构建交付包

本机空间不足时，可在已推送的候选分支手动运行 `Federation Compose delivery`，
选择 `build_offline_bundle=true` 和精确 `spack_version`（默认 1.0.3）。
工作流复用同一 `offline.py build/export/verify`，在 GitHub 托管 Runner 串行构建，
上传包含 21 个 linux/amd64 镜像、公共配置和逐文件摘要的 artifact，保留 14 天；
运行摘要记录提交、Spack 版本和 manifest SHA-256。构建仅在一次性 Runner 回收未使用的 SDK，
不清理本机材料，不发布 main/latest 标签，不部署，也不签署机构材料。

```sh
gh workflow run federation-compose.yml --ref <候选分支> \
  -f build_offline_bundle=true -f spack_version=1.0.3
```

下载 artifact 后仍按下文提供可信 manifest 摘要完成校验和加载。
镜像内含未签名的公共 SIF；科研软件材料、目标 lock、机构签署和现场验收单独准备。

## 文件搬运、公共 CA 与容量保护

跨机构 Workflow 的网络输入／结果搬运通过 AIO `env.example` 中的 `AGENT_FEDERATION_INPUT_COPY`、`AGENT_FEDERATION_RESULT_COPY` 显式配置，默认均为 `null`。两项分别使用 `/var/lib/kuintessence/federation-input` 和 `/var/lib/kuintessence/federation-result`，保存在 `scheduler-state` 卷内；声明字节预算和允许的 HTTPS 来源／目标，不自动开放其他机构的 origin。托管模式也可在私有 `runtime/agent.json` 设置对应 JSON 字符串，此时 Compose 保持 null；两处均启用且内容不同时拒绝启动。

仅开启搬运时，由实际 Agent 身份创建自己的 0700 暂存目录（托管模式为 kq）。已有目录的所有者、权限或符号链接不符时要求维护，不递归改属主或移动历史数据。切换普通／托管身份前单独处理已有暂存目录，不能靠重新部署覆盖。媒体交付配置不因网络搬运开启而启用。

私有 CA 站点在 `config` 时显式添加 `--public-ca-file /绝对路径/public-ca.pem`，为 Server、Registry 和 Agent 只读挂载公共 CA bundle；不挂载包含私钥的整个 TLS 目录。文件应为规范绝对路径、普通非空文件、无组／其他用户写权限，且供容器用户读取。运行前再次检查；工具不生成或批准 CA。`CURL_CA_BUNDLE` 使用该文件作为信任集合，若需要同时访问其他可信站点，应预先提供包含所需 CA 的完整 bundle。托管 `agent.json` 不能覆盖 Compose 已选定的另一套 CA，冲突会阻止启动。

容量保护在 `config` 时显式添加 `--storage-guard`，适用于 direct／fabric 机构和独立 R，独立 Orderer 不接受此参数。先按[存储容量说明](../storage-capacity.md)在包外提供 Server policy、observer 配置／Ed25519 key、卷 marker 及报告目录，并在私有 env 中配置 `FEDERATION_STORAGE_POLICY_FILE`、`FEDERATION_STORAGE_OBSERVER_CONFIG`、`FEDERATION_STORAGE_OBSERVER_KEY`、`FEDERATION_STORAGE_REPORT_DIRECTORY`、`FEDERATION_STORAGE_OBSERVER_UID` 和 `FEDERATION_STORAGE_REPORT_GID`。启动前检查 owner、权限与只读报告挂载，不制造密钥、政策或健康报告；缺失／过期报告继续由生产 Server 拒绝新接单。

观测服务使用已交付镜像，无现场构建或拉取，另计 128 MiB 内存及 0.25 CPU 预算。上述可选入口补齐部署接线，尚未证明真实文件传输、TLS 登录、容量暂停恢复或现场故障验收通过。

## 目标容器运行时材料

Ubuntu 24.04 amd64 新机可使用发行版的 `docker.io`、`docker-compose-v2`、`containerd`、`runc`。先读取目标 `/var/lib/dpkg/status`，在本机用该状态求解缺失依赖；不能按构建机是否已安装依赖决定下载范围。已有 Docker 的主机不使用此包覆盖安装，原 Runner/DinD 等服务预算另计。

当前材料固定 Docker 29.1.3、Compose 2.40.3、containerd 2.2.1、runc 1.3.4，具体 Ubuntu 修订号以交付清单为准。使用 `apt-get download` 在本机下载，保存各包版本、架构、原仓库路径、SHA-256、APT 元数据及包内 copyright；材料不进入源码仓库。两台目标的软件包状态相同，已在本机以空仓库列表、目标状态和 `--simulate --no-download --no-install-recommends` 求解本地四个 deb：四项新增、零升级、零卸载，没有安装或启动服务。

交付时将此运行时包与镜像包分别校验。接收方先独立核对可信清单摘要，再检查所有文件；安装前用本站当前状态重新运行离线求解，状态变化或出现额外下载、升级、卸载时停止。实际安装属于部署操作，会创建或启动 Docker/containerd 服务，须在部署授权后执行；本轮不安装，也不把依赖求解通过当成安装成功。

## 续传、核验和加载

SSH 公钥须预先核对。续传只写专用 incoming 目录，不启动服务。

```sh
python3 deploy/federation/offline.py transfer \
  --bundle /交付盘/指定版本 --manifest-sha256 <可信摘要> \
  --host <SSH别名> --destination /opt/kuintessence-federation/incoming/<版本>

# 目标端使用事先受信任的脚本，不先执行尚未核验的包内代码。
python3 /受信任工具/offline.py verify --bundle /目标交付目录 --manifest-sha256 <可信摘要>
python3 /受信任工具/offline.py load --bundle /目标交付目录 --manifest-sha256 <可信摘要>
```

加载前检查全部文件，以及 Docker 数据盘可用空间（镜像展开大小总和的两倍加 1 GiB，不假设共享层能节省空间）；须在目标 Docker 主机本地执行。加载后复核镜像 ID。缺项、摘要不符、链接或错误架构均拒绝。固定候选 `92c31a8` 的 21 个镜像已通过 nerdctl 归档至目标 Docker 29 的实际加载与身份核对；该结果不替代平台、通道或计算验收。

Ubuntu Docker 29 的 containerd 镜像存储可能以 manifest digest 作为 inspect ID；工具通过本站 `ctr --namespace moby` 读取内容，核对 manifest／config 的 SHA-256 与平台，再用 config digest 对照交付记录，不放宽身份比对。该路径要求可访问默认 containerd socket 的 `ctr`，已含在上述 Ubuntu 运行时包中；未知多平台清单或内容不匹配仍拒绝，不自动连接其他 socket。

## 最终镜像的目标信息

镜像完成构建、导出后，在本机运行下面的显式观察命令。它会创建短期容器，不启动 KQ、调度器或 Agent。`b54743b` 的两类正式 target 入口已在相同隔离条件通过；Slurm 版本读取使用 `slurmd --version`，避免 `sinfo` 依赖本站配置。最终选定版本的新候选须重新记录观察结果。

```sh
python3 deploy/federation/offline.py \
  --image-engine nerdctl --containerd-address /run/k3s/containerd/containerd.sock \
  --namespace kq-federation-build \
  target --bundle /交付盘/指定版本 --manifest-sha256 <可信摘要> \
  --scheduler slurm --output /受控记录/slurm-target.json
```

PBS 再执行一次并选择 `--scheduler pbs` 和独立输出。目标 Docker 端省略 nerdctl 全局选项。命令只使用已核对 ID 的镜像，禁止拉取，禁网、只读根目录、非 root、无挂载、无额外 capability，限制 1 CPU/256 MiB/120 秒。输出保存为新的 0600 文件，已有记录不覆盖；缺工具、命令失败或观察结果不匹配不会生成成功记录。

记录绑定提交和镜像 ID，包含 OS、glibc、Spack 版本/架构，以及 GCC/G++/Fortran/Python 等工具事实。观察实现现补齐 Apptainer、Perl 的 path、canonicalPath、SHA-256 和版本，供验签配置与 profile 使用；新候选中同样要求这些工具存在。`hostTarget` 是运行观察容器那台主机的 CPU 观察值；它不保证其他主机支持同一指令集。按三机共同 CPU 能力选择最终 target，随后通过既有材料生产工具生成 profile 和 native lock，不能把本文件直接当作它们导入。

`runtimeToolsPresent` 保留兼容，只表示镜像内可找到 Apptainer/systemd 命令；不替代工具摘要，也不证明用户服务、cgroup 委派、签名 SIF、受限作业或安装 store 已配置。普通模式的 `AGENT_SPACK_ENABLED=true` 只打开探测。需要托管安装和 SelfAccount 联邦任务时使用下面的显式配置；目标平台原生运行与内核隔离仍须现场验收。

## 托管安装与联邦任务运行时

AIO 调度器使用 Ubuntu 24.04、显式选择的 Spack 兼容版本、同提交的编译 Agent、Apptainer 1.4.3 和 systemd。AIO 构建显式指定 Spack 版本，普通调度器基础镜像的 Ubuntu 20.04／Spack 1.0.3 默认值不变；旧宿主或旧镜像的 native lock 不能直接套用。公共 SIF 仅包含系统与编译/Spack 工具，不预装待验收的科学软件。提取先用与目标观察相同的限额、禁网、只读、非 root 观察容器读取镜像内 SIF 的字节数／SHA-256 小 JSON，再以受限 create 建立但不启动临时容器，通过 cp 复制文件，并在 finally 删除该容器：

```sh
python3 deploy/federation/offline.py runtime \
  --bundle /交付盘/指定版本 --manifest-sha256 <可信摘要> \
  --scheduler slurm --output /受控材料/spack-unsigned.sif
```

containerd 构建机在 `runtime` 前加前述 nerdctl 全局参数。复制后的字节数和 SHA-256 必须与镜像内记录完全一致，才发布只读 SIF 及旁边的 0600 metadata JSON；记录绑定提交、镜像 ID、字节数和 SHA-256，并明确标记尚未签名、尚未通过软件安装。失败留下 `.creating`，不会覆盖已有文件或盲目重试。先核对失败记录再人工处置；不把残留文件当作可用材料。实际发现过 stdout 命令退出 0 但 SIF 少 57,344 字节，原件留证且不得签名；`b54743b` 两类正式 runtime 入口已通过完整复制校验。新候选 SIF 的摘要与入口结果须重新取得。

各机构在独立受控环境批准签署，先核对原始提取记录，再在已存在的私有签署目录独占创建可写副本。下面只使用机构自行持有的 PEM 密钥，不创建密钥或覆盖原件：

```sh
(
  set -euC
  umask 077
  cat /受控材料/spack-unsigned.sif > /机构签署目录/spack-signed.sif
  apptainer sign --key /机构密钥/runtime-private.pem /机构签署目录/spack-signed.sif
  apptainer verify --all --key /机构信任/runtime-public.pem /机构签署目录/spack-signed.sif
  sha256sum /受控材料/spack-unsigned.sif /机构签署目录/spack-signed.sif > /机构签署目录/sif-sha256.txt
  chmod 0444 /机构签署目录/spack-signed.sif
)
```

`noclobber` 与 umask 保证副本以 0600 新建，已有副本或摘要记录会令流程失败；失败残留须先核对，不能直接重跑覆盖。私钥不进入通用包、调度器或 Agent。签名会改变文件摘要，保留原始提取记录和签后摘要，部署后的 SIF 须归 root、0444。构建公共 SIF 不授予软件安装或数据访问权。

SIF 的 `runtime.pub` 是 PEM 验签公钥；`AGENT_SANDBOX_PUBLIC_KEYS_JSON` 信任本站 Server 的派发签名；Registry 的 Workflow 信任键用于资产发布。三种公钥不能混用，PR 专用 `workflow-signing.ts` 不能替机构配置 SIF 信任。

在本站私有目录下准备 `runtime/`，目录归 root、0755，所有父目录禁止组/其他用户写入；公共配置、公钥、profile 归 root、0444，容器只读挂载到 `/opt/kq/runtime`。`agent.json` 采用下面的结构，摘要与公钥替换为实际值：

```json
{
  "version": 1,
  "environment": {
    "AGENT_SPACK_AUDIT_APPTAINER_PATH": "/usr/bin/apptainer",
    "AGENT_SPACK_AUDIT_APPTAINER_SHA256": "<最终镜像内可执行文件SHA-256>",
    "AGENT_SPACK_AUDIT_SIF_PATH": "/opt/kq/runtime/spack.sif",
    "AGENT_SPACK_AUDIT_SIF_SHA256": "<签后SIF的SHA-256>",
    "AGENT_SPACK_INSTALL_SITE_PROFILE_PATH": "/opt/kq/runtime/site.json",
    "AGENT_SPACK_INSTALL_SITE_PROFILE_SHA256": "<实际profile的SHA-256>",
    "AGENT_SANDBOX_SIF_PUBLIC_KEY_PATH": "/opt/kq/runtime/runtime.pub",
    "AGENT_SANDBOX_SIF_PUBLIC_KEY_SHA256": "<SIF公钥文件SHA-256>",
    "AGENT_SANDBOX_PUBLIC_KEYS_JSON": "{\"本站派发keyId\":\"本站Server的PEM公钥\"}",
    "AGENT_SANDBOX_RUNTIME_CACHE_JSON": "{\"sha256:<签后摘要>\":{\"kind\":\"SIF\",\"localPath\":\"/opt/kq/runtime/spack.sif\",\"signatureVerified\":false}}"
  }
}
```

只接受这些运行时键、显式网络输入／结果搬运 JSON，以及安装内存/超时、证明期限、可选公共 CA 路径 `NODE_EXTRA_CA_CERTS`/`CURL_CA_BUNDLE`。CA 文件同样受 root 路径保护。不能覆盖 Agent/Server 身份、开启 root impersonation 或注入 Node/shell 选项。不要把部署口令或任何私钥放入此 JSON。缓存中的 `signatureVerified` 不能代替实际验签和原生探测。

`site.json` 沿用生产 [site profile 契约](../../../packages/agent/src/spack/install-contract.ts)，绑定签后 SIF、最终镜像 OS、编译器/外部工具摘要及目标 lock 的 external。固定 `storeRoot=/srv/kq/spack`；共享 store、节点兼容、可信 recipe、本站限额四项确认须由本站核对，启动脚本不替操作者填写。镜像观察结果不是完整 profile，也不能替代 lock 生成。Spack 仍须从平台导入的真实 recipe、源码和最终目标依赖锁完成冷安装。

机构 `config` 命令加 `--managed` 后，只有测试调度器获得 privilege、私有 cgroup namespace 和 systemd；KQ/Fabric/R 不增加权限，R 与独立 Orderer 拒绝此选项。Agent 固定为非 root 的 kq（UID/GID 1000），两类调度器均走生产 SelfAccount 签名与原生探测。平台须显式批准对应账号映射和 SelfAccount 政策，节点/队列/签名资源/证明到期仍由生产入口检查；受限材料的 root trusted profile 不因此自动开放。PBS 在注册前部署固定逐作业 cgroup hook，失败阻止注册。

独立 Docker 卷保存 ext4 store 镜像，默认 2 GiB，可在首次启动前用 `KQ_AIO_MANAGED_STORE_BYTES` 选择 1–16 GiB；现有 store 尺寸变化会停止，绝不重格式化。格式化失败保留独占检查点；删除卷会丢失安装，不能作为修复办法。默认测试容器预算 2560 MiB（`KQ_AIO_MANAGED_MEMORY`），比普通模式多 2176 MiB，安装 worker 默认 1024 MiB、并发 1；还须核对完整主机预算。已有部署不能用换开关、换版本覆盖在途任务，须先停止接单、核对原作业并备份，走维护迁移。

privileged 测试容器不能抵御宿主管理员或容器 root 越权，不能用于不受信任机构共享宿主的生产隔离。此配置只用于用户指定的容器测试集群。目标平台的 SIF 签名、systemd/cgroup 委派、两类调度器签名作业与安装/停止/恢复的实际验收尚未执行，不能用配置检查代替。

## 托管 Slurm 的原生用量

`--managed --scheduler slurm` 自动增加独立的 MariaDB 11.4.8 容器和 `slurm-accounting` 持久卷，使用本机导出的镜像，预算 384 MiB，不映射宿主端口。调度器镜像内增加匹配版本的 slurmdbd/MySQL 插件，普通调度器构建不默认安装。PBS 不增加该服务。

每个机构独立准备两个密码文件，归 root、0600：`runtime/slurm-db-password` 和 `accounting/root-password`，均采用 32 个随机字节的十六进制编码。前者供 Slurm 专用数据库账号和 slurmdbd 使用；root 密码只挂载到数据库容器。不要放入 agent.json、环境变量明文或通用镜像包。首次创建可使用：

```sh
# 先准备本站 root 所有的 runtime/ 和 accounting/，后者设为 0700。
(
  set -eC
  umask 077
  openssl rand -hex 32 > /本站私有目录/runtime/slurm-db-password
  openssl rand -hex 32 > /本站私有目录/accounting/root-password
)
```

独占创建拒绝覆盖；已有数据库不能靠重新生成密码修复，须走备份和凭据轮换维护。Compose 只保存文件路径，原生数据库按其原持久卷启动，不删除或重新初始化旧账目。恢复须同时保留数据库、Munge、controller spool 和本站原密码，不能只恢复其中一项。

启动等待数据库健康，核对私有密码后写入 slurm 所有、0600 的 slurmdbd 配置；记账服务就绪并核对固定 cluster/account/kq 用户关联后，才启动计算调度器和注册 Agent。只补缺失关联，不重写已有不匹配关联；数据库不可用、密码不符或关联异常均阻止注册。该技术账号不授予平台业务权限；本站仍须批准 kq 的映射，调度账号为 `kq-aio`。

托管模式的 Agent 使用 `sacct`，原生累计用量沿现有 `slurm-sacct` 证据路径采集。slurmdbd 与计算/Agent 共同监督，任一退出即停止本次容器运行，避免长期只运行部分服务。普通 AIO Slurm 继续用 scontrol 查询保留终态，不提供 sacct 用量；不据此完成商业计费验收。本轮只完成接线和命令夹具，真实作业的 sacct 数值、数据库恢复及账单对应关系仍待现场验证。

## 私有配置与正式身份

合并[平台变量](../../main/env.example)、[联邦变量](../env.example)和[AIO 变量](env.example)，保存为本机构所有、0600 的文件。所有挂载采用绝对路径，签名、MSP、恢复密钥和账户均按机构独立配置，不放入通用归档。

`KQ_AIO_PRIVATE_DIRECTORY` 下准备：

- `casdoor/app.conf`：独立 SSO 数据库连接、origin、初始化数据和客户端。`staticBaseUrl` 使用本站资源，不能依赖国外 CDN；不使用开发免密登录。用户 `groups` 使用完整的 `机构/组名`；应用显式设置 `tokenGroupFormat: "Name"`，使令牌的组名与 KQ 的 SSO 映射一致。已有库的 `initDataNewOnly` 不会修复旧组关系，须由 SSO 管理员通过正常接口更新后重新登录。平台角色不隐含联邦业务权限，机构成员仍须在“设置 → 安全 → 联邦权限”独立授权。
- `edge/`、`tls/`：参考[HTTPS 示例](edge.conf.example)配置平台、SSO、对象存储三类域名；SAN 和 DNS 匹配。受控 CA 加入浏览器/Server/Agent 信任，不关闭 TLS 校验。
- `grpc/server.crt`、`grpc/server.key`：Server direct mTLS 的服务端证书和私钥，只读挂载；SAN 覆盖 Agent 实际连接名，由 Agent 信任的 CA 签发。客户端验证仍使用本站持久 Server CA。即使不启用调度器，Server 启动也需要这两个文件；私钥只供 Server 读取，不把 CA 私钥挂给 Agent。
- `agent-enrollment/token`：经本站正式 API 签发的单次注册令牌，归容器执行账号所有、0600；Slurm 为 root，PBS 默认为 kq。

机构 mTLS、Fabric 及治理材料沿[部署契约](../deployment.md)配置，端点必须是可达 VPC 地址。调度器预置 Agent 和注册工具，没有源码挂载、Bun 在线安装或开发登录。注册成功持久化；未知结果留下 `registration.attempt`，管理员核对原 Agent/证书后才可再次登记，不能反复生成身份绕过。

Slurm/PBS 按 cgroup 宣告资源，预留 256 MiB 给调度器/Agent；384 MiB 容器只申报 128 MiB 作业内存。真实编译另配足够预算。容器系统与旧 lock 不一致时，按最终镜像重新生成 profile/native lock。

Slurm controller/worker spool 和 Munge 身份分别使用持久卷；构建时移除软件包可能生成的 Munge key，首次启动各自生成，重建沿用本站原 key。已有部署不自动轮换密钥。PBS 使用独立 `PBS_HOME` 卷。容器重建不得删卷或重新初始化已有 PBS 数据库。两类调度器保留 24 小时终态查询窗口，PBS 配置失败会阻止 Agent 注册；窗口外或记录缺失时仍须人工核对原请求，不能推断原作业没有执行。普通 AIO Slurm 显式使用 scontrol，托管 Slurm 按上节使用实际记账数据库和 sacct。保留终态与数据库持久化都不保证运行中的进程在容器被删除后继续运行。实际重建、作业停止证明与历史恢复仍在现场验收中执行。

## 配置与显式启动

以下在目标机使用 Docker/Compose v2.24.4+ 执行，不要求 Bun。PBS 覆盖使用 Compose 的 `!override` 替换调度器卷，避免挂载 Slurm 状态目录。`config` 仅写新的 0600 私有配置并输出容量预算，不代表 readiness。

```sh
python3 /受信任工具/offline.py config \
  --bundle /目标交付目录 --manifest-sha256 <可信摘要> \
  --mode fabric --role institution --scheduler slurm \
  --env-file /etc/kuintessence-aio/site-a.env --project kq-fed-site-a \
  --output /etc/kuintessence-aio/site-a.config
```

C 使用 `--scheduler pbs`。普通模式只有 PBS 测试容器获得 privilege；托管模式两类测试调度器均需要该权限，按上节准备运行时后为机构配置显式加 `--managed`。独立无链验收使用 `--mode direct`，没有 Fabric 服务/连接。R 使用 `--role arbitrator --mode fabric`，不包含调度器或 Orderer，移除非案件链能力；使用独立项目、私有目录及全部端口。

只验收平台与联盟链时，为机构的 `config` 命令增加 `--no-scheduler`。平台、登录、权限、存储、Registry、Peer、Orderer 及四组 Adapter／链码保持启用；生成配置不包含 Slurm/PBS、Agent、记账数据库或调度器专用卷，也不需要 Agent ID、注册令牌、签名 SIF、site profile 或 native lock。该选项不能与 `--managed` 或非机构角色同时使用，`--scheduler` 在此模式不启用任何调度服务。无链模式同样可用。

此模式的默认预算为 direct 2848 MiB、fabric 4640 MiB，均含 512 MiB 系统余量，未计同机其他容器及可选 observer。完整 fabric 平台仍超过当前 4 GiB 主机预算；不自动降低限额或裁剪链能力。无 Agent 时不验收任务执行、科研软件安装、实际计算用量或跨机构计算 Workflow。切换已有项目的调度器参与状态须先维护、处理原任务并保留状态卷；启动工具拒绝直接覆盖，不自动停止或删除旧容器／卷。

该选项只改变 Compose 渲染，无需重建平台或链镜像。已导出的旧交付包及其摘要保持不变，可用包外另行取得并信任的新版 `offline.py` 读取原包；单独记录工具版本，旧包内的脚本不会自动新增此选项。

第四排序节点使用 `--role orderer --mode fabric --project kq-fed-orderer-four`；只需要 Fabric 私有目录、bind 和端口。其配置仅包含 Orderer 与独立卷，不导入原平台或 `/opt/deploy`。

得到部署授权、准备备份后才能启动：

```sh
python3 /受信任工具/offline.py up \
  --bundle /目标交付目录 --manifest-sha256 <可信摘要> \
  --config /etc/kuintessence-aio/site-a.config
```

启动重新核对交付/镜像和项目范围，固定 `pull_policy: never` 与 `--no-build --pull never --wait`。模式、角色和交付版本在启动前持久化；失败后不能换模式/版本覆盖在途状态。升级另走维护、备份和兼容性核对，不提供强制跳过。

容量按常驻服务限额加 512 MiB 系统余量、当前可用内存做保守检查，不等于峰值实测。完整默认 Fabric AIO 预算可能超过 4 GiB，工具会拒绝启动；须测量调优或申请扩容，不能删除必要组件伪造成功。

## 首次登录与权限就绪

`up --wait` 只确认容器启动与各服务自身的健康检查；Server 的 `/api/health` 也只表示 HTTP 进程可用，不能据此宣布用户权限或联盟通道就绪。

AIO 默认 `AUTHZ_OUTBOX_INTERVAL_SEC=1`，可在私有环境文件调整；普通平台的服务默认值仍为 5 秒。首次目录可能产生数万条投影，处理时间仍取决于数据库与 CPU 预算。调整轮询间隔不跳过授权或持久化，也不增加主机资源限额。

1. 完成真实 SSO 登录，检查 `/api/auth/session` 中的角色是否与本站已批准的组映射一致。OIDC 登录只同步平台角色，不自动创建开发机构或赋予机构成员身份；管理员通过平台的机构管理和成员管理建立正式归属，再单独授予所需联邦能力。旧机构和成员不会因升级删除，SSO 登录也不会覆盖其成员角色。开发免密登录仍保留历史默认机构行为，仅在开发环境可用。
2. 打开“设置”的权限管理面板（`/settings#security/authz`），查看现有就绪结果，或用当前管理员会话请求 `GET /api/admin/authz/readiness`。AIO edge 的 API 前缀是 `/platform/api`。验收要求 `mode=enforce`、`healthy/schemaWritten/schemaMatches=true`、`outbox.pending/processing/dead=0`、`shadowDiffs=0`、`enforceReady=true`；接口的 `externalSmokeRequired=true` 表示还需验证实际授权操作。
3. 首次软件目录初始化会生成大量权限投影，新管理员的投影可能仍在队列中。若管理接口暂时返回 403，用已有 Compose 配置执行下面的只读队列查询；有积压且持续下降时等待后台处理，不能删除队列或关闭 enforce。队列清空后仍为 403，回查 SSO 角色和管理员授权；有 dead 行时在管理入口核查失败原因并按原记录恢复。

```sh
docker compose --project-name <本站项目> -f /本站私有配置/compose.json \
  exec -T postgres sh -ec 'psql -X -v ON_ERROR_STOP=1 -U "$POSTGRES_USER" -d "$POSTGRES_DB" -c "SELECT status, count(*) FROM authz_outbox GROUP BY status ORDER BY status"'
```

查询不输出连接密码、授权原件或用户资料。随后只验证本站需要的授予／撤销及跨机构拒绝；已有未受影响的验收证据直接引用。权限就绪与 Fabric 通道加入、指定机构背书和 VALID 交易分别验收。

## 停止与恢复

Registry 和四种链码服务使用 Compose `init: true`，由运行时转发停止信号并回收子进程，避免未处理信号的 Bun／Node.js 直接作为 PID 1 时一直等待到 SIGKILL。镜像内容不变；应用配置需要重建受影响容器，保留原命名卷、私有文件与镜像 ID。信号退出可能记录为 143，不能仅因退出码非零就认定 OOM；同时检查 `OOMKilled`、停止耗时与日志。这一设置不提供在途交易排空或数据库恢复证明。

Casdoor 同样启用 `init: true`。固定镜像中的 Go runtime 在进程作为 PID 1、无法按默认信号动作终止时会兜底退出 2；该现象不能直接当作应用 panic。已在一个机构平台定向验证：保留同一镜像与挂载，启动后健康，停止约 0.33 秒、退出 143，无 OOM。此项只验证启动健康与停止信号，真实 SSO 使用前次整站恢复证据，不重复计为本次检查。

使用原项目的 `docker compose stop` 保留容器和数据，不用 `down -v`。停止后核对挂载时按目标路径比较全部属性，Docker inspect 的列表顺序可能变化。已有初始化容器退出 0 时不重复执行初始化。共享 CI 主机在暂停 Runner 前确认没有活动任务，试验全部停止后才能恢复 Runner；再次启动平台需重新安排资源窗口。

固定候选的一个机构平台已补验整站恢复：21 个常驻服务按依赖顺序启动，原账号真实 SSO、机构和三项读取权限保留，三个读取 API 返回 200，页面无脚本或 HTTP 错误。该站应用 init 后再次停止，Registry／四链码均退出 143，无强杀或 OOM；全部原镜像与挂载保留，结束后恢复原 Runner／DinD。整站检查时 Casdoor 的退出 2 已由上述定向接续修复。原 Runner 反复重启的日志为向 Forgejo Declare 请求返回 HTTP 524；两处网络访问均超时，外部连接原因仍待定位，未改注册凭据或用容器恢复代替新 CI 作业验收。这些结果不覆盖在途业务、备份恢复或联合链交易。

后续用户已明确停用原 Runner／DinD，两者现保持停止，容器、配置、数据和原 `unless-stopped` 策略保留，外部 Forgejo 诊断不再推进。停用期间的试验不得沿用历史收尾步骤自动恢复它们。

## 离线机构管理操作

取得部署与治理授权、启动对应项目后，使用同一可信包和私有配置运行按需工具，不切换到旧在线入口：

```sh
python3 /受信任工具/offline.py admin \
  --bundle /目标交付目录 --manifest-sha256 <可信摘要> \
  --config /etc/kuintessence-aio/site-a.config --operation orderer-join

python3 /受信任工具/offline.py admin \
  --bundle /目标交付目录 --manifest-sha256 <可信摘要> \
  --config /etc/kuintessence-aio/site-a.config --operation approve --kind evidence
```

支持现有初始化脚本的 `orderer-join`、`peer-join`、`install`、`approve`、`readiness`、`commit`、`initialize`、`verify`；后六项须指定 `--kind`。参数文件、组织独立批准和未知结果查询仍沿用[初始化契约](../deployment.md#显式初始化与升级)，不会生成或替其他机构批准材料。

direct 拒绝链管理；R 只允许本站 Peer 和 case 链码操作；第四 Orderer 仅允许 `orderer-join`，临时工具只挂载独立 admin 目录，不增加常驻服务。命令校验原部署身份、镜像、容量并持有同一部署锁，执行 `run --rm --no-deps --pull never`，不会连带启动其他服务。未知响应后先查询原状态，不能将重跑批准、提交或 Init 当作恢复机制。这一入口完成了模拟执行和 Compose 配置检查，真实通道操作仍待部署验收。

先一台稳定及测量，再三机构和四节点 SmartBFT。通道/PDC/链码由各方按[初始化流程](../deployment.md#显式初始化与升级)批准，不用健康检查代替有效交易。最后限制国外出口但保留 VPC/DNS/SSH，检查加载、登录、初始化、作业和软件准备无外网依赖。满盘及恢复测试使用专用卷/通道，38 项分别保存证据。
