use crate::prelude::*;
use alice_architecture::IDBRepository;

#[async_trait]
pub trait IFileMetaRepo: IDBRepository<FileMeta> {
    async fn get_by_hash_and_algorithm(
        &self,
        hash: &str,
        hash_algorithm: &HashAlgorithm,
    ) -> AnyhowResult<Option<FileMeta>>;
}
