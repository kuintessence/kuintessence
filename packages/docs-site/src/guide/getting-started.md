# 快速开始

首次使用可按以下步骤启动开发环境、登录 Web 控制台并检查服务状态。

## 1. 准备环境

需要：

- Bun `>=1.1.0`
- Docker 与 Docker Compose
- Git

使用仓库提供的 Compose 脚本启动开发环境：

```bash
bun install
bun run dev:compose:build
```

日常开发复用已构建镜像：

```bash
bun run dev:compose
```

如果需要带 Slurm / PBS / K3s 的测试环境：

```bash
bun run dev:scheduler:compose
```

## 2. 打开控制台

默认入口：

| 服务 | 地址 |
|---|---|
| Web SPA | `http://localhost:5173` 或 scheduler watch 栈的 `http://localhost:15173` |
| Server HTTP | `http://localhost:3000` 或 scheduler watch 栈的 `http://localhost:13000` |
| Registry | `http://localhost:3100` 或 scheduler watch 栈的 `http://localhost:13100` |
| MinIO console | `http://localhost:9001` 或 scheduler watch 栈的 `http://localhost:19001` |

开发模式登录页允许输入任意邮箱，并选择调试角色。生产环境应配置 SSO/OIDC。

## 3. 验证服务

```bash
curl http://localhost:3000/api/health
curl http://localhost:3100/api/spack/catalog?page=1&pageSize=1
```

scheduler watch 栈可用：

```bash
curl http://localhost:13000/api/health
curl http://localhost:15173/software/api/spack/catalog?page=1&pageSize=1
```

## 4. 常见开发流程

1. 修改 TypeScript / React / JSON / CSS。
2. 功能或操作方式变化时，同步更新文档。
3. 运行相关测试。
4. 提交前运行：

```bash
bun run lint
bun run typecheck
```

## 5. 下一步

- 科研用户阅读 [用户手册](../roles/user.md)。
- 集群管理员阅读 [算力提供者手册](../roles/compute-provider.md)。
- 平台运营阅读 [平台运营手册](../roles/platform-operator.md)。
- 软件发布者阅读 [软件开发者手册](../roles/software-provider.md)。
