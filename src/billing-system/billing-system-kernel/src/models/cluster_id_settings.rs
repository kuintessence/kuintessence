use rust_decimal::Decimal;
use serde::{Deserialize, Serialize};
use uuid::Uuid;

impl alice_architecture::model::IAggregateRoot for ClusterIdSettings {}
#[derive(Clone, Serialize, Deserialize, Default, Debug)]
pub struct ClusterIdSettings {
    pub id: Uuid,
    pub cluster_id: Uuid,
    pub cpu: Decimal,
    pub memory: Decimal,
    pub storage: Decimal,
    pub cpu_time: Decimal,
    pub wall_time: Decimal,
    pub formula: String,
}
