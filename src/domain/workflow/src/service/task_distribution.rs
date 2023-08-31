use alice_architecture::utils::*;

use crate::model::entity::Task;

#[async_trait]
pub trait TaskDistributionService: Send + Sync {
    /// 分发任务
    ///
    /// # 参数
    ///
    /// * `task` - 任务
    /// * `queue_id` - 队列 id
    async fn send_task(&self, task: &Task, queue_id: Uuid) -> anyhow::Result<()>;
}
