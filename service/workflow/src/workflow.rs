use std::sync::Arc;

use alice_architecture::repository::{DBRepository, ReadOnlyRepository};
use async_trait::async_trait;
use domain_storage::model::entity::FileMeta;
use domain_workflow::{
    exception::{WorkflowException, WorkflowResult},
    model::{
        entity::{
            node_instance::NodeInstanceStatus, workflow_draft::WorkflowDraftSpec,
            workflow_instance::WorkflowInstanceStatus, WorkflowDraft, WorkflowInstance,
        },
        vo::schedule::ScheduleMode,
    },
    repository::NodeInstanceRepo,
    service::{WorkflowScheduleService, WorkflowService},
};
use typed_builder::TypedBuilder;
use uuid::Uuid;

#[derive(TypedBuilder)]
pub struct WorkflowServiceImpl {
    workflow_draft_repository: Arc<dyn ReadOnlyRepository<WorkflowDraft>>,
    workflow_instance_repository: Arc<dyn DBRepository<WorkflowInstance>>,
    node_instance_repository: Arc<dyn NodeInstanceRepo>,
    file_metadata_repository: Arc<dyn ReadOnlyRepository<FileMeta>>,
    workflow_schedule_service: Arc<dyn WorkflowScheduleService>,
}

#[async_trait]
impl WorkflowService for WorkflowServiceImpl {
    async fn submit_workflow(&self, id: Uuid) -> WorkflowResult<Uuid> {
        let workflow_draft = self.workflow_draft_repository.get_by_id(id).await?;
        let spec = &workflow_draft.spec;
        self.validate_workflow_draft(spec).await?;
        let workflow_instance = WorkflowInstance::from(workflow_draft);
        let node_instances = workflow_instance.parse_node_instances().await?;
        self.workflow_instance_repository.insert(&workflow_instance).await?;
        for node_instance in node_instances.into_iter() {
            self.node_instance_repository.insert(&node_instance).await?;
        }
        self.node_instance_repository.save_changed().await?;
        Ok(workflow_instance.id)
    }

    async fn validate(&self, id: Uuid) -> WorkflowResult<()> {
        let workflow_draft = self.workflow_draft_repository.get_by_id(id).await?;
        self.validate_workflow_draft(&workflow_draft.spec).await
    }

    async fn start_workflow(&self, id: Uuid) -> WorkflowResult<()> {
        let mut workflow_instance =
            self.workflow_instance_repository.get_by_id(id).await?;
        let mut node_instances = self
            .node_instance_repository
            .get_all_workflow_instance_nodes(workflow_instance.id)
            .await?;
        workflow_instance.status = WorkflowInstanceStatus::Pending;
        self.workflow_instance_repository.update(&workflow_instance).await?;
        for node_instance in node_instances.iter_mut() {
            node_instance.status = NodeInstanceStatus::Pending;
            self.node_instance_repository.update(node_instance).await?;
        }
        self.workflow_instance_repository.save_changed().await?;
        self.workflow_schedule_service
            .schedule_next_nodes(ScheduleMode::WorkflowInstanceId(id))
            .await?;
        Ok(())
    }

    async fn pause_workflow(&self, id: Uuid) -> WorkflowResult<()> {
        Ok(self.workflow_schedule_service.pause_workflow(id).await?)
    }

    async fn continue_workflow(&self, id: Uuid) -> WorkflowResult<()> {
        Ok(self.workflow_schedule_service.continue_workflow(id).await?)
    }

    async fn terminate_workflow(&self, id: Uuid) -> WorkflowResult<()> {
        Ok(self.workflow_schedule_service.terminate_workflow(id).await?)
    }
}

impl WorkflowServiceImpl {
    /// 验证工作流草稿逻辑
    ///
    /// 须同时满足以下条件：
    /// 1. 节点依赖中提及的节点必须存在
    /// 2. 插槽依赖中提及的插槽必须存在
    /// 3. 文本输出只能对应文本输入，文件输出只能对应文件输入
    /// 5. MatchRegex 类型批量输入必须等于 1
    /// 6. 调度策略 Manual 和 Prefer 至少选一个队列
    /// 7. 所有输入文件必须在 FileMeta 表中存在
    async fn validate_workflow_draft(&self, data: &WorkflowDraftSpec) -> WorkflowResult<()> {
        if data.node_drafts.is_empty() {
            return Err(WorkflowException::EmptyNodeDrafts);
        }
        let relied_input_slots = data.validate_related_nodes().await?;
        data.validate_per_node(relied_input_slots, self.file_metadata_repository.to_owned())
            .await?;
        Ok(())
    }
}
