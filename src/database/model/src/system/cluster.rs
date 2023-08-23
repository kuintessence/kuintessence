//! 集群
use crate::system::prelude::*;
use kernel::models::prelude::Cluster;
use num_traits::FromPrimitive;
use sea_orm::{entity::prelude::*, Set};
use std::str::FromStr;

#[derive(Clone, Debug, PartialEq, DeriveEntityModel)]
#[sea_orm(table_name = "cluster")]
pub struct Model {
    #[sea_orm(primary_key, auto_increment = false)]
    pub id: Uuid,
    pub name: String,
    /// 订阅的消息队列主题名称
    pub topic_name: String,
    pub available_zone_id: Uuid,
    pub cluster_tech: i32,
    pub enabled: bool,
}

#[derive(Copy, Clone, Debug, EnumIter, DeriveRelation)]
pub enum Relation {
    #[sea_orm(
        belongs_to = "AvailableZoneEntity",
        from = "Column::AvailableZoneId",
        to = "AvailableZoneColumn::Id"
    )]
    AvailableZone,
    #[sea_orm(has_many = "UserResourceEntity")]
    UserResource,
    #[sea_orm(has_one = "ClusterResourceEntity")]
    ClusterResource,
    #[sea_orm(has_one = "ClusterIdSettingsEntity")]
    ClusterIdSettings,
}

impl Related<AvailableZoneEntity> for Entity {
    fn to() -> RelationDef {
        Relation::AvailableZone.def()
    }
}

impl Related<UserResourceEntity> for Entity {
    fn to() -> RelationDef {
        Relation::UserResource.def()
    }
}

impl Related<ClusterResourceEntity> for Entity {
    fn to() -> RelationDef {
        Relation::ClusterResource.def()
    }
}

impl Related<ClusterIdSettingsEntity> for Entity {
    fn to() -> RelationDef {
        Relation::ClusterIdSettings.def()
    }
}

impl ActiveModelBehavior for ActiveModel {}

impl TryFrom<Cluster> for Model {
    type Error = anyhow::Error;
    fn try_from(l: Cluster) -> Result<Self, Self::Error> {
        Ok(Self {
            id: Uuid::from_str(&l.id)?,
            name: l.name,
            topic_name: l.topic_name,
            available_zone_id: Uuid::from_str(&l.available_zone_id)?,
            cluster_tech: l.cluster_tech as i32,
            enabled: l.enabled,
        })
    }
}

impl TryInto<Cluster> for Model {
    type Error = anyhow::Error;

    fn try_into(self) -> Result<Cluster, Self::Error> {
        Ok(Cluster {
            id: self.id.to_string(),
            name: self.name,
            topic_name: self.topic_name,
            available_zone_id: self.available_zone_id.to_string(),
            cluster_tech: FromPrimitive::from_i32(self.cluster_tech)
                .ok_or(anyhow::anyhow!("No such cluter tech type!"))?,
            enabled: self.enabled,
        })
    }
}

impl Model {
    pub fn into_set(self) -> ActiveModel {
        ActiveModel {
            id: Set(self.id),
            name: Set(self.name),
            topic_name: Set(self.topic_name),
            available_zone_id: Set(self.available_zone_id),
            cluster_tech: Set(self.cluster_tech),
            enabled: Set(self.enabled),
        }
    }
}
