//! 可用区
use crate::system::prelude::*;
use sea_orm::entity::prelude::*;

#[derive(Clone, Debug, PartialEq, DeriveEntityModel)]
#[sea_orm(table_name = "available_zone")]
pub struct Model {
    #[sea_orm(primary_key, auto_increment = false)]
    pub id: Uuid,
    pub name: String,
    pub region_id: Uuid,
}

#[derive(Copy, Clone, Debug, EnumIter, DeriveRelation)]
pub enum Relation {
    #[sea_orm(has_many = "ClusterEntity")]
    Cluster,
    #[sea_orm(
        belongs_to = "RegionEntity",
        from = "Column::RegionId",
        to = "RegionColumn::Id"
    )]
    Region,
    #[sea_orm(has_many = "StorageServerEntity")]
    StorageServer,
}

impl Related<ClusterEntity> for Entity {
    fn to() -> RelationDef {
        Relation::Cluster.def()
    }
}

impl Related<RegionEntity> for Entity {
    fn to() -> RelationDef {
        Relation::Region.def()
    }
}

impl Related<StorageServerEntity> for Entity {
    fn to() -> RelationDef {
        Relation::StorageServer.def()
    }
}

impl ActiveModelBehavior for ActiveModel {}
