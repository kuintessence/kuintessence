# 独立机构 AIO 交付

AIO 将一个机构的 KQ 平台、机构网关与可选 Fabric 组件部署在独立主机。机构之间不共享登录库、权限状态、业务数据库、对象存储或 Registry。调度器为可选配置，普通生产交付不强制包含容器测试集群。

## 主机职责

| 主机 | 服务 |
| --- | --- |
| 机构 A | 独立 KQ、Peer、Orderer 1；可选 Slurm |
| 机构 B | 独立 KQ、Peer、Orderer 2；可选 Slurm |
| 机构 C | 独立 KQ、Peer、Orderer 3；可选 PBS |
| 第四主机 | 独立 Compose 项目的 Orderer 4 |

仲裁机构 R 按需使用独立项目、机构身份、密钥、数据库权限和案件存储，不与机构 A 混用身份。R 与高内存的软件安装任务不同时运行。共用托管环境和 VPC 仍有共同基础设施信任边界。

## 离线材料

构建和第三方镜像取得在本机完成，固定完整提交、架构和源镜像。交付清单保存镜像 ID、版本、文件大小及 SHA-256。东京构建机支持 containerd、nerdctl 和 BuildKit；目标支持 Docker。机构私钥和密码独立配置，不进入公共镜像包。

通过 SSH 续传到云端，再经内网复制。目标先用可信清单核对归档，执行 `docker load`，核对镜像身份后以 `--no-build --pull never` 启动；缺镜像直接失败。目标不执行 Git 拉取、依赖在线安装或镜像现场构建。操作命令见[AIO 入口](../../../deploy/federation/aio/README.md)。

Spack 支持显式选择[兼容版本](../../spack-compatible-versions.md)。交付 runtime、材料、锁和审计报告必须同版；选择另一兼容版本不放宽目标系统、架构或依赖锁绑定。科学软件通过平台安装，运行容器预构建不表示待用软件已安装。

## 运行配置

`direct` 不依赖 Fabric；`fabric` 增加 Peer、Orderer、链码与 Adapter。`config --no-scheduler` 保留平台和链，移除调度器、Agent 及其专用卷，不提供软件安装或计算任务。`config --managed` 提供受管运行时，需另行准备经机构批准的 SIF、profile、目标 native lock 和签名。

可选文件搬运须明确 HTTPS origin、私有目录和预算；公共 CA 覆盖只读挂载，不暴露 edge 私钥。`config --storage-guard` 添加签名容量观测和准入保护。Fabric 初始化由各机构分别批准，不自动修改定义、策略或信任。

内网部署使用单一 HTTPS 域名，通过 `/sso/` 和对象原生路径分流。人员登录账户可按部署要求对齐；OIDC secret、数据库密码、机构密钥和 Fabric MSP 仍独立保管。

## 容量和恢复

部署工具根据容器声明限额、系统余量和同机其他项目检查预算。4 GiB 主机不能据空闲采样保证完整托管环境可运行；容量不足时扩容或明确关闭可选组件，不降低必要组件限额来绕过保护。具体预算见[配置与显式启动](../../../deploy/federation/aio/README.md#配置与显式启动)。

保留原数据库、对象数据、权限状态、账本、配置和恢复密钥。升级只替换受影响组件，不重建机构身份或 Fabric 网络。具有旧分支迁移历史的数据库使用[专用转换规则](../../../deploy/federation/aio/main-upgrade.md)，普通 main 库继续使用常规迁移。

现有平台与链部署中，调度器、Agent、R 及 C 站 Runner 保持关闭。启用计算须另外满足软件材料、锁、权限及资源条件，详见[行为契约](acceptance.md)。通知功能暂停。
