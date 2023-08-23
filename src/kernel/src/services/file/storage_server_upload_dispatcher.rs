use crate::prelude::*;

#[derive(Builder, Clone)]
pub struct StorageServerUploadDispatcherService {
    resources_service: Arc<dyn IResourcesService + Send + Sync>,
    storage_server_broker_service: Arc<dyn IStorageServerBrokerService + Send + Sync>,
}

#[async_trait]
impl IStorageServerUploadDispatcherService for StorageServerUploadDispatcherService {
    async fn upload(&self, meta_id: Uuid, content: &[u8]) -> AnyhowResult<ServerUrl> {
        let storage_server = &self.resources_service.default_file_storage_server().await?;

        self.storage_server_broker_service
            .upload(storage_server, meta_id, content)
            .await
    }
}
