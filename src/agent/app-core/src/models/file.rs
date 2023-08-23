use super::*;
#[derive(Default, Deserialize, Serialize, Clone, Debug)]
pub struct File {
    pub id: uuid::Uuid,
    pub metadata_id: uuid::Uuid,
    pub file_name: String,
    pub related_task_body: uuid::Uuid,
    pub file_type: FileType,
    pub status: FileStatus,
    pub is_optional: bool,
    pub is_packaged: bool,
    pub text: String,
    pub is_generated: bool,
}

impl IAggregateRoot for File {}

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

#[derive(Default, Serialize, Deserialize, Debug)]
pub enum FileTransferStatus {
    Start,
    Stop,
    Pause,
    Continue,
    #[default]
    Unknown,
}
