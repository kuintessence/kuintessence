use std::ops::Range;
use std::sync::Arc;


use async_trait::async_trait;
use domain_storage::service::{
    StorageServerResourceService, StorageServerBrokerService, StorageServerDownloadDispatcherService,
};
use typed_builder::TypedBuilder;
use uuid::Uuid;

#[derive(TypedBuilder)]
pub struct StorageServerDownloadDispatcherServiceImpl {
    resources_service: Arc<dyn StorageServerResourceService>,
    storage_server_broker_service: Arc<dyn StorageServerBrokerService>,
}

#[async_trait]
impl StorageServerDownloadDispatcherService for StorageServerDownloadDispatcherServiceImpl {
    async fn download(&self, meta_id: Uuid) -> anyhow::Result<()> {
        let storage_server = &self.resources_service.default_file_storage_server().await?;
        self.storage_server_broker_service.download(storage_server, meta_id).await
    }

    async fn get_bytes(&self, meta_id: Uuid) -> anyhow::Result<Vec<u8>> {
        let storage_server = &self.resources_service.default_file_storage_server().await?;
        self.storage_server_broker_service.get_bytes(storage_server, meta_id).await
    }

    async fn get_text(&self, meta_id: Uuid) -> anyhow::Result<String> {
        let storage_server = &self.resources_service.default_file_storage_server().await?;
        self.storage_server_broker_service.get_text(storage_server, meta_id).await
    }

    async fn rangely_get_file(&self, meta_id: Uuid, ranges: &[Range<u64>]) -> anyhow::Result<Vec<Vec<u8>>> {
        let storage_server = &self.resources_service.default_file_storage_server().await?;
        self.storage_server_broker_service
            .rangely_get_file(storage_server, meta_id, ranges)
            .await
    }

    async fn get_file_size(&self, meta_id: Uuid) -> anyhow::Result<u64> {
        let storage_server = &self.resources_service.default_file_storage_server().await?;
        self.storage_server_broker_service.get_file_size(storage_server, meta_id).await
    }

    async fn get_download_url(&self, meta_id: Uuid) -> anyhow::Result<String> {
        let storage_server = &self.resources_service.default_file_storage_server().await?;
        self.storage_server_broker_service
            .get_download_url(storage_server, meta_id)
            .await
    }
}
