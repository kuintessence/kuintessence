use crate::prelude::*;
use alice_architecture::IAggregateRoot;

impl IAggregateRoot for WsReqInfo {}

#[derive(Clone, Serialize, Deserialize)]
pub struct WsReqInfo {
    pub request_id: Uuid,
    pub client_id: Uuid,
}
