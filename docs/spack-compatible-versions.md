# Spack 兼容版本与运行时绑定

平台支持多个显式列出的 Spack 版本，每个 Agent 执行环境仍固定一个签名 SIF，不按作业自动下载或切换版本。无需数据库迁移，既有材料中的 `spackVersion` 继续作为精确绑定。

## 兼容规则

唯一代码表为 [spack-compatibility.json](../packages/shared/src/spack-compatibility.json)，目前列出 1.0.0、1.0.3，均为 lockfile 6 / specfile 5。共享静态检查、Python source audit、安装 worker、审计报告与 AIO 交付读取同一表。Agent 将构建时嵌入的表以只读文件提供给 worker，不接受材料自带的兼容声明。Forge 制包端保留同内容版本表，升级时须同步。

材料声明、锁生产者、实际运行时和审计报告的版本必须完全一致。即使两个版本均在表中，也不能让 1.0.3 的运行时消费标为 1.0.0 的材料。未知版本、预发布后缀、版本范围及不符的锁格式均拒绝。原锁、源码、recipe、许可证、provenance 和签名保持原件；为另一版本重制材料时重新求解、校验并发布新摘要，不能只改版本字段。

## AIO 交付

[离线工具](../deploy/federation/aio/README.md)的 `build --spack-version` 选择本次交付的版本，默认仍为 1.0.0；可以显式选择 1.0.3。最终 Slurm/PBS 镜像继承版本 label，导出要求两者一致，将版本写入交付清单，并携带兼容表。缺失或混用时在导出前失败；目标端继续核对可信清单和实际镜像身份。旧格式交付包仍可校验，但其中旧 Agent 不因此自动获得新兼容能力。

更换 SIF 按既有维护流程处理，重新提供签名与信任、公用工具摘要、目标 profile 和相应材料。不能跨版本复用不匹配的安装绑定或 store。一次 Agent 内并发运行多套 Spack、自动迁移 store 不在本轮范围。

## 验证与准入

多版本代码表不代替站点准入。1.0.3 已完成下述固定 Ubuntu 24.04 工具镜像的 GNU Hello 原生兼容检查，正式托管／调度及联邦验收仍待执行。保留 1.0.0 默认值，既有 1.0.0 材料不受影响；没有自动重建或降级已有镜像。

新增版本要核对实际 native API、完整 DAG/hash、recipe package hash 和 externals，并在最终运行时完成 source audit、空 store 无外网安装、只读 verify、load 和小作业。分别记录版本、提交、SIF、profile、材料摘要、命令和结果。通过后才能称相应运行环境已验证；机构批准不能由工具代签。科研 BWA 与 38 项联邦联合验收仍须使用正式材料另行执行，不能用夹具结果替代。

## 真实原生兼容入口

[GNU Hello 检查](../deploy/pr-test/spack-case/compatibility.py)只使用已核对 recipe 的 Hello 2.12.1，本轮检查 Ubuntu 24.04/x86_64；另保留 x86_64_v2 与旧 Ubuntu 20.04/x86_64 的目标检查，未据此新增这些目标的验收结论。先用指定版本的真实干净 Spack checkout 重新生成 lock 和材料清单，再在固定运行镜像内执行。不得把旧锁改写版本字段当作新输入。

调用方提供禁网、只读根、非 root、去 capabilities、CPU／内存／进程与时间上限；只挂载必要代码和只读材料，使用独立私有工作盘。三个动作分别使用新的工作目录，首次安装要求 store 不存在，后两次将同一个 store 真正只读挂载；脚本使用 statvfs 检查只读状态，不根据命令文本推定。

```sh
# 在受限容器内执行；不是宿主机安装命令。
/opt/spack/bin/spack python /workspace/deploy/pr-test/spack-case/compatibility.py install \
  --input /materials --digest sha256:<材料清单摘要> \
  --work /native/install-check --store /native/store
# 分别以只读 store 的新容器运行 verify 和 load；对应 work 换成新目录。
```

入口复用生产 audit 和安装 worker 的原生函数，检查缺源码拒绝、完整 DAG／recipe hash、重新求解精确匹配、空 store 安装、数据库／落盘 spec 校验及输出树。load 应用 Spack 生成的 shell，通过软件名解析并调用真实 Hello ELF，核对路径和固定输出。报告含实际引擎源码和可执行文件 SHA-256，父任务另记录镜像身份、命令及资源限制。

它不调用生产 managed 入口，不省略该入口的审批检查后冒称通过；不生成 site profile、四项站点确认或签名。报告明确保留 `managedRuntimeAccepted=false`、`siteAccepted=false`。原生小软件结果仍不能替代签名 SIF、受管安装、Slurm/PBS 调度、BWA 或联邦联合验收。

## 1.0.3 原生检查结果

2026-11-12：官方干净 Git commit `1b670fed69cb88fc095d37a4a011c432030f9c1c` 实际生成新的 lock v6/spec v5，GNU Hello 2.12.1 的六节点依赖闭包经生产原生审计和精确重新求解。固定 Ubuntu 24.04/GCC 13.3/Clingo 5.7.1 工具镜像下，禁网、2 CPU、2 GiB、非 root 容器从空 store 编译安装成功；新容器以只读 store 完成 verify 和 Spack load，按名称运行真实 ELF 得到 `Hello, world!`，store 文件／链接摘要保持一致。原始源码、许可证和 provenance 保留，旧 1.0.0 材料没有改写。

结果限于相应原生 API 与小软件路径；没有正式 Agent/Apptainer、调度 Job、站点签名或机构批准，不关闭科研／联邦验收。原始命令、引擎与材料摘要、输出及失败修正记录由交付方保存在包外验收报告。完整镜像更新须先满足当次磁盘门禁，不能用此次实验的旧工具镜像冒充新候选镜像交付。
