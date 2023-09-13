use alice_architecture::model::derive::AggregateRoot;
use serde::{Deserialize, Serialize};
use uuid::Uuid;

use crate::model::vo::HashAlgorithm;

/// Snapshot record.
#[derive(Debug, Serialize, Deserialize, AggregateRoot)]
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
}
