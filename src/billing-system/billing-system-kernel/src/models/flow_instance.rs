use alice_architecture::model::IAggregateRoot;
use serde::{Deserialize, Serialize};
use uuid::Uuid;

impl IAggregateRoot for FlowInstance {}

#[derive(Serialize, Deserialize)]
pub struct FlowInstance {
    pub id: Uuid,
    pub user_id: Uuid,
}
