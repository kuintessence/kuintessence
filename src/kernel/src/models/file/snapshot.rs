use crate::prelude::*;
use alice_architecture::IAggregateRoot;

impl IAggregateRoot for Snapshot {}

/// Snapshot record.
#[derive(Serialize, Deserialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Snapshot {
    /// Snapshot id.
    pub id: Uuid,
    /// Snapshot file's origin file meta id. Is the meta_id of snapshot multipart upload.
    pub meta_id: Uuid,
    /// Node id
    pub node_id: Uuid,
    /// Generating and unuploaded meta id in agent.
    pub file_id: Uuid,
    /// Snapshot timestamp
    pub timestamp: i64,
    /// Snapshot file name
    pub file_name: String,
    pub size: usize,
    pub hash: String,
    pub hash_algorithm: HashAlgorithm,
    pub user_id: Uuid,
}
