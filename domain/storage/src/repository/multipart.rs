use alice_architecture::repository::LeaseDBRepository;
use async_trait::async_trait;

use crate::model::entity::Multipart;

#[async_trait]
pub trait MultipartRepo: LeaseDBRepository<Multipart> + Send + Sync {
    async fn get_one_by_key_regex(&self, regex: &str) -> anyhow::Result<Option<Multipart>>;

    async fn delete_by_key_regex(&self, regex: &str) -> anyhow::Result<()>;
}
