//! 软件阻止清单
use sea_orm::entity::prelude::*;
#[derive(Clone, Debug, PartialEq, DeriveEntityModel)]
#[sea_orm(table_name = "software_block_list")]
pub struct Model {
    #[sea_orm(primary_key, auto_increment = false)]
    pub id: Uuid,
    pub name: String,
    pub version: String,
    pub created_user_id: Uuid,
    pub created_time: DateTimeUtc,
    pub last_modified_time: DateTimeUtc,
}
#[derive(Copy, Clone, Debug, EnumIter, DeriveRelation)]
pub enum Relation {}
impl ActiveModelBehavior for ActiveModel {}

pub mod prelude {
    pub use super::{
        ActiveModel as SoftwareBlockListActiveModel, Column as SoftwareBlockListColumn,
        Entity as SoftwareBlockListEntity, Model as SoftwareBlockListModel,
        PrimaryKey as SoftwareBlockListPrimaryKey, Relation as SoftwareBlockListRelation,
    };
}
