use alice_architecture::model::AggregateRoot;
use anyhow::Context;
use num_derive::{FromPrimitive, ToPrimitive};
use num_traits::FromPrimitive;
use uuid::Uuid;

use crate::model::vo::task_dto::result::TaskResultStatus;

#[derive(AggregateRoot, Clone, Debug)]
pub struct Task {
    pub id: String,
    pub node_instance_id: String,
    pub r#type: TaskType,
    /// Task biz data.
    pub body: String,
    pub status: TaskStatus,
    pub message: Option<String>,
    pub used_resources: Option<String>,
}

#[derive(ToPrimitive, FromPrimitive, Debug, Clone)]
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
    /// Recovered, only use in status receiver, it eventually turns into Running.
    Recovered,
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

impl TryFrom<database_model::task::Model> for Task {
    type Error = anyhow::Error;

    fn try_from(value: database_model::task::Model) -> Result<Self, Self::Error> {
        Ok(Self {
            id: value.id,
            node_instance_id: value.node_instance_id,
            r#type: FromPrimitive::from_i32(value.r#type).context("Wrong Task type")?,
            body: value.body.to_string(),
            status: FromPrimitive::from_i32(value.status).context("Wrong Task statsu")?,
            message: value.message,
            used_resources: value.used_resources.map(|u| u.to_string()),
        })
    }
}
