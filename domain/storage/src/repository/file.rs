use crate::model::entity::FileStorage;
use alice_architecture::repository::DBRepository;
use async_trait::async_trait;
use uuid::Uuid;

#[async_trait]
pub trait FileStorageRepo: DBRepository<FileStorage> + Send + Sync {
    ///Get one by storage_server_id and meta_id.
    async fn get_by_storage_server_id_and_meta_id(
        &self,
        storage_server_id: Uuid,
        meta_id: Uuid,
    ) -> anyhow::Result<String>;
}
