use alice_architecture::model::IAggregateRoot;
use serde::{Deserialize, Serialize};
use uuid::Uuid;

impl IAggregateRoot for WsFileInfo {}

#[derive(Clone, Serialize, Deserialize)]
pub struct WsFileInfo {
    pub request_id: Uuid,
    pub client_id: Uuid,
    // pub file_id: Uuid,
    // pub node_instance_id: Uuid,
}

impl WsFileInfo {
    pub fn new(request_id: Uuid, client_id: Uuid) -> Self {
        Self {
            request_id,
            client_id,
        }
    }
}
