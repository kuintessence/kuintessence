use alice_architecture::utils::*;
use alice_architecture::ILeaseDBRepository;

use crate::model::entity::MoveRegistration;

#[async_trait]
pub trait MoveRegistrationRepo: ILeaseDBRepository<MoveRegistration> + Send + Sync {
    /// Get move registrations by key_regex.
    async fn get_all_by_key_regex(&self, key_regex: &str) -> Anyhow<Vec<MoveRegistration>>;

    /// Get by key regex.
    async fn get_one_by_key_regex(&self, key_regex: &str) -> Anyhow<Option<MoveRegistration>>;

    /// Get user by key regex.
    async fn get_user_by_key_regex(&self, key_regex: &str) -> Anyhow<Option<Uuid>>;

    async fn remove_all_by_key_regex(&self, key_regex: &str) -> Anyhow;
}
