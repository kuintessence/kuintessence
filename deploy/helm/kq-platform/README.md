# kq-platform Helm 图表

使用此 Helm chart 将 Server 与 Registry 部署到 Kubernetes。

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

Server Pod 的 initContainer 等待与当前 bootstrap 配置哈希对应的 Job 成功。不要将此 Job 改为 `post-install` / `post-upgrade` hook，否则 `helm install --wait` 与 Server initContainer 会相互等待。参数或 bootstrap 脚本变更后会创建新 Job，已完成的旧 Job 在一天后由 TTL 清理。

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
