use uuid::Uuid;

use crate::model::entity::Task;

#[async_trait::async_trait]
pub trait TaskSchedulerService: Send + Sync {
    async fn enqueue_task(&self, task: &Task) -> anyhow::Result<()>;
    async fn schedule_next_task(&self) -> anyhow::Result<()>;
    async fn schedule_next_task_by_id(&self, id: Uuid) -> anyhow::Result<()>;
    async fn pause_task(&self, id: &str) -> anyhow::Result<()>;
    async fn delete_task(&self, id: &str, is_internal: bool) -> anyhow::Result<()>;
    async fn continue_task(&self, id: &str) -> anyhow::Result<()>;
    async fn complete_sub_task(&self, id: &str) -> anyhow::Result<()>;
    async fn fail_sub_task(&self, id: &str) -> anyhow::Result<()>;
    async fn delete_all_completed_tasks(&self) -> anyhow::Result<()>;
}
