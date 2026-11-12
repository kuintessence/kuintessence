# 离线 Slurm PostgreSQL 恢复验收

在已备妥 PostgreSQL 16 和仓库依赖的验收机运行：

```bash
DATABASE_URL=postgres://kq:kq@127.0.0.1:5432/postgres bun run test:unit --suite offline-slurm-pg
```

这里的 URL 只用于定位 PostgreSQL 实例和管理连接；账号须有 `CREATEDB` 权限。
命令复用 `scripts/test-unit.ts`：先生成 `kuintessence_unit_<时间>_<pid>_<随机值>` 数据库，
在该新库运行完整 migration 链和指定 suite，最后无论测试成功与否均尝试删除该库。
`DATABASE_URL` 与 `KQ_PG_URL` 都改写为新库；不会对传入 URL 的原数据库运行 migration 或测试。
清理失败会使命令失败并输出生成的库名，需由验收人员清理遗留的 `kuintessence_unit_*` 库。
禁止把生产数据库实例作为验收实例。该命令不启动数据库、容器、对象存储或云服务。

`.github/workflows/ci.yml` 的现有测试 job 使用 PostgreSQL 16 service 执行同一命令，
位于原有数据库 migration 和完整单元测试步骤之前。该 job 仍遵循现有 runtime-check gate。
未指定 `--suite` 的旧命令保留 core、server、registry 三个 slice；也支持显式选择它们。

专用 suite 是 `packages/server/src/services/offline-slurm.pg.test.ts`，覆盖：

- 新建隔离库的实际 migration journal 中，0073、0074 按顺序及对应 hash 登记，并核对输出发布 0075 的 journal hash；使用原 migration SQL 升级事务内临时旧表，检查已有行保留、JSONB 字段可读写。
- 两条独立 PostgreSQL 连接并发 complete，第三条连接通过 `pg_stat_activity` 观察真实锁等待；提交前元数据与授权 outbox 都不可见，提交后仅一个文件和一份授权。
- 实际写入授权 outbox 后模拟崩溃，验证新文件、旧文件 tombstone 与 outbox 全部回滚；已组装对象可重试完成。
- 对象 complete 丢回复、数据库提交后响应丢失的重试，以及错误 uploadId、内容摘要的拒绝。
- 真实传输行锁下，旧 dispatcher 保存会话不能清空 completion；错误 owner、绑定变化、完成内容变化及取消后写回被拒绝。
- 普通 Workflow publication 经过真实 JSONB 回读仍复用首批 transferId；两条连接竞争租约仅一方成功。已发布文件映射跨连接保留，租约过期即禁止旧 worker 续租复活、保存或释放目录；被接管后旧 token 同样拒绝写入；新 worker 仅在全部文件发布后写入唯一工作目录释放 outbox。完整 migration 链包含 0075 publication 表与 0076 待处理记录局部索引。
- 普通 Workflow 提交 job 与 0077 intent 同事务提交；用独立观察连接检查提交前均不可见，强制回滚时均不保留。计算完成事实已入库但 publication 尚未建立时，新连接从 intent 与原 job 输出绑定补建发布；普通手动作业不误建 intent，不释放目录或重算。
- Agent 心跳写入 `site_operations` 后，新 manager/独立连接仍能读取；旧版 Agent 不带该字段的心跳不会清除既有状态。

对象存储使用内存 FakeMinioBackend，SpiceDB 客户端关闭，但授权 outbox 使用真实 PostgreSQL。
导入 FakeMinioBackend 会附带执行其所在文件的存储单元测试；这是现有测试依赖形式。
验收不证明真实 S3、网关、Slurm 或 SpiceDB 的现场连通性。

无需 PostgreSQL 的入口与 CI/migration 静态契约可单独运行：

```bash
bun test scripts/test-unit.test.ts
```

本次完成本地 fixture、静态契约、类型和格式检查，没有执行上述真实数据库验收命令、
启动服务或应用 migration。只有命令实际成功退出，才可记录该实例的 PG 验收通过。
