use alice_architecture::model::AggregateRoot;
use num_derive::{FromPrimitive, ToPrimitive};
use uuid::Uuid;

use crate::model::vo::task_dto::{self, result::TaskResultStatus, StartTaskBody};

#[derive(AggregateRoot, Clone, Debug, Default)]
pub struct Task {
    pub id: Uuid,
    pub node_instance_id: Uuid,
    pub r#type: TaskType,
    /// Task biz data.
    pub body: serde_json::Value,
    pub status: TaskStatus,
    pub message: Option<String>,
    pub used_resources: Option<serde_json::Value>,
    pub queue_topic: String,
}

#[derive(Default, ToPrimitive, FromPrimitive, Debug, Clone, PartialEq)]
pub enum TaskType {
    #[default]
    DeploySoftware,
    DownloadFile,
    ExeceteUsecase,
    UploadFile,
    CollectOutput,
    ExecuteScript,
}

#[derive(ToPrimitive, FromPrimitive, Debug, Clone, Default)]
pub enum TaskStatus {
    /// Pending on co.
    #[default]
    Standby,
    /// Pending on agent.
    Queuing,
    /// Running on agent.
    Running,
    /// Completed.
    Completed,
    /// Failed.
    Failed,
    /// Terminating.
    Cancelling,
    /// Terminated.
    Cancelled,
    /// Pausing.
    Pausing,
    /// Pasued.
    Paused,
    /// Recovering.
    Resuming,
}

impl From<TaskResultStatus> for TaskStatus {
    fn from(value: TaskResultStatus) -> Self {
        match value {
            TaskResultStatus::Queued => Self::Queuing,
            TaskResultStatus::Started => Self::Running,
            TaskResultStatus::Completed => Self::Completed,
            TaskResultStatus::Failed => Self::Failed,
            TaskResultStatus::Paused => Self::Paused,
            TaskResultStatus::Resumed => Self::Running,
            TaskResultStatus::Cancelled => Self::Cancelled,
        }
    }
}

impl From<TaskType> for task_dto::TaskType {
    fn from(value: TaskType) -> Self {
        match value {
            TaskType::DeploySoftware => Self::DeploySoftware,
            TaskType::DownloadFile => Self::DownloadFile,
            TaskType::ExeceteUsecase => Self::ExecuteUsecase,
            TaskType::UploadFile => Self::UploadFile,
            TaskType::CollectOutput => Self::CollectOutput,
            TaskType::ExecuteScript => Self::ExecuteScript,
        }
    }
}

impl TaskType {
    pub fn from_ref(value: &StartTaskBody) -> Self {
        match value {
            StartTaskBody::DeploySoftware(_) => Self::DeploySoftware,
            StartTaskBody::DownloadFile(_) => Self::DownloadFile,
            StartTaskBody::ExecuteUsecase(_) => Self::ExeceteUsecase,
            StartTaskBody::UploadFile(_) => Self::UploadFile,
            StartTaskBody::CollectOutput(_) => Self::CollectOutput,
            StartTaskBody::ExecuteScript(_) => Self::ExecuteScript,
        }
    }
}
