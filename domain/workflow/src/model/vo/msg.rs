use serde::{Deserialize, Serialize};
use uuid::Uuid;

use crate::model::entity::{
    node_instance::NodeInstanceStatus, task::TaskStatus, workflow_instance::WorkflowInstanceStatus,
};

use super::task_dto::result::{TaskResultStatus, TaskUsedResource};

#[derive(Serialize, Deserialize)]
pub struct ChangeMsg {
    pub id: Uuid,
    pub info: Info,
}

#[derive(Serialize, Deserialize)]
pub enum Info {
    Task(TaskChangeInfo),
    Node(NodeChangeInfo),
    Flow(FlowStatusChange),
}

/// Use as change info.
pub trait ChangeInfo {}

impl ChangeInfo for TaskChangeInfo {}

#[derive(Default, Serialize, Deserialize)]
pub struct TaskChangeInfo {
    pub status: TaskStatusChange,
    pub message: Option<String>,
    pub used_resources: Option<TaskUsedResource>,
}

impl ChangeInfo for NodeChangeInfo {}

#[derive(Default, Serialize, Deserialize)]
pub struct NodeChangeInfo {
    pub status: NodeStatusChange,
    pub message: Option<String>,
    pub used_resources: Option<TaskUsedResource>,
}

#[derive(Default, Serialize, Deserialize, Clone)]
pub enum TaskStatusChange {
    #[default]
    Queuing,
    Running {
        is_resumed: bool,
    },
    Completed,
    Failed,
    Cancelling,
    Cancelled,
    Pausing,
    Paused,
    Resuming,
}

#[derive(Default, Serialize, Deserialize, Clone)]
pub enum NodeStatusChange {
    #[default]
    Pending,
    Running {
        is_resumed: bool,
    },
    Completed,
    Failed,
    Terminating,
    Terminated,
    Standby,
    Pausing,
    Paused,
    Resuming,
}

impl ChangeInfo for FlowStatusChange {}

#[derive(Default, Serialize, Deserialize, Clone)]
pub enum FlowStatusChange {
    #[default]
    Pending,
    Running {
        is_resumed: bool,
    },
    Completed,
    Failed,
    Terminating,
    Terminated,
    Pausing,
    Paused,
    Resuming,
}

impl From<TaskStatusChange> for TaskStatus {
    fn from(value: TaskStatusChange) -> Self {
        match value {
            TaskStatusChange::Queuing => Self::Queuing,
            TaskStatusChange::Running { .. } => Self::Running,
            TaskStatusChange::Completed => Self::Completed,
            TaskStatusChange::Failed => Self::Failed,
            TaskStatusChange::Cancelling => Self::Cancelling,
            TaskStatusChange::Cancelled => Self::Cancelled,
            TaskStatusChange::Pausing => Self::Pausing,
            TaskStatusChange::Paused => Self::Paused,
            TaskStatusChange::Resuming => Self::Resuming,
        }
    }
}

impl TryFrom<TaskResultStatus> for TaskStatusChange {
    type Error = anyhow::Error;

    fn try_from(value: TaskResultStatus) -> Result<Self, Self::Error> {
        Ok(match value {
            TaskResultStatus::Queued => Self::Queuing,
            TaskResultStatus::Started => anyhow::bail!("Started can't turn into TastStatusChange"),
            TaskResultStatus::Completed => Self::Completed,
            TaskResultStatus::Failed => Self::Failed,
            TaskResultStatus::Paused => Self::Paused,
            TaskResultStatus::Resumed => Self::Running { is_resumed: true },
            TaskResultStatus::Cancelled => Self::Cancelled,
        })
    }
}

impl From<NodeStatusChange> for NodeInstanceStatus {
    fn from(value: NodeStatusChange) -> Self {
        match value {
            NodeStatusChange::Pending => Self::Pending,
            NodeStatusChange::Running { .. } => Self::Running,
            NodeStatusChange::Completed => Self::Completed,
            NodeStatusChange::Failed => Self::Failed,
            NodeStatusChange::Terminating => Self::Terminating,
            NodeStatusChange::Terminated => Self::Terminated,
            NodeStatusChange::Standby => Self::Standby,
            NodeStatusChange::Pausing => Self::Pausing,
            NodeStatusChange::Paused => Self::Paused,
            NodeStatusChange::Resuming => Self::Resuming,
        }
    }
}

impl From<FlowStatusChange> for WorkflowInstanceStatus {
    fn from(value: FlowStatusChange) -> Self {
        match value {
            FlowStatusChange::Pending => Self::Pending,
            FlowStatusChange::Running { .. } => Self::Running,
            FlowStatusChange::Completed => Self::Completed,
            FlowStatusChange::Failed => Self::Failed,
            FlowStatusChange::Terminating => Self::Terminating,
            FlowStatusChange::Terminated => Self::Terminated,
            FlowStatusChange::Pausing => Self::Pausing,
            FlowStatusChange::Paused => Self::Paused,
            FlowStatusChange::Resuming => Self::Resuming,
        }
    }
}
