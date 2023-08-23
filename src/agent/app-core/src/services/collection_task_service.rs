use super::{ISubTaskReportService, ISubTaskService};
use crate::{
    models::{CollectFrom, CollectTo, SubTask, TaskDisplayType},
    repository::ISubTaskRepository,
};

pub struct CollectionTaskService {
    repo: std::sync::Arc<dyn ISubTaskRepository + Send + Sync>,
    report_service: std::sync::Arc<dyn ISubTaskReportService + Send + Sync>,
    file_load_service: std::sync::Arc<dyn IFileLoadService + Send + Sync>,
}

#[async_trait::async_trait]
impl ISubTaskService for CollectionTaskService {
    async fn enqueue_sub_task(&self, id: &str) -> anyhow::Result<()> {
        let sub_task = self.repo.get_by_id(id).await?;
        match self.inner_run_sub_task(&sub_task).await {
            Ok(()) => {
                self.repo
                    .update(SubTask {
                        status: crate::models::TaskStatus::Completed,
                        ..sub_task
                    })
                    .await?;
                self.repo.save_changed().await?;
                self.report_service.report_completed_task(id).await?;
            }
            Err(e) => {
                self.repo
                    .update(SubTask {
                        status: crate::models::TaskStatus::Failed,
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

impl CollectionTaskService {
    pub fn new(
        repo: std::sync::Arc<dyn ISubTaskRepository + Send + Sync>,
        report_service: std::sync::Arc<dyn ISubTaskReportService + Send + Sync>,
        file_load_service: std::sync::Arc<dyn IFileLoadService + Send + Sync>,
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
            crate::models::TaskType::CollectedOut {
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
                    crate::models::CollectRule::Regex { exp } => regex::Regex::new(exp.as_str())?
                        .captures_iter(input.as_str())
                        .filter_map(|x| x.get(0).map(|x| x.as_str()))
                        .collect::<Vec<&str>>()
                        .join("\n"),
                    crate::models::CollectRule::BottomLines { n } => {
                        let lines = input.lines().count();
                        input.lines().skip(lines - n).take(n).collect::<Vec<&str>>().join("\n")
                    }
                    crate::models::CollectRule::TopLines { n } => {
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

#[async_trait::async_trait]
pub trait IFileLoadService {
    async fn load_file(&self, parent_id: &str, from: &CollectFrom) -> anyhow::Result<String>;
    async fn save_file(
        &self,
        parent_id: uuid::Uuid,
        output: &str,
        to: &CollectTo,
    ) -> anyhow::Result<()>;
}
