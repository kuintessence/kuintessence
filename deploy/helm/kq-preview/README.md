# kq-preview

面向 CI 的短期 PR preview wrapper，通过 `file://../kq-platform` dependency
复用用户 chart，不复制工作负载模板。所有 PR 使用预先创建的共享 `preview`
namespace，每个 PR 的 Helm release 为 `kq-pr-<编号>`。
只支持本轮约定的单节点 `linux/amd64`；不部署嵌套 k3s。
共享 namespace 安全实现仍待复核及对应提交的 Actions/真实集群验收，本文不代表已上线。

## CI 输入

所有覆盖值位于 `kq-platform` key 下。CI 在 Actions 中先构建本地 chart dependency，
再部署 wrapper；不要提交 dependency archive 或将第三方凭据写入 values。

| key | 含义 |
| --- | --- |
| `preview.host` | 完整 DNS hostname，不含协议、端口、路径 |
| `preview.credentialsRevision` | CI提供的非敏感 cookie摘要，变化时自动 rollout gateway |
| `server.image` | Server 镜像 |
| `registry.image` | Registry 镜像 |
| `web.image` | Web 镜像，构建时启用 `VITE_PREVIEW_LOGIN=true` |
| `migration.image` | db-migrate 镜像 |
| `scheduler.image` | Slurm + Agent 镜像，完整内置 `/workspace` 和依赖 |
| `seed.image` | seed 镜像，入口由镜像提供 |
| `global.imagePullSecrets` | CI 固定 `[]`，从公开 GHCR 匿名拉取 |
| `secrets.existingSecret` | CI 指定当前 release 的 `kq-pr-<编号>-secrets`，不可跨 PR 共用 |
| `preview.repository` | CI 从受信 `GITHUB_REPOSITORY` 传入 `owner/repo`，用于 PVC 归属核验 |
| `scheduler.providerName` | 默认 `Development Compute Provider`，需与 seed 一致 |
| `scheduler.registrationEmail` | 默认 `scheduler-compose-seed@kuintessence.test` |

六镜像分别使用 `ghcr.io/<owner>/kq-dev-<component>`，component 为
`server`、`registry`、`web`、`db-migrate`、`scheduler`、`seed`。
每个 image 支持 `repository`、`tag`、`digest`、`pullPolicy`：
CI 使用 `repository@sha256:<64hex>`，并记录
`pr-<PR>-sha-<fullsha>-run-<run ID>-<attempt>` tag 供版本归属和清理。
wrapper 故意不提供可运行的默认镜像地址，防止漏传时启动旧镜像。

五类 PVC 的容量/StorageClass 使用：
`postgres.storage/storageClass`、`redis.storage/storageClass`、
`rustfs.storage/storageClass`、`registry.persistence.storage/storageClass`、
`scheduler.storage/storageClass`。空 StorageClass 使用集群默认值。

`global.nodeSelector` 已设 `kubernetes.io/os=linux` 和
`kubernetes.io/arch=amd64`；所有工作负载及 init Job 继承。
首次发布六个 package 后，由维护者手动设为 public，再重试失败的部署 job。
CI 在访问 k3s 前校验匿名拉取，不把 `GITHUB_TOKEN` 或其他 GHCR 凭据保存到集群。

preview 的 `migration.waitImage` 与 `rustfs.bootstrapWaitImage` 暂时统一使用
`docker.io/bitnamilegacy/kubectl:1.32.3`，保留等待脚本接口和 kubectl 版本。
Legacy 镜像不再获得安全更新，只用于本次短期预览兼容，不推荐用于生产；
后续应替换为持续维护、固定 digest 的等待镜像。此覆盖不改变用户版 Chart 的配置。
Actions 显式运行容器契约测试，验证匿名拉取、amd64、`/bin/sh` 和 `kubectl wait`；
同时验证渲染后的 gateway 配置与启动流程，不能只以 Helm 渲染成功作为运行验收。

## Namespace 与资源归属

管理员预建 `preview` 并配置 namespace-only RBAC。CI 只管理其中的 Chart 资源、
Helm release Secret、自有 PVC、应用 Secret 和 owner marker；
不要求读取 nodes/namespace 对象，不创建或删除 namespace，不需要 cluster-admin。
节点架构、存储、Traefik/TLS 和 NetworkPolicy 执行能力由管理员预先准备。

每个 release 的资源使用 `app.kubernetes.io/instance=kq-pr-<编号>` label，
Service、PVC 归属及网络策略均需限定该 release。CI 以
`kq-pr-<编号>-preview-owner` marker 核验仓库、PR 和 release 的归属，
不能仅凭共享 namespace 或资源名称前缀接管、删除现有资源。
namespace 级权限不是每 PR 的 RBAC 隔离，本模式只适合受信任维护者。

## Secret 契约

CI 必须在安装前于 `preview` 创建本 PR 的 `kq-pr-<编号>-secrets`，
并通过 `secrets.existingSecret` 引用。不同 PR 不共享 Secret。
Chart 不创建或读取明文口令，不把 Secret 内容写入 ConfigMap、values 或 Helm release 参数。

| key | 使用者 / 约束 |
| --- | --- |
| `DATABASE_URL` | Server、Registry、migration、seed；指向 `<release>-postgres:5432` |
| `POSTGRES_PASSWORD` | PostgreSQL；必须与 `DATABASE_URL` 中经过 URL 编码的密码一致 |
| `JWT_SECRET` | Server/Registry 共用，至少 32 字符 |
| `RUSTFS_SECRET_KEY` | RustFS root 与 bootstrap |
| `NETDRIVE_ACCESS_KEY` | Server 与 bootstrap 共用的普通 IAM 用户，不能等于 RustFS root |
| `NETDRIVE_SECRET_KEY` | 该普通用户的密码 |
| `PREVIEW_HTPASSWD` | 完整 `<PREVIEW_USER>:<hash>` 一行；由 CI 从仓库固定入口凭据生成 |
| `PREVIEW_COOKIE` | 32 字节随机值的小写 hex，即恰好 64 字符；不能是密码或公开固定值 |
| `SERVER_CA_CERT` / `SERVER_CA_KEY` | 持久保留的 Agent CA证书和私钥，仅挂载到 Server |
| `SERVER_TLS_CERT` / `SERVER_TLS_KEY` | 同一 CA签发的 Server gRPC证书和私钥，仅挂载到 Server |

CI 必须读取仓库 Actions Secrets `PREVIEW_USER` 和 `PREVIEW_PASSWORD`，所有 PR
使用同一组固定 Basic Auth 凭据；缺失或不合法时拒绝部署，不随机生成或沿用旧入口口令。
用户名须为 1–64 字符、以字母或数字开头，仅含字母、数字、`_`、`.`、`@`、`-`；
口令至少 24 字符且不含控制字符。CI 将两者额外保存在同一 Secret，供 HTTPS 验收使用，
chart 不挂载或输出这两个字段。数据库、JWT、对象存储凭据和 Cookie 仍按 PR 隔离。
固定凭据不变时升级保留 hash/cookie；变更账号或口令、迁移旧格式 Secret 时轮换 Cookie。
修改仓库 Secrets 后须重新部署各开放 PR，运行中环境不会自动同步新凭据。
CI将 `sha256(data.PREVIEW_COOKIE)` 的 64位小写 hex结果写入
`preview.credentialsRevision`；该非敏感摘要成为 Pod annotation，cookie轮换后随
Helm upgrade自动 rollout gateway，不把 cookie本身放入 values/ConfigMap。
轮换 NetDrive 用户/密码后递增 `netdrive.bootstrapRevision` 并重启 Server。

维护者通过私密渠道向审阅者提供固定账号与口令，不在 Actions、PR 评论或公开日志中输出。

## 启动与数据

1. PostgreSQL 就绪后 migration Job 运行；Server、Registry 等待 migration 完成。
2. seed Job 等待 migration，按镜像默认 command 运行，仅注入 `DATABASE_URL` 与
   `SEED_MODE=demo`。seed 应幂等创建机构/provider、用户及公开 demo workflow；
   不依赖 Server/Agent 启动，不记录数据库凭据。Server还需等待 seed完成，
   因此 seed入口必须保持 DB-only，不能反过来请求 Server API。
3. RustFS bootstrap 创建三个 bucket、Object Lock/retention/lifecycle/CORS及非 root
   committer；Server 等待该 bootstrap 成功。
4. scheduler 等待 seed 与 Server health，再启动现有 Slurm entrypoint：
   munge、slurmctld、slurmd及 Agent。开发注册仅使用内部 HTTP Server Service，
   CLI返回客户端证书和 CA；Agent gRPC始终使用 HTTPS direct mTLS。

Server开启 `MTLS_MODE=direct`，从同一个只读 Secret volume读取：
`SERVER_CA_DIR=/etc/kuintessence/ca`、
`SERVER_GRPC_TLS_CERT_FILE=/etc/kuintessence/tls/server.crt`、
`SERVER_GRPC_TLS_KEY_FILE=/etc/kuintessence/tls/server.key`。
内部 gRPC连接为 `https://<release>-server:3001`，证书 SAN必须包含该 Service名
以及使用的 `preview` namespace FQDN，如 `<release>-server.preview.svc` 和
`<release>-server.preview.svc.cluster.local`。CA与私钥只挂载给 Server，不挂载给 scheduler。
不得使用 `NODE_TLS_REJECT_UNAUTHORIZED=0`、跳过证书校验或降级为 HTTP gRPC。
四个 PKI字段首次生成后持久保留；若更换 Server证书，更新
`server.grpcTls.credentialsRevision` 触发 Server rollout。CA轮换还需协调重签并
更新 Agent bundle，不可单独替换 CA后继续复用旧客户端证书。

Registry 的现有 blob PVC 同时保存 `recipes/`、`materials/`，继续保持单 writer。
Agent PVC 的 `state/` 保存 registration bundle、数据库与 managed job work root，
`scratch/` 挂载到 `/scratch`。Slurm 使用 `proctrack/linuxproc` 和 `task/none`，
容器以 root 启动守护进程但 `privileged: false`，无 `hostPath`、Docker socket、
host network或宿主机 cgroup 挂载。不是 managed Spack/Apptainer隔离验收环境；
不能把 Slurm 的资源报告当作 Pod cgroup 配额的精确映射。

**阶段 1边界：`AGENT_SPACK_ENABLED=false`，明确不提供远程 managed Spack安装、
审计、激活或 Spack全工作流验收。** 本轮仅接线基本 Slurm/Agent运行与 demo
workflow；镜像内有 Spack不代表这些能力已启用或在远端通过验收。

镜像必须内置依赖；initContainer 缺依赖时立即失败，不依赖启动时联网安装。
本轮镜像仍须在 Actions/真实集群确认非 privileged Slurm 的运行兼容性。

## HTTPS 与认证边界

Ingress 只暴露 gateway，使用 `traefik`、`websecure`、完整 Host及相同 `tls.hosts`。
不设置 `secretName`，不创建 cert-manager 资源，不跨 namespace引用 `kube-system`
证书。集群已有的 Traefik默认 TLS 证书必须覆盖 `preview.host`，浏览器和 Agent
都必须信任该证书；DNS及集群内对该 HTTPS origin 的可达性由操作者负责。

gateway 的 `/__preview/unlock` 通过 BasicAuth验证后签发 Secure/HttpOnly/SameSite
cookie。应用 API/页面请求用 cookie通过 preview gate，Bearer Authorization原样转发；
Basic Authorization不传给应用。cookie值仅通过 Secret env注入，官方 nginx
entrypoint的 envsubst严格限制为 `PREVIEW_COOKIE`。不在日志中记录请求 URL。
Web nginx来自共享配置副本，只替换 release Service upstream、端口及 preview HTTPS
forwarded protocol；合同测试检查副本和原文件一致。

默认 `NETDRIVE_PUBLIC_URL=https://<preview.host>`，S3在同 origin的三个 bucket
路径转发，完整保留 Host、路径和 query。当前 Server presign不支持 `/s3` base path，
不能配置成 `https://host/s3`；例如 bucket `kuintessence` 使用 `/kuintessence/...`。
三个固定 bucket的对象路径仅允许 GET/PUT，显式拒绝 HEAD和其他方法；
bucket根路径（含尾随 `/`）返回 404，不开放 console/admin、bucket listing
或任意 bucket。

**S3对象请求独立使用 presigned URL授权，不要求浏览器 preview cookie。**
gateway只预筛 query中存在非空 `X-Amz-Signature`，不把该检查当作认证成功：
RustFS继续验证 SigV4、有效期、方法、对象及 IAM权限。伪造/过期签名必须由
RustFS拒绝；对象请求清除 Authorization与 Cookie，不支持 AWS header认证绕过。
原 Host、query和对象路径保持不变，gateway access/error日志不记录 signed URL。
因此 Agent signed-URL GET/PUT无需浏览器会话；文件工作流的真实验收仍留给 Actions，
不能把路由接线或浏览器下载验收当作 Agent文件工作流已经通过。

preview主动使用开发登录和 `AUTHZ_MODE=off`，只适合受信任维护者共享的临时环境，
不是生产认证方案或不受信任多租户沙箱。公网必须经过 gate；Agent注册/证书路径
在 gateway阻断，内部注册不经过 gateway。不要再暴露 Server/Registry/对象存储的
NodePort、LoadBalancer或额外 Ingress。

preview NetworkPolicy按 release label 选择受保护 Pod 和允许的同 release 来源，
不能放通 `preview` namespace 中所有 Pod；不同 PR 不能因为共享 namespace 而
互访受保护后端。外部入口仅允许指定 namespace 与 Pod label 匹配的 Traefik访问
对应 gateway。该策略不提供完整 egress隔离，也不能代替应用认证或构成不可信
多租户沙箱。部署前确认 k3s启用了 NetworkPolicy执行，并确认 Traefik Pod labels。

## 生命周期与验证

普通 Helm卸载会保留 Registry PVC以及 StatefulSet PVC。CI先核验 owner marker
和资源归属，在 `preview` 中仅卸载本 PR 的 `kq-pr-<编号>` release，再删除其自有
残留 PVC、`kq-pr-<编号>-secrets`，最后删除 `kq-pr-<编号>-preview-owner`。
本 PR 的集群资源清理成功后，才回收对应的专用 GHCR 镜像版本；
跨 PR 或包含其他用途 tag 的 version 不删除。任何归属或资源清理失败均阻止 GHCR 回收。
后续 GHCR 回收失败不改变本 PR 站点已移除的事实，但 cleanup job仍失败并可重试。

**清理绝不删除共享 `preview` namespace 或其他 PR 的资源。** 本 PR 的演示数据随
自有 PVC清理而丢失，底层卷是否回收由 StorageClass决定；控制器不直接管理集群级 PV。
旧 `kq-pr-<编号>` 独立 namespace 不自动迁移、复制或删除，须由管理员另行审核处理。
完整的首次公开、重试和版本回收边界见 [预览配置](../../../docs/preview-k3s.md)。

Actions应执行 `scripts/helm-preview-contract.test.ts` 和
`scripts/helm-preview-render.test.ts`。后者仅在 Helm可用时运行，使用临时目录构建
本地 dependency并渲染，不访问集群。真实部署还应验收未解锁访问受阻、解锁后
Bearer请求成功、TLS证书、Agent online及实际 demo workflow；这些不由静态合同
测试替代。
