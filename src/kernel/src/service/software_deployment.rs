use crate::prelude::*;

#[async_trait]
pub trait ISoftwareDeploymentService {
    async fn install_software(
        &self,
        software_id: &str,
        software_source_id: &str,
        cluster_id: &str,
    ) -> anyhow::Result<()>;
    async fn uninstall_software(&self, id: &str, cluster_id: &str) -> anyhow::Result<()>;
    async fn cancel_install(&self, id: &str, cluster_id: &str) -> anyhow::Result<()>;
}
