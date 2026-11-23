# Multipart 最终提交恢复

Server 在调用对象存储 complete 前，将 Agent 的最终 size、sha256、parts 保存在原传输的 `resume_session.completion`。失败保留会话；恢复同一传输时先重新检查归属、Agent 和集群根授权，再重放完成请求。已有匹配的完成回执时，恢复接口仍复查原 Agent 的登记和当前集群根目录授权，但无需连接 Agent 检查源文件。即使 Agent 已离线或源文件已经归档，也可以重放最终提交。若回执在恢复期间消失，本次恢复会失败。其余上传仍需在线检查源文件。

会话保存通过传输行的 `SELECT FOR UPDATE` 串行化：绑定字段不可变化，completion 只能首次写入或原样重试；旧进程保存不含 completion 的会话时保留既有完成回执，并将合并结果返回 dispatcher，直接进入完成重放。显式取消才会清空会话；已取消行拒绝后续写回。

最终提交按 storageKey 获取 PostgreSQL 事务锁。已提交记录必须匹配 owner、path、size、sha256、contentType 且未删除，才返回原 file id；不会重复创建记录或授权 outbox。新文件、被替换文件的状态、授权变更和上传流量在同一事务中提交。授权或记账失败会回滚元数据，重放成功的提交只计一次上传量。

对象 complete 已成功但响应丢失或数据库事务回滚时，恢复通过 head 和流式 sha256 校验对象，再提交元数据；仅 size 相同不足以认定成功。提交成功仍保留 completion，覆盖传输最终状态落库前崩溃的窗口。sha256 不匹配、绑定变化会明确失败；底层 SDK/数据库异常向用户返回 `MULTIPART_FINALIZATION_RETRY_REQUIRED`，不会显示底层 URL。

部署前须完成数据库迁移并保留对象存储的未完成分片会话。恢复时，Server 复查授权与原内容绑定后签发提交凭证。

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

主机 Agent 为带可信摘要的下载登记它创建的部分文件。Agent 启动时和随后每小时从本地 SQLite 检查最多 64 条超过七天未使用的记录。续传和中断会刷新保留期。回收前复核父目录、文件身份、权限和独占锁；正在写入、已替换或在中断后被修改的文件会保留。未登记的同名文件留在原处。若文件系统没有提供创建时间，Agent 在写入时异常退出后可能无法确认文件身份，此时保留文件。没有可用的 `flock` 命令时，下载仍可续传，这些文件留给人工清理。

部分文件回收后再次恢复同一下载，会从头获取内容并核对完整摘要。容器下载在临时目录校验 Server 下发的大小和摘要后发布，跨重启的 Range 恢复适用于主机上有内容绑定的下载。

工作流输入的两条路径也传递已授权 NetDrive 文件的 SHA-256 与大小：Server 直接触发的 `createFileStager`，
以及 Agent 管理工作目录时的 `InputStaging.total_bytes/expected_sha256`。主机 Agent 使用同一下载器保留摘要绑定部分文件、
按 Range 恢复并在整文件校验后发布；任务输入下载使用 Agent 生命周期取消信号，退出时保留部分文件。
Server 在下发下载 URL 和内容绑定前复查授权。只有提供可信摘要的主机下载才登记可回收的部分文件。

容器模式使用提交调度作业的账号创建工作目录和暂存输入文件，作业可直接读取自己的输入。

容器来源的 multipart 上传现在与主机上传使用相同的持久 checkpoint（需配置 Agent 的 transfer state 目录），
绑定稳定的 transfer_id、upload_id、对象大小、partSize 和每个完成 part 的 SHA-256/ETag。
Agent 重启或重派后仍须重新读取容器并生成独立 spool，再逐片重算哈希；只有记录匹配的 part 才跳过上传，
源文件内容或大小变化会拒绝复用。同一 checkpoint 的写入在 Agent 进程内串行，取消排队不会跳过前一个写入者；
每次请求使用独立临时 spool 并仅删除自身文件，已取消请求不再上报旧终态。
part PUT 每次尝试有 5 分钟总期限，网络停滞或取消后保留已完成 checkpoint，重派可用新 URL 继续缺失 part。
该期限不是随进度刷新的空闲期限；低于完成一整个 part 所需带宽的链路仍可能失败。Server 默认
`NETDRIVE_MULTIPART_PART_SIZE_MB=64`，每片须在期限内传完；较慢站点可由部署方降低该值（S3 最低为 5 MiB），
对新建上传生效。已有会话固定 partSize，须另建传输才能采用新值；同时保持总片数不超过 10000。
配置持久 state 目录后，Agent 通过在线心跳每批核对最多 64 个本地上传断点文件。Server 查询 PostgreSQL 中属于该 Agent 的传输，只对已成功或已取消的上传确认回收。Agent 核对心跳序号、文件身份和本地写入状态后删除对应断点及遗留的临时记录。断线、等待重试、Server 缺少归属记录或确认丢失时保留断点，每轮目录扫描结束后一小时再复查。

每次 multipart part URL 申请现在独立生成 `correlation_id`，同时提交固定 `upload_id`；
每次派发生成独立的 `request_id`，用于关联进度、分片 URL 和取消确认。重试复用的 `transfer_id` 用于查找上传断点。
Server 核对登录 Agent、当前 pending uploadId 后回显关联 ID 和 uploadId，Agent 仅接受三者均匹配的当前请求的响应。
同一 transfer 超时重试、URL 续签或重派后的迟到响应不会消费新 pending；超时和取消只清理自身请求及监听器。
Agent 会丢弃缺少关联 ID 的响应，等待本次请求的有效响应直至超时。

Sandbox artifact 持久化与普通工作流结果发布现在共用持久传输等待逻辑：先创建并核对 `file_transfers` 行，
再启动上传，使 `PgTransferSessionStore` 能保存 multipart session。Sandbox 使用 artifact、replica 和批内成员路径派生的稳定
transfer UUID，重试复用同一行与 uploadId；成功回执需保存后才返回，并继续按实际 NetDrive 对象比对路径、大小与 SHA-256。
调用方中断等待后，持有租约的 Server 仍会保存 Agent 的完成回执。下一次发布可直接取回文件 ID。派发失败时释放租约，其他 Server 可用同一条传输记录重试。已取消的行或改变的 owner/source/target/Agent/job/run 绑定拒绝复用。
这些操作只恢复原文件传输，不重新提交计算任务。

普通 Workflow 的逐文件传输由[输出发布 outbox](workflow-output-recovery.md)持久关联；后台恢复已入库的 publication，不要求用户另起手动传输。文件提交与计算完成分别观察，文件恢复不会续跑已失败的 DAG。

Sandbox 文件已上传、产物映射尚未写入时，Server 可从同一工作流和生产作业的成功传输回执重建映射。恢复时逐项核对所有者、Agent、源副本记录、目标路径、NetDrive 文件 ID、大小和 SHA-256。本地副本已过期时仍可复用已确认的文件；批次里缺少回执的成员须等到有可用源副本才能补传。

如果 NetDrive 已保存文件，而 Server 在写入传输成功状态前重启，工作流会用原上传会话的对象键、目标路径、字节数和 SHA-256 核对仍可用的文件。核对通过后，Server 补记原传输的成功回执并复用同一文件 ID。正在派发或取消的传输由持有租约的 Server 处理，已取消的传输保持终态。

检查点恢复和持久产物登记都会检查单文件或批内各成员是否仍在 NetDrive 中。文件移入回收站后，只重新发布缺失的文件，其他成员保留原文件 ID。

Server 写入用户传输的进度和终态时，数据库同时核对运行状态与本轮启动时间。取消后到达的进度写入、重试后才结束的上一轮回调都会被忽略。

同一 transfer 重试时，Server 会清理上一轮超时计时器，并按当前 entry 身份过滤已经排队的旧 timeout；旧轮次的异步 complete/abort 收尾也不能清除新轮次的 active/pending 映射或回报旧终态。该进程内保护与持久 uploadId/completion 绑定共同使用，不以重新提交计算规避传输失败。
