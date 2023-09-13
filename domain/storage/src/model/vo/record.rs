use serde::{Deserialize, Serialize};
use uuid::Uuid;

use super::HashAlgorithm;

pub struct RecordFileMeta {
    pub name: String,
    pub hash: String,
    pub hash_algorithm: HashAlgorithm,
    pub size: usize,
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RecordFileStorage {
    pub storage_server_id: Uuid,
    pub server_url: String,
}
