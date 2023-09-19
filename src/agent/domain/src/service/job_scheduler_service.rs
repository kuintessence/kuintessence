use crate::model::vo::job::ScriptInfo;
use crate::model::vo::Job;

#[async_trait::async_trait]
pub trait JobSchedulerService: Send + Sync {
    async fn get_jobs(&self) -> anyhow::Result<Vec<Job>>;
    async fn get_job(&self, id: &str) -> anyhow::Result<Job>;
    async fn submit_job_script(&self, script_info: ScriptInfo) -> anyhow::Result<String>;
    async fn submit_job(&self, script_path: &str) -> anyhow::Result<String>;
    async fn delete_job(&self, job_id: &str) -> anyhow::Result<()>;
    async fn pause_job(&self, job_id: &str) -> anyhow::Result<()>;
    async fn continue_job(&self, job_id: &str) -> anyhow::Result<()>;
}
