use std::sync::Arc;

use alice_architecture::repository::DbField;
use anyhow::Context;
use async_trait::async_trait;
use domain_workflow::{
    model::{
        entity::{node_instance::NodeInstanceStatus, task::DbTask},
        vo::{
            msg::NodeInstanceStatusChangeInfo,
            task_dto::result::{TaskResult, TaskResultStatus},
        },
    },
    repository::TaskRepo,
    service::{QueueResourceService, StatusChangeHandleService, TaskService},
};
use uuid::Uuid;

pub struct TaskStatusChangeHandleService {
    task_repo: Arc<dyn TaskRepo>,
    queue_resource_service: Arc<dyn QueueResourceService>,
    node_instance_status_change_handle_service:
        Arc<dyn StatusChangeHandleService<ChangeInfo = NodeInstanceStatusChangeInfo>>,
    task_service: Arc<dyn TaskService>,
    /// The id of reqwesting agent(queue).
    queue_id: Option<Uuid>,
}

#[async_trait]
impl StatusChangeHandleService for TaskStatusChangeHandleService {
    type ChangeInfo = TaskResult;

    /// Handle the status change.
    async fn handle(&self, result: Self::ChangeInfo) -> anyhow::Result<()> {
        // Firstly, update task status.
        self.task_repo
            .update(&DbTask {
                id: DbField::Set(result.id),
                status: DbField::Set(result.status.to_owned().into()),
                ..Default::default()
            })
            .await?;

        // Get node_instance id.
        let task = self.task_repo.get_by_id(result.id).await?;
        let node_instance_id = task.node_instance_id;

        // Handle task status change.
        match result.status {
            TaskResultStatus::Queued => {
                // Do nothing, wait for agent sending next task result.

                return Ok(());
            }
            TaskResultStatus::Started => {
                // Notify queue resource manager task started.
                // Then notify NodeStatusChangeHandleService to handle status change to Running.

                self.queue_resource_service
                    .task_started(
                        self.queue_id
                            .context("No queue id when receive status service need it.")?,
                    )
                    .await?;
                self.node_instance_status_change_handle_service
                    .handle(NodeInstanceStatusChangeInfo {
                        id: node_instance_id,
                        status: NodeInstanceStatus::Running,
                    })
                    .await?;
            }
            TaskResultStatus::Completed => {
                // Firstly, get all tasks belongs to the node_instance_id, and judge they are all not
                // running.
                // If so, means that the last running tasks are all done. Then notify task service
                // to run the next tasks.
                // If all tasks in the node_instance_id are done, update the node_instance to
                // Completed.
            }
            TaskResultStatus::Failed => todo!(),
            TaskResultStatus::Paused => todo!(),
            TaskResultStatus::Continued => todo!(),
            TaskResultStatus::Deleted => todo!(),
        }
        todo!();
    }
}
