use alice_architecture::utils::*;
use alice_architecture::ILeaseDBRepository;

use crate::model::entity::WsReqInfo;

#[async_trait]
pub trait WsReqInfoRepo: ILeaseDBRepository<WsReqInfo> + Send + Sync {
    async fn delete_all_by_key_regex(&self, regex: &str) -> Anyhow;
    async fn get_one_by_key_regex(&self, regex: &str) -> Anyhow<Option<WsReqInfo>>;
}
