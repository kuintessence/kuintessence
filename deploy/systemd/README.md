# Agent systemd 部署

`kq-agent` 在 Linux 登录节点上运行，通过 connectRPC 连接 Server，调用本地调度器。
安装目录为 `/usr/local/bin/kq-agent`，配置位于 `/etc/kq-agent/kq-agent.env`，
证书、SQLite 缓存和作业数据保存在 `/var/lib/kq-agent`。

## 前置条件

- Linux、systemd，以及安装所需的 root 权限。
- 节点能够访问 Server HTTP API 和 connectRPC HTTP/2 入口。
- `kq-agent` 服务账号已获准使用调度器，能够提交作业、读取状态并访问作业目录。
- 节点上另行安装 `kq` CLI，用于首次注册；Agent 二进制不包含 CLI 子命令。

服务以 `kq-agent` 账号执行本地命令。调度器权限和账号映射由站点管理员配置。

## 获取二进制

优先从已部署的 Server 获取同一源码提交编译的 Agent。Server 镜像内置 Linux x64、
ARM64 的 glibc 可执行文件及 SHA-256 清单，产物自带 Bun 运行时。下载不需要登录，
但安装后仍须完成节点注册、mTLS 和站点调度器配置。

通过 Web 同源入口下载（需要 `curl`、`jq`、`sha256sum`）：

```bash
set -euo pipefail
AGENT_URL="https://platform.example.com/platform/api/agent-binaries"
AGENT_FILE="kq-agent-bun-linux-x64" # ARM64 改为 kq-agent-bun-linux-arm64
curl -fsS "$AGENT_URL" -o agent-manifest.json
AGENT_REVISION="$(jq -er .revision agent-manifest.json)"
curl -fS "$AGENT_URL/$AGENT_FILE?revision=$AGENT_REVISION" -o "$AGENT_FILE"
jq -er --arg name "$AGENT_FILE" \
  '.files[] | select(.name == $name) | "\(.sha256)  \(.name)"' \
  agent-manifest.json | sha256sum --check -
install -m 0755 "$AGENT_FILE" ./kq-agent
```

直接访问 Server 时使用 `/api/agent-binaries`。下载期间 Server 若切换提交，
带 `revision` 的下载返回 409；重新获取清单后重试。源码运行未配置产物时返回 404；
可通过 Server 的 `AGENT_BINARIES_DIR` 指定产物目录。原始 `manifest.json` 和
`SHA256SUMS` 也可通过同一下载路径获取。

不经过 HTTP 时，从指定 Server 镜像复制产物（`docker create` 不启动容器）：

```bash
SERVER_IMAGE="ghcr.io/kuintessence/kuintessence-server:main" # 固定版本时使用部署的 digest
docker pull "$SERVER_IMAGE"
AGENT_CONTAINER="$(docker create "$SERVER_IMAGE")"
mkdir -p ./agent-bundle
docker cp "$AGENT_CONTAINER:/opt/kuintessence/agent/." ./agent-bundle/
docker rm "$AGENT_CONTAINER"
(cd agent-bundle && sha256sum --check SHA256SUMS)
install -m 0755 ./agent-bundle/kq-agent-bun-linux-x64 ./kq-agent
```

也可在 GitHub Actions 中手动运行 **Build Agent binary**，选择与 Server 相同的提交，
下载对应 Linux 架构的产物。
本地构建时，在仓库根目录执行：

```bash
bun install --frozen-lockfile
bun run --filter @kuintessence/proto generate
bun scripts/build-agent-bundle.cjs /tmp/kq-agent-bundle "$(git rev-parse HEAD)"
install -m 0755 /tmp/kq-agent-bundle/kq-agent-bun-linux-x64 ./kq-agent
```

脚本同时编译两种架构；ARM64 安装 `kq-agent-bun-linux-arm64`。为支持跨架构构建，
打包时排除 ssh2 的可选本机 addon，使用其内置 `node:crypto` 回退实现。

## 安装与注册

将二进制和 `deploy/systemd/` 目录复制到目标节点：

```bash
chmod +x ./kq-agent
sudo bash deploy/systemd/install-agent.sh ./kq-agent
```

脚本创建服务账号、安装二进制和配置模板，并重新加载 systemd。
它不执行 Agent，也不启用、启动或重启服务。

在已登录平台的 `kq` CLI 中，为目标算力提供者签发一次性注册凭证：

```bash
kq agent token create \
  --provider-org <provider-org-uuid> \
  --agent-id agent-site-a \
  --site-name site-a
```

在目标节点按[Agent 注册说明](../../docs/security.md#agent)运行 `kq agent register`，
使用实际 HTTP、connectRPC 地址和该凭证。默认输出目录为
`~/.kuintessence/agent/agent-site-a/`，其中包含 `agent.env` 和 `certs/`。
注册凭证只用于此次注册，不写入服务环境文件。

将证书交给服务账号：

```bash
CERT_SOURCE="$HOME/.kuintessence/agent/agent-site-a/certs"
sudo install -d -o kq-agent -g kq-agent -m 0700 /var/lib/kq-agent/certs
sudo install -o kq-agent -g kq-agent -m 0600 \
  "$CERT_SOURCE/client.key" "$CERT_SOURCE/client.crt" "$CERT_SOURCE/ca.crt" \
  /var/lib/kq-agent/certs/
sudoedit /etc/kq-agent/kq-agent.env
```

若注册时使用了其他 Agent ID 或 `--output-dir`，相应调整 `CERT_SOURCE`。
配置文件中的 `SERVER_HTTP_URL`、`SERVER_GRPC_URL`、`AGENT_ID` 和 `AGENT_SITE_NAME`
应与注册输出一致；保留模板中 `/var/lib/kq-agent` 下的证书和数据路径。

在配置文件的 `PATH` 中加入站点调度器命令目录，填写完整路径列表，不使用 `$PATH` 展开。
需要 Spack 时设置 `AGENT_SPACK_ENABLED=true` 和 `AGENT_SPACK_PATH`。

## 启动与升级

首次启动并启用开机自启：

```bash
sudo systemctl enable --now kq-agent
sudo systemctl status kq-agent
sudo journalctl -u kq-agent -f
```

升级时重新安装并重启：

```bash
sudo bash deploy/systemd/install-agent.sh ./kq-agent-new
sudo systemctl restart kq-agent
```

安装脚本替换二进制和 unit，保留已有配置与数据。站点的 unit 调整使用
`sudo systemctl edit kq-agent` 保存为 drop-in，避免升级覆盖。

## 站点目录与权限

默认 unit 隐藏 `/home`、隔离临时目录和设备，并限制提权与 namespace 创建。
需要访问共享目录、设备、Apptainer 或 Kubernetes 凭据时，通过 drop-in 调整对应限制，
并配置服务账号的文件访问权限。模板适用于普通服务账号，不提供 root 身份切换。

作业、数据集和受限材料目录由 Agent 创建，归服务账号所有，权限为 `0700`。
多节点作业需要所有执行节点可访问的工作目录时，调整 `AGENT_JOB_WORK_ROOT` 等配置，
在共享存储上为 Agent 分配独立目录。

日志写入 journal，可通过 `journalctl -u kq-agent` 查看。

## 证书轮换

通过[证书管理 API](../../docs/security.md#agent)提交以 Agent ID 为 CN 的新 CSR。
在节点保留对应私钥，将返回的证书和 CA 分别保存为 `client.crt`、`ca.crt`。
停止服务后替换 `AGENT_CERT_DIR` 中的 `client.key`、`client.crt` 和 `ca.crt`，
保持服务账号所有权与 `0600` 权限，再启动服务。
确认新证书连接正常后，撤销旧证书。

## 卸载

```bash
sudo systemctl disable --now kq-agent
sudo rm /etc/systemd/system/kq-agent.service /usr/local/bin/kq-agent
sudo systemctl daemon-reload
```

配置、证书和数据仍保留在 `/etc/kq-agent`、`/var/lib/kq-agent`。
确认不再需要后，可删除这两个目录、自定义 drop-in 和 `kq-agent` 服务账号。
