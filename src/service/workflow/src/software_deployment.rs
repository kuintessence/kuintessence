use std::sync::Arc;

use alice_architecture::repository::IReadOnlyRepository;
use async_trait::async_trait;
use domain_workflow::{
    model::entity::software_deployment::{InstalledSoftware, Software, SoftwareSource},
    repository::ReadOnlyByQueueRepo,
    service::SoftwareDeploymentService,
};

pub struct SoftwareDeploymentServiceImpl {
    _installed_repo: Arc<dyn IReadOnlyRepository<InstalledSoftware> + Send + Sync>,
    source_repo: Arc<dyn ReadOnlyByQueueRepo<SoftwareSource>>,
    software_repo: Arc<dyn IReadOnlyRepository<Software> + Send + Sync>,
    _install_history_repo: Arc<dyn IReadOnlyRepository<SoftwareSource> + Send + Sync>,
}

#[async_trait]
impl SoftwareDeploymentService for SoftwareDeploymentServiceImpl {
    async fn install_software(
        &self,
        software_id: &str,
        _software_source_id: &str,
        queue_id: &str,
    ) -> anyhow::Result<()> {
        let _software_source =
            self.source_repo.get_by_id_with_queue_id(software_id, queue_id).await?;
        let _software = self.software_repo.get_by_id(software_id.to_string().as_str()).await?;

        Ok(())
    }

    async fn uninstall_software(&self, _id: &str, _queue_id: &str) -> anyhow::Result<()> {
        todo!()
    }

    async fn cancel_install(&self, _id: &str, _queue_id: &str) -> anyhow::Result<()> {
        todo!()
    }
}
