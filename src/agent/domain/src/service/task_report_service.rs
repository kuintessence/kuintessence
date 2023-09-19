#[async_trait::async_trait]
pub trait TaskReportService: Send + Sync {
    async fn report_completed_task(&self, id: &str) -> anyhow::Result<()>;
    async fn report_failed_task(&self, id: &str, message: &str) -> anyhow::Result<()>;
    async fn report_paused_task(&self, id: &str) -> anyhow::Result<()>;
    async fn report_resumed_task(&self, id: &str) -> anyhow::Result<()>;
    async fn report_deleted_task(&self, id: &str) -> anyhow::Result<()>;
    async fn report_started_task(&self, id: &str) -> anyhow::Result<()>;
}
