use alice_architecture::utils::*;

#[async_trait]
pub trait SoftwareDeploymentService: Send + Sync {
    async fn install_software(
        &self,
        software_id: &str,
        software_source_id: &str,
        queue_id: &str,
    ) -> anyhow::Result<()>;
    async fn uninstall_software(&self, id: &str, queue_id: &str) -> anyhow::Result<()>;
    async fn cancel_install(&self, id: &str, queue_id: &str) -> anyhow::Result<()>;
}
