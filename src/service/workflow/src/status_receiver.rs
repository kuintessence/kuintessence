use std::sync::Arc;

use alice_architecture::IMessageQueueProducerTemplate;
use anyhow::bail;
use async_trait::async_trait;
use domain_workflow::{
    model::{
        entity::{
            node_instance::NodeInstanceStatus,
            task::{TaskResult, TaskResultStatus},
            workflow_instance::WorkflowInstanceStatus,
        },
        vo::schedule::ScheduleMode,
    },
    repository::{NodeInstanceRepo, WorkflowInstanceRepo},
    service::*,
};
use typed_builder::TypedBuilder;
use uuid::Uuid;

#[derive(TypedBuilder)]
pub struct WorkflowStatusReceiverServiceImpl {
    node_instance_repository: Arc<dyn NodeInstanceRepo>,
    workflow_instance_repository: Arc<dyn WorkflowInstanceRepo>,
    schedule_service: Arc<dyn WorkflowScheduleService>,
    mq_producer: Arc<dyn IMessageQueueProducerTemplate<Uuid> + Send + Sync>,
    queue_resource_service: Arc<dyn QueueResourceService>,
    bill_topic: String,
}

#[async_trait]
impl WorkflowStatusReceiverService for WorkflowStatusReceiverServiceImpl {
    async fn receive_node_status(&self, result: TaskResult) -> anyhow::Result<()> {
        if let TaskResultStatus::Start(id) = result.status {
            self.queue_resource_service.task_started(id.unwrap()).await?;
            return Ok(());
        }
        let mut node_instance =
            self.node_instance_repository.get_by_id(&result.id.to_string()).await?;
        node_instance.log = Some(result.message);
        node_instance.resource_meter = result.used_resources;
        node_instance.status = match result.status {
            TaskResultStatus::Success => NodeInstanceStatus::Finished,
            TaskResultStatus::Continued => NodeInstanceStatus::Running,
            TaskResultStatus::Paused => NodeInstanceStatus::Paused,
            TaskResultStatus::Failed => NodeInstanceStatus::Error,
            TaskResultStatus::Deleted => NodeInstanceStatus::Stopped,
            TaskResultStatus::Start(_) => bail!("Start status is not allowed here"),
        };
        let mut workflow_instance = self
            .workflow_instance_repository
            .get_by_id(&node_instance.flow_instance_id.to_string())
            .await?;
        let stopping_node_count = self
            .node_instance_repository
            .get_all_workflow_instance_nodes(workflow_instance.id)
            .await?
            .iter()
            .filter(|el| matches!(el.status, NodeInstanceStatus::Stopping))
            .count();
        let pausing_node_count = self
            .node_instance_repository
            .get_all_workflow_instance_nodes(workflow_instance.id)
            .await?
            .iter()
            .filter(|el| matches!(el.status, NodeInstanceStatus::Pausing))
            .count();
        let recovering_node_count = self
            .node_instance_repository
            .get_all_workflow_instance_nodes(workflow_instance.id)
            .await?
            .iter()
            .filter(|el| matches!(el.status, NodeInstanceStatus::Recovering))
            .count();
        self.node_instance_repository.update(node_instance.to_owned()).await?;
        self.node_instance_repository.save_changed().await?;

        match result.status {
            TaskResultStatus::Success => {
                self.mq_producer.send_object(&result.id, Some(&self.bill_topic)).await?;
                self.schedule_service
                    .schedule_next_nodes(ScheduleMode::NodeInstanceId(result.id))
                    .await?;
            }
            TaskResultStatus::Failed => {
                workflow_instance.status = WorkflowInstanceStatus::Error;
                self.workflow_instance_repository.update(workflow_instance).await?;
            }
            TaskResultStatus::Deleted => {
                if stopping_node_count - 1 == 0 {
                    workflow_instance.status = WorkflowInstanceStatus::Stopped;
                    self.workflow_instance_repository.update(workflow_instance).await?;
                }
            }
            TaskResultStatus::Paused => {
                if pausing_node_count - 1 == 0 {
                    workflow_instance.status = WorkflowInstanceStatus::Paused;
                    self.workflow_instance_repository.update(workflow_instance).await?;
                }
            }
            TaskResultStatus::Continued => {
                if recovering_node_count - 1 == 0 {
                    workflow_instance.status = WorkflowInstanceStatus::Running;
                    self.workflow_instance_repository.update(workflow_instance).await?;
                }
            }
            TaskResultStatus::Start(_) => bail!("Start status is not allowed here"),
        }

        self.workflow_instance_repository.save_changed().await?;
        Ok(())
    }
}
