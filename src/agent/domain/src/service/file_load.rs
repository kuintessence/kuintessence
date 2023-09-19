use uuid::Uuid;

use crate::model::entity::task::{CollectFrom, CollectTo};

#[async_trait::async_trait]
pub trait FileLoadService: Send + Sync {
    async fn load_file(&self, parent_id: &str, from: &CollectFrom) -> anyhow::Result<String>;
    async fn save_file(&self, parent_id: Uuid, output: &str, to: &CollectTo) -> anyhow::Result<()>;
}
