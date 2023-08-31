use std::sync::Arc;

use alice_architecture::utils::Anyhow;
use alice_architecture::IReadOnlyRepository;
use async_trait::async_trait;
use domain_storage::{model::entity::StorageServer, service::StorageServerResourceService};
use typed_builder::TypedBuilder;
use uuid::Uuid;

#[derive(TypedBuilder)]
pub struct StorageServerResourceServiceImpl {
    default_storage_server_id: Uuid,
    storage_server_repo: Arc<dyn IReadOnlyRepository<StorageServer> + Send + Sync>,
}

#[async_trait]
impl StorageServerResourceService for StorageServerResourceServiceImpl {
    async fn default_file_storage_server(&self) -> Anyhow<StorageServer> {
        self.storage_server_repo
            .get_by_id(&self.default_storage_server_id.to_string())
            .await
    }
}
