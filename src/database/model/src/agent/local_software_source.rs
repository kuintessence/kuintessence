//! 本地软件源
use sea_orm::entity::prelude::*;
#[derive(Clone, Debug, PartialEq, DeriveEntityModel)]
#[sea_orm(table_name = "local_software_source")]
pub struct Model {
    #[sea_orm(primary_key, auto_increment = false)]
    pub id: Uuid,
    pub name: String,
    pub version: String,
    /// Spack 安装参数
    pub software_install_argument: Json,
    pub exe_path: String,
}
#[derive(Copy, Clone, Debug, EnumIter, DeriveRelation)]
pub enum Relation {}
impl ActiveModelBehavior for ActiveModel {}

pub mod prelude {
    pub use super::{
        ActiveModel as LocalSoftwareSourceActiveModel, Column as LocalSoftwareSourceColumn,
        Entity as LocalSoftwareSourceEntity, Model as LocalSoftwareSourceModel,
        PrimaryKey as LocalSoftwareSourcePrimaryKey, Relation as LocalSoftwareSourceRelation,
    };
}
