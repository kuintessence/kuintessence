use async_trait::async_trait;

use crate::model::vo::task_dto::result::TaskResult;

#[async_trait]
/// Scoped Service
/// Receive task status and do things.
pub trait TaskStatusReceiveService: Send + Sync {
    /// Receive task result.
    async fn receive_status(&self, result: TaskResult) -> anyhow::Result<()>;
}
