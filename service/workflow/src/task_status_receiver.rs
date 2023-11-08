use std::sync::Arc;

use alice_architecture::repository::DbField;
use async_trait::async_trait;
use domain_workflow::{
    model::{
        entity::task::DbTask,
        vo::{msg::TaskChangeInfo, task_dto::result::TaskResult},
    },
    repository::TaskRepo,
    service::{ScheduleService, TaskStatusReceiveService},
};
use typed_builder::TypedBuilder;

#[derive(TypedBuilder)]
pub struct TaskStatusReceiveServiceImpl {
    task_repo: Arc<dyn TaskRepo>,
    task_schedule_service: Arc<dyn ScheduleService<Info = TaskChangeInfo>>,
}

#[async_trait]
impl TaskStatusReceiveService for TaskStatusReceiveServiceImpl {
    /// Receive task result.
    async fn receive_status(&self, result: TaskResult) -> anyhow::Result<()> {
        // Update task repo, then notify task schedule service to handle status changed.

        self.task_repo
            .update(&DbTask {
                id: DbField::Set(result.id),
                status: DbField::Set(result.status.to_owned().into()),
                message: match result.message {
                    m @ Some(_) => DbField::Set(m),
                    None => DbField::NotSet,
                },
                used_resources: match result.used_resources {
                    u @ Some(_) => DbField::Set(u.as_ref().map(serde_json::to_string).transpose()?),
                    None => DbField::NotSet,
                },
                ..Default::default()
            })
            .await?;
        self.task_repo.save_changed().await?;

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
