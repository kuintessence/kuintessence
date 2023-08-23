//! 枚举字典
use crate::system::prelude::*;
use sea_orm::entity::prelude::*;

#[derive(Clone, Debug, PartialEq, DeriveEntityModel)]
#[sea_orm(table_name = "dictionary")]
pub struct Model {
    #[sea_orm(primary_key, auto_increment = false)]
    pub id: Uuid,
    pub name: String,
    #[sea_orm(column_type = "Text")]
    pub description: String,
    /// 是否启用
    pub status: bool,
    pub created_time: DateTimeUtc,
}

#[derive(Copy, Clone, Debug, EnumIter, DeriveRelation)]
pub enum Relation {
    #[sea_orm(has_many = "DictionaryValueEntity")]
    DictionaryValue,
}

impl Related<DictionaryValueEntity> for Entity {
    fn to() -> RelationDef {
        Relation::DictionaryValue.def()
    }
}

impl ActiveModelBehavior for ActiveModel {}
