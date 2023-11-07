use database_model::agent::prelude::{SoftwareBlockListColumn, SoftwareBlockListEntity};
use domain_workflow::repository::SoftwareBlockListRepo;
use sea_orm::prelude::*;

use crate::infrastructure::database::OrmRepo;

#[async_trait::async_trait]
impl SoftwareBlockListRepo for OrmRepo {
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
