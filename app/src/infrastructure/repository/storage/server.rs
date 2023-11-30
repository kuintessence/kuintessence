use alice_architecture::repository::ReadOnlyRepository;

use database_model::storage_server;
use domain_storage::model::entity::StorageServer;
use sea_orm::prelude::*;

use crate::infrastructure::database::OrmRepo;

#[async_trait::async_trait]
impl ReadOnlyRepository<StorageServer> for OrmRepo {
    async fn get_by_id(&self, uuid: Uuid) -> anyhow::Result<StorageServer> {
        storage_server::Entity::find_by_id(uuid)
            .one(self.db.get_connection())
            .await?
            .ok_or(anyhow::anyhow!(
                "There is no such storage_server with id: {uuid}"
            ))?
            .try_into()
    }

    async fn get_all(&self) -> anyhow::Result<Vec<StorageServer>> {
        unimplemented!()
    }
}
