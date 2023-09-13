use async_trait::async_trait;
use uuid::Uuid;

use crate::model::entity::TextStorage;

#[async_trait]
pub trait TextStorageService: Send + Sync {
    async fn upload_text(&self, txt: TextStorage) -> anyhow::Result<Uuid>;
    async fn get_by_ids(&self, ids: &[Uuid]) -> anyhow::Result<Vec<(Uuid, String)>>;
}
