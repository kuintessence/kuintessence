use database_model::software_block_list;
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
        Ok(software_block_list::Entity::find()
            .filter(software_block_list::Column::Name.eq(software_name))
            .filter(software_block_list::Column::Version.eq(version))
            .count(self.db.get_connection())
            .await?
            > 0)
    }
}
