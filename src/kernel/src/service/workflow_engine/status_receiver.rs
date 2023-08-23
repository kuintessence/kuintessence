use crate::prelude::*;

#[async_trait]
/// 工作流状态更新微服务
pub trait IWorkflowStatusReceiverService {
    /// 接收节点状态
    /// 输入 节点 Id、节点状态
    /// 输出 Ok
    async fn receive_node_status(&self, result: TaskResult) -> anyhow::Result<()>;
}
