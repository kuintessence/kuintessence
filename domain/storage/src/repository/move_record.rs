use alice_architecture::repository::LeaseDBRepository;
use async_trait::async_trait;

use crate::model::entity::MoveRegistration;

#[async_trait]
pub trait MoveRegistrationRepo: LeaseDBRepository<MoveRegistration> + Send + Sync {
    /// Get move registrations by key_regex.
    async fn get_all_by_key_regex(&self, key_regex: &str) -> anyhow::Result<Vec<MoveRegistration>>;

    /// Get by key regex.
    async fn get_one_by_key_regex(
        &self,
        key_regex: &str,
    ) -> anyhow::Result<Option<MoveRegistration>>;

    async fn remove_all_by_key_regex(&self, key_regex: &str) -> anyhow::Result<()>;
}
