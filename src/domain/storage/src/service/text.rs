use alice_architecture::utils::*;

use crate::model::entity::TextStorage;

#[async_trait]
pub trait TextStorageService: Send + Sync {
    async fn upload_text(&self, txt: TextStorage) -> anyhow::Result<String>;
    async fn get_by_ids(&self, ids: &[Uuid]) -> anyhow::Result<Vec<(Uuid, String)>>;
}
