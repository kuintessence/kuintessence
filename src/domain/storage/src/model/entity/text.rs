use alice_architecture::IAggregateRoot;
use serde::{Deserialize, Serialize};
use uuid::Uuid;

#[derive(Debug, IAggregateRoot, Clone, Serialize, Deserialize)]
pub struct TextStorage {
    pub key: Option<Uuid>,
    pub value: String,
}
