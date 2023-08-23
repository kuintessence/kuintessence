//! 软件安装记录
use sea_orm::entity::prelude::*;
#[derive(Clone, Debug, PartialEq, DeriveEntityModel)]
#[sea_orm(table_name = "software_install_history")]
pub struct Model {
    #[sea_orm(primary_key, auto_increment = false)]
    pub id: Uuid,
    pub name: String,
    pub status: i32,
    #[sea_orm(column_type = "Text")]
    pub log: String,
    pub start_time: DateTimeUtc,
    pub end_time: DateTimeUtc,
    pub request_user_id: Uuid,
}
#[derive(Copy, Clone, Debug, EnumIter, DeriveRelation)]
pub enum Relation {}
impl ActiveModelBehavior for ActiveModel {}

pub mod prelude {
    pub use super::{
        ActiveModel as SoftwareInstallHistoryActiveModel, Column as SoftwareInstallHistoryColumn,
        Entity as SoftwareInstallHistoryEntity, Model as SoftwareInstallHistoryModel,
        PrimaryKey as SoftwareInstallHistoryPrimaryKey, Relation as SoftwareInstallHistoryRelation,
    };
}
