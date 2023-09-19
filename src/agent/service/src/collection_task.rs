use domain::{
    model::{
        entity::{
            task::{CollectRule, TaskStatus, TaskType},
            SubTask,
        },
        vo::TaskDisplayType,
    },
    repository::ISubTaskRepository,
    sender::ISubTaskReportService,
    service::{FileLoadService, SubTaskService},
};

pub struct CollectionTaskServiceImpl {
    repo: std::sync::Arc<dyn ISubTaskRepository + Send + Sync>,
    report_service: std::sync::Arc<dyn ISubTaskReportService>,
    file_load_service: std::sync::Arc<dyn FileLoadService>,
}

#[async_trait::async_trait]
impl SubTaskService for CollectionTaskServiceImpl {
    async fn enqueue_sub_task(&self, id: &str) -> anyhow::Result<()> {
        let sub_task = self.repo.get_by_id(id).await?;
        match self.inner_run_sub_task(&sub_task).await {
            Ok(()) => {
                self.repo
                    .update(SubTask {
                        status: TaskStatus::Completed,
                        ..sub_task
                    })
                    .await?;
                self.repo.save_changed().await?;
                self.report_service.report_completed_task(id).await?;
            }
            Err(e) => {
                self.repo
                    .update(SubTask {
                        status: TaskStatus::Failed,
                        failed_reason: format!("Failed to collect value. Because of {e}"),
                        ..sub_task
                    })
                    .await?;
                self.repo.save_changed().await?;
                self.report_service.report_failed_task(id).await?;
                return Err(e);
            }
        }
        Ok(())
    }
    async fn delete_sub_task(&self, _id: &str) -> anyhow::Result<()> {
        Ok(())
    }
    async fn pause_sub_task(&self, _id: &str) -> anyhow::Result<()> {
        Ok(())
    }
    async fn continue_sub_task(&self, _id: &str) -> anyhow::Result<()> {
        Ok(())
    }
    async fn refresh_all_status(&self) -> anyhow::Result<()> {
        Ok(())
    }
    async fn refresh_status(&self, _id: &str) -> anyhow::Result<()> {
        Ok(())
    }
    fn get_task_type(&self) -> TaskDisplayType {
        TaskDisplayType::CollectedOut
    }
}

impl CollectionTaskServiceImpl {
    pub fn new(
        repo: std::sync::Arc<dyn ISubTaskRepository + Send + Sync>,
        report_service: std::sync::Arc<dyn ISubTaskReportService>,
        file_load_service: std::sync::Arc<dyn FileLoadService>,
    ) -> Self {
        Self {
            repo,
            report_service,
            file_load_service,
        }
    }
    async fn inner_run_sub_task(&self, sub_task: &SubTask) -> anyhow::Result<()> {
        let sub_task = sub_task.clone();
        match sub_task.task_type {
            TaskType::CollectedOut {
                from,
                rule,
                to,
                optional,
            } => {
                let input = match self
                    .file_load_service
                    .load_file(sub_task.parent_id.to_string().as_str(), &from)
                    .await
                {
                    Ok(x) => x,
                    Err(e) => {
                        if optional {
                            return Ok(());
                        } else {
                            anyhow::bail!("Unable to collect {}, file not found. {e}", sub_task.id)
                        }
                    }
                };
                let output = match rule {
                    CollectRule::Regex { exp } => regex::Regex::new(exp.as_str())?
                        .captures_iter(input.as_str())
                        .filter_map(|x| x.get(0).map(|x| x.as_str()))
                        .collect::<Vec<&str>>()
                        .join("\n"),
                    CollectRule::BottomLines { n } => {
                        let lines = input.lines().count();
                        input.lines().skip(lines - n).take(n).collect::<Vec<&str>>().join("\n")
                    }
                    CollectRule::TopLines { n } => {
                        input.lines().take(n).collect::<Vec<&str>>().join("\n")
                    }
                };
                self.file_load_service
                    .save_file(sub_task.parent_id, output.as_str(), &to)
                    .await?;
            }
            _ => anyhow::bail!("Unable to run {}, mismatch task type.", sub_task.id),
        }
        Ok(())
    }
}
