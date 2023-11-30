use std::sync::Arc;

use alice_architecture::{
    message_queue::producer::MessageQueueProducerTemplate,
    repository::{MutableRepository, ReadOnlyRepository},
};
use async_trait::async_trait;
use domain_storage::model::entity::FileMeta;
use domain_workflow::{
    exception::{WorkflowException, WorkflowResult},
    model::{
        entity::{
            workflow_draft::WorkflowDraftSpec, NodeInstance, WorkflowDraft, WorkflowInstance,
        },
        vo::msg::{ChangeMsg, FlowStatusChange, Info},
    },
    service::ControlService,
};
use uuid::Uuid;

#[derive(typed_builder::TypedBuilder)]
pub struct ControlServiceImpl {
    draft_repo: Arc<dyn ReadOnlyRepository<WorkflowDraft>>,
    instance_repo: Arc<dyn MutableRepository<WorkflowInstance>>,
    node_repo: Arc<dyn MutableRepository<NodeInstance>>,
    file_meta_repo: Arc<dyn ReadOnlyRepository<FileMeta>>,
    status_mq_producer: Arc<dyn MessageQueueProducerTemplate<ChangeMsg>>,
    status_mq_topic: String,
}

#[async_trait]
impl ControlService for ControlServiceImpl {
    async fn submit(&self, draft_id: Uuid) -> WorkflowResult<Uuid> {
        let draft = self.draft_repo.get_by_id(draft_id).await?;
        let spec = &draft.spec;
        self.validate_workflow_draft(spec).await?;
        let instance = WorkflowInstance::from(draft);
        self.instance_repo.insert(&instance).await?;
        let nodes = instance.parse_node_instances().await?;
        self.node_repo.insert_list(&nodes).await?;
        self.node_repo.save_changed().await?;
        Ok(instance.id)
    }
    async fn start(&self, instance_id: Uuid) -> WorkflowResult<()> {
        self.status_mq_producer
            .send_object(
                &ChangeMsg {
                    id: instance_id,
                    info: Info::Flow(FlowStatusChange::Pending),
                },
                Some(&self.status_mq_topic),
            )
            .await?;
        Ok(())
    }

    async fn pause(&self, instance_id: Uuid) -> WorkflowResult<()> {
        self.status_mq_producer
            .send_object(
                &ChangeMsg {
                    id: instance_id,
                    info: Info::Flow(FlowStatusChange::Pausing),
                },
                Some(&self.status_mq_topic),
            )
            .await?;
        Ok(())
    }

    async fn resume(&self, instance_id: Uuid) -> WorkflowResult<()> {
        self.status_mq_producer
            .send_object(
                &ChangeMsg {
                    id: instance_id,
                    info: Info::Flow(FlowStatusChange::Resuming),
                },
                Some(&self.status_mq_topic),
            )
            .await?;
        Ok(())
    }

    async fn terminate(&self, instance_id: Uuid) -> WorkflowResult<()> {
        self.status_mq_producer
            .send_object(
                &ChangeMsg {
                    id: instance_id,
                    info: Info::Flow(FlowStatusChange::Terminating),
                },
                Some(&self.status_mq_topic),
            )
            .await?;
        Ok(())
    }

    async fn validate(&self, draft_id: Uuid) -> WorkflowResult<()> {
        let draft = self.draft_repo.get_by_id(draft_id).await?;
        let spec = &draft.spec;
        self.validate_workflow_draft(spec).await
    }
}
impl ControlServiceImpl {
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
        data.validate_per_node(relied_input_slots, self.file_meta_repo.to_owned())
            .await?;
        Ok(())
    }
}
