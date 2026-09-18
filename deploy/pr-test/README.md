# PR 调度器测试

这是可销毁的测试环境，不是公网 preview，也不复用现有 scheduler 开发栈。
专用配置：[docker-compose.pr-test.yml](../compose/docker-compose.pr-test.yml)。

## 镜像和网络

构建依赖为：

```text
scheduler-base (现有 base/Dockerfile, Spack 1.0.0, Bun 1.3.13)
  ├─ scheduler-runtime (现有 slurm 或 pbs Dockerfile)
  └─ test-workspace (当前代码、锁定依赖、生成的 protobuf)
       └─ scheduler (scheduler-runtime + test-workspace)
```

现有 base 已包含 Spack，默认 `v1.0.3`。本配置只将 PR 构建参数设为 `v1.0.0`，
与当前材料 lock 预检协议一致，不修改开发栈默认版本。
镜像构建需要访问 Ubuntu apt、GitHub、Bun/npm registry 和 Docker registry；
不是离线构建。可用 `KQ_PR_APT_MIRROR` 配置现有 base 的 apt mirror 参数，
不等同于 Spack 专用 HTTP/SOCKS 代理。依赖在 build 时安装，运行时不安装依赖、
不挂载宿主源码或 Docker socket、不提供 Web、SSO、SpiceDB、RustFS 或 tunnel。

Server 和 Registry 共用本次测试数据库；scheduler 与 Server 位于独立 control 网络，
Registry/数据库在 backend 网络，两个网络均为 `internal`。
Agent 不与 Registry 共享网络，没有 Registry URL 或凭据。
Registry 的 recipe Git、materials、blobs 分目录存入命名卷；Agent 数据和 scratch
也使用本次 project 的独立卷，不读取宿主机 recipe 或源码材料。

仅 PBS 容器启用 `privileged`，用于现有 OpenPBS 测试镜像启动；不要在生产主机或
承载其他敏感容器的共享 daemon 上运行。优先使用临时 GitHub-hosted Linux runner。
当前不覆盖 K3s、Torque 或跨架构仿真。

## 执行

要求 Docker daemon、Docker Compose 2.20+（支持 build `additional_contexts`）、
BuildKit、Bash 和 OpenSSL。从仓库根目录运行：

```bash
# 只解析配置，不需要 daemon，不构建、不启动、不清理容器
bash deploy/pr-test/run.sh slurm --config
bash deploy/pr-test/run.sh pbs --config

# 构建、启动、测试，然后自动清理本次临时环境
bash deploy/pr-test/run.sh slurm
bash deploy/pr-test/run.sh pbs
```

入口生成独立随机 `kq-pr-test-*` project、数据库密码和 JWT secret，忽略根 `.env`
及调用者的 Compose project/file/profile；不使用平台或预览 secret。成功、失败和
可捕获的中断均清理本次容器、网络、卷和专用镜像，不执行全局 `prune`；
构建缓存和共享上游镜像保留。`SIGKILL`、daemon 宕机无法保证清理，
应确认残留的 `kq-pr-test-*` project；不要清理其他项目。

不直接调用 `docker compose up`，也不要在现有部署上叠加此配置。
入口在所有 Compose 调用中保留 `images` profile，确保构建上下文引用可解析；
启动时使用 `--no-build` 并显式选择 `scheduler registry`，不启动构建辅助服务。
入口不会将包含临时注册凭据的容器日志输出或上传为 artifact。
构建/启动/测试失败保留非零退出码；清理失败同样报错。

## 检查范围

容器内以 `kq` 身份检查：

1. 实际 `spack --version` 和 `bun --version`、测试代码 TypeScript 检查。
2. Server 登录、Agent 自动注册及在线 control channel，等待心跳上报可用的 queue
   inventory 和接受提交的目标队列后，创建本次测试 queue；超时或请求失败均报错。
3. 通过 Server/Agent 提交真实 echo 作业，检查终态和 Server 返回的 stdout。
4. 提交 sleep 作业，等待运行后取消，同时检查 Server 和原生调度器终态。
5. 未配置材料分发时，Spack 安装请求必须被 Server 拒绝，不能落入直连上游安装。
6. 进程内 Spack lock、Git recipe、材料导入/目录/下载、Agent 缓存/预检及运行脚本回归。

Recipe bundle 导入和快照导出使用 base 镜像自带的 Git 验证，覆盖实际运行环境的
命令兼容性；快照按明确的 commit/ref 读取，不依赖 `FETCH_HEAD`。

第 6 项使用 fixture/替身；不是真实 Registry → Server → Agent 的网络材料交付验收。
这套测试未配置 mTLS 材料票据、Apptainer/SIF/site profile 或真实材料包，
`SPACK_MATERIAL_DELIVERY_ENABLED` 和 `AGENT_SPACK_INSTALL_ENABLED` 保持关闭。
**通过本套测试也不能宣称受管离线安装、15 个科学工作流或生产部署已验收。**

## GitHub Actions

独立工作流 [PR scheduler tests](../../.github/workflows/pr-scheduler-tests.yml)
对目标 `main` 的可信同仓库非草稿 PR 自动执行 Slurm/PBS matrix，也可手动触发。
不使用 `pull_request_target`、生产 environment、发布权限、仓库 secret 或持久 runner。
每个 job 有独立 project 和总超时；失败不取消另一个调度器的诊断。
取消时脚本尽力清理，runner 回收是强制中断的最终隔离边界。

现有 `Preview` 工作流保持独立；`preview-paused` 只暂停公网预览，不暂停本测试工作流。
实际构建与运行结果以对应提交的 GitHub Actions 或上述命令结果为准。
配置解析或 fixture 检查通过不代表 PR runtime 已通过。

## GNU Hello 单步案例

独立的 [Spack case overlay](../compose/docker-compose.pr-spack-case.yml) 扩展上述基础环境，
由同一 Actions 工作流中的 `Spack GNU Hello single-step case` job 执行：

```bash
bash deploy/pr-test/run.sh slurm --spack-case
```

该模式只支持 Slurm，不替代默认 Slurm/PBS 回归。它使用 Spack 1.0.0、
固定 builtin recipe commit 和 GNU Hello 2.12.1 源码；材料准备在镜像构建阶段联网，
生成真实 Linux lock、源码 mirror 和自包含 Git bundle，不使用手写 DAG/hash。
材料不提交 Git，不进入 scheduler 镜像；只保留可复现准备脚本及自有 recipe。
编译器和基础工具使用镜像中的 external，不代表完全从源码自举工具链。

检查步骤：

1. 每次生成独立 CA 和 Server TLS 证书，真实注册 Agent；control stream 使用 direct mTLS。
2. 运维容器通过 Registry HTTP API 导入 recipe bundle、lock 和源码，发布固定 release；
   Server 重启加载本次 binding。Agent 无 Registry 网络、URL、管理凭据或 CA 私钥。
3. 通过 Server 的软件操作 API 下发安装请求；空缓存 Agent 只从 Server HTTPS 下载，
   逐个校验 manifest/blob。预检完成后操作必须停在关闭的 managed-install gate，返回 `rejected`。
4. 测试工具只将已校验的材料复制给非 root `kq` 用户。独立 native 容器使用
   `network_mode: none`、只读 rootfs、禁止提权和资源限制，只挂载只读材料卷及输出
   scratch 卷，不挂载 Agent 状态或证书。确认仅有 loopback、无默认路由、
   不能访问上游或 Registry，再运行 native Spack 的源码校验与离线编译。
5. 通过 Server 提交一个执行编译产物 `hello` 的 Slurm 作业，要求真实作业完成，
   并从 Server 日志接口读到 `Hello, world!`。
6. 重启 Registry 和 scheduler，重新导出 Git recipe snapshot、下载全部材料 blob 并逐一
   校验 size/SHA-256，再提交同一单步作业验证持久化安装产物。

**这是材料交付 + 手动 native 离线编译 + 单步作业验收，不是自动受管安装验收。**
Agent 的 audit/install 开关仍关闭，不跳过或放松产品安装器的任何安全门槛。
native 测试使用 Docker 隔离网络及已审核 recipe，不调用 Apptainer/SIF 安装 worker，
不写 managed installation 账本，不把返回的 `rejected` 改成 `succeeded`。
通过此案例不能宣称 Apptainer/cgroup/site profile、计算节点共享存储/ABI、15 个工作流
或生产安装功能已经验收。测试输出只报告实际完成的阶段；缺件或构建失败即非零退出。
