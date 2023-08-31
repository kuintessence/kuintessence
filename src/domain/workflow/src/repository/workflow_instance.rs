use alice_architecture::repository::IDBRepository;
use alice_architecture::utils::*;

use crate::model::entity::WorkflowInstance;

#[async_trait]
pub trait WorkflowInstanceRepo: IDBRepository<WorkflowInstance> + Send + Sync {
    /// 根据节点 id 获取工作流实例
    async fn get_by_node_id(&self, node_id: Uuid) -> anyhow::Result<WorkflowInstance>;

    /// 使用乐观锁更新工作流实例
    async fn update_immediately_with_lock(
        &self,
        entity: WorkflowInstance,
    ) -> anyhow::Result<WorkflowInstance>;
}
