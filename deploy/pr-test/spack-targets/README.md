# 三种 Linux 目标环境

## 范围与状态

这是独立于 Ubuntu 20.04 scheduler/managed 回归的 **Actions-only 原生环境基线**。
固定测试 GNU Hello 2.12.1，先验证三种 Linux 用户空间的工具链、Spack 求解、
材料准备和断网源码安装。入口存在不等于环境已通过，结论必须对应具体 commit
和 Actions matrix；没有运行的目标不能标成成功。

| Profile | 容器基础镜像 | 预期原生 Spack target |
|---|---|---|
| `centos7` | `quay.io/centos/centos:7`，额外检查 release 为 7.9.2009 | `linux-centos7-x86_64` |
| `ubuntu24` | `ubuntu:24.04` | `linux-ubuntu24.04-x86_64` |
| `ubuntu26` | `ubuntu:26.04` | `linux-ubuntu26.04-x86_64` |

基础 tag 和发行版软件源不是不可变快照。每次构建后的本地 image ID 同时用于该目标
的 preparation/offline 容器，不重新按 tag 拉取 runtime；每个目标单独生成原生
lock、recipe snapshot 和源码 mirror。实际 GCC 版本经固定格式 identity marker
记录，不宣称跨日期重建会取得完全相同的系统包。

CentOS 7 仅为 EOL 兼容试验，使用固定 7.9.2009 的官方 archive 路径、HTTPS、
RPM GPG 校验，不添加 `--nogpgcheck`、不关闭 TLS、不退回 HTTP。
新增 Python/OpenSSL 不能使整个 CentOS 7 系统恢复安全维护。
需要长期使用时，另行审核安全更新来源及风险，不直接将此测试镜像投入生产。

## 固定工具与材料

- Python 3.11.16 与 OpenSSL 3.5.8 从固定 HTTPS 地址下载，先验证可信来源的
  SHA-256 再源码构建；不使用宿主或另一发行版的二进制 Python。
- clingo 5.7.1、cffi 1.17.1、pycparser 2.22 仅允许固定 SHA-256 的 wheel，
  禁止隐式源码构建或无摘要的传递依赖。
- Spack 1.0.0 固定 commit `73eaea13f381e3495299284856fd02a64e1d154c`。
- 官方 `spack-packages` 使用现有基线固定的 commit/tree，复用原 recipe
  完整性检查和 Git bundle 帮助函数，不改写既有准备器的 Ubuntu 20.04 约束。
- Hello 使用现有审阅过的 `kq_case` recipe 和固定发布源码 SHA-256，
  只允许 Hello、compiler-wrapper、gcc-runtime 作为非 external DAG 节点；
  GCC、GNU make 与可选 glibc 必须来自目标系统。

可信摘要来源：

- Python：[Docker 官方 Python 定义](https://github.com/docker-library/python/blob/fe89472bda6128fef7e964d1f1991534e32dcfb7/3.11/bookworm/Dockerfile)。
- OpenSSL：[3.5.8 官方发布](https://github.com/openssl/openssl/releases/tag/openssl-3.5.8)的 `.sha256` 文件。
- wheels：对应精确版本的 PyPI JSON 元数据中的文件摘要，写入 `requirements.txt`。

这些版本仅定义本基线，不是全部科学软件推荐版本或生产安全认证。

## 执行

由 `Spack target environments` 工作流在一次性 GitHub-hosted x86_64 Linux runner 执行。
工作流对相关文件变更的可信同仓库 PR（包含 draft）运行三目标 matrix，也支持手动
触发。fork PR 不运行容器 matrix。`preview-paused` 不影响此独立测试，不提供公网入口。

下列命令仅用于工作流，不在个人电脑或真实集群执行：

```bash
bash deploy/pr-test/spack-targets/run.sh centos7
bash deploy/pr-test/spack-targets/run.sh ubuntu24
bash deploy/pr-test/spack-targets/run.sh ubuntu26
```

执行分层：

1. 构建该发行版工具环境，固定 Spack/recipe 来源和 solver 依赖。
2. 以 UID/GID 1000 的联网 preparation 容器生成原生单 root lock、Git bundle、
   完整源码 mirror 和逐文件 checksum/size 清单；此阶段不安装 Hello。
3. 启动新的同 image ID offline 容器：rootfs 只读、材料卷只读、`--network none`、
   去除 capabilities、禁止提权，并限制 CPU、内存、PID。
4. 运行前 inspect 验证离线网络和材料只读挂载。容器中检查发行版、架构和工具链，
   拒绝其他 profile 的材料；缺一份源码的独立副本必须被拒绝，原输入不变。
5. 从已校验 bundle 加载 recipe，在新的配置 scope 原生重新求解并对比原 lock
   的 root/DAG/package hash。使用空 store 与 mirror-only fetch 安装，禁用
   bootstrap、upstreams、binary cache 和复用。
6. 检查实际 ELF、精确版本与 `Hello, world!` 输出，重新核对输入材料没有改变。
   无论通过或失败，清理本次容器、卷、镜像及临时日志。

日志仅输出固定 stage/code 和受约束的 identity markers，不上传原始构建日志、
源码、bundle、lock、安装树或镜像。失败时保留 stage 分类，不能把任何失败都
归为网络问题；禁止为通过而更换目标 OS 或关闭 checksum/隔离。

## 不覆盖

- 没有启动 Registry/Server/Agent、Slurm/PBS 或 production managed worker。
  本文不证明 Server → Agent 的授权交付或 Apptainer/cgroup 隔离。
- Docker 容器共享 Actions 宿主内核，不证明 CentOS 7 的 3.10 内核、
  旧驱动、真实硬件、MPI ABI 或跨节点共享存储兼容。
- 不是平台可直接导入的材料发布包，内部 `metadata.json` 只供此基线使用。
  不改变[材料发布协议](../../../docs/spack-material-delivery.md)和 Agent 仅从 Server 拉取的规则。
- 没有准备全部[15 个科学工作流](../../../docs/spack-workflow-materials.md)；
  也未验证 samtools 或其他软件在这些新 target 上可用。

原有 Ubuntu 20.04 Hello/samtools Web/bootstrap managed 验收仍使用
[PR scheduler 入口](../README.md)，不能拿本基线代替或覆盖它。
