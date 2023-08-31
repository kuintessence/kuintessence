use alice_architecture::IReadOnlyRepository;
use async_trait::async_trait;
use uuid::Uuid;

use crate::model::entity::package::Package;

#[async_trait]
pub trait PackageRepo: IReadOnlyRepository<Package> + Send + Sync {
    /// get package by ID
    async fn get_package(&self, content_entity_ver_id: Uuid) -> anyhow::Result<Package>;
}
