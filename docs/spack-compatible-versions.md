# Spack 兼容版本与运行时绑定

平台支持多个显式列出的 Spack 版本，每个 Agent 执行环境仍固定一个签名 SIF，不按作业自动下载或切换版本。无需数据库迁移，既有材料中的 `spackVersion` 继续作为精确绑定。

## 兼容规则

唯一代码表为 [spack-compatibility.json](../packages/shared/src/spack-compatibility.json)，目前列出 1.0.0、1.0.3，均为 lockfile 6 / specfile 5。共享静态检查、Python source audit、安装 worker、审计报告与 AIO 交付读取同一表。Agent 将构建时嵌入的表以只读文件提供给 worker，不接受材料自带的兼容声明。Forge 制包端保留同内容版本表，升级时须同步。

材料声明、锁生产者、实际运行时和审计报告的版本必须完全一致。即使两个版本均在表中，也不能让 1.0.3 的运行时消费标为 1.0.0 的材料。未知版本、预发布后缀、版本范围及不符的锁格式均拒绝。原锁、源码、recipe、许可证、provenance 和签名保持原件；为另一版本重制材料时重新求解、校验并发布新摘要，不能只改版本字段。

## AIO 交付

[离线工具](../deploy/federation/aio/README.md)的 `build --spack-version` 选择本次交付的版本，默认仍为 1.0.0；可以显式选择 1.0.3。最终 Slurm/PBS 镜像继承版本 label，导出要求两者一致，将版本写入交付清单，并携带兼容表。缺失或混用时在导出前失败；目标端继续核对可信清单和实际镜像身份。旧格式交付包仍可校验，但其中旧 Agent 不因此自动获得新兼容能力。

更换 SIF 按既有维护流程处理，重新提供签名与信任、公用工具摘要、目标 profile 和相应材料。不能跨版本复用不匹配的安装绑定或 store。一次 Agent 内并发运行多套 Spack、自动迁移 store 暂不支持。

## 运行环境准入

兼容代码表只声明平台可识别的原生格式与接口。每个站点仍需固定签名 SIF、目标 profile 和匹配的材料，并确认原生 API、完整 DAG/hash、recipe package hash、externals 及实际软件环境。

更换版本时从可信干净 Spack checkout 重新求解和准备材料，不改写旧 lock。安装采用空 store 和无外网环境，随后以只读 store 完成 verify 和 load。目标软件、调度器与资源规模分别满足运行要求后，才向用户开放相应能力。

## 真实原生兼容入口

[GNU Hello 检查](../deploy/pr-test/spack-case/compatibility.py)只使用已核对 recipe 的 Hello 2.12.1，支持 Ubuntu 24.04/x86_64，并提供 x86_64_v2 与旧 Ubuntu 20.04/x86_64 的目标检查，各目标需要匹配的材料和运行配置。先用指定版本的真实干净 Spack checkout 重新生成 lock 和材料清单，再在固定运行镜像内执行。不得把旧锁改写版本字段当作新输入。

调用方提供禁网、只读根、非 root、去 capabilities、CPU／内存／进程与时间上限；只挂载必要代码和只读材料，使用独立私有工作盘。三个动作分别使用新的工作目录，首次安装要求 store 不存在，后两次将同一个 store 真正只读挂载；脚本使用 statvfs 检查只读状态，不根据命令文本推定。

```sh
# 在受限容器内执行；不是宿主机安装命令。
/opt/spack/bin/spack python /workspace/deploy/pr-test/spack-case/compatibility.py install \
  --input /materials --digest sha256:<材料清单摘要> \
  --work /native/install-check --store /native/store
# 分别以只读 store 的新容器运行 verify 和 load；对应 work 换成新目录。
```

入口复用生产 audit 和安装 worker 的原生函数，检查缺源码拒绝、完整 DAG／recipe hash、重新求解精确匹配、空 store 安装、数据库／落盘 spec 校验及输出树。load 应用 Spack 生成的 shell，通过软件名解析并调用真实 Hello ELF，核对路径和固定输出。报告含实际引擎源码和可执行文件 SHA-256，父任务另记录镜像身份、命令及资源限制。

它不调用生产 managed 入口，不省略该入口的审批检查后冒称通过；不生成 site profile、四项站点确认或签名。报告明确保留 `managedRuntimeAccepted=false`、`siteAccepted=false`。原生小软件结果仍不能替代签名 SIF、受管安装、Slurm/PBS 调度、BWA 或联邦联合运行检查。
