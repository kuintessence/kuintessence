# 两种 Docker Compose 部署

共用 [基础平台](../main/compose.yml)，通过 [compose.sh](compose.sh) 选择部署。镜像由 [production images](../../.github/workflows/build-images.yml) 发布；PR 的 [Compose delivery](../../.github/workflows/federation-compose.yml) 检查配置并实际启动新增镜像入口。

| 入口 | 服务 | 能力 |
| --- | --- | --- |
| `direct` | 基础平台、机构 mTLS Gateway | 双边直接合作，不依赖链 |
| `fabric` | 上述服务、本站 Peer/Orderer、evidence/commercial/market/case 四类链码及四个 Adapter | 双边合作、异步存证、链上协调 |

同一机构使用一个入口。双边异步存证在链故障时继续执行并保存待补交记录；链上认领、额度锁定等仍须确认后执行。部署服务不会自动登记机构、批准业务协议、开放集群、建立合同或生成积分。

## 启动

在仓库根目录操作，要求 Linux amd64、Docker Engine、Compose v2.24+。本交付与原有平台镜像一致，仅发布 linux/amd64。

1. 将 [基础变量](../main/env.example) 和 [联邦变量](env.example) 合并到一个部署方管理的 `.env`，例如 `/etc/kuintessence/deployment.env`。配置本机构真实身份及 SSO；所有宿主机挂载使用绝对路径，`KQ_SEED_DIRECTORY` 也必须使用固定绝对路径。
2. 先准备本文的证书和 Fabric 材料，再检查、拉取并启动所选入口：

```sh
export KQ_DEPLOY_ENV_FILE=/etc/kuintessence/deployment.env
# 无链部署
bash deploy/federation/compose.sh direct config --quiet
bash deploy/federation/compose.sh direct pull
bash deploy/federation/compose.sh direct up -d --wait

# 或有链部署
bash deploy/federation/compose.sh fabric config --quiet
bash deploy/federation/compose.sh fabric pull
bash deploy/federation/compose.sh fabric up -d --wait
```

Gateway、四个 Adapter 和链码从 GHCR 拉取，使用与 Server、Registry、Web、迁移器相同的 `KQ_IMAGE_OWNER` 和 `KQ_IMAGE_TAG`。主分支发布 `main` 和按提交标记的 `sha-<40位提交>` 标签；正式环境优先固定后者，release 也可使用已发布标签。不再要求目标机器持有源码构建工具或 Bun。

Agent 仍部署在真实调度器所在主机；这两个入口不会把 Slurm/PBS 伪装成平台容器。云盘和数据搬运继续使用现有 [存储配置](compose.storage.yml) 及 [Agent 配置](README.md#接收端输入凭据)，按实际网络配置 HTTPS origin；仅启动联邦服务不会自动开启云盘或取得数据权限。介质导出需要额外挂载受控 age 工具和独立 wrapping key，见 [介质包](../../docs/design/federation/media-package.md)。

首次 Fabric 部署时，Peer/Orderer 进程可先于通道运行，Adapter 的健康只表示配置、身份及 Unix listener 可用，不表示通道、链码或交易可用。完成以下初始化、查询已提交定义并执行受权交易后，才可把链能力标为就绪。不要将 `up --wait` 当成业务联合验收。

## 无链机构身份

`env.example` 列出的七个文件必须已存在；缺失挂载不自动创建空目录。业务签名私钥使用独立 RSA PKCS#8 PEM；TLS 入站、出站使用专用证书。私钥由运行 UID 持有且为 0600，证书含正确 SAN 和 serverAuth/clientAuth，CA 与信任登记均须有效。

Server 持有签名和出站 mTLS 私钥，Gateway 仅持有入站 TLS 私钥；Gateway 不挂载业务签名私钥。共享 socket 位于卷中的 `private/` 子目录，运行时创建为 0700，socket 为 0600。默认容器 UID 为 root；改变 UID 时同步 Server/Gateway/Adapter 和所有文件所有者。

Gateway 默认仅发布到宿主机 `127.0.0.1:3443`。跨机构时通过 TLS 直通或明确配置 `FEDERATION_TLS_BIND` 和防火墙开放；不允许终止 TLS 后伪造身份头。原有 Web/Agent TLS 入口与机构入口相互独立。

启动后通过现有联邦信任管理页面登记本站和对方的公钥、用途、证书及端点，再交换协议；不自动给旧密钥添加新用途。详见 [信任与权限](README.md#本地信任管理-api)。无链版不创建任何 Fabric 服务、账本卷或链 socket，也不要求设置 Fabric 变量。

## Fabric 部署材料

每个机构独立保管自己的 MSP、TLS、签名和恢复密钥、数据库及账本。此 Compose 是一个机构的部署单元，不是单机集中生成 A/B/R 身份的信任替代品。多机构部署时，通道配置必须使用实际可达的 DNS、TLS SAN 和端口；本站 Peer 的 gossip externalEndpoint、anchor peer 以及 Orderer endpoint/consenter 都不能填其他机构不可达的容器名。

`KQ_FABRIC_DIRECTORY` 为 0700 的部署方目录，建议结构：

```text
fabric/
  peer/                 core.yaml、本站 Peer MSP/TLS、CCAAS builder 配置
  orderer/              orderer.yaml、本站 Orderer MSP/TLS
  adapters/
    evidence/           adapter.json、签名身份、TLS 客户端身份、CA、recovery.key
    commercial/         同上，独立 recovery.key
    market/             同上，独立 recovery.key
    case/               同上，独立 recovery.key
  chaincodes/
    evidence/           trust.json、server.crt、server.key、client-ca.crt
    commercial/         同上
    market/             同上
    case/               同上
  trust/case.json        Server 案件信任，须与 case 链码/Adapter 的公开配置一致
  admin/                仅 fabric-admin 临时任务可见
    core.yaml           本机构管理员 MSP/TLS 客户端配置
    channel.id
    channel.block       经联盟治理批准的通道配置块
    orderer-join.args
    evidence/           package.tgz、package.id、各动作的 .args 和 collections.json
    commercial/         同上
    market/             同上，市场无私有价格正文
    case/               同上，案件独立三方 PDC
```

从官方 Fabric **3.1.5** 的完整 `core.yaml`、`orderer.yaml` 开始配置，不能只写几个示例字段覆盖所有默认配置。容器内路径：

- Peer：`FABRIC_CFG_PATH=/run/kq-peer`，监听 `0.0.0.0:7051`，MSP/TLS 文件位于 `/run/kq-peer`；开启 TLS 和客户端认证；配置本站 MSP ID、Gateway、gossip、私有数据传输及对方信任 CA。账本统一写入 `/var/hyperledger/production`。
- Orderer：`FABRIC_CFG_PATH=/run/kq-orderer`，数据端口 `0.0.0.0:7050`，开启 TLS/客户端认证和 channel participation；`BootstrapMethod: none`，MSP/TLS 位于 `/run/kq-orderer`。Admin 端口可设 `0.0.0.0:9443`，强制管理员 mTLS，仅容器网络可访问，不映射宿主机。账本、Raft WAL 和 snapshot 均在持久卷。
- Peer 使用官方 `/opt/hyperledger/ccaas_builder`，包 metadata type 为 `ccaas`。每类链码的 `connection.json` 指向 `fabric-<kind>-chaincode:9999`，强制 `tls_required=true`、`client_auth_required=true`，填写此机构 Peer 的链码客户端身份与 CA；服务端 SAN 包含对应服务名。包可包含私钥，必须像凭据一样管理，不能进公共 Registry 或 CI artifact。
- 本站链码包的 `peer lifecycle chaincode calculatepackageid` 结果写入 `.env` 对应 `KQ_FABRIC_<KIND>_PACKAGE_ID` 和 `admin/<kind>/package.id`。各机构的连接包可不同；链码名称、版本、sequence、init-required、PDC 与组织背书策略必须由联盟一致批准。不能随镜像升级自动提升 sequence。

Fabric MSP 的签名身份使用官方 Gateway 支持的 ECDSA P-256 密钥，不复用业务 JWS 的 RSA 私钥。四类 Adapter 的 `adapter.json` 示例结构如下；`trust` 必须换成经治理批准且符合对应契约的完整公开信任对象，示例中的省略对象不能直接运行：

```json
{
  "adapter": {
    "siteId": "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    "channel": "research-federation",
    "chaincode": "kq-evidence",
    "trust": {}
  },
  "peerEndpoint": "fabric-peer:7051",
  "peerTlsCaFile": "/run/kq-fabric-config/peer-ca.pem",
  "tlsCertificateFile": "/run/kq-fabric-config/client.pem",
  "tlsPrivateKeyFile": "/run/kq-fabric-config/client.key",
  "identityCertificateFile": "/run/kq-fabric-config/identity.pem",
  "identityPrivateKeyFile": "/run/kq-fabric-config/identity.key",
  "recoveryKeyFile": "/run/kq-fabric-config/recovery.key",
  "runDirectory": "/run/kq-fabric/evidence/private"
}
```

其他三类替换 chaincode、trust 和 runDirectory 中的类型。恢复密钥各自为 **32 个原始随机字节**，0600，不是 64 字符 hex 文本；首次生成后安全备份，重启或更新镜像不得重新生成。Adapter 没有数据库，交易恢复检查点由 Server PostgreSQL 保存。旧恢复密钥、原配置代际及历史公钥在待处理交易结束前必须保留。

信任/PDC/组织背书定义分别见 [证据](fabric-evidence.md)、[商业](fabric-commercial.md)、[市场](fabric-market.md)、[案件](fabric-cases.md)。读取许可与背书策略分别配置；价格、用量、合同不进入公共状态。不允许使用单一全联盟 collection 取代双边或案件成员范围。

## 显式初始化与升级

`fabric-admin` 仅通过 profile 按需运行，不是常驻服务。其他服务不挂载管理员材料，不会自动批准任何组织。

```sh
bash deploy/federation/compose.sh fabric --profile fabric-admin run --rm fabric-admin orderer-join
bash deploy/federation/compose.sh fabric --profile fabric-admin run --rm fabric-admin peer-join
# 每个机构分别操作；以下以 evidence 为例，其他类型相同。
bash deploy/federation/compose.sh fabric --profile fabric-admin run --rm fabric-admin install evidence
bash deploy/federation/compose.sh fabric --profile fabric-admin run --rm fabric-admin approve evidence
bash deploy/federation/compose.sh fabric --profile fabric-admin run --rm fabric-admin readiness evidence
# 取得通道策略要求的批准后，指定管理员执行 commit 和首次 Init。
bash deploy/federation/compose.sh fabric --profile fabric-admin run --rm fabric-admin commit evidence
bash deploy/federation/compose.sh fabric --profile fabric-admin run --rm fabric-admin initialize evidence
bash deploy/federation/compose.sh fabric --profile fabric-admin run --rm fabric-admin verify evidence
```

各 `.args` 文件是一行一个完整 CLI 参数，无 shell 求值，不写私钥正文：

| 文件 | 参数内容 |
| --- | --- |
| `orderer-join.args` | `--channelID`、通道名、`--config-block`、`/run/kq-admin/channel.block`、`-o`、`fabric-orderer:9443`、`--ca-file`、`--client-cert`、`--client-key` 的路径 |
| `<kind>/approve.args` | `--channelID`、`--name`、`--version`、`--sequence`、`--init-required`、联盟批准的 `--signature-policy` 或 `--channel-config-policy`、必要的 `--collections-config`、Orderer TLS/mTLS 参数；工具自动添加本站校验过的 `--package-id` |
| `<kind>/readiness.args` | 与 approve 相同的定义和 PDC/策略参数，不含连接参数与 package-id；工具添加 JSON 输出 |
| `<kind>/commit.args` | 相同定义参数，Orderer TLS/mTLS 参数及所需各背书 Peer 的 `--peerAddresses`/`--tlsRootCertFiles` |
| `<kind>/initialize.args` | `-C` 通道、`-n` 名称、Orderer/Peer TLS/mTLS 参数；工具固定 `--isInit`、`Args=["Init"]` 和等待提交事件 |
| `<kind>/verify.args` | `--channelID`、`--name`，工具添加 JSON 输出 |

管理员配置必须包含链码初始化要求的 `kq.role=trust-admin` 签名身份。Init 会设置组织信任与私有数据策略，不是健康探针。首次 Init 后不能在例行 CD 中重复运行；重复通道加入、已安装相同包可查询恢复，生命周期批准、commit、Init 的结果不确定时先查询原状态，不盲目重做。

常规更新只拉取固定版本并重建容器。链码升级另行批准新定义，验证 PDC 和信任代际后操作；不删除账本、不重建密钥、不自动改变组织策略。只有受治理允许的组织签名才可推进通道或定义。此交付不提供证书颁发机构、跨机构治理批准或多 Orderer 容灾的自动安装。

## CI/CD 与现有腾讯云部署

发布矩阵新增 `federation-gateway`、`fabric-adapter`、`fabric-chaincode`、`fabric-tools`，共八类 KQ 镜像。官方 Peer/Orderer 固定为 3.1.5，工具下载也校验与真实网络 CI 相同的 SHA-256。新增 CI 仅检查部署配置、构建新增镜像、启动 Node 入口与私有 socket/CCAAS listener，不重复完整科研软件和业务协议矩阵，也不把无 Peer 的镜像启动检查描述为交易成功。

[Deploy federation Compose](../../.github/workflows/deploy-federation.yml) 为手动 CD，可选择 `direct`/`fabric` 和已发布 main 完整提交。工作流仅允许从 main 调用，检查所选提交属于 main；使用 `sha-<revision>` 拉取镜像，并核对 KQ 镜像的 revision 标签。需要独立的 `federation-production` GitHub Environment：

- `FEDERATION_SSH_HOST`、`FEDERATION_SSH_PORT`、`FEDERATION_SSH_USER`、`FEDERATION_SSH_KEY`。
- `FEDERATION_SSH_KNOWN_HOSTS`：预先核对的主机公钥，强制 StrictHostKeyChecking。
- 目标机器预置 Docker/Compose、`/etc/kuintessence/deployment.env`、私钥和 Fabric 治理材料；私有 GHCR 时预先配置目标机器的只读拉取权限。SSH 用户须能管理 `/opt/kuintessence-federation`、文件锁及 Docker，不由脚本临时提权。

CD 部署到独立 `/opt/kuintessence-federation`，持有部署锁；第一次启动前记录模式，即使启动失败也不能用另一模式覆盖在途状态。启动成功后切换 `current`。不复制密钥、不运行治理初始化、不自动转换 direct/fabric 模式。失败保留发布目录用于排查；数据库迁移可能已经运行，不能声称自动回滚，须按备份兼容性处理。历史发布目录由运维确认后清理。

腾讯云当前 `/opt/deploy` 的历史部署适配器只认识四类旧镜像，会丢弃额外服务，因此本次保留其 main 自动发布行为，不向它静默叠加 Fabric，也不在同一站点另启一套服务。要迁移该现网，须先安排维护窗口、保留原数据库/卷/身份、适配原发布管理器或迁移到本入口，确认 SSO/端口/代理后再切换。新增手动 CD 是独立部署入口，不表示腾讯云已启用联盟链。

## 数据与验收边界

`down` 保留卷；不要执行 `down -v`、删除 Peer 区块文件或只备份容器文件系统。至少备份 PostgreSQL、Peer/Orderer 卷、Registry/对象数据、原 MSP/TLS/JWS/恢复密钥、批准的通道/PDC/链码定义及应用信任配置。Peer 空间不足按 [容量蓝图](../../docs/design/federation/blueprint.md) 做监控、受控快照与归档，不能把 `blockToLive` 或删区块当通用扩容。

本交付验证范围是 Compose 接线及新增镜像启动。正式多机构的独立身份、通道治理、故障恢复、多 Orderer 容灾、真实作业与金额联合验收仍按 [验收清单](../../docs/design/federation/acceptance.md) 执行。已有业务测试结论不因新部署文件自动扩大。
