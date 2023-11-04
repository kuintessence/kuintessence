use alice_architecture::model::AggregateRoot;
use serde::{Deserialize, Serialize};
use uuid::Uuid;

#[derive(Debug, AggregateRoot, Clone, Serialize, Deserialize)]
pub struct TextStorage {
    pub key: Option<Uuid>,
    pub value: String,
}
