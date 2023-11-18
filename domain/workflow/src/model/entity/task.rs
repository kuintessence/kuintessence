use alice_architecture::model::AggregateRoot;
use num_derive::{FromPrimitive, ToPrimitive};
use uuid::Uuid;

use crate::model::vo::task_dto::{self, result::TaskResultStatus};

#[derive(AggregateRoot, Clone, Debug)]
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

#[derive(ToPrimitive, FromPrimitive, Debug, Clone, PartialEq)]
pub enum TaskType {
    SoftwareDeployment,
    FileDownload,
    UsecaseExecution,
    FileUpload,
    OutputCollect,
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
            TaskType::SoftwareDeployment => Self::SoftwareDeployment,
            TaskType::FileDownload => Self::FileDownload,
            TaskType::UsecaseExecution => Self::UsecaseExecution,
            TaskType::FileUpload => Self::FileUpload,
            TaskType::OutputCollect => Self::OutputCollect,
            TaskType::ExecuteScript => Self::ExecuteScript,
        }
    }
}
