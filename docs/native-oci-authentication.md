# 原生 OCI 登录与统一 HTTPS 入口

Registry 与 Server 设置相同 `REGISTRY_PUBLIC_ORIGIN=https://platform.example.com`。
该显式配置是外部入口，不从客户端 Host、Forwarded 或内部请求 URL 推断。
`/v2/` 由统一入口转发 Registry，`/api/registry/token` 转发 Server，保留 Authorization。
TLS 在统一网关终止；离线 CONNECT/SSH 隧道须继续使用证书中的平台域名，安装受信 CA，不能改为内网 HTTP origin 或关闭 TLS 校验。
Helm 对应 `registry.auth.publicOrigin`，AIO 对应同名环境变量。
独立部署中 Server 的 `SPACK_REGISTRY_JWT_SECRET/ISSUER/AUDIENCE` 与 Registry 的
`REGISTRY_JWT_SECRET/ISSUER/AUDIENCE` 必须一致；publisher roles 同样保持一致。
启用公共 origin 后，原生 `/v2/` 要求交换后的 scope token；材料 API 的既有内部认证不变。

无凭据的版本及仓库请求返回 401、`Docker-Distribution-API-Version: registry/2.0` 和
`WWW-Authenticate: Bearer realm="https://platform.example.com/api/registry/token",service="platform.example.com",scope="repository:public/image:pull"`。
版本探测没有 scope。token endpoint 接受 GET、service 和多个 scope 参数，使用标准 Basic 凭据交换短期 JWT。
realm 与 service 均指向统一公共入口，不包含 Registry 内部主机或端口。

人类先通过平台既有登录流程（包括 SSO/MFA）取得未过期的 access JWT。
将登录 email 或该 token 的 subject 作为 username，将 access JWT 作为 password；不能直接使用账户密码、refresh token 或浏览器 cookie。
Server 复用现有登录验证、会话撤销、主体查询和服务账户限制，避免另建绕过 MFA 的密码入口。
现有机器凭据 `kqac_` 没有 OCI scope，本入口拒绝它；不能把 `software:read` 解释为 OCI 授权。

```sh
# KQ_ACCESS_TOKEN 由既有登录流程安全取得，不写入 shell 历史。
printf '%s' "$KQ_ACCESS_TOKEN" | docker login platform.example.com --username user@example.com --password-stdin
docker pull platform.example.com/public/image:latest
printf '%s' "$KQ_ACCESS_TOKEN" | apptainer registry login --username user@example.com --password-stdin docker://platform.example.com
apptainer pull image.sif docker://platform.example.com/public/image:latest
# 已具备 publisher role 且有目标 namespace 写权限时：
docker push platform.example.com/org/your-org/image:latest
```

Docker/Apptainer 保存的登录凭据仍是短期平台 access JWT；到期后重新登录。
交换 JWT 最长 300 秒，且不能超过平台 access JWT 的剩余寿命，不签发 refresh token。
Docker 标准登录附带的 `offline_token=true` 是可选提示，本入口忽略它，仍只返回上述短期 access token；
不返回 `refresh_token`，不支持 refresh-token grant，也不提供 catalog scope。
平台会话撤销会阻止新交换；已签发 JWT 最长在上述寿命内有效。每个 Registry 请求仍查询实时角色、组织及停用状态。
登录阶段可取得空 access grant；该 token 仅允许版本探测，不能拉取任何仓库或列出 catalog。
每个 repository scope 均按 subject、组织成员和 publisher role 校验，pull 不能转换为 push，跨仓库 mount 另需源仓库 pull。
不提供匿名公共 token，也不授予通配 catalog/delete scope。


登录失败时检查平台会话、TLS 和统一 origin。拉取或推送被拒绝时检查目标 namespace、实时角色和 repository scope；不要通过重写 Forwarded host、关闭证书验证或复用另一仓库的 token 绕过授权。
