use alice_architecture::IDBRepository;

use alice_architecture::utils::*;

use crate::model::entity::FileMeta;
use crate::model::vo::HashAlgorithm;

#[async_trait]
pub trait FileMetaRepo: IDBRepository<FileMeta> + Send + Sync {
    async fn get_by_hash_and_algorithm(
        &self,
        hash: &str,
        hash_algorithm: &HashAlgorithm,
    ) -> Anyhow<Option<FileMeta>>;
}
