use alice_architecture::repository::LeaseDBRepository;
use async_trait::async_trait;

use crate::model::entity::WsReqInfo;

#[async_trait]
pub trait WsReqInfoRepo: LeaseDBRepository<WsReqInfo> + Send + Sync {
    async fn delete_all_by_key_regex(&self, regex: &str) -> anyhow::Result<()>;
    async fn get_one_by_key_regex(&self, regex: &str) -> anyhow::Result<Option<WsReqInfo>>;
}
