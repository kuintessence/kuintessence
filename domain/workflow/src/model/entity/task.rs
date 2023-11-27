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
    pub body: String,
    pub status: TaskStatus,
    pub message: Option<String>,
    pub used_resources: Option<String>,
    pub queue_topic: String,
}

#[derive(Default, FromPrimitive, Debug, Clone, PartialEq)]
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
    Terminating,
    /// Terminated.
    Terminated,
    /// Pausing.
    Pausing,
    /// Pasued.
    Paused,
    /// Recovering.
    Recovering,
}

impl From<TaskResultStatus> for TaskStatus {
    fn from(value: TaskResultStatus) -> Self {
        match value {
            TaskResultStatus::Queued => Self::Queuing,
            TaskResultStatus::Started => Self::Running,
            TaskResultStatus::Completed => Self::Completed,
            TaskResultStatus::Failed => Self::Failed,
            TaskResultStatus::Paused => Self::Paused,
            TaskResultStatus::Continued => Self::Running,
            TaskResultStatus::Deleted => Self::Terminated,
        }
    }
}

impl From<TaskType> for task_dto::TaskType {
    fn from(value: TaskType) -> Self {
        match value {
            TaskType::DeploySoftware => Self::SoftwareDeployment,
            TaskType::DownloadFile => Self::FileDownload,
            TaskType::ExeceteUsecase => Self::UsecaseExecution,
            TaskType::UploadFile => Self::FileUpload,
            TaskType::CollectOutput => Self::OutputCollect,
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
