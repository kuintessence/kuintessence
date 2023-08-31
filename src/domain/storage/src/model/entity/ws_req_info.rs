use alice_architecture::utils::*;
use alice_architecture::IAggregateRoot;

#[derive(Debug, Clone, Serialize, Deserialize, IAggregateRoot)]
pub struct WsReqInfo {
    pub request_id: Uuid,
    pub client_id: Uuid,
}
