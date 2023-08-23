//! 工作流实例
use crate::system::prelude::*;
use billing_system_kernel::prelude::*;
use chrono::Utc;
use kernel::models::prelude::WorkflowInstance;
use num_traits::FromPrimitive;
use sea_orm::entity::prelude::*;

// use serde::{Deserialize, Serialize};
#[derive(Clone, Debug, PartialEq, DeriveEntityModel)]
#[sea_orm(table_name = "flow_instance")]
pub struct Model {
    #[sea_orm(primary_key, auto_increment = false)]
    pub id: Uuid,
    pub name: String,
    pub description: String,
    #[sea_orm(column_type = "Text")]
    pub logo: Option<String>,
    pub status: i32,
    pub spec: Json,
    pub user_id: Uuid,
    pub created_time: DateTimeUtc,
    pub last_modified_time: DateTimeUtc,
}

#[derive(Copy, Clone, Debug, EnumIter, DeriveRelation)]
pub enum Relation {
    #[sea_orm(has_many = "NodeInstanceEntity")]
    NodeInstance,
    #[sea_orm(has_one = "FlowInstanceBillingEntity")]
    FlowInstanceBilling,
}

impl Related<NodeInstanceEntity> for Entity {
    fn to() -> RelationDef {
        Relation::NodeInstance.def()
    }
}
impl Related<FlowInstanceBillingEntity> for Entity {
    fn to() -> RelationDef {
        Relation::FlowInstanceBilling.def()
    }
}

impl ActiveModelBehavior for ActiveModel {}

impl TryInto<WorkflowInstance> for Model {
    type Error = anyhow::Error;

    fn try_into(self) -> Result<WorkflowInstance, Self::Error> {
        Ok(WorkflowInstance {
            id: self.id,
            name: self.name,
            description: self.description,
            logo: self.logo,
            status: FromPrimitive::from_i32(self.status)
                .ok_or(anyhow::anyhow!("Status is invalid."))?,
            spec: serde_json::from_value(self.spec)?,
            last_modified_time: self.last_modified_time,
            user_id: self.user_id,
        })
    }
}
impl TryInto<FlowInstance> for Model {
    type Error = anyhow::Error;

    fn try_into(self) -> Result<FlowInstance, Self::Error> {
        Ok(FlowInstance {
            id: self.id,
            user_id: self.user_id,
        })
    }
}

impl TryFrom<WorkflowInstance> for Model {
    type Error = anyhow::Error;

    fn try_from(l: WorkflowInstance) -> Result<Self, Self::Error> {
        Ok(Self {
            id: l.id,
            name: l.name,
            description: l.description,
            logo: l.logo,
            status: l.status as i32,
            spec: serde_json::to_value(l.spec)?,
            user_id: l.user_id,
            created_time: Utc::now(),
            last_modified_time: l.last_modified_time,
        })
    }
}
