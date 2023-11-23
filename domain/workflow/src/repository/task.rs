use alice_architecture::repository::DBRepository;
use uuid::Uuid;

use crate::model::entity::task::Task;

#[async_trait::async_trait]
pub trait TaskRepo: Send + Sync + DBRepository<Task> {
    /// Get tasks within the same node_instance as provided task id.
    async fn get_same_node_tasks(&self, task_id: Uuid) -> anyhow::Result<Vec<Task>>;

    /// Get tasks with node_id.
    async fn get_tasks_by_node_id(&self, node_id: Uuid) -> anyhow::Result<Vec<Task>>;
}
