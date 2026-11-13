# Multipart 最终提交恢复

Server 在调用对象存储 complete 前，将 Agent 的最终 size、sha256、parts 保存在原传输的 `resume_session.completion`。失败保留会话；恢复同一传输时先重新检查归属、Agent 和集群根授权，再重放完成请求。有完成回执时 Agent 可以离线，不再重发上传任务。

会话保存通过传输行的 `SELECT FOR UPDATE` 串行化：绑定字段不可变化，completion 只能首次写入或原样重试；旧进程保存不含 completion 的会话时保留既有完成回执，并将合并结果返回 dispatcher，直接进入完成重放。显式取消才会清空会话；已取消行拒绝后续写回。

最终提交按 storageKey 获取 PostgreSQL 事务锁。已提交记录必须匹配 owner、path、size、sha256、contentType 且未删除，才返回原 file id；不会重复创建记录或授权 outbox。新记录与替换记录的授权变更在同一事务中提交，授权失败回滚元数据。

对象 complete 已成功但响应丢失或数据库事务回滚时，恢复通过 head 和流式 sha256 校验对象，再提交元数据；仅 size 相同不足以认定成功。提交成功仍保留 completion，覆盖传输最终状态落库前崩溃的窗口。sha256 不匹配、绑定变化会明确失败；底层 SDK/数据库异常向用户返回 `MULTIPART_FINALIZATION_RETRY_REQUIRED`，不会显示底层 URL。

不保证 best-effort 流量审计在进程崩溃时必达。已有旧 multipart token 未绑定 path，需经授权恢复换发新 token。真实 PostgreSQL 并发及事务恢复测试已补入 `netdrive.test.ts`，本次仅执行假依赖单元测试，未连接数据库或对象存储。

## 登录节点对象下载恢复

Server 对 NetDrive 下载下发已授权文件的真实大小和 `expected_sha256`，不信任客户端填入的大小。
主机 Agent 将部分文件保存在目标旁的 `<target>.kq-sha256-<digest>.part`，传输失败、SSH断线或 Agent 重启后保留；
重试同一内容时按长度发送 Range，URL 续签不改变内容绑定。正常 EOF 少字节也会在本次操作中重试；
对端不支持 Range 而返回200时从头重写，不拼接两份内容。网络请求和读流均有60秒空闲超时，每次有进展后重新计时。

只有大小及全文件 SHA-256 匹配后才 fsync 并原子发布，损坏内容清零以免反复复用。
已完整的 `.part` 直接校验发布，避免末尾416；403等授权失败保留进度并要求经平台恢复同一传输、重新授权换发URL。
取消或被新请求替代的旧传输不再上报虚假失败。相同目标的不同内容串行写入，取消排队等待不会越过前一个写入者。
既有 `AGENT_FILE_TRANSFER_CONNECT_TO` 仍保留原始 Host 和TLS身份；显式 site transport 优先，不能通过旧映射旁路隧道。

目标目录必须由 Agent 用户持有，且不能允许其他账号写入；部分文件须为当前 UID 的私密普通文件。
发布前再次核对目录和部分文件的 inode、设备、大小与权限，拒绝下载期间被替换的路径。
这沿用单用户信任边界，不隔离同一 Unix 账号下的恶意进程。

此增强适用于带可信内容绑定的主机下载。旧发送端未提供摘要时及 Docker 容器分支保留原有curl行为，
不能据此宣称这些兼容路径已有跨重启断点和整件摘要验收。失败部分文件尚无自动GC，确认没有在途操作后再人工清理。


工作流输入的两条路径也传递已授权 NetDrive 文件的 SHA-256 与大小：Server 直接触发的 `createFileStager`，
以及 Agent 管理工作目录时的 `InputStaging.total_bytes/expected_sha256`。主机 Agent 使用同一下载器保留摘要绑定部分文件、
按 Range 恢复并在整文件校验后发布；任务输入下载使用 Agent 生命周期取消信号，退出时保留部分文件。
授权仍先于下载 URL 和内容绑定下发。旧消息、未提供可信摘要的特殊输入，以及容器下载继续走兼容路径。


容器来源的 multipart 上传现在与主机上传使用相同的持久 checkpoint（需配置 Agent 的 transfer state 目录），
绑定 requestId/uploadId、对象大小、partSize 和每个完成 part 的 SHA-256/ETag。
Agent 重启或重派后仍须重新读取容器并生成独立 spool，再逐片重算哈希；只有记录匹配的 part 才跳过上传，
源文件内容或大小变化会拒绝复用。同一 checkpoint 的写入在 Agent 进程内串行，取消排队不会跳过前一个写入者；
每次请求使用独立临时 spool 并仅删除自身文件，已取消请求不再上报旧终态。
part PUT 每次尝试有 5 分钟总期限，网络停滞或取消后保留已完成 checkpoint，重派可用新 URL 继续缺失 part。
该期限不是随进度刷新的空闲期限；低于完成一整个 part 所需带宽的链路仍可能失败。Server 默认
`NETDRIVE_MULTIPART_PART_SIZE_MB=64`，每片须在期限内传完；较慢站点可由部署方降低该值（S3 最低为 5 MiB），
对新建上传生效。已有会话固定 partSize，须另建传输才能采用新值；同时保持总片数不超过 10000。
未配置持久 state 目录时仍不承诺跨重启恢复；legacy single PUT 保留整件重传行为，checkpoint 尚无自动 GC。


每次 multipart part URL 申请现在独立生成 `correlation_id`，同时提交固定 `upload_id`；
`request_id` 继续表示 Server 管理的 transfer，不能由关联 ID 替代。
Server 核对登录 Agent、当前 pending uploadId 后回显关联 ID 和 uploadId，Agent 仅接受三者均匹配的本轮响应。
同一 transfer 超时重试、URL 续签或重派后的迟到响应不会消费新 pending；超时和取消只清理自身请求及监听器。
Server 仍兼容未提供新增字段的旧 Agent，按原有 transfer 查表授权；旧 Agent 不具备此响应隔离保证。
新 Agent 连接未支持回显字段的旧 Server 时会拒绝不带关联 ID 的响应并超时失败，升级时应先部署 Server，
不能通过降级接收旧响应来跨 uploadId 使用票据。

Sandbox artifact 持久化与普通工作流结果发布现在共用持久传输等待逻辑：先创建并核对 `file_transfers` 行，
再启动上传，使 `PgTransferSessionStore` 能保存 multipart session。Sandbox 使用 artifact/replica 派生的独立稳定
transfer UUID，重试复用同一行与 uploadId；成功回执需保存后才返回，并继续按实际 NetDrive 对象比对路径、大小与 SHA-256。
取消等待只结束当前等待者，不主动销毁可恢复上传；已取消的行或改变的 owner/source/target/Agent/job/run 绑定拒绝复用。
这些操作不重新提交计算任务；未在本轮执行真实 PostgreSQL 或 Sandbox 运行环境验收。

普通 Workflow 的逐文件传输由[输出发布 outbox](workflow-output-recovery.md)持久关联；后台恢复已入库的 publication，不要求用户另起手动传输。文件提交与计算完成分别观察，文件恢复不会续跑已失败的 DAG。

工作流单文件发布在上传前重新读取已完成的持久映射，校验所有者、未删除状态、大小与摘要后复用，避免延迟请求携带旧快照重复上传。文件已删除时允许重新发布；已有有效引用保持稳定。

同一 transfer 重试时，Server 会清理上一轮超时计时器，并按当前 entry 身份过滤已经排队的旧 timeout；旧轮次的异步 complete/abort 收尾也不能清除新轮次的 active/pending 映射或回报旧终态。该进程内保护与持久 uploadId/completion 绑定共同使用，不以重新提交计算规避传输失败。
