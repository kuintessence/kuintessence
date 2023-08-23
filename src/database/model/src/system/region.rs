//! 区域
use crate::system::prelude::*;
use sea_orm::entity::prelude::*;

#[derive(Clone, Debug, PartialEq, DeriveEntityModel)]
#[sea_orm(table_name = "region")]
pub struct Model {
    #[sea_orm(primary_key, auto_increment = false)]
    pub id: Uuid,
    pub name: String,
    /// 显示地址
    pub address: String,
    /// Gis 信息
    pub location: Json,
    /// 属于的组织
    pub organization_id: Uuid,
    /// 邮政编码
    pub postal_code: String,
    /// 邮寄地址
    pub mailing_address: String,
}

#[derive(Copy, Clone, Debug, EnumIter, DeriveRelation)]
pub enum Relation {
    #[sea_orm(has_many = "AvailableZoneEntity")]
    AvailableZone,
}

impl Related<AvailableZoneEntity> for Entity {
    fn to() -> RelationDef {
        Relation::AvailableZone.def()
    }
}

impl ActiveModelBehavior for ActiveModel {}
