use std::sync::Arc;

use anyhow::Context;
use async_trait::async_trait;
use domain_workflow::{
    model::vo::{msg::TaskChangeInfo, task_dto::result::TaskResult},
    service::{QueueResourceService, ScheduleService, TaskStatusReceiveService},
};
use typed_builder::TypedBuilder;
use uuid::Uuid;

#[derive(TypedBuilder)]
pub struct TaskStatusReceiveServiceImpl {
    task_schedule_service: Arc<dyn ScheduleService<Info = TaskChangeInfo>>,
    queue_resource_service: Arc<dyn QueueResourceService>,
    queue_id: Option<Uuid>,
}

#[async_trait]
impl TaskStatusReceiveService for TaskStatusReceiveServiceImpl {
    /// Receive task result.
    async fn receive_status(&self, result: TaskResult) -> anyhow::Result<()> {
        match result.status.try_into() {
            Ok(status) => {
                self.task_schedule_service
                    .handle_changed(
                        result.id,
                        TaskChangeInfo {
                            status,
                            ..Default::default()
                        },
                    )
                    .await?
            }
            Err(_) => {
                self.queue_resource_service
                    .task_started(
                        self.queue_id
                            .context("No queue id when TaskStatusReceiveSerrvice use it")?,
                    )
                    .await?
            }
        }
        Ok(())
    }
}
