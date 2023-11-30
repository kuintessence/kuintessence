use alice_architecture::repository::DBRepository;
use async_trait::async_trait;

use crate::model::{entity::FileMeta, vo::HashAlgorithm};

#[async_trait]
pub trait FileMetaRepo: DBRepository<FileMeta> + Send + Sync {
    async fn get_by_hash_and_algorithm(
        &self,
        hash: &str,
        hash_algorithm: &HashAlgorithm,
    ) -> anyhow::Result<Option<FileMeta>>;
}
