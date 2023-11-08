use std::sync::Arc;

use async_trait::async_trait;
use domain_workflow::{
    model::vo::task_dto::result::TaskResult,
    service::{StatusChangeHandleService, TaskStatusReceiveService},
};
use typed_builder::TypedBuilder;

#[derive(TypedBuilder)]
pub struct TaskStatusReceiveServiceImpl {
    task_status_change_handle_service: Arc<dyn StatusChangeHandleService<ChangeInfo = TaskResult>>,
    // node_instance_status_service: Arc<dyn StatusChangeHandleService<Status = NodeInstanceStatus>>,
    // node_instance_repository: Arc<dyn NodeInstanceRepo>,
    // workflow_instance_repository: Arc<dyn WorkflowInstanceRepo>,
    // task_repo: Arc<dyn TaskRepo>,
    // schedule_service: Arc<dyn WorkflowScheduleService>,
    // mq_producer: Arc<dyn MessageQueueProducerTemplate<Uuid>>,
    // queue_resource_service: Arc<dyn QueueResourceService>,
    // bill_topic: String,
    // queue_id: Option<Uuid>,
}

#[async_trait]
impl TaskStatusReceiveService for TaskStatusReceiveServiceImpl {
    /// Receive task result.
    async fn receive_status(&self, result: TaskResult) -> anyhow::Result<()> {
        self.task_status_change_handle_service.handle(result).await
    }
}
// #[async_trait]
// impl TaskStatusReceiveService for TaskStatusReceiveServiceImpl {
//     async fn receive_status(&self, result: TaskResult) -> anyhow::Result<()> {
//         // Update status to queuing and return.
//         self.task_repo
//             .update(&DbTask {
//                 id: DbField::Set(result.id),
//                 status: DbField::Set(result.status.into()),
//                 ..Default::default()
//             })
//             .await?;
//         self.task_repo.save_changed().await?;
//
//         let task = self.task_repo.get_by_id(result.id).await?;
//         match result.status {
//             TaskResultStatus::Started => {
//                 // Update node instance status the task belongs.
//                 // Handle it with `queue_resource_service` and return.
//                 self.node_instance_repository
//                     .update(&DbNodeInstance {
//                         id: DbField::Set(task.node_instance_id),
//                         status: DbField::Set(NodeInstanceStatus::Running),
//                         ..Default::default()
//                     })
//                     .await?;
//                 self.queue_resource_service
//                     .task_started(
//                         self.queue_id
//                             .context("No queue id when receive status service need it.")?,
//                     )
//                     .await?;
//                 return Ok(());
//             }
//             TaskResultStatus::Queued => {
//                 // Do nothing.
//                 // Waitting agent to request.
//                 return Ok(());
//             }
//             TaskResultStatus::Completed => {
//                 // Judge if there isn't any task in the same node_instance is running.
//                 // Then calculate the next runnable tasks and send to agent.
//                 self.handle_completed(result).await?;
//             }
//             TaskResultStatus::Failed => {
//                 self.node_instance_repository
//                     .update(&DbNodeInstance {
//                         id: DbField::Set(task.node_instance_id),
//                         status: DbField::Set(NodeInstanceStatus::Failed),
//                         ..Default::default()
//                     })
//                     .await?;
//             }
//             TaskResultStatus::Paused => todo!(),
//             TaskResultStatus::Continued => todo!(),
//             TaskResultStatus::Deleted => todo!(),
//         };
//
//         let mut node_instance = self.node_instance_repository.get_by_id(result.id).await?;
//         node_instance.log = result.message;
//         node_instance.resource_meter = result.used_resources.map(|r| r.into());
//         node_instance.status = match result.status {
//             TaskResultStatus::Completed => NodeInstanceStatus::Completed,
//             TaskResultStatus::Continued => NodeInstanceStatus::Running,
//             TaskResultStatus::Paused => NodeInstanceStatus::Paused,
//             TaskResultStatus::Failed => NodeInstanceStatus::Failed,
//             TaskResultStatus::Deleted => NodeInstanceStatus::Stopped,
//             TaskResultStatus::Started => bail!("Start status is not allowed here"),
//             TaskResultStatus::Queued => todo!(),
//         };
//         let mut workflow_instance = self
//             .workflow_instance_repository
//             .get_by_id(node_instance.flow_instance_id)
//             .await?;
//         let stopping_node_count = self
//             .node_instance_repository
//             .get_all_workflow_instance_nodes(workflow_instance.id)
//             .await?
//             .iter()
//             .filter(|el| matches!(el.status, NodeInstanceStatus::Stopping))
//             .count();
//         let pausing_node_count = self
//             .node_instance_repository
//             .get_all_workflow_instance_nodes(workflow_instance.id)
//             .await?
//             .iter()
//             .filter(|el| matches!(el.status, NodeInstanceStatus::Pausing))
//             .count();
//         let recovering_node_count = self
//             .node_instance_repository
//             .get_all_workflow_instance_nodes(workflow_instance.id)
//             .await?
//             .iter()
//             .filter(|el| matches!(el.status, NodeInstanceStatus::Recovering))
//             .count();
//         self.node_instance_repository.update(&node_instance).await?;
//         self.node_instance_repository.save_changed().await?;
//
//         match result.status {
//             TaskResultStatus::Completed => {
//                 self.mq_producer.send_object(&result.id, Some(&self.bill_topic)).await?;
//                 self.schedule_service
//                     .schedule_next_nodes(ScheduleMode::NodeInstanceId(result.id))
//                     .await?;
//             }
//             TaskResultStatus::Failed => {
//                 workflow_instance.status = WorkflowInstanceStatus::Error;
//                 self.workflow_instance_repository.update(&workflow_instance).await?;
//             }
//             TaskResultStatus::Deleted => {
//                 if stopping_node_count - 1 == 0 {
//                     workflow_instance.status = WorkflowInstanceStatus::Stopped;
//                     self.workflow_instance_repository.update(&workflow_instance).await?;
//                 }
//             }
//             TaskResultStatus::Paused => {
//                 if pausing_node_count - 1 == 0 {
//                     workflow_instance.status = WorkflowInstanceStatus::Paused;
//                     self.workflow_instance_repository.update(&workflow_instance).await?;
//                 }
//             }
//             TaskResultStatus::Continued => {
//                 if recovering_node_count - 1 == 0 {
//                     workflow_instance.status = WorkflowInstanceStatus::Running;
//                     self.workflow_instance_repository.update(&workflow_instance).await?;
//                 }
//             }
//             TaskResultStatus::Started => bail!("Start status is not allowed here"),
//             TaskResultStatus::Queued => todo!(),
//         }
//
//         self.workflow_instance_repository.save_changed().await?;
//         Ok(())
//     }
// }
