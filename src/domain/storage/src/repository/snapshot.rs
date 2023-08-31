use alice_architecture::utils::*;
use alice_architecture::ILeaseDBRepository;

use crate::model::entity::Snapshot;

#[async_trait]
pub trait SnapshotRepo: ILeaseDBRepository<Snapshot> + Send + Sync {
    async fn delete_by_key_regex(&self, regex: &str) -> Anyhow<Snapshot>;
    async fn get_one_by_key_regex(&self, regex: &str) -> Anyhow<Option<Snapshot>>;
    async fn get_all_by_key_regex(&self, regex: &str) -> Anyhow<Vec<Snapshot>>;
}
