use async_trait::async_trait;
use uuid::Uuid;

#[async_trait]
pub trait SoftwareDeploymentService: Send + Sync {
    async fn install_software(
        &self,
        software_id: Uuid,
        software_source_id: &str,
        queue_id: Uuid,
    ) -> anyhow::Result<()>;
    async fn uninstall_software(&self, id: &str, queue_id: Uuid) -> anyhow::Result<()>;
    async fn cancel_install(&self, id: &str, queue_id: Uuid) -> anyhow::Result<()>;
}
