use alice_architecture::repository::LeaseDBRepository;
use async_trait::async_trait;
use uuid::Uuid;

use crate::{exception::FileResult, model::entity::Multipart};

#[async_trait]
pub trait MultipartRepo: LeaseDBRepository<Multipart> + Send + Sync {
    async fn get_one_by_key_regex(&self, regex: &str) -> anyhow::Result<Option<Multipart>>;

    async fn delete_by_key_regex(&self, regex: &str) -> anyhow::Result<()>;

    async fn remove_nth(&self, id: Uuid, nth: u64, ttl: i64) -> FileResult<Multipart>;
}
