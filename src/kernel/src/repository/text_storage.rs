use crate::prelude::*;
use alice_architecture::repository::IDBRepository;

#[async_trait]
pub trait ITextStorageRepository: IDBRepository<TextStorage> {
    /// 文本原有 uuid
    async fn text_already_uuid(&self, text: &str) -> anyhow::Result<Option<Uuid>>;
    async fn get_by_ids(&self, ids: &[Uuid]) -> anyhow::Result<Vec<(Uuid, String)>>;
}
