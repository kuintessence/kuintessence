use crate::prelude::*;
use alice_architecture::ILeaseDBRepository;

#[async_trait]
pub trait ISnapshotRepo: ILeaseDBRepository<Snapshot> {
    async fn delete_by_key_regex(&self, regex: &str) -> AnyhowResult<Snapshot>;
    async fn get_one_by_key_regex(&self, regex: &str) -> AnyhowResult<Option<Snapshot>>;
    async fn get_all_by_key_regex(&self, regex: &str) -> AnyhowResult<Vec<Snapshot>>;
}
