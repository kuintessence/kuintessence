# Spack 兼容版本与运行时绑定

平台支持多个显式列出的 Spack 版本，每个 Agent 执行环境仍固定一个签名 SIF，不按作业自动下载或切换版本。无需数据库迁移，既有材料中的 `spackVersion` 继续作为精确绑定。

## 兼容规则

唯一代码表为 [spack-compatibility.json](../packages/shared/src/spack-compatibility.json)，目前列出 1.0.0、1.0.3，均为 lockfile 6 / specfile 5。共享静态检查、Python source audit、安装 worker、审计报告与 AIO 交付读取同一表。Agent 将构建时嵌入的表以只读文件提供给 worker，不接受材料自带的兼容声明。Forge 制包端保留同内容版本表，升级时须同步。

材料声明、锁生产者、实际运行时和审计报告的版本必须完全一致。即使两个版本均在表中，也不能让 1.0.3 的运行时消费标为 1.0.0 的材料。未知版本、预发布后缀、版本范围及不符的锁格式均拒绝。原锁、源码、recipe、许可证、provenance 和签名保持原件；为另一版本重制材料时重新求解、校验并发布新摘要，不能只改版本字段。

## AIO 交付

[离线工具](../deploy/federation/aio/README.md)的 `build --spack-version` 选择本次交付的版本，默认仍为 1.0.0；可以显式选择 1.0.3。最终 Slurm/PBS 镜像继承版本 label，导出要求两者一致，将版本写入交付清单，并携带兼容表。缺失或混用时在导出前失败；目标端继续核对可信清单和实际镜像身份。旧格式交付包仍可校验，但其中旧 Agent 不因此自动获得新兼容能力。

更换 SIF 按既有维护流程处理，重新提供签名与信任、公用工具摘要、目标 profile 和相应材料。不能跨版本复用不匹配的安装绑定或 store。一次 Agent 内并发运行多套 Spack、自动迁移 store 不在本轮范围。

## 验证与准入

本轮是多版本研发候选，1.0.3 的静态／隔离夹具检查不等于原生安装验收。保留 1.0.0 默认值，既有 1.0.0 材料不受影响；没有自动重建或降级已有镜像。

新增版本要核对实际 native API、完整 DAG/hash、recipe package hash 和 externals，并在最终运行时完成 source audit、空 store 无外网安装、只读 verify、load 和小作业。分别记录版本、提交、SIF、profile、材料摘要、命令和结果。通过后才能称相应运行环境已验证；机构批准不能由工具代签。科研 BWA 与 38 项联邦联合验收仍须使用正式材料另行执行，不能用夹具结果替代。
