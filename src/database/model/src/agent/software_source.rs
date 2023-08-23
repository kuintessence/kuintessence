//! 软件源
use crate::agent::installed_software::prelude::*;
use sea_orm::entity::prelude::*;
#[derive(Clone, Debug, PartialEq, DeriveEntityModel)]
#[sea_orm(table_name = "software_source")]
pub struct Model {
    #[sea_orm(primary_key, auto_increment = false)]
    pub id: Uuid,
    pub name: String,
    /// 比如本地还是远程
    pub r#type: i32,
    /// 如果是远程，远程仓库地址
    pub url: Option<String>,
    /// 如果是远程，连接远程仓库使用的用户名
    pub username: Option<String>,
    /// 如果是远程，连接远程仓库使用的密码
    pub password: Option<String>,
}
#[derive(Copy, Clone, Debug, EnumIter, DeriveRelation)]
pub enum Relation {
    #[sea_orm(has_many = "InstalledSoftwareEntity")]
    InstalledSoftware,
}
impl Related<InstalledSoftwareEntity> for Entity {
    fn to() -> RelationDef {
        Relation::InstalledSoftware.def()
    }
}
impl ActiveModelBehavior for ActiveModel {}

pub mod prelude {
    pub use super::{
        ActiveModel as SoftwareSourceActiveModel, Column as SoftwareSourceColumn,
        Entity as SoftwareSourceEntity, Model as SoftwareSourceModel,
        PrimaryKey as SoftwareSourcePrimaryKey, Relation as SoftwareSourceRelation,
    };
}
