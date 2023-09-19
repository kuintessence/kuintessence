use alice_architecture::IAggregateRoot;
use serde::{Deserialize, Serialize};
use uuid::Uuid;

#[derive(Default, Deserialize, Serialize, Clone, Debug, IAggregateRoot)]
pub struct File {
    pub id: Uuid,
    pub metadata_id: Uuid,
    pub file_name: String,
    pub related_task_body: Uuid,
    pub file_type: FileType,
    pub status: FileStatus,
    pub is_optional: bool,
    pub is_packaged: bool,
    pub text: String,
    pub is_generated: bool,
}

#[derive(Default, Deserialize, Serialize, Clone, Debug, Eq, PartialEq)]
pub enum FileType {
    #[default]
    IN,
    OUT,
}

#[derive(Default, Deserialize, Serialize, Clone, Debug, Eq, PartialEq)]
pub enum FileStatus {
    RemoteOnly,
    LocalOnly,
    Both,
    Downloading,
    Uploading,
    WaittingCreate,
    NotExist,
    #[default]
    Unknown,
}
