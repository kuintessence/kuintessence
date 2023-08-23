use alice_architecture::model::IAggregateRoot;
use serde::{Deserialize, Serialize};
use uuid::Uuid;

impl IAggregateRoot for StorageServer {}

/// Storage server.
#[derive(Clone, Debug)]
pub struct StorageServer {
    /// Server id.
    pub id: Uuid,
    /// Server name.
    pub name: String,
    /// Server capacity.
    pub capacity: u64,
    /// Storage type.
    pub storage_type: StorageType,
    /// Available zone id.
    pub available_zone_id: Uuid,
}

#[derive(Clone, Serialize, Deserialize, Debug)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum StorageType {
    ObjectStorage {
        #[serde(flatten)]
        options: ObjectServerOption,
    },
}

#[derive(Clone, Default, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ObjectServerOption {
    pub endpoint: String,
    pub download_endpoint: String,
    pub default_bucket: String,
    pub access_key_id: String,
    pub secret_access_key: String,
    pub region: String,
}
