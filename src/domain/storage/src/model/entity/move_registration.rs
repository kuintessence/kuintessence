use alice_architecture::utils::*;
use alice_architecture::IAggregateRoot;

use super::net_disk::{FileType, RecordNetDiskKind};
use crate::model::vo::HashAlgorithm;

#[derive(Serialize, Deserialize, IAggregateRoot)]
/// A pending file move information.
pub struct MoveRegistration {
    pub id: Uuid,
    /// Id of the file to move
    pub meta_id: Uuid,
    pub file_name: String,
    pub hash: String,
    pub hash_algorithm: HashAlgorithm,
    pub size: usize,
    /// Destination of the file move.
    pub destination: MoveDestination,
    pub is_upload_failed: bool,
    pub failed_reason: Option<String>,
    pub user_id: Option<Uuid>,
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
/// Destination of file moving.
pub enum MoveDestination {
    /// Move to snapshot.
    Snapshot {
        node_id: Uuid,
        timestamp: i64,
        /// Unuploaded file meta id in agent.
        file_id: Uuid,
    },
    /// When a file is moved to storage server, it also need to be recorded in file_metadata and file_storage, and perhaps net disk.
    ///
    /// It holds information about file_metadata, file_storage, and optional net disk infomation.
    StorageServer {
        record_net_disk: Option<RecordNetDisk>,
    },
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RecordNetDisk {
    pub file_type: FileType,
    pub kind: RecordNetDiskKind,
}

impl std::fmt::Display for MoveDestination {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            MoveDestination::Snapshot { .. } => write!(f, "Snapshot"),
            MoveDestination::StorageServer { .. } => write!(f, "StorageServer"),
        }
    }
}
