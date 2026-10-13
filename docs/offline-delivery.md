# 离线交付与启动 seed

平台通过同一个 `OfflineDeliveryService` 接收运行时上传和部署只读目录。
导入 recipe/material、生态 stage、安装映射 bind、生态 activate 分项记录；
这些结果均不代表真实软件安装或作业验收成功。

## 格式与材料端分工

合同实现位于 `packages/shared/src/offline-delivery.ts`、`spack-materials.ts`、
`spack-material-import.ts`。导出 JSON Schema 和离线验证：

```sh
bun deploy/offline-delivery/contract.ts --schema > /tmp/kq-delivery.schema.json
bun deploy/offline-delivery/contract.ts /path/to/delivery.json
bun deploy/offline-delivery/create-fixture.ts /tmp/kq-contract-fixture
```

最后一条生成可预检/导入的最小合同 fixture，含真实 Git bundle、**合成** native-format
lock、合成源码和通知、签名生态清单，以及仅供本 fixture 的公钥；私钥不落盘。
它不是材料制造或安装验收。不要将 fixture 公钥加入生产信任集。
JSON Schema 表达结构；引用、摘要、权限、签名和 native lock 语义以平台预检为准。

目录示例：

```text
seed/
  delivery.json
  recipe.bundle
  spack.lock
  source.tar.gz
  NOTICE.txt
  ecosystem.json
  trusted-keys.json
```

`delivery.json` 版本为 `1`：

- `name`、`release`：不可变交付身份；同 `repository/name/release` 内容不同返回
  `DELIVERY_VERSION_CONFLICT`，修改内容须使用新的 release。
- `repository`：交付文件上传的授权仓库，也是目标 namespace；一份交付不得跨 namespace。
  可引用已有 public recipe，但不能扩大私有 recipe 可见范围。
- `files[] = {path, blob:{digest,size}}`：相对目录路径、原始字节 SHA-256（`sha256:` 前缀）
  和字节数。路径不可绝对、穿越或包含 `.git`。HTTP 只把它当上传清单键，从不访问主机路径。
- `items[]`：最多 200 项，唯一 `id`、显式 `dependsOn`，依赖必须在前。
  `recipe` 包含 repository、精确 commit、file；`material` 包含现有 publish 请求 release；
  `ecosystem` 包含签名 JSON 的 file；`binding` 包含现有 `SpackInstallBindingChange` 的 change；
  新发布材料的绑定可使用 `change: {action:"bind-imported",materialItem,scope,spec,expectedRevision,reason}`，
  并显式 dependsOn 该 material 项；执行时取真实发布收据，无需导出端伪造 binding。
  `activate` 包含 stagedItem、expectedActiveReleaseId（首次为 null），且依赖该 stage。
- 多个 recipe/material 批次通过多项表达。材料必须显式依赖同清单中提供其 snapshot 的 recipe。
  独立生态资产不强制依赖材料；携带签名材料关联时，必须先发布对应材料。
- 总清单上限 2 MiB，20,000 个文件，总字节 512 GiB；单 blob 16 GiB，
  Git bundle 默认 128 MiB，lock 16 MiB，签名生态 JSON 32 MiB。
  现有 recipe 展开量、文件数和 Git 校验预算继续生效。新入口不接收 tar/zip，不解包 Forge OCI。

Forge `application/vnd.kq.forge.bundle.v1` / config `2.0.0` 是来源候选，
不是 `application/vnd.kuintessence.ecosystem.release.v1+json` 或 material release。
`GET /api/offline-deliveries/formats` 提供机器可读转换路径；将 Forge manifest 提交给预检会返回
`FORGE_SOURCE_CANDIDATE` 和缺口。Web 也明确说明需先转换，不能靠改 mediaType/schemaVersion 导入。

由 kq-bundles 选择完整 recipe 基础、合并独立 package.py 及 patch/module、真实原生求解、
覆盖所有 source/resource/compiler/externals/bootstrap，然后导出兼容交付。
字段映射：Git bundles → recipe 项；nativeLocks + spec/target/Spack/recipe roots → material release；
源码/native-mirror → sources 与 files；companions/license/provenance → material v2 evidence；
catalog → signed ecosystem JSON。脚本不是 workflow，数据 metadata 不是数据字节交付。
缺件报告模板见 [gaps.example.json](../deploy/offline-delivery/gaps.example.json)。
平台不在 Registry 启动中执行 recipe、solve、build 或 install。

## material v2 证据

旧 version 1 发布/manifest 原样兼容，不原地改写。需证据的包使用 version 2，
新增必填 `evidence: {version:1, materials:[...]}`，每个不同 source blob 恰好关联一项：

```json
{
  "subject": {"digest":"sha256:<source-sha256>","size":123},
  "license": {"expression":"MIT OR LicenseRef-Upstream","status":"pending"},
  "provenance": [{
    "origin":"upstream release / original material ID",
    "original":{"digest":"sha256:<original-bytes-sha256>","size":123},
    "evidence":{"digest":"sha256:<provenance-json-sha256>","size":456}
  }],
  "attachments":[{
    "path":"NOTICE.txt","kind":"notice",
    "blob":{"digest":"sha256:<notice-bytes-sha256>","size":789}
  }]
}
```

上述摘要占位符用于解释字段；有效摘要/大小见生成 fixture。
license status 为 pending/approved/rejected/unknown，原始 expression 与状态原样保留。
附件 kind 为 license/notice/provenance/conversion；original/evidence/attachment 引用的字节
必须全部上传，不能只存 URL。原始来源到 subject 的关联不等于签名，也不授予许可证权限。
现有 release 的 `redistribution: unrestricted` 仍是发布者的**独立明确声明**；
未知/受限再分发材料不能为了导入而填写此值。pending 不会被平台改写为 approved。

Registry 发布前重验全部 blob 的摘要与大小；附件进入不可变 manifest 的引用集合。
读取授权、withdraw 生命周期、Agent cache 下载/摘要校验和容量统计与核心材料共用。
材料 blob 存储与 OCI GC 隔离，目前不提供材料物理 GC；未来清理必须使用完整引用集合
`spackMaterialBlobs`，不得仅遍历 sources。旧读取端的 strict version/schema 会拒绝 v2。
Web 材料详情展示逐材料 license/provenance，可下载并校验附件（浏览器下载上限 32 MiB）；
较大附件用带鉴权的 blob API 流式保存。

## 运行时入口

在软件管理 → Spack → 材料管理中选择“离线交付导入”，选择清单与目录，
上传并预检、检查逐项状态后执行。File 直接作为上传请求体，不把大文件转 JSON 或读入浏览器内存。
查询历史收据或重新执行相同清单可处理后续批次与部分失败。

API 均要求 canonical principal，用户角色/组织从数据库重新读取；沿用 namespace、
发布、绑定和平台生态权限。服务端每项执行前重查身份，停用用户不能继续导入。
外部入口经 Web 为 `/software/api`，直接 Registry 为 `/api`：

```sh
# KQ_TOKEN 是已有身份的 bearer token；不要把它写入交付包。
curl --fail-with-body -H "Authorization: Bearer $KQ_TOKEN" \
  -H 'Content-Type: application/octet-stream' --data-binary @NOTICE.txt \
  "$REGISTRY/api/spack/material-repositories/blobs?repository=public/example&digest=sha256:ACTUAL_DIGEST"
# 对清单里的每个文件执行上述流式上传，包括 Git bundle 和签名 JSON。
for action in preflight import history; do
  curl --fail-with-body -H "Authorization: Bearer $KQ_TOKEN" \
    -H 'Content-Type: application/json' --data-binary @delivery.json \
    "$REGISTRY/api/offline-deliveries/$action"
done
```

操作员应在 preflight 与 import 之间审阅结果；循环仅说明请求格式。
预检返回 `{digest,status:"planned",items:[{id,kind,status,code?,receipt?}]}`，
会验证所有上传字节、Git snapshot、真实 lock 的 `valid`、recipe roots、签名与格式。
预检不发布目标资产；临时 recipe 检查目录会删除。上传的 blob 可保留。
导入结果 status 为 completed/partial/failed，失败包含阶段 id/kind/code，成功材料 receipt
包含 Registry 返回的真实 binding 和 manifest，而不是推算 repository ID。
HTTP 200 仅表示返回了报告，必须检查报告状态和逐项结果。
`history` 返回最多最近 200 条审计记录；完整历史留在 audit log。

生态 manifest 的可选 `materialRequirements[]`：
`{ecosystemKey,binding:{repositoryId,manifestDigest},spec,target,spackVersion}`。
这些字段参与 Ed25519 签名，Registry stage 时实际核验 public 材料与 public recipe、
精确 spec/target/Spack。签名只认证声明的关联，不能认证未关联的独立源码。
被生态清单引用的材料受生命周期引用保护；包括 inactive 历史版本，避免破坏 rollback。
真正的站点安装映射仍通过现有精确 spec、材料 target 与 revision 控制，不把站点 UUID 写入通用包。
生态 active 与材料可安装、站点可运行是独立状态。

## Compose 与 readiness

实际 main 的 [compose.yml](../deploy/main/compose.yml) 已接线。复制
[env.example](../deploy/main/env.example) 中的新增配置到部署机器 `.env`：

```dotenv
KQ_SEED_DIRECTORY=/opt/deploy/seed
OFFLINE_DELIVERY_SEED=/opt/kq-seed/delivery.json
OFFLINE_DELIVERY_SEED_SUBJECT=11111111-1111-4111-8111-111111111111
ECOSYSTEM_RELEASE_TRUSTED_KEYS='{"publisher-key":"BASE64_DER_SPKI_PUBLIC_KEY"}'
```

subject 是**已存在的**受控服务用户 UUID，需由正常身份/部署流程授予对应 namespace 权限。
平台不信任 seed JSON 中自封的 role，不创建或提升用户。空 Registry 可导入，但数据库迁移、
服务身份和现有材料 rollout/epoch 必须先由管理员按原部署流程准备好。
私钥始终由发布端保管；此处只有公钥，服务用户凭据沿用部署秘密管理。

目录只读挂载到 `/opt/kq-seed`；文件与所有子目录不得 group/world writable，
拒绝软链接、硬链接和读取期间改变的内容。先校验全部本地摘要，再上传到 Registry 的材料存储，
不要求空 Registry 预先存在 OCI manifest/blobs；生态使用本地签名 JSON。
迁移成功后 Registry 开始启动，直接调用内部服务导入，不等待自己的 readiness。
`/api/ready` seed=running/failed 时 503，completed/disabled 时 200；
`/api/health` 是独立存活检查，不因 seed 失败触发重启循环。
main 与普通 Compose 的 Registry healthcheck 使用 readiness，Web 依赖它。
部署脚本须检查 `docker compose up -d --wait` 的结果，不能忽略 unhealthy。

不配置 OFFLINE_DELIVERY_SEED 时正常启动。错误文件、摘要、签名、权限、合同或导入失败
使 readiness 失败。`GET /api/offline-deliveries/seed-status` 供平台管理员查询持久化 seed 状态；
缺文件等尚不能读取计划的失败也保存在 audit log，且不记录本地主机路径或凭据。
修正配置/输入后重启，或通过运行时 API 重试。运行时重试不自动清除本次启动的 failed 状态；
需要重启重新完成必需 seed，避免错误宣告部署成功。

Helm 的既有 `seed.enabled` 是 minimal/demo 身份数据库 seed，**不是本离线交付开关**，
本次不改变其行为。完整离线挂载接线由两个 Compose 入口提供；Helm 操作者需另行提供只读 PVC、
上述 Registry 环境变量和 `/api/ready` readinessProbe；liveness 保持 `/api/health`。
现有 Helm recipe 本地存储仍限定单 Registry writer，不因 seed 并发锁宣称支持共享卷水平扩容。

## 幂等、失败与兼容

内容摘要及目标 repository 标识计划与逐项身份；不按文件名或“仓库非空”跳过。
legacy recipe bootstrap 也改为仅在 bundle 摘要精确相同时跳过。
recipe 新 snapshot 不自动 activate；重复材料发布保留原始字节、withdraw 与 visibility。
绑定沿用 expectedRevision；activation 沿用生态事务锁，并增加 expectedActiveReleaseId 检查。
重跑有成功收据的绑定/activation 不执行，避免覆盖人工更新或恢复停用项。
若进程在绑定提交后、收据落盘前中断，重跑返回 revision conflict，必须人工核对现有历史，
不能凭猜测覆盖；成功 recipe/material/生态 stage 可通过不可变身份确认并续跑。

PostgreSQL advisory lock 串行化交付执行；专用锁连接避免小连接池自锁。
每步审计独立提交，异常保留已完成项；批次不承诺全量回滚。并发等待预算 30 秒，超时请求需重试。
审计数据是此功能的幂等状态，不可随意清理 `offline-delivery` 记录。
正常 HTTP 绑定/激活仍使用各自原有 revision/事务锁，并未被全局交付锁替代。
未提交项不会改变当前 active release 或用户资产。
新入口与任一 legacy recipe/material/OCI bootstrap 同时配置时，配置验证明确拒绝，
操作员需将输入合并为一份交付计划；旧入口单独配置保持兼容。

## 签名与验收边界

签名算法继续使用原生态算法，已提取为共享 `ecosystemCanonicalJson`：对象键按 JS UTF-16
顺序排序，JSON.stringify 字符串/数值，UTF-8 编码后 Ed25519；与 localeCompare 排序的通用
canonicalJson 不可混用。Python 导出器必须对照
[黄金向量](../deploy/offline-delivery/canonical-vector.json)，不能未经核对使用普通 sort_keys。
公钥为 base64 DER/SPKI，signature 为 base64。32 MiB 签名层上限不因大源码包扩大。

本功能的合同 fixture/模拟生态持久化测试不等于真实 native solve 或安装。
真实 samtools@1.23.1 验收仍需材料端交付完整 recipe、真实单 root lock、依赖源码和目标环境，
并指定已授权的隔离 Agent（managed installation 的 host spawner、固定 runtime/site profile；
不支持 Kubernetes adapter）。禁止以旧 samtools@1.19.2 lock 替代。
应在空 store、禁止公网且无隐式 cache/upstream/bootstrap 的环境完成安装，再由 KQ 提交
view → sort → index → quickcheck 的 3 条 SAM 记录作业，断言总数 3、mapped 2，
记录 job/run ID、退出码和 BAM/BAI 摘要；隔离副本移除必需源码必须失败且不联网补件。
本次未指定这样的材料及测试站点，真实安装/作业/缺源码负例均保持 **not-run**。
