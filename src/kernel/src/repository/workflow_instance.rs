use crate::prelude::*;
use alice_architecture::repository::IDBRepository;

#[async_trait]
pub trait IWorkflowInstanceRepository: IDBRepository<WorkflowInstance> {
    /// 根据节点 id 获取工作流实例
    async fn get_by_node_id(&self, node_id: Uuid) -> anyhow::Result<WorkflowInstance>;
    /// Update node_instance prepared upload using file meta id,
    /// because in the case when file is uploading via node instance,
    /// but a flash upload occured, will cause different meta id between prepared and recorded.
    async fn update_node_instance_prepared_file_ids(
        &self,
        old_id: Uuid,
        new_id: Uuid,
        node_instance_id: Uuid,
    ) -> Anyhow;
}
