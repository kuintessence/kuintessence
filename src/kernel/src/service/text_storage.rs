use crate::prelude::*;

#[async_trait]
pub trait ITextStorageService {
    async fn upload_text(&self, txt: TextStorage) -> anyhow::Result<String>;
    async fn get_by_ids(&self, ids: &[Uuid]) -> anyhow::Result<Vec<(Uuid, String)>>;
}
