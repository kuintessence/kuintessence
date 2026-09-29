# kq-platform Helm 图表

使用此 Helm chart 将 Server 与 Registry 部署到 Kubernetes。

## 用户部署与 PR preview

本 chart 是共用模板的唯一来源。CI 使用
[`../kq-preview`](../kq-preview/README.md) wrapper，通过本地 dependency启用完整
Server、Registry、Web、PostgreSQL、Redis、RustFS、NetDrive、seed和单容器
Slurm/Agent；无需复制模板。preview的开发认证不可用于真实用户公网部署。

PR preview 使用预先创建的共享 `preview` namespace，各 PR 对应独立
`kq-pr-<编号>` Helm release、`kq-pr-<编号>-secrets` 应用 Secret 和
`kq-pr-<编号>-preview-owner` owner marker。资源使用
`app.kubernetes.io/instance=kq-pr-<编号>` release label，Service和 preview
NetworkPolicy限定本 release，不放通同 namespace 的其他 PR 后端访问。
部署身份仅需 `preview` 内的工作负载、存储声明、Secret、网络策略和 namespace 级
RBAC权限；不需要 nodes/namespace 对象查询、namespace创建删除或 cluster-admin。
基础设施与策略执行由管理员预先配置，namespace权限本身不是每 PR 的权限隔离。
这些约定只适用于 preview wrapper，不改变用户版 chart的安装 namespace选择。
共享 namespace实现仍待安全复核和对应提交的 Actions/真实集群验收，不宣称已上线；
旧独立 PR namespace不会自动迁移或清除。完整契约见
[k3s PR 预览](../../../docs/preview-k3s.md)。

用户默认 `server.env.NODE_ENV=production`，禁用任意邮箱/角色的开发登录。
`seed.enabled` 默认关闭，启用后 `seed.mode` 默认 `minimal`，只执行镜像中的最小
初始化入口；`demo` 由 preview显式启用。seed并不是认证初始化的替代品：
生产用户仍需设置可信 OIDC/SSO并完成管理员引导。非 production Server只允许在
启用受保护 preview时渲染，不能用 minimal seed作为开放开发登录的理由。

六个自建组件的 `image` 支持 `digest`；配置时使用 `repository@digest`，
否则使用 `repository:tag`。`global.imagePullSecrets` 与 `global.nodeSelector`
适用于本 chart的工作负载。启用 Web会挂载 chart内 nginx副本，按 release名称
替换 Server/Registry upstream；源码一致性由 `scripts/helm-preview*.test.ts` 检查。

推荐使用 `secrets.existingSecret`，不要通过命令行或 values传递生产密码。
使用内置 PostgreSQL时，该 Secret必须同时包含 `POSTGRES_PASSWORD` 和完整
`DATABASE_URL`，二者密码一致；迁移、seed、Server、Registry均从 Secret引用连接串。
其余 key包括 `JWT_SECRET`、`RUSTFS_SECRET_KEY`，启用 NetDrive还需
`NETDRIVE_ACCESS_KEY`、`NETDRIVE_SECRET_KEY`。Server与 bootstrap从同一 Secret
读取非 root committer凭据，不要求 values中的用户名与 Secret同步。

`server.env` 提供固定的 `NODE_ENV`、`AUTHZ_MODE`、`SSO_BOOTSTRAP_ENABLED`、
`WEB_BASE_URL`、LOG/mTLS代理设置。附加非敏感配置可用 `server.extraEnv`；
敏感配置使用 `server.extraSecretEnv: [{name, secretName, key}]`，例如 OIDC
client secret。受 chart管理的认证模式/数据库/NetDrive凭据不允许被这两种扩展覆盖。
生产 mTLS仍需按下文配置受信代理或独立 TLS材料，本 chart不代替证书管理。

### 用户版单容器 Slurm/Agent

用户 chart可显式开启 `scheduler.enabled=true`，但不能自动调用开发登录注册。
必须提供 `scheduler.registration.existingSecret`，其中包含已通过正常注册流程
取得的 `client.crt`、`client.key`、`ca.crt`。证书对应的 Agent identity必须已经
存在于此 Server的注册/证书 ledger中；单独生成自签客户端证书不能代替注册。
`scheduler.agentId`、`scheduler.siteName` 必须与该注册一致。

```yaml
server:
  env:
    NODE_ENV: production
    MTLS_MODE: direct
  grpcTls:
    existingSecret: kq-server-pki
    credentialsRevision: "1"
scheduler:
  enabled: true
  agentId: registered-slurm
  siteName: Registered Slurm
  registration:
    existingSecret: kq-registered-agent
    credentialsRevision: "1"
```

示例省略镜像与其他服务设置，使用者需提供完整 workspace镜像。
`kq-server-pki` 包含 `SERVER_CA_CERT`、`SERVER_CA_KEY`、
`SERVER_TLS_CERT`、`SERVER_TLS_KEY`；未单独指定该 Secret时回退到
`secrets.existingSecret`。Server原生 direct mTLS挂载 CA和 server key，配置
`SERVER_CA_DIR`、`SERVER_GRPC_TLS_CERT_FILE`、`SERVER_GRPC_TLS_KEY_FILE`。
Server证书必须由提供的 CA签发，SAN覆盖 `<release>-server`；Agent Secret中的
`ca.crt` 必须信任该 Server证书。gRPC固定使用内部 HTTPS Service，不关闭证书校验。

注册 Secret只读挂载到 `/etc/kuintessence/agent-certs`。已有 bundle中的
`agent.env` 不执行：chart提供仅含注释的 env文件，身份、HTTPS端点和 mTLS开关均
由 Deployment提供，避免 PVC中旧的 HTTP端点覆盖新配置。用户模式设置
`KQ_AGENT_REGISTRATION_ENABLED=0`；本地 Agent数据库放在 PVC
`/var/lib/kuintessence/agent.db`。轮换客户端证书后更新
`scheduler.registration.credentialsRevision` 触发 rollout。
seed可独立选择是否启用；启用时 Server和 scheduler等待 seed，否则 scheduler只等待
Server health。seed镜像必须保持 DB-only，不能请求尚在等待它的 Server API。

这提供用户版单容器调度器的部署/注册接线，不等于完整生产安全认证已自动配置：
OIDC、CA生命周期、机构与调度权限仍由用户设置。Slurm root守护进程要求 namespace
允许非 privileged的 root容器，本模式不提供强作业沙箱或宿主机 cgroup隔离。
**当前所有该模板部署的 scheduler均设置 `AGENT_SPACK_ENABLED=false`，不宣称支持
远程 managed Spack安装/审计/激活或完整 Spack工作流。** 相关集群运行验收仍待 Actions。

已有 MinIO 部署不能直接原地升级。先阅读 [RustFS 迁移边界](../../rustfs/README.md)，
迁移数据与固定版本引用后使用 `rustfs.*` values；旧 `minio.*` values 会明确报错。

## 快速安装（自托管依赖）

```bash
helm install kq deploy/helm/kq-platform \
  --set secrets.jwtSecret="$(openssl rand -hex 32)" \
  --set postgres.password="$(openssl rand -hex 16)" \
  --set rustfs.rootPassword="$(openssl rand -hex 16)"
```

此命令在集群内安装 Server、Registry、PostgreSQL、Redis 和 RustFS。

每次 Helm revision 先运行 `migration.image` 指定的幂等数据库迁移 Job。Server 与 Registry 的 initContainer 等待迁移成功后再启动应用。Registry 默认使用 `jwt` 鉴权，OCI blob 存放在受保护的持久卷中。

运行限制：

- Chart 部署 Redis，但 Server 请求使用进程内事件总线，不连接 Redis。多 Server 的 pub/sub/cache 尚未实现。
- Server 的事件总线、Agent session/dispatcher 和 Metering cron 使用单进程状态，因此 `values.production.yaml` 强制单副本并关闭 HPA。共享总线、session ownership 路由和 cron leader election 完成前，不得扩容。
- 默认 values 不启用 NetDrive。部署 RustFS 后，还需设置 `NETDRIVE_ENABLED=true` 并补齐必要的 `NETDRIVE_*` 环境变量，Server 才会挂载 S3-backed NetDrive 路由。
- Agent-Server 生产 mTLS 默认由受信任代理处理。上线前还需验证 Registry publisher RBAC、浏览器 CSP 和 SSH/file 多租户 scoping，见 [`../../../docs/status/current-state.md`](../../../docs/status/current-state.md)。

## Spack Recipe Git 存储

`registry.recipes.enabled` 默认 `true`，要求 `registry.persistence.enabled=true`
且 `registry.replicas=1`，否则 `helm template` 即失败。启用时 Registry Deployment
使用 `Recreate` 策略，先终止旧 Pod 再创建新 Pod，避免滚动升级期间出现两个 Git writer。
升级会短暂停机；不要另建写入同一 PVC 的 Registry，也不要通过手动替换 Pod 绕过单写者约束。

原有 `<release>-registry-blobs` PVC、`blob-storage` 挂载和 `BLOB_STORE_DIR` 均保持不变，
不添加 `subPath`，也不迁移已有 blob。Chart 仅在原 `registry.persistence.mountPath`
下增加 `recipes/`，并将该绝对路径传给 `SPACK_RECIPE_STORE_DIR`。默认布局：

```text
/var/lib/kuintessence/registry/blobs/  # existing blob PVC mount
  recipes/
    repositories/
    manifests/
    staging/
```

Recipe Git 只保存 recipe 内容与版本历史。源码包、厂商安装包和 buildcache 继续使用独立
制品存储，不能导入 recipe Git。Registry runtime 包含 Git，并设置
`GIT_CONFIG_GLOBAL=/dev/null`、`GIT_CONFIG_NOSYSTEM=1` 禁用默认 global/system config。

### 可选离线 Bootstrap

默认 `registry.recipes.bootstrapManifest=""`，不注入 Bootstrap 环境变量。启用时配置
容器内 manifest 的绝对本地路径：

```yaml
registry:
  recipes:
    enabled: true
    bootstrapManifest: /recipe-bootstrap/manifest.json
```

Chart 只将路径接线到 `SPACK_RECIPE_BOOTSTRAP_MANIFEST`，不会创建输入卷、ConfigMap、
Secret 或下载任务。管理员需通过自有 chart 扩展或离线 post-renderer 给 Registry Pod
配置 `volumes` 与 `volumeMounts`，将 manifest 和其引用的完整 Git bundle 挂载到
`/recipe-bootstrap`，并设置 `readOnly: true`。不要把只读输入挂载到可写的 `recipes/` 上；
设置路径本身并不代表文件已挂载。示例 manifest：

```json
{
  "version": 1,
  "repositories": [
    {"repository": "public/example", "bundlePath": "/recipe-bootstrap/example.bundle"}
  ]
}
```

Bundle 必须自包含且含 HEAD，例如在已有 recipe 仓库中执行
`git bundle create example.bundle HEAD`。管理员负责取得并检查输入，不把第三方输入或
本地运维清单提交到平台仓库。Bootstrap 不重导入已有仓库，不覆盖已有激活状态；
导入后的新快照须显式确认并激活。

#### 原需求源码材料文件包

`registry.recipes.materialBootstrapManifest` 默认 `""`，不注入
`SPACK_MATERIAL_BOOTSTRAP_MANIFEST`。启用时使用容器内 manifest 的绝对本地路径：

```yaml
registry:
  recipes:
    enabled: true
    bootstrapManifest: /recipe-bootstrap/manifest.json
    materialBootstrapManifest: /material-bootstrap/manifest.json
```

Chart 仅注入环境变量，不创建输入 volume、ConfigMap、Secret 或下载任务。运维负责通过
自有 chart 扩展或离线 post-renderer 将 manifest 及其引用的源码材料文件包挂载到
`/material-bootstrap`，并设置 `readOnly: true`；所有引用文件须在容器内可读。
不要覆盖可写的 recipe、material 或 OCI 存储目录，不要将受限文件包或运维清单提交到仓库。

Registry 将空字符串视为未设置；配置 material manifest 时必须有
`SPACK_MATERIAL_STORE_DIR`，且继续要求 recipe 与 blob 存储。Chart 在 recipes 启用时
提供这些路径，继续要求持久 PVC、单副本和 `Recreate`；关闭 recipes 后不注入 material
bootstrap 环境变量。Registry 先完成 recipe bootstrap，再执行 material bootstrap；
已有 recipe 时可以只配置 material manifest。初始化导入不自动激活 Agent，也不修改
Server 的材料绑定；失败时同样不会自动激活 Agent 或改写 Server 绑定，运维应检查错误并
修正输入后重试。完整材料约定见 [Spack 材料交付](../../../docs/spack-material-delivery.md)。

### 关闭与备份

既有无持久化测试配置必须同时关闭 recipes；关闭后不注入 recipe 环境变量、不强制
Recreate 或单副本，不改变原 blob 配置，也不删除已有 recipe 历史：

```yaml
registry:
  recipes:
    enabled: false
  persistence:
    enabled: false
```

关闭 recipes 不代表其他 Registry 存储已经支持多副本；生产仍应遵循原单副本配置。
备份前先停止 Registry 写入，快照整个原 blob PVC，包含完整 `recipes/`（Git objects、
refs、manifests 和 staging），不要只复制当前激活快照。恢复时保留原 PVC 挂载和目录布局。
PVC 的 `helm.sh/resource-policy: keep` 保持不变。

离线验证：

```bash
bun test scripts/spack-recipe-storage.test.ts scripts/helm-production-hardening.test.ts scripts/helm-rustfs-bootstrap-render.test.ts
bun test packages/registry/src/config.test.ts scripts/spack-material-delivery.test.ts
helm template kq deploy/helm/kq-platform -f deploy/helm/kq-platform/values.testing.yaml
```

部署测试仅读取部署文件并在本地有 Helm 时渲染配置，材料流水线使用进程内 fixture 与替身；
不安装依赖、启动监听服务、容器或真实 Spack，也不连接集群。
无 Helm 时渲染用例明确跳过，静态断言仍执行。这些检查不验证镜像构建或运行时持久化。

## Spack 受控上游导入

默认 `registry.upstream.enabled=false`；开启时要求 recipes 持久化和单写者。
`registry.upstream.proxySecretRef.name/key` 必须引用同 namespace 中已有 Secret，
只向 Registry 容器注入 `SPACK_UPSTREAM_PROXY_URL`，不接受 values 中的明文代理 URL，
不把凭据放入共享 ConfigMap 或 Server/Web/Agent 环境。
另配置 `registry.upstream.allowedOrigins` 精确 HTTPS origin 列表和传输限额。
代理失败不直连、不跟随重定向，目标仅为公共 IPv4 HTTPS/443。

可选 `registry.upstream.caBundle` 为容器内绝对路径，管理员需另行只读挂载目标 TLS CA；
chart 不自动创建 CA 卷。外层 Ingress 须对齐精确导入路径的 2 MiB JSON 限额与
30 分钟超时，不能仅提高 Registry 内部超时。Secret 轮换后按部署流程重建 Registry Pod。
完整 values 示例、权限和取消边界见
[Spack 受控上游导入](../../../docs/spack-upstream-import.md)。
新增接线及静态测试尚待对应提交 CI，不代表渲染、部署或真实代理已验收。

## 生产 Agent mTLS 边界

`values.production.yaml` 默认使用 `MTLS_MODE=trusted-proxy`。安装时填写专用 Agent mTLS ingress/proxy 的来源 CIDR，范围只包含需要连接 Server 的代理地址：

```bash
helm upgrade --install kq deploy/helm/kq-platform \
  -f deploy/helm/kq-platform/values.production.yaml \
  --set-string server.env.MTLS_TRUSTED_PROXY_CIDRS=10.42.7.18/32 \
  -n kuintessence --create-namespace
```

将示例 CIDR 替换为部署中的代理地址。CIDR 留空时，Helm 会拒绝渲染生产部署。

受信任代理必须删除外部传入的 `x-kq-client-cert-fingerprint`，校验客户端证书后，再写入从该证书计算的 fingerprint。普通 Web ingress 不得注入此 header。

无法部署受信任代理时，改用 `MTLS_MODE=direct`，并为 Server gRPC listener 配置 server certificate、server key 和 client CA。使用该模式需要覆盖默认生产配置。

## 启用 NetDrive

NetDrive 默认关闭。使用 chart 内的 RustFS 时，按以下配置启用：

```bash
helm install kq deploy/helm/kq-platform \
  --set secrets.jwtSecret="$(openssl rand -hex 32)" \
  --set postgres.password="$(openssl rand -hex 16)" \
  --set rustfs.rootPassword="$(openssl rand -hex 16)" \
  --set netdrive.enabled=true \
  --set netdrive.secretKey="$(openssl rand -hex 32)" \
  --set netdrive.bucket=kuintessence \
  --set netdrive.publicUrl="https://rustfs.example.com"
```

将 `netdrive.publicUrl` 设置为浏览器和 Agent 都能访问的地址。留空时，presigned URL 使用内部 S3 endpoint，客户端需要能访问该内部地址。

当 `rustfs.enabled=true` 且 `netdrive.enabled=true` 时，Chart 创建一个常规 RustFS bootstrap Job，而非 Helm hook。Job 使用 root 完成初始化：创建 `netdrive`、staging、immutable 三个 bucket，以及普通 IAM committer user，并为其分配最小权限 policy。Server 使用此普通用户，不使用 root。

immutable bucket 创建时必须启用 Object Lock、versioning 和 default COMPLIANCE retention；已有未启用 Object Lock 的 bucket 不能原地升级。committer policy 只允许从 staging copy-source 携带 `COMPLIANCE` lock 复制到 immutable bucket，拒绝 direct immutable PUT、非 staging copy 和 delete。

CORS 写入失败只记录 warning，其他初始化检查失败会终止 Job。使用浏览器 presigned PUT 时，需在对象存储侧检查 CORS 是否允许该请求。

平台不依赖 `s3:if-none-match` policy condition。Server 通过每次 copy 返回的 `VersionId`、逐 version digest 回读和 COMPLIANCE lock 保存不可变对象，并使用固定 `versionId` 提供下载。

Server Pod 的 initContainer 等待与当前 bootstrap 配置哈希对应的 Job 成功。不要将此 Job 改为 `post-install` / `post-upgrade` hook，否则 `helm install --wait` 与 Server initContainer 会相互等待。参数或 bootstrap 脚本变更后会创建新 Job。当前版本的 migration、seed 和 bootstrap 完成 Job 不设 TTL，供 Pod 重建时继续检查；旧资源由对应 release 的 Helm 升级或卸载清理，PR preview 不删除共享 namespace。

保留期限由两个参数控制，均须为正整数：

- `netdrive.dataMarketStagingExpiryDays`：staging lifecycle expiry 天数，默认 `1`。
- `netdrive.dataMarketImmutableRetentionDays`：Server 为每个 immutable object 写入的 COMPLIANCE retention 天数，默认 `365`。

两个参数同时传入 Server ConfigMap 和 bootstrap Job。轮换 `netdrive.secretKey` 时，必须递增 `netdrive.bootstrapRevision`。此非敏感 revision 与 committer access key 一起用于 Job 名称，让 Helm 创建新 Job，更新 RustFS 普通用户凭据。

外部 S3/RustFS：

```bash
helm install kq deploy/helm/kq-platform \
  --set secrets.jwtSecret="$(openssl rand -hex 32)" \
  --set postgres.password="$(openssl rand -hex 16)" \
  --set rustfs.enabled=false \
  --set netdrive.enabled=true \
  --set netdrive.endpoint="s3.example.com" \
  --set netdrive.port=443 \
  --set netdrive.useSsl=true \
  --set netdrive.bucket=kuintessence \
  --set netdrive.publicUrl="https://s3.example.com" \
  --set netdrive.accessKey="..." \
  --set netdrive.secretKey="..."
```

使用外部 S3/RustFS 时，Chart 不创建 bootstrap Job，也不修改远端 bucket。安装前需完成以下配置；Server 启动时会检查，配置不满足要求时终止启动：

- 创建 `NETDRIVE_BUCKET`、`DATA_MARKET_STAGING_BUCKET`、`DATA_MARKET_IMMUTABLE_BUCKET` 三个彼此不同的 bucket。
- staging bucket 不得启用 Object Lock，并对 `data-market/staging/` 配置 `netdrive.dataMarketStagingExpiryDays` 天的 lifecycle expiry。
- immutable bucket 创建时必须启用 Object Lock、versioning 和 default COMPLIANCE retention。Server 必须使用普通 IAM user，仅授予从 staging prefix 以 `COMPLIANCE` copy 至 `data-market/immutable/*` 的权限，不得允许 direct PUT 或 delete。
- `netdrive.dataMarketImmutableRetentionDays` 必须与 Server 的 `DATA_MARKET_IMMUTABLE_RETENTION_DAYS` 一致。初始化时将其设为 default retention；Server 在 immutable copy 时再次写入 COMPLIANCE retention，并固定回读的 `versionId`。

RustFS 可使用 [`../../rustfs/bootstrap-object-lock.sh`](../../rustfs/bootstrap-object-lock.sh) 和固定版本 `rustfs/rc:v0.1.36` 初始化。外部 S3 不兼容 `rc` 管理 API 时，使用云厂商的 IaC/API 完成上述配置。

Compose 本地栈使用 `deploy/compose/docker-compose.local.yml` 作为 NetDrive 覆盖层：

```bash
docker compose --project-directory . -f deploy/compose/docker-compose.yml -f deploy/compose/docker-compose.local.yml up --build
```

## 使用外部服务

将对应服务设为 `*.enabled=false`，再填写 `external.*` 连接配置：

```bash
helm install kq deploy/helm/kq-platform \
  --set secrets.jwtSecret="$(openssl rand -hex 32)" \
  --set postgres.enabled=false \
  --set redis.enabled=false \
  --set rustfs.enabled=false \
  --set external.databaseUrl="postgres://user:pass@my-pg-host:5432/kuintessence" \
  --set external.redisUrl="redis://my-redis-host:6379" \
  --set external.s3Endpoint="https://my-s3-endpoint"
```

## 使用已有 Secret

通过 External Secrets Operator、Vault 等系统管理密钥时，指定已有 Secret：

```bash
helm install kq deploy/helm/kq-platform \
  --set secrets.existingSecret="my-kq-secrets"
```

引用的 Secret 必须包含 `JWT_SECRET`。启用 `postgres.enabled` 时还需 `POSTGRES_PASSWORD`，启用 `rustfs.enabled` 时还需 `RUSTFS_SECRET_KEY`。

## 启用 Ingress

```bash
helm install kq deploy/helm/kq-platform \
  --set secrets.jwtSecret="..." \
  --set postgres.password="..." \
  --set rustfs.rootPassword="..." \
  --set ingress.enabled=true \
  --set ingress.hosts[0].host=kq.example.com
```

## 升级

升级前先创建数据库和 Registry blob 卷快照，包含卷中的完整 `recipes/` 目录；
创建一致性快照前先停止 Registry 写入。

迁移使用全局 PostgreSQL advisory lock，在单个 transaction 中执行。迁移失败会阻止应用 Pod 滚动。数据库迁移为 forward-only，Helm rollback 只回滚应用制品，不回退 schema；需要回退 schema 时，必须恢复升级前快照。

```bash
helm upgrade kq deploy/helm/kq-platform \
  --reuse-values \
  --set server.image.tag=v0.2.0 \
  --set registry.image.tag=v0.2.0 \
  --set migration.image.tag=v0.2.0
```

外部 PostgreSQL 的连接串可放在 `secrets.existingSecret` 指定的 Secret 中，key 为 `DATABASE_URL`，无需写入 values。使用其他 key 名时，设置 `external.databaseUrlSecretKey`。

## 卸载

PR preview 不采用删除 namespace 的方式清理：控制器核验 owner marker和资源归属后，
仅在 `preview` 中 Helm uninstall本 PR的 `kq-pr-<编号>` release，再删除其自有残留
PVC、`kq-pr-<编号>-secrets`，最后删除 `kq-pr-<编号>-preview-owner`，成功后才进入
该 PR的 GHCR版本回收。归属不符或资源清理失败时拒绝继续，不删除其他 PR资源，
也绝不删除共享 `preview` namespace。旧独立 namespace不在该流程的自动清理范围内。
此过程会丢弃本 PR演示数据；底层卷遵循 StorageClass回收策略。

以下为用户版 release的手动卸载示例，不能用作整个共享 preview环境的批量清理：

卸载后可保留持久卷。下面的 `kubectl delete pvc` 会删除该 release 的 PVC，执行前确认数据已备份且无需保留。

```bash
helm uninstall kq
# Registry blob PVC 带有 Helm keep policy；确认备份后才能手动删除
kubectl delete pvc -l app.kubernetes.io/instance=kq
```

## values 参考

| Key | 默认值 | 说明 |
|---|---|---|
| `server.replicas` | `1` | Server pod 数量 |
| `server.image.repository` | `kuintessence/server` | Server 镜像 |
| `server.image.tag` | `latest` | Server 镜像 tag |
| `server.port` | `3000` | HTTP 端口 |
| `server.grpcPort` | `3001` | gRPC/connectRPC 端口 |
| `server.env.MTLS_MODE` | `off` | Agent mTLS 模式；生产 profile 默认为 `trusted-proxy` |
| `server.env.MTLS_TRUSTED_PROXY_CIDRS` | `""` | `trusted-proxy` 必填的代理来源 CIDR |
| `registry.enabled` | `true` | 是否部署 Registry |
| `registry.port` | `3100` | Registry HTTP 端口 |
| `registry.auth.mode` | `jwt` | Registry 鉴权模式；Chart 部署不得降级为 `dev` |
| `registry.persistence.enabled` | `true` | 为 OCI blob 启用持久卷 |
| `registry.persistence.storage` | `50Gi` | OCI blob PVC 容量 |
| `registry.persistence.mountPath` | `/var/lib/kuintessence/registry/blobs` | 原 blob 挂载点；recipes 使用其子目录 |
| `registry.recipes.enabled` | `true` | 启用 recipe Git；要求持久化、单副本和 Recreate |
| `registry.recipes.bootstrapManifest` | `""` | 可选容器内绝对本地路径；管理员自行只读挂载 manifest 与 bundle |
| `registry.recipes.materialBootstrapManifest` | `""` | 可选材料 manifest 的容器内绝对本地路径；运维只读挂载文件包，recipe bootstrap 完成后执行 |
| `registry.upstream.enabled` | `false` | 受控 recipe/material 上游导入；要求 recipes 开启 |
| `registry.upstream.proxySecretRef.name/key` | `""` / `SPACK_UPSTREAM_PROXY_URL` | 已有 Secret 引用，不接受明文代理 URL |
| `registry.upstream.allowedOrigins` | `[]` | 精确公共 HTTPS/443 origin 数组 |
| `registry.upstream.timeoutMs` | `300000` | 单文件传输总超时，最多 1800000 毫秒 |
| `registry.upstream.idleTimeoutMs` | `30000` | 传输空闲超时，毫秒 |
| `registry.upstream.maxConcurrent` | `2` | 单实例并发上限，最多 4 |
| `registry.upstream.maxBytes` | `1073741824` | 单文件下载上限，最多 16 GiB |
| `registry.upstream.caBundle` | `""` | 可选目标 TLS CA 的绝对容器路径，运维自行只读挂载 |
| `migration.image.repository` | `kuintessence/db-migrate` | Helm revision 的数据库迁移镜像 |
| `postgres.enabled` | `true` | 是否部署集群内 PostgreSQL |
| `postgres.storage` | `20Gi` | PVC 大小 |
| `redis.enabled` | `true` | 是否部署集群内 Redis |
| `rustfs.enabled` | `true` | 是否部署集群内 RustFS |
| `rustfs.storage` | `50Gi` | RustFS PVC 大小 |
| `rustfs.rcImage` | `rustfs/rc:v0.1.36` | 自托管 RustFS bootstrap Job 的客户端镜像 |
| `netdrive.dataMarketStagingExpiryDays` | `1` | staging `data-market/staging/` lifecycle expiry 天数 |
| `netdrive.dataMarketImmutableRetentionDays` | `365` | Server 写入 immutable object 的 COMPLIANCE retention 天数 |
| `secrets.jwtSecret` | `""` | 必填 JWT 签名密钥（>= 32 字符） |
| `secrets.existingSecret` | `""` | 已有 Kubernetes Secret 名称；设置后跳过 Secret 创建 |
| `ingress.enabled` | `false` | 是否部署 Ingress |
| `ingress.className` | `nginx` | IngressClass 名称 |
| `external.databaseUrl` | `""` | 外部 PostgreSQL URL（当 `postgres.enabled=false`） |
| `external.databaseUrlSecretKey` | `DATABASE_URL` | 从已有 Secret 读取外部 PostgreSQL URL 的 key |
| `external.redisUrl` | `""` | 外部 Redis URL（当 `redis.enabled=false`） |
| `external.redisUrlSecretKey` | `REDIS_URL` | 从已有 Secret 读取外部 Redis URL 的 key |

完整列表见 `values.yaml`。

启用 `registry.recipes.enabled` 时，同一 PVC 也保存 `materials` 子目录，用于独立的
Spack 源码 blob、namespace receipts 和固定 release manifests，不改变旧 OCI blob 路径。
Server 材料分发需要另外配置专用密钥、固定 release 映射与 mTLS，默认不自动开启；
配置和当前安装阻断状态见 [Spack 材料交付](../../../docs/spack-material-delivery.md)。
