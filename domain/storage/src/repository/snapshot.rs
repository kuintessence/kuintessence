use alice_architecture::repository::LeaseDBRepository;
use async_trait::async_trait;

use crate::model::entity::Snapshot;

#[async_trait]
pub trait SnapshotRepo: LeaseDBRepository<Snapshot> + Send + Sync {
    async fn delete_by_key_regex(&self, regex: &str) -> anyhow::Result<Snapshot>;
    async fn get_one_by_key_regex(&self, regex: &str) -> anyhow::Result<Option<Snapshot>>;
    async fn get_all_by_key_regex(&self, regex: &str) -> anyhow::Result<Vec<Snapshot>>;
}
