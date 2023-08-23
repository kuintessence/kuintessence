use super::SeaOrmDbRepository;
use alice_architecture::repository::IReadOnlyRepository;
use database_model::system::prelude::*;
use kernel::prelude::*;
use rand::Rng;
use sea_orm::{prelude::Uuid, ColumnTrait, EntityTrait, PaginatorTrait, QueryFilter, QuerySelect};
use std::str::FromStr;

#[async_trait::async_trait]
impl IReadOnlyRepository<Cluster> for SeaOrmDbRepository {
    async fn get_by_id(&self, uuid: &str) -> anyhow::Result<Cluster> {
        ClusterEntity::find_by_id(Uuid::from_str(uuid)?)
            .one(self.db.get_connection())
            .await?
            .ok_or(anyhow::anyhow!("there is no such row with key {uuid}"))?
            .try_into()
    }
    async fn get_all(&self) -> anyhow::Result<Vec<Cluster>> {
        unimplemented!()
    }
}

#[async_trait::async_trait]
impl IClusterRepository for SeaOrmDbRepository {
    async fn get_random_cluster(&self) -> anyhow::Result<Uuid> {
        let count = ClusterEntity::find()
            .filter(ClusterColumn::Enabled.eq(true))
            .count(self.db.get_connection())
            .await?;
        let nth = rand::thread_rng().gen_range(0..count);
        Ok(ClusterEntity::find()
            .filter(ClusterColumn::Enabled.eq(true))
            .limit(1)
            .offset(nth)
            .one(self.db.get_connection())
            .await?
            .ok_or(anyhow::anyhow!("No such cluster id!"))?
            .id)
    }
}
