//! 已经安装的软件
use crate::agent::software_source::prelude::*;
use sea_orm::entity::prelude::*;
#[derive(Clone, Debug, PartialEq, DeriveEntityModel)]
#[sea_orm(table_name = "installed_software")]
pub struct Model {
    #[sea_orm(primary_key, auto_increment = false)]
    pub id: Uuid,
    pub source_id: Uuid,
    pub software_id: Uuid,
    pub software_name: String,
    pub install_argument: Json,
    pub installed_time: DateTimeUtc,
    pub installed_user_id: Uuid,
}
#[derive(Copy, Clone, Debug, EnumIter, DeriveRelation)]
pub enum Relation {
    #[sea_orm(
        belongs_to = "SoftwareSourceEntity",
        from = "Column::SourceId",
        to = "SoftwareSourceColumn::Id"
    )]
    SoftwareSource,
}
impl Related<SoftwareSourceEntity> for Entity {
    fn to() -> RelationDef {
        Relation::SoftwareSource.def()
    }
}
impl ActiveModelBehavior for ActiveModel {}

pub mod prelude {
    pub use super::{
        ActiveModel as InstalledSoftwareActiveModel, Column as InstalledSoftwareColumn,
        Entity as InstalledSoftwareEntity, Model as InstalledSoftwareModel,
        PrimaryKey as InstalledSoftwarePrimaryKey, Relation as InstalledSoftwareRelation,
    };
}
