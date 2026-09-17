# Kuintessence 演示

## 通过 Docker Compose 运行完整栈

```bash
docker compose -f examples/docker-compose.demo.yml up --build
```

启动的服务：

| 服务 | URL | 说明 |
|---|---|---|
| Server HTTP | http://localhost:3000 | API + WebSocket |
| Server gRPC | http://localhost:3001 | connectRPC（Agent protocol） |
| Registry | http://localhost:3100 | 应用注册中心 |
| MinIO API | http://localhost:9000 | S3-compatible object store |
| MinIO console | http://localhost:9001 | Web UI（minioadmin / minioadmin） |

Server 与 Registry 首次运行会从源码构建，后续复用缓存镜像层。
这套演示配置包含 Redis 与 MinIO，Server 暂不使用 Redis；配置 Server 的 `NETDRIVE_*`
环境变量后可启用 S3 文件服务。

## 停止与清理

```bash
# 停止，保留 volumes
docker compose -f examples/docker-compose.demo.yml down

# 停止并删除所有数据
docker compose -f examples/docker-compose.demo.yml down -v
```

## 提交 demo 工作流

`kq` CLI 接受单作业 JSON spec 和工作流 YAML。
以下命令以仓库根目录为工作目录；计算节点示例中的用例和软件引用须替换为目标环境中已发布、可访问的资产。

```bash
# 确保 Server 已运行，然后安装依赖
bun install

# 登录（dev/demo 模式，无需真实 OIDC）
bun packages/cli/src/index.ts login \
  --email demo@kuintessence.test \
  --url http://localhost:3000

# 单作业提交
cat > /tmp/hello.json <<'EOF'
{
  "name": "hello",
  "command": "echo \"Hello, Kuintessence!\"",
  "resources": { "cpus": 1, "memoryMb": 1024 }
}
EOF
bun packages/cli/src/index.ts submit /tmp/hello.json

# 多节点控制流工作流
bun packages/cli/src/index.ts workflow submit examples/workflows/two-node-pipeline.yaml

# 查看
bun packages/cli/src/index.ts jobs list
bun packages/cli/src/index.ts workflow list
bun packages/cli/src/index.ts workflow status <runId>
```

## Workflow YAML 格式

工作流使用控制流 DSL。Server 使用 `WorkflowSchema` 校验提交的 YAML（定义在 `@kuintessence/shared`）；`kq workflow submit <file>` 通过 `POST /api/workflows` 异步提交，返回 run ID 后可查询运行状态。

```yaml
name: <required, human-readable>
description: <optional, human-readable>
parameters: []          # typed workflow inputs（可选）
spec:
  nodeDrafts:           # control-flow nodes（SoftwareUsecaseComputing / Switch / Loop / ...）
    - type: SoftwareUsecaseComputing
      id: <slug unique within scope>
      name: <human readable>
      # ... usecase/software-version refs、input/output slots、CEL bindings
  nodeRelations:        # explicit DAG edges（fromId -> toId）
    - fromId: <node id>
      toId: <node id>
```

单节点用例见 [hello.yaml](workflows/hello.yaml)，两节点 DAG 见
[two-node-pipeline.yaml](workflows/two-node-pipeline.yaml)。字段说明见[工作流指南](../docs/workflow-schema/README.md)。

## Helm 部署

Kubernetes 使用 `deploy/helm/kq-platform/` 下的 Helm chart：

```bash
helm install kq deploy/helm/kq-platform \
  --set secrets.jwtSecret="$(openssl rand -hex 32)" \
  --set postgres.password="$(openssl rand -hex 16)" \
  --set minio.rootPassword="$(openssl rand -hex 16)"
```

配置选项见 [Helm 部署说明](../deploy/helm/kq-platform/README.md)。
