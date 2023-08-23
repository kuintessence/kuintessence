use crate::prelude::*;
use alice_architecture::ILeaseDBRepository;

#[async_trait]
pub trait IWsReqInfoRepo: ILeaseDBRepository<WsReqInfo> {
    async fn delete_all_by_key_regex(&self, regex: &str) -> Anyhow;
    async fn get_one_by_key_regex(&self, regex: &str) -> AnyhowResult<Option<WsReqInfo>>;
}
