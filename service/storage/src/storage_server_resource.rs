use std::sync::Arc;

use alice_architecture::repository::ReadOnlyRepository;
use async_trait::async_trait;
use domain_storage::{model::entity::StorageServer, service::StorageServerResourceService};
use typed_builder::TypedBuilder;
use uuid::Uuid;

#[derive(TypedBuilder)]
pub struct StorageServerResourceServiceImpl {
    default_storage_server_id: Uuid,
    storage_server_repo: Arc<dyn ReadOnlyRepository<StorageServer>>,
}

#[async_trait]
impl StorageServerResourceService for StorageServerResourceServiceImpl {
    async fn default_file_storage_server(&self) -> anyhow::Result<StorageServer> {
        self.storage_server_repo.get_by_id(self.default_storage_server_id).await
    }
}
