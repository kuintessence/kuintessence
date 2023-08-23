use rust_decimal::Decimal;
use serde::{Deserialize, Serialize};
use uuid::Uuid;

impl alice_architecture::model::IAggregateRoot for NodeInstanceBilling {}
#[derive(Clone, Serialize, Deserialize, Default, Debug)]
pub struct NodeInstanceBilling {
    pub id: Uuid,
    pub node_instance_id: Uuid,
    pub flow_instance_id: Uuid,
    pub cpu: i64,
    pub memory: i64,
    pub storage: i64,
    pub cpu_time: i64,
    pub wall_time: i64,
    pub price: Decimal,
    pub formula: String,
}
