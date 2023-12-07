use actix_easy_multipart::{tempfile::Tempfile, text::Text, MultipartForm};
use domain_storage::model::{
    entity::{FileType, MoveRegistration, RecordNetDiskKind},
    vo::{HashAlgorithm, MoveDestination, RecordNetDisk},
};
use domain_workflow::model::entity::queue::{QueueCacheInfo, QueueResourceUsed, QueueTaskCount};
use serde::{Deserialize, Serialize};
use uuid::Uuid;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentRegisterDto {
    pub memory: i64,
    pub core_number: i64,
    pub storage_capacity: i64,
    pub node_number: i64,
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateUsedResourceDto {
    pub allocated_memory: i64,
    pub allocated_cpu_count: i64,
    pub used_storage: i64,
    pub queuing_task_count: i64,
    pub running_task_count: i64,
    pub used_node_count: i64,
}

impl From<QueueCacheInfo> for UpdateUsedResourceDto {
    fn from(info: QueueCacheInfo) -> Self {
        UpdateUsedResourceDto {
            allocated_memory: info.used.memory_used,
            allocated_cpu_count: info.used.core_number_used,
            used_storage: info.used.storage_capacity_used,
            queuing_task_count: info.task_count.queuing_task_count,
            running_task_count: info.task_count.running_task_count,
            used_node_count: info.used.node_number_used,
        }
    }
}

impl From<UpdateUsedResourceDto> for QueueCacheInfo {
    fn from(val: UpdateUsedResourceDto) -> Self {
        QueueCacheInfo {
            used: QueueResourceUsed {
                memory_used: val.allocated_memory,
                core_number_used: val.allocated_cpu_count,
                storage_capacity_used: val.used_storage,
                node_number_used: val.used_node_count,
            },
            task_count: QueueTaskCount {
                queuing_task_count: val.queuing_task_count,
                running_task_count: val.running_task_count,
            },
        }
    }
}

#[derive(Deserialize, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct PreparePartialUpload {
    pub file_name: String,
    pub hash: String,
    pub hash_algorithm: FileHashAlgorithm,
    pub file_metadata_id: Option<Uuid>,
    pub size: u64,
    pub count: u64,
    #[serde(flatten)]
    pub r#type: PreparePartialUploadFrom,
}

#[derive(Deserialize, Serialize, Clone)]
#[serde(untagged)]
pub enum PreparePartialUploadFrom {
    #[serde(rename_all = "camelCase")]
    FlowDraft { flow_draft_uuid: Uuid },
    #[serde(rename_all = "camelCase")]
    FlowInstance { node_instance_uuid: Uuid },
    #[serde(rename_all = "camelCase")]
    NetDisk { parent_id: Option<Uuid> },
    #[serde(rename_all = "camelCase")]
    SnapShot {
        node_id: Uuid,
        file_id: Uuid,
        timestamp: u64,
    },
}

#[derive(Deserialize, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub enum FileHashAlgorithm {
    Blake3,
}

impl From<HashAlgorithm> for FileHashAlgorithm {
    fn from(value: HashAlgorithm) -> Self {
        match value {
            HashAlgorithm::Blake3 => Self::Blake3,
        }
    }
}
impl From<FileHashAlgorithm> for HashAlgorithm {
    fn from(value: FileHashAlgorithm) -> Self {
        match value {
            FileHashAlgorithm::Blake3 => Self::Blake3,
        }
    }
}

impl PreparePartialUpload {
    pub fn into_registration(self) -> MoveRegistration {
        MoveRegistration {
            id: Uuid::new_v4(),
            meta_id: self.file_metadata_id.unwrap_or(Uuid::new_v4()),
            file_name: self.file_name,
            hash: self.hash.to_uppercase(),
            hash_algorithm: self.hash_algorithm.into(),
            size: self.size,
            destination: match self.r#type {
                PreparePartialUploadFrom::FlowDraft { flow_draft_uuid } => {
                    MoveDestination::StorageServer {
                        record_net_disk: Some(RecordNetDisk {
                            file_type: FileType::Unkonwn,
                            kind: RecordNetDiskKind::FlowDraft {
                                flow_draft_id: flow_draft_uuid,
                            },
                        }),
                    }
                }
                PreparePartialUploadFrom::FlowInstance { node_instance_uuid } => {
                    MoveDestination::StorageServer {
                        record_net_disk: Some(RecordNetDisk {
                            file_type: FileType::Unkonwn,
                            kind: RecordNetDiskKind::NodeInstance {
                                node_id: node_instance_uuid,
                            },
                        }),
                    }
                }
                PreparePartialUploadFrom::NetDisk { parent_id } => MoveDestination::StorageServer {
                    record_net_disk: Some(RecordNetDisk {
                        file_type: FileType::Unkonwn,
                        kind: RecordNetDiskKind::Normal { parent_id },
                    }),
                },
                PreparePartialUploadFrom::SnapShot {
                    node_id,
                    file_id,
                    timestamp,
                } => MoveDestination::Snapshot {
                    node_id,
                    timestamp,
                    file_id,
                },
            },
            is_upload_failed: false,
            failed_reason: None,
        }
    }
}

#[derive(MultipartForm)]
pub struct PartialUploadRequest {
    pub file_metadata_id: Text<Uuid>,
    pub nth: Text<u64>,
    pub bin: Vec<Tempfile>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GetPartialUploadInfoResponse {
    pub file_metadata_id: Uuid,
    pub hash: String,
    pub hash_algorithm: FileHashAlgorithm,
    /// Unfinished parts.
    pub shards: Vec<u64>,
    pub is_upload_failed: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub failed_reason: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SnapshotInfoRequset {
    pub node_id: Uuid,
    pub file_id: Uuid,
}

#[derive(Deserialize, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct CreateSnapshotRequest {
    pub node_id: Uuid,
    pub file_id: Uuid,
    pub timestamp: i64,
}

#[derive(Deserialize, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct CreateSnapshotPartialRequest {
    pub node_id: Uuid,
    pub file_id: Uuid,
    pub timestamp: i64,
    pub context: String,
}

#[derive(Deserialize, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct SnapshotPartialUploadRequest {
    pub node_id: Uuid,
    pub file_id: Uuid,
    pub timestamp: i64,
    pub hash: String,
}

#[derive(Serialize)]
pub struct GetTextByIdResponse {
    pub key: String,
    pub value: String,
}
