use std::sync::Arc;

use async_trait::async_trait;
use domain_workflow::{
    model::vo::{msg::TaskChangeInfo, task_dto::result::TaskResult},
    service::{ScheduleService, TaskStatusReceiveService},
};
use typed_builder::TypedBuilder;

#[derive(TypedBuilder)]
pub struct TaskStatusReceiveServiceImpl {
    task_schedule_service: Arc<dyn ScheduleService<Info = TaskChangeInfo>>,
}

#[async_trait]
impl TaskStatusReceiveService for TaskStatusReceiveServiceImpl {
    /// Receive task result.
    async fn receive_status(&self, result: TaskResult) -> anyhow::Result<()> {
        self.task_schedule_service
            .handle_changed(
                result.id,
                TaskChangeInfo {
                    status: result.status.into(),
                    ..Default::default()
                },
            )
            .await
    }
}
