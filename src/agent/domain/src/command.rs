use serde::{Deserialize, Serialize};

use crate::model::{
    entity::{task::TaskStatus, File},
    vo::FileTransferStatus,
};

#[derive(Default, Serialize, Deserialize, Debug)]
pub struct FileTransferCommand {
    pub id: uuid::Uuid,
    pub parent_id: uuid::Uuid,
    pub status: FileTransferStatus,
    pub task_file: Option<File>,
}

#[derive(Clone, Default, Serialize, Deserialize, Debug)]
pub struct SoftwareDeploymentCommand {
    pub id: uuid::Uuid,
    pub task_status: TaskStatus,
}
