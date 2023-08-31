use alice_architecture::utils::*;
use alice_architecture::ILeaseDBRepository;

use crate::model::entity::Multipart;

#[async_trait]
pub trait MultipartRepo: ILeaseDBRepository<Multipart> + Send + Sync {
    async fn get_one_by_key_regex(&self, regex: &str) -> Anyhow<Option<Multipart>>;

    async fn delete_by_key_regex(&self, regex: &str) -> Anyhow;
}
