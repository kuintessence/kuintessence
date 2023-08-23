use super::SeaOrmDbRepository;
use alice_architecture::repository::IReadOnlyRepository;
use database_model::system::prelude::*;
use kernel::prelude::*;
use sea_orm::{prelude::Uuid, EntityTrait};
use std::str::FromStr;

#[async_trait::async_trait]
impl IReadOnlyRepository<StorageServer> for SeaOrmDbRepository {
    async fn get_by_id(&self, uuid: &str) -> anyhow::Result<StorageServer> {
        StorageServerEntity::find_by_id(Uuid::from_str(uuid)?)
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
