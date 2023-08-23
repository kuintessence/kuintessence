//! 工作流节点实例
use crate::system::prelude::*;
use anyhow::anyhow;
use chrono::Utc;
use kernel::models::prelude::NodeInstance as KernelNodeInstance;
use num_traits::FromPrimitive;
use sea_orm::{entity::prelude::*, Set};
#[derive(Clone, Debug, PartialEq, DeriveEntityModel)]
#[sea_orm(table_name = "node_instance")]
pub struct Model {
    #[sea_orm(primary_key, auto_increment = false)]
    pub id: Uuid,
    pub name: String,
    pub kind: i32,
    pub is_parent: bool,
    pub batch_parent_id: Option<Uuid>,
    pub status: i32,
    pub resource_meter: Option<Json>,
    pub log: Option<String>,
    pub cluster_id: Option<Uuid>,
    pub flow_instance_id: Uuid,
    pub created_time: DateTimeUtc,
    pub last_modified_time: DateTimeUtc,
}

#[derive(Copy, Clone, Debug, EnumIter, DeriveRelation)]
pub enum Relation {
    #[sea_orm(
        belongs_to = "FlowInstanceEntity",
        from = "Column::FlowInstanceId",
        to = "FlowInstanceColumn::Id"
    )]
    FlowInstance,
    #[sea_orm(
        belongs_to = "Entity",
        from = "Column::BatchParentId",
        to = "Column::Id"
    )]
    SelfReferencing,
    #[sea_orm(
        belongs_to = "ClusterEntity",
        from = "Column::ClusterId",
        to = "ClusterColumn::Id"
    )]
    Cluster,
    #[sea_orm(has_many = "NodeInstanceFileEntity")]
    NodeInstanceFile,
    #[sea_orm(has_one = "NodeInstanceBillingEntity")]
    NodeInstanceBilling,
}

impl Related<FlowInstanceEntity> for Entity {
    fn to() -> RelationDef {
        Relation::FlowInstance.def()
    }
}

impl Related<ClusterEntity> for Entity {
    fn to() -> RelationDef {
        Relation::Cluster.def()
    }
}
impl Related<NodeInstanceFileEntity> for Entity {
    fn to() -> RelationDef {
        Relation::NodeInstanceFile.def()
    }
}
impl Related<NodeInstanceBillingEntity> for Entity {
    fn to() -> RelationDef {
        Relation::NodeInstanceBilling.def()
    }
}

impl ActiveModelBehavior for ActiveModel {}

pub struct SelfReferencingLink;

impl Linked for SelfReferencingLink {
    type FromEntity = Entity;
    type ToEntity = Entity;

    fn link(&self) -> Vec<RelationDef> {
        vec![Relation::SelfReferencing.def()]
    }
}

impl TryFrom<KernelNodeInstance> for Model {
    type Error = anyhow::Error;
    fn try_from(l: KernelNodeInstance) -> Result<Self, Self::Error> {
        Ok(Self {
            id: l.id,
            name: l.name,
            kind: l.kind as i32,
            is_parent: l.is_parent,
            batch_parent_id: l.batch_parent_id,
            status: l.status as i32,
            resource_meter: match l.resource_meter {
                Some(el) => Some(serde_json::to_value(el)?),
                None => None,
            },
            log: l.log,
            cluster_id: l.cluster_id,
            flow_instance_id: l.flow_instance_id,
            created_time: Utc::now(),
            last_modified_time: Utc::now(),
        })
    }
}

impl TryInto<KernelNodeInstance> for Model {
    type Error = anyhow::Error;

    fn try_into(self) -> Result<KernelNodeInstance, Self::Error> {
        Ok(KernelNodeInstance {
            kind: FromPrimitive::from_i32(self.kind)
                .ok_or(anyhow::anyhow!("Wrong node instance kind."))?,
            id: self.id,
            name: self.name,
            is_parent: self.is_parent,
            batch_parent_id: self.batch_parent_id,
            flow_instance_id: self.flow_instance_id,
            status: FromPrimitive::from_i32(self.status)
                .ok_or(anyhow::anyhow!("Wrong status type."))?,
            cluster_id: self.cluster_id,
            log: self.log,
            resource_meter: match self.resource_meter {
                Some(x) => Some(serde_json::from_value(x)?),
                None => None,
            },
        })
    }
}
impl TryInto<billing_system_kernel::prelude::NodeInstance> for Model {
    type Error = anyhow::Error;

    fn try_into(self) -> Result<billing_system_kernel::prelude::NodeInstance, Self::Error> {
        Ok(billing_system_kernel::prelude::NodeInstance {
            id: self.id,
            flow_id: self.flow_instance_id,
            cluster_id: self
                .cluster_id
                .ok_or(anyhow!("node: {} didn't assigned to a cluster", self.id))?,
            resource_meter: match self.resource_meter {
                Some(x) => serde_json::from_value(x)?,
                None => anyhow::bail!("node: {} didn't has resource meter", self.id),
            },
        })
    }
}

impl Model {
    pub fn into_set(self) -> ActiveModel {
        ActiveModel {
            id: Set(self.id),
            name: Set(self.name),
            kind: Set(self.kind),
            is_parent: Set(self.is_parent),
            batch_parent_id: Set(self.batch_parent_id),
            status: Set(self.status),
            resource_meter: Set(self.resource_meter),
            log: Set(self.log),
            cluster_id: Set(self.cluster_id),
            flow_instance_id: Set(self.flow_instance_id),
            created_time: sea_orm::ActiveValue::Unchanged(self.created_time),
            last_modified_time: sea_orm::ActiveValue::Unchanged(self.last_modified_time),
        }
    }
}
