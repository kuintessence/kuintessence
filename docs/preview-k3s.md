# k3s PR 预览

## 流程

1. [`PR preview tests`](../.github/workflows/preview-tests.yml) 固定当前 PR head SHA，
   运行完整 CI、调度器矩阵和 Spack workflow 矩阵。测试容器只存在于 runner。
2. [`Preview`](../.github/workflows/preview.yml) 从可信 workflow 版本加载部署逻辑，
   校验当前 PR、作者权限、标签、受测 SHA、必需 job 以及后续重跑状态。
3. 独立镜像 job 构建 `linux/amd64` 的 Server、Registry、Web、db-migrate、seed、
   scheduler 六个镜像并推送 GHCR。名称为 `ghcr.io/<owner>/kq-dev-<component>`，
   tag 为 `sha-<完整提交SHA>`，Helm 实际使用构建返回的 digest。
4. 独立部署 job 再次核验授权，通过 SSH 本地转发访问远程 k3s 的 `127.0.0.1:6443`，
   安装 `kq-preview` Chart。runner 只绑定 `127.0.0.1:16443`。
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
| `GHCR_PULL_USER` / `GHCR_PULL_TOKEN` | 私有镜像所需的长期只读拉取身份；公开镜像可省略 |
| `PREVIEW_PASSWORD` | 可选，至少 24 字符的独立预览入口口令 |

构建推送使用该 job 的 `GITHUB_TOKEN` 和 `packages: write`，不会把此临时 token
保存为集群长期拉取凭据。新建 GHCR package 后需配置可用的公开可见性，或上述私有拉取
凭据（并按组织策略授权访问）。部署前会逐个验证 image digest 可拉取；失败时不修改应用。
不要在 Git、PR 评论、日志或 artifact 中提供私钥、token、kubeconfig 或预览口令。

`KUBE_CONFIG` 仅允许 HTTPS API、内联 CA 和内联认证；拒绝 `exec`/auth-provider
插件、引用本地证书文件、proxy-url 和跳过 TLS 校验。转发后保留原 API 的 TLS server name。
账号不需要在服务器上执行 Helm，也不需要将 kubeconfig 改为 world-readable；
Helm/kubectl 在 Actions runner 执行。Kubernetes 身份需能管理指定预览 namespace、
Chart 资源、Secret、PVC、NetworkPolicy 和 namespace 级 RBAC。

按当前部署者的明确选择，SSH 使用 `StrictHostKeyChecking=no`，忽略 known_hosts。
**这放弃了 SSH 服务端身份校验，存在中间人风险**；仅限此预览配置，不能作为生产示例。
此选择不关闭 Kubernetes CA 校验或预览站点 HTTPS 校验。

## Helm 与入口

- 用户版：[kq-platform](../deploy/helm/kq-platform/README.md)，默认生产运行模式，
  seed 可选且默认为 minimal，不创建演示管理员或开放开发登录。
- CI 版：[kq-preview](../deploy/helm/kq-preview/README.md)，依赖同一 platform Chart，
  启用 demo seed、Web、Server、Registry、PostgreSQL、Redis、RustFS/NetDrive，
  以及测试用单容器 Slurm + Agent。
- 每个 PR 使用独立 `kq-pr-<编号>` namespace 和同名 Helm release。
  应用 Secret、数据库、recipe 本地 Git 目录、材料及 Agent 状态跨升级保留。
- Traefik Ingress 使用完整 Host 和 `tls.hosts`，由现有默认 TLSStore 提供证书。
  不跨 namespace 引用 TLS Secret，不请求 cert-manager 签发，不修改集群 TLSStore。
- 开发登录只允许经受保护的 gateway 访问。入口用户名 `preview`，
  解锁后使用 HttpOnly/Secure cookie，不覆盖应用的 Bearer Authorization。
  不公开 Server gRPC、数据库、RustFS 控制台或 Agent 注册管理端点。

未提供 `PREVIEW_PASSWORD` 时，首次部署生成随机口令，之后保留在
`kq-preview-secrets`。管理员可在服务器上通过受信终端读取，私下交给审阅者：

```bash
sudo k3s kubectl -n kq-pr-123 get secret kq-preview-secrets \
  -o jsonpath='{.data.PREVIEW_PASSWORD}' | base64 --decode
```

将 `123` 替换成实际 PR 编号。**不要在 Actions 或公开终端录屏中运行这条取密命令。**
demo seed 的内容和幂等策略见 [seed 指南](../deploy/seed/README.md)。
该环境只用于虚构数据。单容器调度器不启用高权限 Apptainer managed Spack runtime；
完整受管安装继续由独立 runner 验收，不代表远端预览已覆盖 15 个科学工作流。

## 首次启用

自动 `workflow_run` 部署和 `pull_request_target` 清理须先存在于受信默认分支。
提交本 PR 不会自动合并或安装默认分支控制器。
维护者审核并合入后，给目标 PR 添加 `TRUST_PR_CREATOR`，完整测试通过后自动部署。
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

同一 PR 的部署、清理串行执行，不中途取消 Helm。部署前后均重新检查 PR 状态，
旧 run 不得覆盖新 SHA 的环境或发布错误地址。失败时不发布新的成功链接；
Helm 使用 atomic/wait/wait-for-jobs，原始日志和 Secret 文件不会上传。
Helm 已应用但 HTTPS 验收或最终授权检查失败时，会补偿删除本 PR 的专用环境；
这同样会删除该环境的演示数据，不保留一个未经验收的新版本对外提供服务。
当前版本的 migration、seed 和 RustFS bootstrap 完成 Job 不设置 TTL，
避免 Pod 重建时等待已被自动回收的初始化屏障；由 Helm 升级或 namespace 清理回收。

[`Preview Cleanup`](../.github/workflows/preview-cleanup.yml) 处理关闭/合并、转草稿、
添加暂停标签、移除信任标签，也提供手动重试。仅删除带有本仓库及 PR ownership
标记的 namespace，拒绝接管或删除同名但不受本控制器管理的 namespace。
成功后固定评论标记为不可用，历史 Deployment 标记为 inactive。

**清理会删除 PR namespace 及其中所有演示数据和 PVC；默认 StorageClass 的回收策略
决定底层卷是否随之销毁。** 不在该 namespace 保存真实材料或唯一数据副本。
GHCR 历史镜像不自动删除，按组织自己的保留策略管理。
首次部署失败后 namespace 可能保留用于诊断；必要时添加暂停标签后重试清理。
权限撤销本身没有 PR webhook：再次部署会拒绝，撤销后应同步移除信任标签触发清理。
已部署 PR 若改投非默认 base，应从默认分支手动运行 `Preview Cleanup`；该入口
仍会检查 PR 与 namespace ownership，不会执行新 base 的代码。

所有测试、镜像构建、Helm 渲染与在线验收仅在 GitHub Actions 执行。
代码存在不等于运行验证通过，应以对应 SHA 的 Actions 和 HTTPS 验收结果为准。
