use crate::prelude::*;
use alice_architecture::ILeaseDBRepository;

#[async_trait]
pub trait IMultipartRepo: ILeaseDBRepository<Multipart> {
    async fn get_one_by_key_regex(&self, regex: &str) -> AnyhowResult<Option<Multipart>>;
    async fn delete_by_key_regex(&self, regex: &str) -> Anyhow;
}
