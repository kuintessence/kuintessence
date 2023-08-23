use crate::prelude::*;
use alice_architecture::repository::IReadOnlyRepository;
use std::sync::Arc;

pub struct SoftwareDeploymentService {
    _installed_repo: Arc<dyn IReadOnlyRepository<InstalledSoftware> + Send + Sync>,
    source_repo: Arc<dyn IReadOnlyByClusterRepository<SoftwareSource> + Send + Sync>,
    software_repo: Arc<dyn IReadOnlyRepository<Software> + Send + Sync>,
    _install_history_repo: Arc<dyn IReadOnlyRepository<SoftwareSource> + Send + Sync>,
}

#[async_trait]
impl ISoftwareDeploymentService for SoftwareDeploymentService {
    async fn install_software(
        &self,
        software_id: &str,
        _software_source_id: &str,
        cluster_id: &str,
    ) -> anyhow::Result<()> {
        let _software_source =
            self.source_repo.get_by_id_with_cluster_id(software_id, cluster_id).await?;
        let _software = self.software_repo.get_by_id(software_id.to_string().as_str()).await?;

        Ok(())
    }
    async fn uninstall_software(&self, _id: &str, _cluster_id: &str) -> anyhow::Result<()> {
        todo!()
    }
    async fn cancel_install(&self, _id: &str, _cluster_id: &str) -> anyhow::Result<()> {
        todo!()
    }
}
