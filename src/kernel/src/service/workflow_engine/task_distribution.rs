use crate::prelude::*;

#[async_trait]
pub trait ITaskDistributionService {
    /// 分发任务
    ///
    /// # 参数
    ///
    /// * `task` - 任务
    /// * `cluster_id` - 集群 id
    async fn send_task(&self, task: &Task, cluster_id: Uuid) -> anyhow::Result<()>;
}
