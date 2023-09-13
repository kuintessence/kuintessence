use alice_architecture::repository::DBRepository;
use async_trait::async_trait;
use uuid::Uuid;

use crate::model::entity::TextStorage;

#[async_trait]
pub trait TextStorageRepo: DBRepository<TextStorage> + Send + Sync {
    /// 文本原有 uuid
    async fn text_already_uuid(&self, text: &str) -> anyhow::Result<Option<Uuid>>;
    async fn get_by_ids(&self, ids: &[Uuid]) -> anyhow::Result<Vec<(Uuid, String)>>;
}
