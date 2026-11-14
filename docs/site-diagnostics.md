# 普通用户站点分通道诊断

`kq site doctor` 由现场用户运行，不启动 Agent、不发送 Register，也不会替换正在运行的 Agent 双向流。初始化 `install` 在注册成功后自动运行；单独 `doctor` 先获取并校验签名发行里的 CLI。只须上传 `bootstrap.sh` 和可信 `site.env`；`install` 自动生成共享盘的 `helpers/modules-smoke.sh`。

```bash
kq site doctor --url "$SERVER_HTTP_URL" --grpc-url "$SERVER_GRPC_URL" \
  --cert-dir "$KQ_LOCAL/registration/certs" --json
```

已注册身份使用 `client.crt/client.key`，并读取同级上层 `registration/agent.env` 内的 Agent ID。私钥只在本机签署含 Agent ID、时间和随机 nonce 的 `kq-site-diagnostics-v1` 证明；不传输私钥。Server 查 Agent 及证书 ledger（指纹、有效期、撤销），拒绝过期证明与 nonce 重放。注册前可传 `--token-file <path>` 或 `--token-file -` 从 stdin 读取一次性注册 token，仅访问 metadata、不消费 token。不支持命令行 token 值。

检查返回 `passed`、`failed` 或 `not-tested`。缺身份、缺 fixture、未启用对象存储诊断接口都不能算通过；只有全部检查通过才退出 0。JSON 仅含版本、通道、固定状态与安全原因，不包含地址、预签名 query、证书、token、私钥或对象内容。bootstrap 将它以 0600 保存为本地 `doctor.json`。

| 通道 | 实际动作 |
| --- | --- |
| HTTPS | GET 已有 `agent-binaries`，检查响应格式 |
| 注册身份 | 注册前读 metadata；注册后证书签名证明并生成短期 fixture |
| mTLS HTTP/2 双向流 | 独立 `/site-diagnostics/stream`，保持请求未结束时逐轮发送两次随机 challenge，逐轮核验 seq 和响应 |
| 材料 HTTP GET | 从受当前证书 ledger 约束的材料诊断端点读取固定 probe bytes，并核对长度与 SHA-256 |
| 对象 GET | 经原始预签名地址读取 probe，核对长度与 SHA-256 |
| 对象 PUT | 上传随机会话的 probe，再下载核对内容 |
| multipart | 上传两片（首片 5 MiB），取实际 ETag，通过固定会话 complete，再下载核对完整摘要 |
| fixture cleanup | 删除本次测试对象；失败明确记录 |

材料诊断仅证明这条 HTTPS 下载链路，不证明真实 Registry 材料授权、Spack 闭包或软件可安装。Slurm/module、真实材料安装、断线恢复及科学结果仍需各自现场运行检查。

Server 公开机器路由 `POST /api/agent/site-diagnostics` 自验签，不使用用户 JWT。其返回材料、complete 和 cleanup 的相对 API 路径；CLI 根据已配置的 `SERVER_HTTP_URL/api/` 解析，保留 `/platform` 等部署前缀，不使用代理转发头推断公网地址。对象预签名 URL 保持原样；所有请求继续受站点 allowlist、TLS SNI、证书和隧道/CONNECT 策略约束，无重定向或公网直连回退。

诊断会话使用 5 分钟随机 capability，严格限定到 Server 生成的三个对象及一个 multipart upload，不接受任意 bucket/key/uploadId。Server 完成或超时后尝试清理；清理失败会重试。会话保存在内存，Server 重启会丢失跟踪，因此部署方还须对对象 bucket 的 `site-diagnostics/` 前缀设置过期删除与 incomplete multipart abort 生命周期。该机制不保证跨 Server 重启的即时清理；不要把诊断对象当用户数据。

可选 `--fixtures <private.json>` 只用于平台另行签发的受控测试配置，通常无需使用。fixture 含预签名凭据，不应提交版本库或粘贴诊断报告。`KQ_DOCTOR_TOKEN_FILE` 与 `KQ_DOCTOR_FIXTURES_FILE` 可供 bootstrap 映射上述参数。

状态目录、Agent 锁、更新维护窗口和 stateFormat 规则继续约束激活及回滚。暂存损坏、格式不兼容、Agent writer 未停或 Slurm worker 未终态时保留当前版本；失败写 `status.json` 的 `phase=failed`、固定 `reason` 与当前 `release/activeRelease`。不要因为诊断失败自动切回旧 Agent。
