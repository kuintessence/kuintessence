use alice_architecture::model::IAggregateRoot;
use serde::{Deserialize, Serialize};
use uuid::Uuid;

impl IAggregateRoot for SnapshotInfo {}

#[derive(Clone, Serialize, Deserialize, Debug, Default)]
#[serde(rename_all = "camelCase")]
/// 集群信息
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
