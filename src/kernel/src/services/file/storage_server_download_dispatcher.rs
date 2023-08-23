use crate::prelude::*;
use std::ops::Range;

#[derive(Builder)]
pub struct StorageServerDownloadDispatcherService {
    resources_service: Arc<dyn IResourcesService + Send + Sync>,
    storage_server_broker_service: Arc<dyn IStorageServerBrokerService + Send + Sync>,
}

#[async_trait]
impl IStorageServerDownloadDispatcherService for StorageServerDownloadDispatcherService {
    async fn download(&self, meta_id: Uuid) -> Anyhow {
        let storage_server = &self.resources_service.default_file_storage_server().await?;
        self.storage_server_broker_service.download(storage_server, meta_id).await
    }

    async fn get_bytes(&self, meta_id: Uuid) -> AnyhowResult<Vec<u8>> {
        let storage_server = &self.resources_service.default_file_storage_server().await?;
        self.storage_server_broker_service.get_bytes(storage_server, meta_id).await
    }

    async fn get_text(&self, meta_id: Uuid) -> AnyhowResult<String> {
        let storage_server = &self.resources_service.default_file_storage_server().await?;
        self.storage_server_broker_service.get_text(storage_server, meta_id).await
    }

    async fn rangely_get_file(
        &self,
        meta_id: Uuid,
        ranges: &[Range<u64>],
    ) -> AnyhowResult<Vec<Vec<u8>>> {
        let storage_server = &self.resources_service.default_file_storage_server().await?;
        self.storage_server_broker_service
            .rangely_get_file(storage_server, meta_id, ranges)
            .await
    }

    async fn get_file_size(&self, meta_id: Uuid) -> AnyhowResult<u64> {
        let storage_server = &self.resources_service.default_file_storage_server().await?;
        self.storage_server_broker_service.get_file_size(storage_server, meta_id).await
    }

    async fn get_download_url(&self, meta_id: Uuid) -> AnyhowResult<String> {
        let storage_server = &self.resources_service.default_file_storage_server().await?;
        self.storage_server_broker_service
            .get_download_url(storage_server, meta_id)
            .await
    }
}
