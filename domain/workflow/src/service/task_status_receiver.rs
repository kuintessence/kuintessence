use async_trait::async_trait;

use crate::model::vo::task_dto::result::TaskResult;

#[async_trait]
/// Receive task status and send it to task scheduler.
pub trait TaskStatusReceiveService: Send + Sync {
    /// Receive task result and send to task scheduler.
    async fn receive_status(&self, result: TaskResult) -> anyhow::Result<()>;
}
