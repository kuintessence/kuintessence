use alice_architecture::model::IAggregateRoot;
use serde::{Deserialize, Serialize};
use uuid::Uuid;

impl IAggregateRoot for TextStorage {}

#[derive(Clone, Serialize, Deserialize)]
pub struct TextStorage {
    pub key: Option<Uuid>,
    pub value: String,
}
