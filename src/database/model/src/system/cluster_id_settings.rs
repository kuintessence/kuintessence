use crate::system::prelude::*;
use crate::utils::WithDecimalFileds;
use billing_system_kernel::prelude::*;
use chrono::Utc;
use sea_orm::{entity::prelude::*, Set};

#[derive(Clone, Debug, PartialEq, DeriveEntityModel, Eq)]
#[sea_orm(table_name = "cluster_id_settings")]
pub struct Model {
    #[sea_orm(primary_key, auto_increment = false)]
    pub id: Uuid,
    #[sea_orm(unique)]
    pub cluster_id: Uuid,
    #[sea_orm(column_type = "Decimal(Some((20, 10)))")]
    pub cpu: Decimal,
    #[sea_orm(column_type = "Decimal(Some((20, 10)))")]
    pub memory: Decimal,
    #[sea_orm(column_type = "Decimal(Some((20, 10)))")]
    pub storage: Decimal,
    #[sea_orm(column_type = "Decimal(Some((20, 10)))")]
    pub cpu_time: Decimal,
    #[sea_orm(column_type = "Decimal(Some((20, 10)))")]
    pub wall_time: Decimal,
    pub formula: String,
    pub created_time: DateTimeUtc,
    pub modified_time: DateTimeUtc,
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

impl TryInto<ClusterIdSettings> for Model {
    type Error = anyhow::Error;

    fn try_into(self) -> Result<ClusterIdSettings, Self::Error> {
        Ok(ClusterIdSettings {
            id: self.id,
            cluster_id: self.cluster_id,
            cpu: self.cpu,
            memory: self.memory,
            storage: self.storage,
            cpu_time: self.cpu_time,
            wall_time: self.wall_time,
            formula: self.formula,
        })
    }
}

impl TryFrom<ClusterIdSettings> for Model {
    type Error = anyhow::Error;

    fn try_from(l: ClusterIdSettings) -> Result<Self, Self::Error> {
        Ok(Self {
            id: l.id,
            cluster_id: l.cluster_id,
            cpu: l.cpu,
            memory: l.memory,
            storage: l.storage,
            cpu_time: l.cpu_time,
            wall_time: l.wall_time,
            formula: l.formula,
            created_time: Utc::now(),
            modified_time: Utc::now(),
        })
    }
}

impl Model {
    pub fn into_set(self) -> ActiveModel {
        ActiveModel {
            id: Set(self.id),
            cluster_id: Set(self.cluster_id),
            cpu: Set(self.cpu),
            memory: Set(self.memory),
            storage: Set(self.storage),
            cpu_time: Set(self.cpu_time),
            wall_time: Set(self.wall_time),
            formula: Set(self.formula),
            created_time: Set(self.created_time),
            modified_time: Set(self.modified_time),
        }
    }
}
impl WithDecimalFileds for Model {
    fn rescale_all_to(&mut self, n: u32) {
        self.cpu.rescale(n);
        self.memory.rescale(n);
        self.storage.rescale(n);
        self.cpu_time.rescale(n);
        self.wall_time.rescale(n);
    }
}
