# k3s PR 预览

本轮将部署范围调整为预先创建的共享 `preview` namespace。以下为该模式的部署与
清理契约，安全实现仍待复核，须以对应提交的 Actions 和真实 HTTPS 验收为准，
不代表共享 namespace 模式已上线。旧独立 namespace 不会自动迁移或清理。

## 流程

1. [`PR preview tests`](../.github/workflows/preview-tests.yml) 固定当前 PR head SHA，
   运行完整 CI、调度器矩阵和 Spack workflow 矩阵。测试容器只存在于 runner。
2. [`Preview`](../.github/workflows/preview.yml) 从可信 workflow 版本加载部署逻辑，
   校验当前 PR、作者权限、标签、受测 SHA、必需 job 以及后续重跑状态。
3. 独立镜像 job 构建 `linux/amd64` 的 Server、Registry、Web、db-migrate、seed、
   scheduler 六个镜像并推送 GHCR。名称为 `ghcr.io/<owner>/kq-dev-<component>`，
   tag 为 `pr-<PR编号>-sha-<完整提交SHA>-run-<run ID>-<attempt>`，
   Helm 实际使用构建返回的 digest。
4. 独立部署 job 再次核验授权，通过 SSH 本地转发访问远程 k3s 的 `127.0.0.1:6443`，
   在预建的 `preview` namespace 安装 `kq-preview` Chart，每个 PR 使用独立的
   `kq-pr-<编号>` Helm release。runner 只绑定 `127.0.0.1:16443`。
5. 验证真实 HTTPS、未认证访问拒绝、入口解锁、Web 和 Server health 后，
   更新 PR 的固定评论、Actions Summary 和 GitHub Deployment 状态。

PR 必须同时满足：同仓库、目标为默认分支、打开、非草稿、精确标签 `TRUST_PR_CREATOR`、
没有 `preview-paused`、作者**当前**拥有 write/maintain/admin 权限。
标签与成员资格是 AND，不接受“只满足其中一个”。不使用过期 SHA 的历史成功结果，
也不把 skipped、缺失或只运行静态检查的 job 算作完整成功。
堆叠 PR 可先运行全部测试；应先完成依赖合并并将 base 调整为默认分支，再进入部署。
部署和自动清理采用相同的 base 限制，避免从非默认 base 执行带集群凭据的控制器。

## Secrets

在仓库 Actions Secrets 配置：

| 名称 | 用途 |
|---|---|
| `SSH_HOST` | 单节点 k3s 服务器地址，不含协议或用户名 |
| `SSH_PORT` | SSH 端口 |
| `SSH_USER` | SSH 用户，需要允许 TCP forwarding |
| `SSH_KEY` | 无交互解密的 SSH 私钥 |
| `KUBE_CONFIG` | kubeconfig 文件原文，包含 CA 和内联 token 或客户端证书/私钥 |
| `PREVIEW_PASSWORD` | 可选，至少 24 字符的独立预览入口口令 |

预览采用**公开 GHCR**：构建推送使用该 job 的 `GITHUB_TOKEN` 和 `packages: write`，
k3s 匿名拉取，不创建 GHCR 拉取 Secret，也不保存 Actions 的临时 token。
部署前须确认六个 `kq-dev-*` package 均为 public；首次创建或重新创建 package
后，由维护者在 GHCR 手动检查并设置可见性。
匿名镜像拉取与 digest 预检失败时，部署 job 会失败，但保留已推送镜像，不访问 k3s 或删除镜像；
修改可见性后，在同一次 `Preview` run 中选择 **Re-run failed jobs** 即可重试部署。
部署复用镜像 job 输出的原始 attempt，不把重试部署误认为一次新的镜像发布。
若对应 tag 已被清理，应重新运行完整 `Preview` 以发布新 attempt；
仅重跑部署 job 不会恢复已删除的镜像。
若 PR 状态或受测 SHA 已改变，仍需重新通过门禁；不因修改可见性而绕过授权。
控制器不会自动修改包可见性；package 被手动删除并重建后，也应再次检查可见性。
不要在 Git、PR 评论、日志或 artifact 中提供私钥、token、kubeconfig 或预览口令。

`KUBE_CONFIG` 仅允许 HTTPS API、内联 CA 和内联认证；拒绝 `exec`/auth-provider
插件、引用本地证书文件、proxy-url 和跳过 TLS 校验。转发后保留原 API 的 TLS server name。
账号不需要在服务器上执行 Helm，也不需要将 kubeconfig 改为 world-readable；
Helm/kubectl 在 Actions runner 执行。管理员须预先创建 `preview` namespace，
并通过其中的 Role/RoleBinding 授予部署身份管理 Chart 资源的权限，包括工作负载、
Service、Ingress、ConfigMap、Secret、PVC、NetworkPolicy 和 Chart 所需的 namespace
级 RBAC。Helm release 记录也保存在该 namespace 的 Secret 中。
部署身份仅需 namespace 内权限，不查询 nodes 或 namespace 对象，不创建、删除
namespace，也不要求创建或修改 ClusterRole/ClusterRoleBinding，或取得 cluster-admin。
节点架构、StorageClass、Ingress/TLS 和 NetworkPolicy 执行能力由管理员预先确认；
控制器不能通过集群级查询替代这些准备。

按当前部署者的明确选择，SSH 使用 `StrictHostKeyChecking=no`，忽略 known_hosts。
**这放弃了 SSH 服务端身份校验，存在中间人风险**；仅限此预览配置，不能作为生产示例。
此选择不关闭 Kubernetes CA 校验或预览站点 HTTPS 校验。

## Helm 与入口

- 用户版：[kq-platform](../deploy/helm/kq-platform/README.md)，默认生产运行模式，
  seed 可选且默认为 minimal，不创建演示管理员或开放开发登录。
- CI 版：[kq-preview](../deploy/helm/kq-preview/README.md)，依赖同一 platform Chart，
  启用 demo seed、Web、Server、Registry、PostgreSQL、Redis、RustFS/NetDrive，
  以及测试用单容器 Slurm + Agent。
- 所有 PR 共用预建的 `preview` namespace，每个 PR 使用独立 `kq-pr-<编号>` release，
  应用 Secret 为 `kq-pr-<编号>-secrets`，owner marker 为
  `kq-pr-<编号>-preview-owner`。marker 记录仓库、PR 和 release 的归属；
  同名资源不满足归属检查时拒绝接管。数据库、recipe 本地 Git 目录、材料及 Agent
  状态使用该 release 的资源和 PVC，跨升级保留，不与其他 PR 共用应用 Secret 或数据卷。
- 工作负载与持久化资源使用 `app.kubernetes.io/instance=kq-pr-<编号>` release label。
  Service 和 NetworkPolicy 按 release 选择工作负载，不能因为同在 `preview`
  namespace 就放通其他 PR 的后端访问；gateway 的外部入口仅允许指定的 Traefik
  namespace/Pod labels。必须由集群实际执行 NetworkPolicy，不能只依赖命名约定。
  namespace 级部署权限本身不构成每 PR 的 RBAC 隔离，也不提供完整 egress 隔离；
  此模式仅供受信任维护者使用，不是不可信多租户沙箱。
- Traefik Ingress 使用完整 Host 和 `tls.hosts`，由现有默认 TLSStore 提供证书。
  不跨 namespace 引用 TLS Secret，不请求 cert-manager 签发，不修改集群 TLSStore。
- 开发登录只允许经受保护的 gateway 访问。入口用户名 `preview`，
  解锁后使用 HttpOnly/Secure cookie，不覆盖应用的 Bearer Authorization。
  不公开 Server gRPC、数据库、RustFS 控制台或 Agent 注册管理端点。

未提供 `PREVIEW_PASSWORD` 时，首次部署生成随机口令，之后保留在
该 PR 的 `kq-pr-<编号>-secrets`。管理员可通过受信终端读取，私下交给审阅者：

```bash
kubectl -n preview get secret kq-pr-123-secrets \
  -o jsonpath='{.data.PREVIEW_PASSWORD}' | base64 --decode
```

将 `123` 替换成实际 PR 编号。**不要在 Actions 或公开终端录屏中运行这条取密命令。**
demo seed 的内容和幂等策略见 [seed 指南](../deploy/seed/README.md)。
该环境只用于虚构数据。单容器调度器不启用高权限 Apptainer managed Spack runtime；
完整受管安装继续由独立 runner 验收，不代表远端预览已覆盖 15 个科学工作流。

## 首次启用

自动 `workflow_run` 部署和 `pull_request_target` 清理须先存在于受信默认分支。
共享 namespace 控制器修改也必须先经审核合入，不能由目标 PR 替换带凭据的部署逻辑。
维护者准备好 `preview` namespace、namespace-only RBAC、公开镜像与集群基础设施后，
给目标 PR 添加 `TRUST_PR_CREATOR`，完整测试通过后才进入自动部署。
信任标签应由维护者在审阅代码后添加，不由构建脚本自动补齐。

测试可在 PR 分支触发；有集群凭据的手动部署入口**仅接受默认分支**：

```bash
gh workflow run preview-tests.yml --ref feat/example -f pr_number=123
gh workflow run preview.yml --ref main \
  -f pr_number=123 -f test_run_id=123456789
```

第一次命令的 ref 必须对应 PR 当前 head；第二次必须等待受审部署控制器进入默认分支，
以及第一组完整测试终态成功。手动入口不绕过任何信任或测试门禁。
只有默认分支已经注册对应 workflow 时，GitHub 才能通过名称发现这些手动入口。

## 升级与清理

同一 PR 的部署、清理串行执行，不中途取消 Helm。构建前和部署前后均重新检查 PR 状态，
旧 run 不得覆盖新 SHA 的环境或发布错误地址。失败时不发布新的成功链接；
Helm 使用 atomic/wait/wait-for-jobs，原始日志和 Secret 文件不会上传。
Helm 已应用但 HTTPS 验收或最终授权检查失败时，会补偿删除本 PR 的专用环境；
这同样会删除该环境的演示数据，不保留一个未经验收的新版本对外提供服务。
当前版本的 migration、seed 和 RustFS bootstrap 完成 Job 不设置 TTL，
避免 Pod 重建时等待已被自动回收的初始化屏障；由对应 release 的 Helm 升级或卸载回收。

[`Preview Cleanup`](../.github/workflows/preview-cleanup.yml) 处理关闭/合并、转草稿、
添加暂停标签、移除信任标签，也提供手动重试。清理范围固定在 `preview` namespace：

1. 校验 `kq-pr-<编号>-preview-owner`、Helm release 和目标资源的仓库/PR/release
   归属；拒绝接管或删除同名但不受本控制器管理的资源。
2. Helm uninstall 仅针对 `kq-pr-<编号>` release，不使用全 namespace 或全 release 清理。
3. 删除该 release 自有的残留 PVC、`kq-pr-<编号>-secrets`，最后删除其 owner marker。
   资源选择必须限定本 PR 的完整 release label 与归属，不能扩大到其他 PR。
4. 本 PR 的集群资源清理成功后，再回收六个专用 dev package 中归属该 PR 的历史镜像版本。
   已不存在的自有资源可幂等处理，但不能因 marker 缺失就接管同名未知资源。

**绝不删除 `preview` namespace，也不删除其他 PR 的 release、PVC、Secret 或 marker。**
归属检查或本 PR 的资源清理失败时，不进入 GHCR 镜像回收。
即使后续 GHCR 回收失败，评论仍如实标记站点不可用、Deployment 为 inactive；
cleanup job 保持失败状态，修复权限等问题后可重复执行清理。

**清理会删除本 PR 的演示数据和自有 PVC；StorageClass 的回收策略决定底层卷是否
随之销毁。** 控制器不直接删除集群级 PV；不要在预览中保存真实材料或唯一数据副本。
GHCR 回收仅使用版本删除 API，不调用整包删除，也不修改包可见性。
分页枚举的 package 必须关联当前代码仓库，包名只能是六个固定的 `kq-dev-*` 名称。
只有全部 tag 都符合该 PR 的专用命名规则的 version 才可删除；
删除前再次核对其 digest 和 tag。其他 PR、release tag、混合用途 alias、
旧的 SHA-only tag 和无法归属的 untagged version 均不会被批量删除。
目标 version 若带有其他用途 tag，保留并使任务报错，要求维护者审查，不静默扩大删除范围。

每次发布使用独立 run/attempt tag，并将该 tag 写入镜像 label，防止不同 PR 或重试
共享同一 version。dev 构建固定单平台 `linux/amd64`，关闭 provenance/SBOM attestation，
避免生成无法按 PR tag 归属的 untagged 子 manifest；此约定不改变正式发布镜像策略。
构建晚于 PR 关闭或撤销信任结束时，会额外检查当前资格，仅回收本次尚未部署到 k3s
的 tag，包括构建失败前已经部分推送的组件。HTTPS/最终授权失败后的补偿清理
也仅回收对应发布 attempt，不触碰更新 run 的镜像。

回收使用有 `packages: write` 的 `GITHUB_TOKEN`，当前仓库还必须拥有 package 的
admin 权限；首次由本仓库 workflow 发布通常会自动授予，旧包需在 package settings
检查 Actions access。公开版本下载量超过 GitHub 删除限制、权限不足或 API 故障均会
使回收失败并保留未删除的版本，不通过个人 token 绕过限制。
PR 仍打开时保留历史版本，便于现有 Pod 重启和失败升级回滚；关闭或暂停时统一回收。
强制取消 workflow、手动增加 alias 或修改 package 权限后，应手动重试
`Preview Cleanup` 并核对 cleanup job 的状态和固定诊断标记，
不能仅依据 Helm release 已卸载判断镜像清理完成。
共享 `preview` namespace 会一直保留，不能把它的存在与否用作单个 PR 的清理结果；
应核对该 release、自有 PVC、Secret、owner marker 及 GHCR 回收结果。
首次部署失败后本 PR 的部分资源可能保留用于诊断；必要时添加暂停标签后重试清理。
权限撤销本身没有 PR webhook：再次部署会拒绝，撤销后应同步移除信任标签触发清理。
已部署 PR 若改投非默认 base，应从默认分支手动运行 `Preview Cleanup`；该入口
仍会检查 PR、release 和资源归属，不会执行新 base 的代码。

### 旧独立 namespace

原有 `kq-pr-<编号>` 独立 namespace 不会自动迁入 `preview`，其中的 Secret、PVC、
数据库及 Helm 状态也不会自动复制或删除。新控制器只管理共享 `preview` 内的资源，
不能将旧 namespace 存在视为新 release 已部署，也不能扩大新 cleanup 的删除范围。
如有旧环境，管理员须另行审核、备份并显式处理；namespace-only 部署身份不负责该迁移。
若旧环境已在运行，启用新版自动清理前必须先完成迁移或下线；新版身份无法核验旧
namespace 内是否还有 Pod 使用同一 PR 的历史镜像，不应在旧环境仍依赖镜像时触发回收。

所有测试、镜像构建、Helm 渲染与在线验收仅在 GitHub Actions 执行。
代码存在不等于运行验证通过，应以对应 SHA 的 Actions 和 HTTPS 验收结果为准。
