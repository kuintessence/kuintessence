use alice_architecture::repository::IDBRepository;
use alice_architecture::utils::*;

use crate::model::entity::TextStorage;

#[async_trait]
pub trait TextStorageRepo: IDBRepository<TextStorage> + Send + Sync {
    /// 文本原有 uuid
    async fn text_already_uuid(&self, text: &str) -> anyhow::Result<Option<Uuid>>;
    async fn get_by_ids(&self, ids: &[Uuid]) -> anyhow::Result<Vec<(Uuid, String)>>;
}
