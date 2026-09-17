# 术语表

## 平台与角色

| 术语 | 含义 |
|---|---|
| 平台服务（Server） | 提供 API、权限、调度、工作流、软件治理和接入代理控制通道的中央服务。 |
| 接入代理（Agent） | 部署在集群或站点侧的守护进程，适配 Slurm、PBS、Torque、Kubernetes 等调度器。 |
| 软件仓库（Registry） | 存储和分发软件目录、发布版本、工作流模板、OCI 制品与 Spack buildcache 的服务。 |
| 软件中心（Software Center） | Web 中浏览、发布和管理软件、用例与工作流模板的功能入口。 |
| CP | Compute Provider，算力提供者或集群管理员。 |
| CC | Compute Consumer，普通计算用户。 |
| SP | Software Provider，软件资产发布者。 |
| Platform Operator | 平台运营或平台管理员。 |

## 软件治理

| 术语 | 含义 |
|---|---|
| Software Asset | 统一软件资产，覆盖 Spack package、usecase、workflow template。 |
| Revision | asset 的一次可审计内容修订。 |
| Grant | 对 asset 的显式授权，例如 `view/use/install/edit`。 |
| Access Request | 用户为缺失 capability 发起的申请。 |
| Official Fork | 平台审核后生成的可信 fork，运行默认引用该内容。 |
| Lifecycle | `draft/submitted/published/deprecated/revoked/archived` 等状态。 |
| Resolver | `resolve-availability` 服务，负责解释软件在节点上的可运行性。 |
| CP Policy Overlay | provider、cluster、agent 三层软件策略覆盖。 |
| Buildcache | Spack 二进制缓存。 |
| Air-gap Bundle | 面向离线环境的签名镜像包，导入与导出执行器尚未实现。 |

## 调度与运行

| 术语 | 含义 |
|---|---|
| Placement Pipeline | 8-stage 调度放置流水线。 |
| Queue Registry | 平台维护的队列/分区注册表。 |
| Locality Hint | 输入数据所在站点对调度评分的提示。 |
| Workflow DSL | 工作流控制流语言，支持条件、循环、聚合和子 workflow。 |
| NetDrive | 平台的对象存储文件服务。 |
| Cluster File Root | CP 配置的集群文件浏览安全根路径。 |

## 安全与运维

| 术语 | 含义 |
|---|---|
| OIDC | 生产登录推荐使用的外部身份认证协议。 |
| mTLS | Agent-Server 双向 TLS 或受信代理证书边界。 |
| Credential Vault | Server 中加密存储的 SSH credential。 |
| Desensitization | 脱敏策略，支持 passthrough/hash/alias/redact/hide。 |
| Metering | 计量系统，统计 CPU/GPU/memory/network/storage 等使用量。 |
