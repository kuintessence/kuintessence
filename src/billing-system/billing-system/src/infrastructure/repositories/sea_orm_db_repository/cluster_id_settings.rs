use super::SeaOrmDbRepository;
use billing_system_kernel::prelude::*;
use database_model::{system::prelude::*, utils::WithDecimalFileds};
use sea_orm::{ColumnTrait, EntityTrait, QueryFilter};
use std::str::FromStr;
use uuid::Uuid;

#[async_trait::async_trait]
impl IClusterIdSettingsRepository for SeaOrmDbRepository {
    async fn get_by_cluster_id(&self, id: &str) -> anyhow::Result<ClusterIdSettings> {
        let mut model = ClusterIdSettingsEntity::find()
            .filter(ClusterIdSettingsColumn::ClusterId.eq(Uuid::from_str(id)?))
            .one(self.db.get_connection())
            .await?
            .ok_or(anyhow::anyhow!("No such cluster"))?;
        model.rescale_all_to(10);
        log::debug!("{model:#?}");
        model.try_into()
    }
}
