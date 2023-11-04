use alice_architecture::model::AggregateRoot;
use serde::{Deserialize, Serialize};
use uuid::Uuid;

#[derive(Debug, Clone, Serialize, Deserialize, AggregateRoot)]
pub struct WsReqInfo {
    pub request_id: Uuid,
    pub client_id: Uuid,
}
