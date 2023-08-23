use crate::system::prelude::*;
use crate::utils::WithDecimalFileds;
use billing_system_kernel::prelude::*;
use chrono::Utc;
use sea_orm::{entity::prelude::*, Set};

#[derive(Clone, Debug, PartialEq, DeriveEntityModel, Eq)]
#[sea_orm(table_name = "node_instance_billing")]
pub struct Model {
    #[sea_orm(primary_key, auto_increment = false)]
    pub id: Uuid,
    #[sea_orm(unique)]
    pub node_instance_id: Uuid,
    pub flow_instance_id: Uuid,
    pub cpu: i64,
    pub memory: i64,
    pub storage: i64,
    pub cpu_time: i64,
    pub wall_time: i64,
    #[sea_orm(column_type = "Decimal(Some((20, 10)))")]
    pub price: Decimal,
    pub formula: String,
    pub created_time: DateTimeUtc,
    pub modified_time: DateTimeUtc,
}
#[derive(Copy, Clone, Debug, EnumIter, DeriveRelation)]
pub enum Relation {
    #[sea_orm(
        belongs_to = "NodeInstanceEntity",
        from = "Column::NodeInstanceId",
        to = "NodeInstanceColumn::Id"
    )]
    NodeInstance,
}
impl Related<NodeInstanceEntity> for Entity {
    fn to() -> RelationDef {
        Relation::NodeInstance.def()
    }
}
impl ActiveModelBehavior for ActiveModel {}

impl TryInto<NodeInstanceBilling> for Model {
    type Error = anyhow::Error;

    fn try_into(self) -> Result<NodeInstanceBilling, Self::Error> {
        Ok(NodeInstanceBilling {
            id: self.id,
            flow_instance_id: self.flow_instance_id,
            node_instance_id: self.node_instance_id,
            cpu: self.cpu,
            memory: self.memory,
            storage: self.storage,
            cpu_time: self.cpu_time,
            wall_time: self.wall_time,
            price: self.price,
            formula: self.formula,
        })
    }
}

impl TryFrom<NodeInstanceBilling> for Model {
    type Error = anyhow::Error;

    fn try_from(l: NodeInstanceBilling) -> Result<Self, Self::Error> {
        Ok(Self {
            id: l.id,
            flow_instance_id: l.flow_instance_id,
            node_instance_id: l.node_instance_id,
            cpu: l.cpu,
            memory: l.memory,
            storage: l.storage,
            cpu_time: l.cpu_time,
            wall_time: l.wall_time,
            price: l.price,
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
            flow_instance_id: Set(self.flow_instance_id),
            node_instance_id: Set(self.node_instance_id),
            cpu: Set(self.cpu),
            memory: Set(self.memory),
            storage: Set(self.storage),
            cpu_time: Set(self.cpu_time),
            wall_time: Set(self.wall_time),
            price: Set(self.price),
            formula: Set(self.formula),
            created_time: Set(self.created_time),
            modified_time: Set(self.modified_time),
        }
    }
}
impl WithDecimalFileds for Model {
    fn rescale_all_to(&mut self, n: u32) {
        self.price.rescale(n);
    }
}
