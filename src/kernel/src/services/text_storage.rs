use crate::prelude::*;
use std::sync::Arc;

#[derive(Builder)]
pub struct TextStorageService {
    text_storage_repository: Arc<dyn ITextStorageRepository + Send + Sync>,
}

#[async_trait]
impl ITextStorageService for TextStorageService {
    async fn upload_text(&self, txt: TextStorage) -> anyhow::Result<String> {
        let txt = self.text_storage_repository.insert(txt.to_owned()).await?;
        self.text_storage_repository.save_changed().await?;
        Ok(txt.key.ok_or(anyhow::anyhow!("Unreachable error!"))?.to_string())
    }

    async fn get_by_ids(&self, ids: &[Uuid]) -> anyhow::Result<Vec<(Uuid, String)>> {
        Ok(self.text_storage_repository.get_by_ids(ids).await?)
    }
}
