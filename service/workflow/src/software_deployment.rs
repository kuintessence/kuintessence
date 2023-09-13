use std::sync::Arc;

use alice_architecture::repository::ReadOnlyRepository;
use async_trait::async_trait;
use domain_workflow::{
    model::entity::software_deployment::{InstalledSoftware, Software, SoftwareSource},
    repository::ReadOnlyByQueueRepo,
    service::SoftwareDeploymentService,
};
use uuid::Uuid;

pub struct SoftwareDeploymentServiceImpl {
    _installed_repo: Arc<dyn ReadOnlyRepository<InstalledSoftware>>,
    source_repo: Arc<dyn ReadOnlyByQueueRepo<SoftwareSource>>,
    software_repo: Arc<dyn ReadOnlyRepository<Software>>,
    _install_history_repo: Arc<dyn ReadOnlyRepository<SoftwareSource>>,
}

#[async_trait]
impl SoftwareDeploymentService for SoftwareDeploymentServiceImpl {
    async fn install_software(
        &self,
        software_id: Uuid,
        _software_source_id: &str,
        queue_id: Uuid,
    ) -> anyhow::Result<()> {
        let _software_source =
            self.source_repo.get_by_id_with_queue_id(software_id, queue_id).await?;
        let _software = self.software_repo.get_by_id(software_id).await?;

        Ok(())
    }

    async fn uninstall_software(&self, _id: &str, _queue_id: Uuid) -> anyhow::Result<()> {
        todo!()
    }

    async fn cancel_install(&self, _id: &str, _queue_id: Uuid) -> anyhow::Result<()> {
        todo!()
    }
}
