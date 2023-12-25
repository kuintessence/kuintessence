use database_model::installed_software;
use domain_workflow::repository::InstalledSoftwareRepo;
use sea_orm::prelude::*;
use sea_orm::sea_query::Expr;

use crate::infrastructure::database::OrmRepo;

#[async_trait::async_trait]
impl InstalledSoftwareRepo for OrmRepo {
    async fn is_software_satisfied(
        &self,
        software_name: &str,
        required_install_arguments: &[String],
    ) -> anyhow::Result<bool> {
        let installed_software_list = installed_software::Entity::find()
            .filter(Expr::col(installed_software::Column::SoftwareName).eq(software_name))
            .all(self.db.get_connection())
            .await?;
        let mut r = true;
        for installed_software in installed_software_list {
            let repo_install_arguments =
                serde_json::from_value::<Vec<String>>(installed_software.install_argument)?;
            for required_install_argument in required_install_arguments.iter() {
                if !repo_install_arguments.contains(&required_install_argument.to_string()) {
                    r = false;
                    break;
                }
            }
        }
        Ok(r)
    }
}
