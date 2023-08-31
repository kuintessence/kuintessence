use alice_architecture::utils::*;
use alice_architecture::IDBRepository;

use crate::model::entity::FileStorage;

#[async_trait]
pub trait FileStorageRepo: IDBRepository<FileStorage> + Send + Sync {
    /// Get all same file meta storage records.
    async fn get_all_by_meta_id(&self, meta_id: Uuid) -> Anyhow<Vec<FileStorage>>;

    ///Get one by storage_server_id and meta_id.
    async fn get_by_storage_server_id_and_meta_id(
        &self,
        storage_server_id: Uuid,
        meta_id: Uuid,
    ) -> Anyhow<String>;
    async fn insert_with_custom_user_id(&self, entity: FileStorage, user_id: Uuid) -> Anyhow;
}
