use crate::prelude::*;
use alice_architecture::IReadOnlyRepository;

#[derive(Builder)]
pub struct ResourcesService {
    default_storage_server_id: Uuid,
    storage_server_repo: Arc<dyn IReadOnlyRepository<StorageServer> + Send + Sync>,
}

#[async_trait]
impl IResourcesService for ResourcesService {
    async fn default_file_storage_server(&self) -> AnyhowResult<StorageServer> {
        self.storage_server_repo
            .get_by_id(&self.default_storage_server_id.to_string())
            .await
    }
}
