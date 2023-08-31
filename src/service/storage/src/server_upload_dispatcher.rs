use std::sync::Arc;

use alice_architecture::utils::Anyhow;
use async_trait::async_trait;
use domain_storage::{model::vo::ServerUrl, service::*};
use typed_builder::TypedBuilder;
use uuid::Uuid;

#[derive(TypedBuilder, Clone)]
pub struct StorageServerUploadDispatcherServiceImpl {
    resources_service: Arc<dyn StorageServerResourceService>,
    storage_server_broker_service: Arc<dyn StorageServerBrokerService>,
}

#[async_trait]
impl StorageServerUploadDispatcherService for StorageServerUploadDispatcherServiceImpl {
    async fn upload(&self, meta_id: Uuid, content: &[u8]) -> Anyhow<ServerUrl> {
        let storage_server = &self.resources_service.default_file_storage_server().await?;

        self.storage_server_broker_service
            .upload(storage_server, meta_id, content)
            .await
    }
}
