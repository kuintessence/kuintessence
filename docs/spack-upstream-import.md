# Spack 受控上游导入

## 范围与状态

本功能为默认关闭的 Registry 入口：运维提交 JSON manifest，Registry 通过专用
HTTP/HTTPS/SOCKS5 代理取得自包含 Git bundle 或源码材料，核验声明的 SHA-256 和
精确字节数后，复用现有 recipe 导入、材料上传及 release 发布逻辑。
它不是通用下载代理，不为 Agent 开放上游网络，也不代理 Git、Spack、OCI 或其他业务流量。

本文说明配置及接口约定；部署接线、代理传输和回归用例的验证结果以对应提交的
GitHub Actions 为准，不代表生产站点或 15 个工作流已通过验收。
既有 [手动 recipe 导入](spack-recipe-repositories.md)、
[材料包初始化与 Web 上传](spack-material-delivery.md) 保留。

- Web 入口为平台软件中心与 CP 软件页已有 recipe / 材料面板中的在线导入。
  浏览器选择并提交 JSON manifest，不从浏览器下载上游文件，也不接收代理凭据。
- 请求固定为 `POST /software/api/spack/upstream-imports`，网关转发到
  Registry `POST /api/spack/upstream-imports`，`Content-Type: application/json`。
  不接受 API query 参数。鉴权及 public/org/user namespace 读写权限沿用原发布流程；
  CP 不能因启用代理而写入其他组织的仓库。
- recipe 不执行、不自动激活；材料发布不自动修改 Server 的 `SPACK_MATERIAL_RELEASES`，
  不自动绑定、部署或开启安装。导入成功不证明 recipe 可信、依赖完整或目标 Linux 可安装。
- **Agent 仍只从 Server 授权下载 recipe 和源码**；Registry 上游导入不改变 Agent 网络边界。

## 配置

仅在运行 Registry 的进程配置以下环境变量，不设置全局 `HTTP_PROXY`、`HTTPS_PROXY`
或 `ALL_PROXY`。启用前应已有持久化 recipe/material 存储与单 Registry 写者，
并确保卷有下载暂存和最终文件所需的容量。

| 环境变量 | 默认值 | 说明 |
|---|---|---|
| `SPACK_UPSTREAM_ENABLED` | `false` | 显式启用；关闭时在线导入不可用，手动入口不变 |
| `SPACK_UPSTREAM_PROXY_URL` | 空 | 必填的受信任出口代理 URL，支持 `http://`、`https://`、`socks5://`、`socks5h://` 及代理认证；属于服务端秘密 |
| `SPACK_UPSTREAM_ALLOWED_ORIGINS` | `[]` | JSON 数组，精确 HTTPS origin 白名单，端口仅 443；没有通配符、路径或尾部 `/` |
| `SPACK_UPSTREAM_TIMEOUT_MS` | `300000` | 单文件传输总超时，最多 `1800000` 毫秒 |
| `SPACK_UPSTREAM_IDLE_TIMEOUT_MS` | `30000` | 单文件传输无进展的超时预算，毫秒，不得超过单文件总超时 |
| `SPACK_UPSTREAM_MAX_CONCURRENT` | `2` | 单 Registry 实例并发上限，最多 `4` |
| `SPACK_UPSTREAM_MAX_BYTES` | `1073741824` | 单文件最多 1 GiB，配置上限 16 GiB；仍受 recipe/material 各自限额约束 |
| `SPACK_UPSTREAM_CA_BUNDLE` | 空 | 可选的目标 HTTPS TLS CA 文件，必须为 Registry 容器内绝对路径并只读挂载；空值使用系统信任根 |

白名单示例值为 `["https://mirror.example.invalid"]`，须替换成实际允许访问的公共
HTTPS 站点；标准 443 origin 使用不含 `:443` 的规范形式。
白名单只授权目标 origin，不授权私网地址、任意端口或其他协议。
代理认证中的特殊字符按 URL userinfo 规则编码；不在 Web manifest、values、
ConfigMap、示例文件或日志中放入代理账号、密码或真实秘密 URL。
服务层对整次导入（包括所有文件）另设固定 30 分钟总预算，不能通过增加文件数、
调高单文件超时或代理超时延长。

Registry runtime 依赖 `curl` 可执行文件及 `ca-certificates`。普通 Registry、
dev、AIO Dockerfile 包含这两个包；PR workspace 从既有 scheduler base 继承。
此接线不改变 Bun、Spack 或基础镜像 pins。宿主机运行 Registry 的运维需自行提供依赖。

### Compose

主 Compose 的 `registry` 和 AIO 的 `kq` 服务透传上述变量，均默认关闭；
watch 继承主配置。scheduler、PR 测试和 preview 固定关闭，不从宿主环境继承
代理凭据。`infra` 只部署依赖服务，不启动 Registry。

在私有环境中设置非敏感配置，例如：

```dotenv
SPACK_UPSTREAM_ENABLED=true
SPACK_UPSTREAM_ALLOWED_ORIGINS='["https://mirror.example.invalid"]'
SPACK_UPSTREAM_TIMEOUT_MS=300000
SPACK_UPSTREAM_IDLE_TIMEOUT_MS=30000
SPACK_UPSTREAM_MAX_CONCURRENT=2
SPACK_UPSTREAM_MAX_BYTES=1073741824
```

`SPACK_UPSTREAM_PROXY_URL` 由秘密管理系统注入启动 Compose 的环境；
不要把真实值写进跟踪的 YAML 或 `.env.example`，也不要把展开后的 `docker compose config`
输出放入 CI artifacts 或日志。当前 Compose 使用环境变量透传，不自动读取 Docker
secret 文件；容器管理员能查看容器环境，须限制 Docker 权限。生产 Kubernetes 使用下述
Secret 引用。AIO 为单容器演示，内部进程共享环境，不提供独立 Registry 秘密隔离。

自定义目标 CA 时，用私有 override 只读挂载，例如：

```yaml
services:
  registry:
    environment:
      SPACK_UPSTREAM_CA_BUNDLE: /etc/kq/upstream/target-ca.pem
    volumes:
      - /srv/kq/upstream/target-ca.pem:/etc/kq/upstream/target-ca.pem:ro
```

AIO 把服务名改为 `kq`。仅设置路径不会自动挂载文件；不要覆盖 recipe/material 持久卷。
其他部署及输入挂载约定见 [Compose 指南](../deploy/compose/README.md)。

### Helm

`registry.upstream.enabled` 默认为 `false`。开启时必须保留
`registry.recipes.enabled=true`，由其约束单写者和持久化。
由秘密管理系统在同 namespace 预先创建 Secret；chart 只引用，不生成代理秘密：

```yaml
registry:
  upstream:
    enabled: true
    proxySecretRef:
      name: kq-spack-upstream
      key: SPACK_UPSTREAM_PROXY_URL
    allowedOrigins:
      - https://mirror.example.invalid
    timeoutMs: 300000
    idleTimeoutMs: 30000
    maxConcurrent: 2
    maxBytes: 1073741824
    caBundle: ""
```

Secret 中对应 key 保存完整代理 URL。不要通过 `--set` 传真实代理 URL，
也不要将其放入 Helm values 或 ConfigMap。chart 仅向 Registry 容器注入这些配置；
不会把代理秘密发给 Server、Web 或 Agent，也不修改全局代理设置。
空 Secret 名称/key 或空白名单会拒绝启用；完整 URL、网络及限额合法性仍由 Registry 校验。
Secret 轮换后需按部署流程重建 Registry Pod，使进程读取新环境。

设置 `caBundle` 时，通过自有 chart 扩展或离线 post-renderer 只读挂载对应文件；
chart 不自动创建 CA volume，路径必须是容器内绝对路径。
仅允许 Registry 的出口访问可信 DNS 和指定代理，并在代理侧进一步限制目的地址；
本功能不会自动修改集群 NetworkPolicy。其他 chart 约束见
[Helm 指南](../deploy/helm/kq-platform/README.md)。

## 请求清单

以下示例中的 `<...>`、大小、spec、target、mirror 路径均为占位示意，不能直接提交。
用可信渠道取得内容及其摘要，填写真实 SHA-256（64 位小写十六进制）和精确字节数。
不要仅信任同一个未受信任下载地址自报的 digest。

### Recipe

```json
{
  "kind": "recipe",
  "repository": "org/provider-example/recipes",
  "url": "https://mirror.example.invalid/spack/builtin.bundle",
  "digest": "sha256:<bundle sha256>",
  "size": 123456
}
```

目标必须为既有手动入口支持的自包含、含 `HEAD` 的 Git bundle，不是 Git clone URL、
GitHub tree 页面、任意 tarball 或服务端路径。下载完整性通过后仍接受原 Git 对象、
资源限额、路径和 recipe 静态诊断检查。bundle 最多 128 MiB，Registry 更低限额继续生效。
成功响应包含 `{kind: "recipe", repository: ...}`；查看诊断后另行显式激活。
代理取得的内容不会获得比手动上传更高的信任。

### 材料

每次提交一个 release，`files` 包含该 release 所需全部 lock/source 文件。
`release` 使用现有 `SpackMaterialPublish`，不使用本地材料文件包的 `releases` 数组：

```json
{
  "kind": "material",
  "files": [
    {
      "url": "https://mirror.example.invalid/spack/root.lock",
      "blob": { "digest": "sha256:<lock sha256>", "size": 456 }
    },
    {
      "url": "https://mirror.example.invalid/spack/source.tar.gz",
      "blob": { "digest": "sha256:<source sha256>", "size": 123 }
    }
  ],
  "release": {
    "version": 1,
    "repository": "org/provider-example/sources",
    "spec": "zlib@1.3.1",
    "spackVersion": "1.0.0",
    "target": "linux-ubuntu24.04-x86_64",
    "redistribution": "unrestricted",
    "recipes": [
      {
        "repositoryId": "<recipe repository id>",
        "commit": "<reviewed recipe commit>",
        "roots": ["repos/spack_repo/builtin"]
      }
    ],
    "sources": [
      {
        "path": "<source path within the exported Spack mirror>",
        "blob": { "digest": "sha256:<source sha256>", "size": 123 }
      }
    ],
    "lockfile": { "digest": "sha256:<lock sha256>", "size": 456 }
  }
}
```

`files` 每个 digest 只列一次，须恰好覆盖 release 引用，不能重复 URL、缺件、
多放未引用文件或为同一 digest 声明不同大小。请求 JSON 最多 2 MiB，最多 256 个文件。
recipe commit 须事先导入且当前身份可读，目标 namespace 不得扩大其可见范围。
材料的源码路径、lock 预检、原有单文件与总量限制、再分发声明均继续适用。
`redistribution: "unrestricted"` 是发布者声明，不替代许可证审查。

成功响应包含 `{kind: "material", binding: {repositoryId, manifestDigest}}`。
另行核验并显式配置 Server binding；不因为下载或发布成功自动开启 Agent 安装。

## 网络与秘密边界

- 只接受公共 HTTPS IPv4 目标、端口 443。解析域名时检查全部 DNS A 记录，
  任一非公共 IPv4 均拒绝；下载通过代理连接到已检查并固定的地址，目标 TLS 仍验证原主机名，
  不把目标 DNS 再交给代理选择，以降低 DNS rebinding 风险。
- 不跟随重定向；常见下载页面若返回 3xx，须由运维取得最终 HTTPS 文件地址并单独加入
  origin 白名单，不能靠开放重定向或放宽私网限制绕过。代理失败不回退直连。
- 目标 URL 不支持 userinfo、query 或 fragment；签名 URL、登录 cookie、
  目标站点 Authorization header、受限下载和需许可的厂商材料继续走人工取得/手动上传，
  并遵守现有再分发边界。不是把代理认证转发给目标站点。
- 代理本身是管理员授权的高权限可信出口，可能位于内网；目标地址限制不能约束恶意代理。
  代理和 DNS 的运维权限、出口 ACL、TLS 信任根及主机权限仍须独立治理。
  `SPACK_UPSTREAM_CA_BUNDLE` 用于目标 TLS，不是通用代理 CA 配置；始终验证证书和主机名，
  不提供关闭证书验证的选项。
- 不输出完整请求 manifest、代理 URL/凭据、上游响应内容或原始 curl stderr；
  运维诊断保留脱敏错误类别。不要为排障启用会泄露凭据的 curl verbose/trace。
  摘要校验只证明字节匹配，不证明软件无恶意或可执行。

## 时限、取消与维护

Web/AIO/preview Nginx 仅对精确在线导入路径设置 2 MiB 请求体和 1800 秒代理读写超时；
Vite 对同一路径复用固定 Registry upstream、禁止重定向及同源 cookie 到 Bearer 的桥接，
并使用相同超时。Vite 不另存或解析请求体，实际 JSON 字节上限由 Registry 强制校验。
其他路由原有上传限额和超时不变。外层 Ingress/LB 需另行对齐该路径的限制，
不要全局放大超时。Nginx 读写超时是 I/O 等待上限，不是整个材料批次的硬截止时间。

多文件按顺序下载、校验和暂存，最后执行 release 发布。单文件传输超时不等于整个请求
总时长：单文件默认 5 分钟、最多 30 分钟，整次导入受服务层独立的 30 分钟总预算约束。
达到总预算后取消后续工作，已开始的不可中断存储/Git 操作仍需完成收尾，不承诺硬实时回滚。
文件多、Git 校验慢或经过额外网关时仍可能失去响应。
当前没有后台 job、进度轮询、Range 或断点恢复；关闭页面、会话切换、取消或断连不会
持久化浏览器队列，也不构成事务回滚。

失败可能留下已验证但尚未被 release 引用的 blob/receipt。提交开始后取消或响应丢失，
结果可能已落盘，应视为 **结果待确认**；先刷新 recipe 历史或材料目录核对，
再决定是否用相同清单重试。重试重新传输并校验文件，不从断点恢复，
已提交的不可变快照/release 不因客户端取消而删除。

正常下载暂存由服务收尾；异常退出可能残留暂存文件。仅在停止 Registry 后按存储维护
约定清理暂存，不手工删除发布引用的 blob、receipt、manifest 或 Git 历史。
当前无自动垃圾回收；关闭 importer 不删除既有材料，也不撤销已配置的 Server binding。
