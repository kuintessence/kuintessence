# kq-preview

面向 CI 的短期 PR preview wrapper，通过 `file://../kq-platform` dependency
复用用户 chart，不复制工作负载模板。每个 preview 必须使用独立 namespace。
只支持本轮约定的单节点 `linux/amd64`；不部署嵌套 k3s。

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
| `secrets.existingSecret` | 默认 `kq-preview-secrets` |
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

## Secret 契约

CI 必须在安装前创建同 namespace 的 `kq-preview-secrets`。Chart 不创建或读取
明文口令，不把 Secret 内容写入 ConfigMap、values 或 Helm release 参数。

| key | 使用者 / 约束 |
| --- | --- |
| `DATABASE_URL` | Server、Registry、migration、seed；指向 `<release>-postgres:5432` |
| `POSTGRES_PASSWORD` | PostgreSQL；必须与 `DATABASE_URL` 中经过 URL 编码的密码一致 |
| `JWT_SECRET` | Server/Registry 共用，至少 32 字符 |
| `RUSTFS_SECRET_KEY` | RustFS root 与 bootstrap |
| `NETDRIVE_ACCESS_KEY` | Server 与 bootstrap 共用的普通 IAM 用户，不能等于 RustFS root |
| `NETDRIVE_SECRET_KEY` | 该普通用户的密码 |
| `PREVIEW_HTPASSWD` | 完整 `preview:<hash>` 一行；由 CI 从 preview 密码生成 |
| `PREVIEW_COOKIE` | 32 字节随机值的小写 hex，即恰好 64 字符；不能是密码或公开固定值 |
| `SERVER_CA_CERT` / `SERVER_CA_KEY` | 持久保留的 Agent CA证书和私钥，仅挂载到 Server |
| `SERVER_TLS_CERT` / `SERVER_TLS_KEY` | 同一 CA签发的 Server gRPC证书和私钥，仅挂载到 Server |

CI 可在首次部署生成并将 `PREVIEW_PASSWORD` 额外保存在同一 Secret，供有权限的
操作者私下获取；chart 不挂载或输出该字段。后续升级保留密码/hash/cookie，
不要每次重新随机生成。CI将 `sha256(data.PREVIEW_COOKIE)` 的 64位小写 hex结果写入
`preview.credentialsRevision`；该非敏感摘要成为 Pod annotation，cookie轮换后随
Helm upgrade自动 rollout gateway，不把 cookie本身放入 values/ConfigMap。
轮换 NetDrive 用户/密码后递增 `netdrive.bootstrapRevision` 并重启 Server。

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
以及需要时的 namespace FQDN。CA与私钥只挂载给 Server，不挂载给 scheduler。
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

preview NetworkPolicy限制跨 namespace入口，仅允许指定 namespace与 Pod label
匹配的 Traefik访问 gateway。同 namespace工作负载彼此信任；该策略不提供完整
egress隔离。部署前确认 k3s启用了 NetworkPolicy执行，并确认 Traefik Pod labels。

## 生命周期与验证

普通 Helm卸载会保留 Registry PVC以及 StatefulSet PVC。CI应按已批准的 preview
生命周期删除整个专用 namespace，并确认 PVC/PV按集群 StorageClass回收策略清理。
不要将 preview namespace与用户数据或其他 release混用。
namespace 清理成功后，CI 同步回收该 PR 的专用 GHCR 镜像版本；
跨 PR 或包含其他用途 tag 的 version 不删除。权限不足时清理 job 会失败并可重试。
完整的首次公开、重试和版本回收边界见 [预览配置](../../../docs/preview-k3s.md)。

Actions应执行 `scripts/helm-preview-contract.test.ts` 和
`scripts/helm-preview-render.test.ts`。后者仅在 Helm可用时运行，使用临时目录构建
本地 dependency并渲染，不访问集群。真实部署还应验收未解锁访问受阻、解锁后
Bearer请求成功、TLS证书、Agent online及实际 demo workflow；这些不由静态合同
测试替代。
