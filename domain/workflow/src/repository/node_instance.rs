use alice_architecture::repository::DBRepository;
use async_trait::async_trait;
use uuid::Uuid;

use crate::model::entity::{
    node_instance::DbNodeInstance, workflow_instance::NodeSpec, NodeInstance,
};

#[async_trait]
pub trait NodeInstanceRepo: DBRepository<NodeInstance> + Send + Sync {
    /// 根据批量父节点 id 获取所有批量子节点信息
    async fn get_node_sub_node_instances(
        &self,
        batch_parent_id: Uuid,
    ) -> anyhow::Result<Vec<NodeInstance>>;

    /// 同批次节点状态是否全部成功
    async fn is_all_same_entryment_nodes_success(&self, node_id: Uuid) -> anyhow::Result<bool>;

    /// 获取某工作流实例的正在待命的节点
    async fn get_all_workflow_instance_stand_by_nodes(
        &self,
        workflow_instance_id: Uuid,
    ) -> anyhow::Result<Vec<NodeInstance>>;

    /// 获取某工作流实例的全部节点
    async fn get_all_workflow_instance_nodes(
        &self,
        workflow_instance_id: Uuid,
    ) -> anyhow::Result<Vec<NodeInstance>>;

    /// 获取批量任务是第几个
    async fn get_nth_of_batch_tasks(&self, sub_node_id: Uuid) -> anyhow::Result<usize>;

    async fn get_node_spec(&self, node_id: Uuid) -> anyhow::Result<NodeSpec>;

    /// For resource_meter update race.
    async fn update_immediately_with_lock(&self, entity: DbNodeInstance) -> anyhow::Result<()>;
}
