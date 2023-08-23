use crate::prelude::*;
use alice_architecture::model::IAggregateRoot;

impl IAggregateRoot for FileStorage {}

/// Record File meta and its stored server.
#[derive(Debug, Clone)]
pub struct FileStorage {
    /// Storage server id.
    pub storage_server_id: Uuid,
    /// File meta id.
    pub meta_id: Uuid,
    /// The relative url on the server.
    pub server_url: String,
}
