use alice_architecture::repository::{DBRepository, MutableRepository, ReadOnlyRepository};
use async_trait::async_trait;
use mockall::mock;
use uuid::Uuid;

use crate::{
    model::entity::{
        task::Task,
        workflow_instance::{DbWorkflowInstance, NodeSpec},
        NodeInstance, Queue, WorkflowDraft, WorkflowInstance,
    },
    repository::{NodeInstanceRepo, TaskRepo, WorkflowInstanceRepo},
};

mock! {
    pub WorkflowInstanceRepo {}
    #[async_trait]
    impl WorkflowInstanceRepo for WorkflowInstanceRepo{
        async fn get_by_node_id(&self, node_id: Uuid) -> anyhow::Result<WorkflowInstance>;
        async fn update_immediately_with_lock(&self, entity: DbWorkflowInstance) -> anyhow::Result<()>;
    }
    impl DBRepository<WorkflowInstance> for WorkflowInstanceRepo {}
    impl ReadOnlyRepository<WorkflowInstance> for WorkflowInstanceRepo {}
    impl MutableRepository<WorkflowInstance> for WorkflowInstanceRepo {}
}

mock! {
    pub NodeInstanceRepo {}
    #[async_trait]
    impl NodeInstanceRepo for NodeInstanceRepo {
        async fn get_node_sub_node_instances(
            &self,
            batch_parent_id: Uuid,
        ) -> anyhow::Result<Vec<NodeInstance>>;
        async fn is_all_same_entryment_nodes_success(&self, node_id: Uuid) -> anyhow::Result<bool>;
        async fn get_all_workflow_instance_stand_by_nodes(
            &self,
            workflow_instance_id: Uuid,
        ) -> anyhow::Result<Vec<NodeInstance>>;
        async fn get_all_workflow_instance_nodes(
            &self,
            workflow_instance_id: Uuid,
        ) -> anyhow::Result<Vec<NodeInstance>>;
        async fn get_nth_of_batch_tasks(&self, sub_node_id: Uuid) -> anyhow::Result<usize>;
        async fn get_node_spec(&self, node_id: Uuid) -> anyhow::Result<NodeSpec>;
    }
    impl DBRepository<NodeInstance> for NodeInstanceRepo {}
    impl ReadOnlyRepository<NodeInstance> for NodeInstanceRepo {}
    impl MutableRepository<NodeInstance> for NodeInstanceRepo {}
}

mock! {
    pub QueueRepo {}
    impl ReadOnlyRepository<Queue> for QueueRepo {}
}

mock! {
    pub TaskRepo {}
    #[async_trait]
    impl TaskRepo for TaskRepo {
        async fn get_same_node_tasks(&self, task_id: Uuid) -> anyhow::Result<Vec<Task>>;
        async fn get_tasks_by_node_id(&self, node_id: Uuid) -> anyhow::Result<Vec<Task>>;
    }
    impl DBRepository<Task> for TaskRepo {}
    impl ReadOnlyRepository<Task> for TaskRepo {}
    impl MutableRepository<Task> for TaskRepo {}
}

mock! {
    pub WorkflowDraftRepo {}
    impl ReadOnlyRepository<WorkflowDraft> for WorkflowDraftRepo {}
}
