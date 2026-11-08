# 加密介质包：格式与 Agent 底层

当前已实现格式、签名验证、流式归档、age 加解密底层，以及 Server 的来源方导出批准/密钥加密托管、接收方包登记和本地导入授权 API。已用真实官方二进制完成受管数据集往返至隔离区；**独立密钥授权通道、Agent 操作入口、原子副本发布和导入回执尚未接通**。来源批准仅准备清单与密钥，登记或本地批准均不会解密文件、创建可用副本或解除 `DATA_WAITING`；这仍不是完整硬盘交付。

## 来源方数据集导出准备

Server 配置 `FEDERATION_ENABLED` 及既有站点/签名配置后，同时配置：

| 配置 | 含义 |
| --- | --- |
| `FEDERATION_MEDIA_AGE_DIRECTORY` | 官方固定版本 age 和 age-keygen 所在绝对目录；工具摘要见下文 |
| `FEDERATION_MEDIA_WRAPPING_KEY` | 至少 32 字符的独立高熵密钥，不得复用 JWT/SSO 密钥；仅通过部署秘密配置注入 |

两项缺一时启动校验拒绝；均未配置时可使用接收登记，但来源导出接口返回 503 `MEDIA_EXPORT_UNAVAILABLE`。Server 镜像尚未包含 age，需要由部署方提供经 pin 校验的工具。托管密钥依赖 wrapping key 恢复，必须独立安全备份；当前无在线轮换工具，直接替换会使历史包密钥无法解密。

以下 API 均以 `/api/federation/media` 开头，要求当前组织的人工会话：

| 方法与路径 | 作用 |
| --- | --- |
| `POST /exports` | 以独立 `media.export` 权限准备指定不可变版本的签名清单及独立包身份 |
| `GET /exports?limit=50&offset=0` | 以 `asset.read` 权限查询当前组织摘要 |
| `GET /exports/:id` | 查询原签名、公钥和批准/撤销记录，不返回私钥及其密文 |
| `POST /exports/:id/revoke` | 以 `media.export` 权限撤销来源批准，保留历史；正文为 `reason` |

准备参数为 `packageId`、`agreementRevisionId`、`recipientSiteId`、`versionId`、`locationId`、`expiresAt`，有效期最多 7 天且不超过合作协议与数据授权的有效期。文件列表、大小、摘要、许可证和完整 provenance 从已发布资产的 ready/不可变版本读取，不接受调用者自报路径或清单。当前只接受本组织 Agent/启用受管目录中的 available `cp-local` 位置；不支持对象存储位置、任务输入包或结果包的来源准备。

必须存在对当前用户/组织适用、有效的显式 download 数据策略，且 download、redistribution、crossCenterReplication 三项均为 allow；适用的禁止/限制优先。公开可见、资产所有权或普通 use 权限不能代替跨机构披露许可。当前数据策略管理写入 API/页面尚未接通，不能宣称运营人员已有完整配置流程。

每包由真实 age 生成独立身份；私钥使用现有 AES-GCM/HKDF 加密，派生域绑定本站、包编号及原清单摘要。数据库只保存密文，普通 API/审计不返回或记录密钥。签名及生成在事务外执行，落库前重查授权、源数据和签名信任；同编号并发重试只保留原签名、公钥、密文与一次审计，修改参数或重放已撤销批准被拒绝。内部使用 guard 再检查原批准人权限、有效期、当前数据策略/位置、协议和原签名密钥。尚无私钥交付端点，也没有自动下发文件导出命令。

## Server 包登记与本地授权

启用 `FEDERATION_SITE_ID` 后，已登录用户可在当前组织范围内访问以下 API；自动化身份不可使用这些人工批准入口。`asset.map` 用于签名包登记/撤销，`asset.read` 用于查询，新增独立 `media.import` 用于接收方本地批准/撤销。平台管理角色不自动获得这些能力；管理页面的权限选择已有中英文标签。

| 方法与路径（均以 `/api/federation/media` 开头） | 作用 |
| --- | --- |
| `POST /packages` | 提交 `senderSiteId`、`signedManifest`，登记接收清单 |
| `GET /packages?limit=50&offset=0` | 查询本组织包摘要，不载入/返回整份清单签名 |
| `GET /packages/:id?authorizationOffset=0` | 查看原始清单/签名、撤销记录与授权历史；每页最多 100 条，`hasMoreAuthorizations` 表示后续记录 |
| `POST /packages/:id/import-authorizations` | 明确批准指定 Agent/受管目录的本地导入 |
| `POST /packages/:id/revoke` | 撤销包的本地接收资格，历史与原签名仍保留 |
| `POST /packages/:id/import-authorizations/:authorizationId/revoke` | 单独撤销本地授权 |

登记核对当前可信来源密钥及签署用途，接收机构必须为本站，合作协议双方必须匹配且属于当前组织。包编号在本站唯一，同编号只能重放同一清单；换签也不覆盖最初原件，内容变化必须使用新编号。登记可以保留已暂停/过期合作的库存历史，但不授予任何导入权。来源密钥已过期/撤销时不能新登记，后续使用原登记包也会被阻止；旧签名历史信任迁移尚未实现。

本地批准参数为 `authorizationId`、`agentId`、`managedRootId`、`expiresAt`、`maxBytes`。有效期最多 7 天，字节上限不能小于清单总量；受管目录必须启用，并与 Agent 同属当前组织。相同授权编号重试不续期、不改目录或限额；已撤销授权不能恢复，需要显式创建新的授权编号，已撤销的包则不能借此恢复。

每次使用本地授权前，内部 guard 重新检查包/授权撤销、有效期、原批准人的组织成员身份与 `media.import` 权限、合作协议当前有效性、双方站点、原签名密钥及用途、Agent 和受管目录归属。批准/撤销与审计在同一事务内提交；并发重试不重复创建记录或审计。包撤销与授权撤销均保留原件，拒绝后续操作；正在运行的实际介质任务撤权/停止机制还需要随 Agent 操作通道接入。

这些 API 不包含密钥、密文内容或本机绝对路径，不替代来源方的当前披露授权。后续独立通道必须同时取得来源方授权与这里的接收方许可，才能把独立包密钥交给指定 Agent；之后发布和每次作业使用仍各自检查权限。当前没有来源方密钥发放接口，不会因批准本地授权而给调用者密钥。

## 包格式

每个包对应一个不可变数据集版本、一个任务输入包或一个任务结果包。完整重制应生成新的随机 `packageId` 和独立 age X25519 身份；复用版本不复用包身份。持有包编号、清单签名或解密密钥均不等于取得导入及使用授权。

外层使用 age v1 文件格式；内部是未压缩的受限 tar 流：

1. `manifest.jws`：现有联邦 RS256 紧凑签名格式，专用 `media-manifest` 签署用途。核对来源机构、接收机构、当前密钥有效期、撤销状态与签署用途。正文仍受现有 256 KiB 签名上限约束。
2. `files/000000` 等按清单顺序编号的普通文件。原始相对路径仅存在于加密后的签名清单中；接收方验证路径后才在隔离区重建目录。
3. 两个 512 字节零块结束，不接受尾随数据或第二份归档。

清单包含来源/接收机构、协议 revision、创建时间与数据集的联邦不可变引用，或者任务 operationId、taskId、attempt、请求摘要和输入/结果内容摘要。逐文件保留相对路径、字节数、SHA-256、许可证与 provenance；许可证或 provenance 缺失时显式为 `null`，不会补写假值。后续授权服务仍须核对这些引用与实际交付单，而不是仅验证签名。

当前每包最多 1000 个文件、总计 5 TiB；清单签名大小可能更早触及上限。常规 tar 八进制大小字段无法表达 8 GiB 以上文件，因此大文件使用 GNU base-256 大小字段。接收端只接受本格式的固定普通文件头；拒绝 PAX、GNU longname、软/硬链接、设备、FIFO、重复/覆盖路径、额外文件和非规范 padding。它不是通用 tar 导入器。

## 读写与隔离

导出只从已初始化的 `AgentDataRoots` 受管目录读取，拒绝链接、特殊文件、文件大小变化或摘要变化。输入使用固定大小的分块读取，输出接入 age 标准输入，不先生成完整明文归档。

导入只向当前 Agent 拥有的私有目录新建随机隔离子目录。读取清单后按本地字节限额、可用空间、文件系统块和 inode 做预检；不把预检当作容量预留，实际写入仍可能失败。逐文件流式核对大小与 SHA-256，成功后 fsync 文件。异常、取消、末尾认证失败或流关闭失败会删除本次隔离子目录；不会发布资源位置或创建计算作业。

解密输出即便已产生若干完整文件，也必须等 age 退出成功、tar 结束及所有摘要一致后才能返回隔离结果。返回隔离目录仍不是副本发布：后续服务需要重新检查双方当前授权、持久保存清单及发布意图、同步目录并完成原子发布，然后才允许 Server 签署回执。进程强制退出后的隔离目录回收及发布恢复还未接入。

age 子进程与归档流使用调用方的取消信号；生产服务需要传入操作期限/撤权信号。私钥通过 age 标准输入传递；命令参数、环境变量、介质文件和日志不包含私钥。加密用的随机包公钥保存在本机私有临时目录，操作结束删除。stderr 不向用户透传。未引入插件身份或口令交互。

## 官方 age 工具

支持 Linux x64 / arm64，固定 **1.3.2**。本地配置提供二进制目录；每次运行检查对应可执行文件 SHA-256、所有者和写权限，并通过已校验的文件描述符执行。运行时不自动下载，不信任 PATH 中的同名程序。

来源：[官方 v1.3.2 release](https://github.com/FiloSottile/age/releases/tag/v1.3.2)。上游许可证 BSD-3-Clause，交付安装包应一并保留上游许可证。本次从官方 GitHub release API 取得发布资产摘要，通过 HTTPS 下载并核对归档后提取二进制摘要；这不是额外完成了上游签名/透明日志证明验证。

| 平台 | 官方归档 SHA-256 |
| --- | --- |
| linux-amd64 | `cbe24006683f8eb669266162894b9a522a1af52f2665fbc63a4bb032ed26ac10` |
| linux-arm64 | `6b8dc4333c53a5a57c9e5834e3a48f92605d7154014cd07269ff3327db5d37f4` |

可执行文件摘要见 `packages/shared/src/federation/media-age.ts` 的 `MEDIA_AGE_RELEASE`。版本升级必须更新归档和两个可执行文件的 pin，并复核加解密验收。二进制分发、安装脚本和部署镜像接线仍待完成。

## 当前验证

无需外部工具的针对性验证：

```bash
bun test packages/shared/src/federation/media.test.ts packages/agent/src/data-market/media-archive.test.ts
```

准备上述官方二进制后显式运行真实加解密验证：

```bash
KQ_MEDIA_AGE_TEST_BIN=/absolute/path/to/age-directory \
  bun test packages/agent/src/data-market/media-age.test.ts
```

未配置二进制目录时，真实工具测试明确跳过；普通单测不会下载程序。当前真实测试为 256 KiB 合成数据，覆盖真实签名、独立包身份、加密后清单不可见、完整导出/隔离导入、错误私钥、最终认证标签损坏、截断、可执行文件篡改，以及运行中取消后关闭输入流/停止子进程。TB 大小只验证 tar 编码，并由 Python 标准库独立解析 1 TiB 文件头，没有读写 TB 文件或测量吞吐。arm64 的发布资产摘要已核对，没有在 ARM 主机执行。

新增 `packages/server/src/federation/media-packages.pg.test.ts` 在独立 `kuintessence_unit_*` PostgreSQL 数据库运行：验证真实签名/HTTP 登记、组织隔离、并发幂等、独立导入权限、限额/到期/目录约束、当前权限重查、撤销后重放、审计失败回滚、数据库约束和授权历史分页。迁移 `0156_many_shiva.sql` 由 Drizzle 生成，两张表只保存清单和接收方批准，没有存储密钥或发布数据位置。

来源准备测试 `packages/server/src/federation/media-exports.pg.test.ts` 需要独立 `kuintessence_unit_*` PostgreSQL 和显式 `KQ_MEDIA_AGE_TEST_BIN`。真实 age 验证覆盖 API 签名/元数据、密钥托管恢复、域绑定、披露限制、并发幂等、动态撤权、生成过程撤权和重启后撤销保持。夹具使用同一隔离数据库中的站点记录及 4 字节合成数据，不是双平台交付或科学计算验收。Drizzle 生成 `0157_fancy_mathemanic.sql`，增加来源托管表及 `media.export` 权限约束。

W07/W08 仍未完成：数据策略管理、密钥通道、持续撤权、发布回执、完整导入重放/版本复用、物理介质及运输批次生命周期、崩溃恢复、真实 ENOSPC 和作业解锁需在完整服务接通后联合验证。其他已经通过的取消退款、满盘恢复测试不因此重复运行。
