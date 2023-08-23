use crate::models::TaskDisplayType;

#[async_trait::async_trait]
pub trait ISubTaskReportService {
    async fn report_completed_task(&self, id: &str) -> anyhow::Result<()>;
    async fn report_failed_task(&self, id: &str) -> anyhow::Result<()>;
}

#[async_trait::async_trait]
pub trait ISubTaskService {
    async fn enqueue_sub_task(&self, id: &str) -> anyhow::Result<()>;
    async fn delete_sub_task(&self, id: &str) -> anyhow::Result<()>;
    async fn pause_sub_task(&self, id: &str) -> anyhow::Result<()>;
    async fn continue_sub_task(&self, id: &str) -> anyhow::Result<()>;
    async fn refresh_all_status(&self) -> anyhow::Result<()>;
    async fn refresh_status(&self, id: &str) -> anyhow::Result<()>;
    fn get_task_type(&self) -> TaskDisplayType {
        TaskDisplayType::Unknown
    }
}
