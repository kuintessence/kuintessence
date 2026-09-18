# RustFS 对象存储

自托管 Compose、AIO、Helm 和 E2E 统一使用 `rustfs/rustfs:1.0.0`，
初始化客户端使用 `rustfs/rc:v0.1.36`。不再拉取 MinIO server 或 `mc` 镜像。
应用的 `minio` npm 包仍作为 S3-compatible SDK 使用，不是 MinIO 服务端依赖。

## 初始化

[`bootstrap-object-lock.sh`](bootstrap-object-lock.sh) 创建三个独立 bucket：
NetDrive、可删除的 staging、启用 versioning 和 COMPLIANCE Object Lock 的 immutable。
初始化使用 RustFS root；应用只获得普通 IAM committer 用户，不使用 root 或其 service account。
immutable 只允许从指定 staging 前缀 copy，并要求 COMPLIANCE；禁止 direct PUT 和删除。
脚本回读 lock 与 IAM policy，不满足即退出失败，不以放宽权限或关闭锁兜底。
staging lifecycle 使用固定 ID 覆盖导入，重复执行不累积规则。

脚本依赖 `rc` 和 `jq`，客户端镜像已包含二者。临时文件与客户端配置使用私有目录，
退出时清理。Helm 内嵌同一脚本，CI 检查两份内容一致。

## 升级边界

这是存储后端变更，不是原地替换二进制：

- Compose 服务名从 `minio`/`minio-init`/`minio-cors` 改为
  `rustfs`/`rustfs-init`/`rustfs-cors`。端口变量前缀改为 `KQ_SCHEDULER_RUSTFS_`。
- Compose 使用新的 `rustfs-data`、`rustfs_data` 或 `scheduler-rustfs-data` 命名卷。
  旧 MinIO 卷不挂载、不转换、不删除。新后端不会自动包含旧对象。
- AIO 使用 `/data/rustfs`，检测到 `/data/minio` 时拒绝启动。
  不要删除旧目录来绕过检查；先备份并迁移到独立的新卷，确认数据库对象引用一致。
- Helm 从 `minio.*` 改为 `rustfs.*`，`mcImage` 改为 `rcImage`；
  已有 Secret 的 root key 改为 `RUSTFS_SECRET_KEY`。
  旧 `minio` values 会明确报错。新的 StatefulSet/PVC 使用 `rustfs` 名称，
  不把旧 PVC 交给 RustFS 打开。
- 外部对象存储继续使用 `NETDRIVE_*` 配置；不迁移的站点设置 `rustfs.enabled=false`，
  显式指向已验证的外部 S3 endpoint，不自动切换既有数据。

现有站点必须安排维护窗口：停止写入、备份数据库和对象/版本/retention/授权配置，
在独立后端初始化权限，再通过受支持的 S3/API 或厂商工具迁移并核对对象校验和。
**Data Market 引用固定到 version ID，普通 bucket mirror 不能证明保留了版本引用。**
切换前必须验证或显式重建受影响的数据库、manifest 和 delivery binding 引用，
并验证保留期不被削弱；平台目前不提供自动迁移工具。验证完成前保留旧服务与回退路径。
不要直接执行 `down -v`、删除 PVC、挂载旧数据目录或盲目 `helm upgrade --reuse-values`。

## 验证

手动触发 GitHub Actions `CI` 并启用 `run_runtime_checks`：

- 检查 Helm render、初始化失败路径和配置引用。
- E2E 使用真实 RustFS 验证文件工作流、multipart、Range、Object Lock 和普通用户权限。
- `RustFS Compose + AIO` 解析 Compose 配置，并构建、启动一次性 AIO 检查服务健康，
  不发布镜像、不映射宿主端口、不使用已有卷，退出时清理。

这些检查不代表旧数据迁移、真实 Kubernetes 存储或生产集群已验收。
