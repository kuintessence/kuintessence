use crate::prelude::*;
use alice_architecture::ILeaseDBRepository;

#[async_trait]
pub trait IMoveRegistrationRepo: ILeaseDBRepository<MoveRegistration> {
    /// Get move registrations by key_regex.
    async fn get_all_by_key_regex(&self, key_regex: &str) -> AnyhowResult<Vec<MoveRegistration>>;
    /// Get by key regex.
    async fn get_one_by_key_regex(&self, key_regex: &str)
        -> AnyhowResult<Option<MoveRegistration>>;
    /// Get user by key regex.
    async fn get_user_by_key_regex(&self, key_regex: &str) -> AnyhowResult<Option<Uuid>>;
    async fn remove_all_by_key_regex(&self, key_regex: &str) -> Anyhow;
}
