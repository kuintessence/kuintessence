use super::SubTaskService;

#[async_trait::async_trait]
pub trait DeploySoftwareService: SubTaskService {
    async fn run_sub_task(&self, id: &str) -> anyhow::Result<()>;
    async fn complete_sub_task(&self, id: &str) -> anyhow::Result<()>;
    async fn fail_sub_task(&self, id: &str) -> anyhow::Result<()>;
}
