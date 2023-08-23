//! 用户集群资源
use crate::system::prelude::*;
use sea_orm::entity::prelude::*;

#[derive(Clone, Debug, PartialEq, DeriveEntityModel)]
#[sea_orm(table_name = "user_resource")]
pub struct Model {
    #[sea_orm(primary_key, auto_increment = false)]
    pub id: Uuid,
    pub user_id: Uuid,
    /// 内存大小，单位为字节
    pub memory: i64,
    /// 设置内存可用最大大小，单位为字节
    pub memory_max: i64,
    /// 使用达到多少时（单位为字节）向算力提供者以及算力运营者告警
    pub memory_alert: i64,
    /// 核心数
    pub core_number: i64,
    pub core_number_max: i64,
    pub core_number_alert: i64,
    /// 存储空间大小，单位为字节
    pub storage_capacity: i64,
    pub storage_capacity_max: i64,
    pub storage_capacity_alert: i64,
    pub cluster_id: Uuid,
}

#[derive(Copy, Clone, Debug, EnumIter, DeriveRelation)]
pub enum Relation {
    #[sea_orm(
        belongs_to = "ClusterEntity",
        from = "Column::ClusterId",
        to = "ClusterColumn::Id"
    )]
    Cluster,
}

impl Related<ClusterEntity> for Entity {
    fn to() -> RelationDef {
        Relation::Cluster.def()
    }
}

impl ActiveModelBehavior for ActiveModel {}
