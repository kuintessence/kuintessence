# 生态 Release：签名、导入与回滚

生态内容通过 OCI artifact 分发，包含 manifest、软件、usecase、脚本、workflow 和 runtime reference；Git 只保留平台代码、测试和文档。

## 导入前检查

导入器会校验 Ed25519 签名、manifest digest、provenance、schema、名称引用、License policy 和 workflow DAG。每个 ecosystem usecase 还必须声明 `specDigest`（canonical JSON `payload.spec` 的 SHA-256）；staged 时平台会创建 content-addressed immutable revision，并记录 manifest entry digest、release provenance 与签名 key。科学软件不会在这一流程中被安装或运行。

`scientific-ecosystem-v1` 必须包含固定版本的软件、强类型 usecase、Sandbox script 和 workflow template；导入器同时检查每个软件至少三个 usecase。

平台部署时通过 `ECOSYSTEM_RELEASE_TRUSTED_KEYS` 配置允许的 Ed25519 公钥，值为 `keyId -> base64 DER/SPKI` 的 JSON。私钥只用于离线签名，不能配置到 Registry。OCI blob 使用 `BLOB_STORE_DIR` 的持久化存储。

Usecase 的 `description` 应说明研究目的、适用任务、计算内容和结果用途。固定软件版本、runtime、参数契约、I/O 与 License policy 分别填写在结构化字段中。修改 `payload.spec.description` 后，必须按 canonical `payload.spec` 重算 `specDigest`，并发布新的 immutable release version。

## 导入与激活

先把 config、签名 bundle layer 和 OCI manifest 推送到公共 registry repository，再使用不可变 manifest digest 导入。管理 API 不接受 tag 作为 release 来源：

```http
POST /api/ecosystem-releases/import
Authorization: Bearer <platform-admin-token>
Content-Type: application/json

{
  "oci": {
    "repository": "public/scientific-ecosystem",
    "digest": "sha256:<oci-manifest-digest>"
  }
}
```

导入成功后，release 进入 staged 状态。确认状态后激活：

```http
POST /api/ecosystem-releases/<release-id>/activate
Authorization: Bearer <platform-admin-token>
```

查询 release 状态：

```http
GET /api/ecosystem-releases
GET /api/ecosystem-releases/scientific-ecosystem/status
```

若需在 Registry 启动时幂等同步，配对设置 `ECOSYSTEM_RELEASE_OCI_REPOSITORY` 和 `ECOSYSTEM_RELEASE_OCI_DIGEST`。默认 `ECOSYSTEM_RELEASE_AUTO_ACTIVATE=false`，同步结果只进入 staged；只有显式设为 `true` 才会自动激活。

签名 ecosystem bundle layer 最大为 32 MiB，Registry 会在读取 layer blob 前按 OCI descriptor 拒绝超限内容。`data-product` 激活时只物化 metadata placeholder 和稳定 revision ID，不传输数据 bytes。Licensed material mapping 的 `auditMetadata` 采用 16 KiB 严格白名单，任何层级的 bytes、base64、blob、content、path、credential、key、token 或 secret 字段都会被拒绝。

## 生命周期

1. 平台管理员导入 bundle，先进入 staged 状态。
2. 所有静态检查成功后，事务性 materialize 并激活 release。缺少或不匹配 `specDigest` 的 legacy bundle 可以保留为 staged 审计记录，但不能激活。
3. bundle-owned 资产按 stable ecosystem key 创建不可变 revision；用户或 CP 自建资产不会被覆盖。
4. 新 release 不再包含的生态资产会被标记 `deprecated`，不会影响历史 run。

只有绑定 active release 的 usecase 和 workflow 才会出现在目录中，并参与 name/version 解析；inactive release 中的记录只能按 ID 查询。没有 ecosystem binding 的普通 catalog 记录仍按 namespace/owner 规则显示。Activation 在同一 PostgreSQL transaction 内为 Software Asset 写入 authz outbox：仅 `published + platform-public` 资产获得公共权限，deprecated、隐藏或私有资产的公共授权会被撤销；Server `authz rebuild` 使用相同规则。

已被 staged 或 active release 引用的 usecase package 不可 update/delete。普通 usecase API 的写入受 namespace/owner scope 限制：`org_admin` 必须指定自己所属的 `orgId`，不能凭全局 ID 修改 platform 或其他组织的 package。Server 会重新校验受限数据任务的 Ed25519 签名、manifest entry、revision、package spec digest 和 release provenance；任一项不一致都会拒绝执行。

staged import 失败不会改变当前 active release。通过 release status 查看 digest、资产数量和验证结果；平台管理员可 activate 指定 release，或 rollback 到同一 release key 的历史版本。

```http
POST /api/ecosystem-releases/scientific-ecosystem/rollback/<target-release-id>
Authorization: Bearer <platform-admin-token>
```

## Runtime reference

详细调用、I/O 和官方文档引用随 bundle 的 runtime reference 发布，不写入 Git。它用于运行时解释和审计，不能替代软件官方 License 或用户自身授权。
