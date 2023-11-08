use alice_architecture::repository::DBRepository;
use uuid::Uuid;

use crate::model::entity::task::Task;

#[async_trait::async_trait]
pub trait TaskRepo: Send + Sync + DBRepository<Task> {
    /// Get tasks within the same node_instance as provided task id.
    async fn get_same_node_tasks(&self, task_id: String) -> anyhow::Result<Vec<Task>>;
    /// Get task queue_id.
    async fn get_queue_topic(&self, task_id: String) -> anyhow::Result<String>;
}
