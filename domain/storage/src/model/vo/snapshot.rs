use serde::{Deserialize, Serialize};
use uuid::Uuid;

/// 快照信息
#[derive(Clone, Serialize, Deserialize, Debug, Default)]
#[serde(rename_all = "camelCase")]
pub struct SnapshotInfo {
    /// id
    pub id: Uuid,
    /// node id
    pub node_id: Uuid,
    /// file id
    pub file_id: Uuid,
    /// snapshot timestamp
    pub timestamp: i64,
}

#[derive(Clone, Serialize, Deserialize, Debug, Default)]
#[serde(rename_all = "camelCase")]
pub struct CreateSnapshot {
    /// node id
    pub node_id: Uuid,
    /// file id
    pub file_id: Uuid,
    /// snapshot timestamp
    pub timestamp: i64,
}
