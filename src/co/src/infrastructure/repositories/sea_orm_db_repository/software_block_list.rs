use super::SeaOrmDbRepository;
use database_model::agent::prelude::{SoftwareBlockListColumn, SoftwareBlockListEntity};
use kernel::prelude::*;
use sea_orm::{ColumnTrait, EntityTrait, PaginatorTrait, QueryFilter};

#[async_trait::async_trait]
impl ISoftwareBlockListRepository for SeaOrmDbRepository {
    async fn is_software_version_blocked(
        &self,
        software_name: &str,
        version: &str,
    ) -> anyhow::Result<bool> {
        Ok(SoftwareBlockListEntity::find()
            .filter(SoftwareBlockListColumn::Name.eq(software_name))
            .filter(SoftwareBlockListColumn::Version.eq(version))
            .count(self.db.get_connection())
            .await?
            > 0)
    }
}
