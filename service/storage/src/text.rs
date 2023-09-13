use std::sync::Arc;

use async_trait::async_trait;
use domain_storage::{
    model::entity::TextStorage, repository::TextStorageRepo, service::TextStorageService,
};
use typed_builder::TypedBuilder;
use uuid::Uuid;

#[derive(TypedBuilder)]
pub struct TextStorageServiceImpl {
    text_storage_repository: Arc<dyn TextStorageRepo>,
}

#[async_trait]
impl TextStorageService for TextStorageServiceImpl {
    async fn upload_text(&self, txt: TextStorage) -> anyhow::Result<Uuid> {
        let key = self.text_storage_repository.insert(&txt).await?;
        self.text_storage_repository.save_changed().await?;
        Ok(key)
    }

    async fn get_by_ids(&self, ids: &[Uuid]) -> anyhow::Result<Vec<(Uuid, String)>> {
        Ok(self.text_storage_repository.get_by_ids(ids).await?)
    }
}
