use serde::{Deserialize, Serialize};
use uuid::Uuid;

use crate::model::entity::net_disk::{FileType, RecordNetDiskKind};
use crate::model::vo::Part;

// use crate::model::

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FileUploadCommand {
    pub move_id: Uuid,
    pub user_id: Uuid,
}

/// View realtime file message.
#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ViewRealtimeCommand {
    #[serde(skip_deserializing)]
    pub req_id: Uuid,
    #[serde(rename = "nodeInstanceId")]
    pub node_id: Uuid,
    #[serde(rename = "fileMetadataId")]
    pub meta_id: Uuid,
    pub start_row: i64,
    pub rows_per_page: i64,
    pub regex: String,
}

/// Request snapshot command.
#[derive(Debug, Default, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RequestSnapshotCommand {
    /// node id
    pub node_id: Uuid,
    /// file id
    pub file_id: Uuid,
    /// timestamp
    pub timestamp: i64,
}

pub enum CacheOperateCommand {
    /// Whole file upload or complete multipart.
    WriteNormal { meta_id: Uuid, content: Vec<u8> },
    /// Complete a part of multipart.
    WritePart(Part),
    /// Remove multipart dir.
    RemoveMultipartDir { meta_id: Uuid },
    /// Remove normal file.
    RemoveNormal { meta_id: Uuid },
    /// Change normal file to snapshot file.
    ChangeNormalToSnapshot { meta_id: Uuid },
    /// Remove snapshot file.
    RemoveSnapshot { meta_id: Uuid },
    /// Ok if exists, else Err
    IsSnapshotExists { meta_id: Uuid },
}

pub enum CacheReadCommand {
    ReadNormal { meta_id: Uuid },
    ReadSnapshot { meta_id: Uuid },
    ReadPart { meta_id: Uuid, nth: usize },
}

pub struct CreateNetDiskFileCommand {
    pub meta_id: Uuid,
    pub file_name: String,
    pub file_type: FileType,
    pub kind: RecordNetDiskKind,
}
