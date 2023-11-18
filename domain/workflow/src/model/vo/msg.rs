use crate::model::entity::{
    node_instance::NodeInstanceStatus, task::TaskStatus, workflow_instance::WorkflowInstanceStatus,
};

use super::task_dto::result::TaskUsedResource;

/// Use as change info.
pub trait ChangeInfo {}

impl ChangeInfo for TaskChangeInfo {}

#[derive(Default)]
pub struct TaskChangeInfo {
    pub status: TaskStatusChange,
    pub message: Option<String>,
    pub used_resources: Option<TaskUsedResource>,
}

impl ChangeInfo for NodeChangeInfo {}

#[derive(Default)]
pub struct NodeChangeInfo {
    pub status: NodeStatusChange,
    pub message: Option<String>,
    pub used_resources: Option<TaskUsedResource>,
}

#[derive(Default, Clone)]
pub enum TaskStatusChange {
    #[default]
    Queuing,
    Running {
        is_recovered: bool,
    },
    Completed,
    Failed,
    Terminating,
    Terminated,
    Pausing,
    Paused,
    Recovering,
}

#[derive(Default, Clone)]
pub enum NodeStatusChange {
    #[default]
    Pending,
    Running {
        is_recovered: bool,
    },
    Completed,
    Failed,
    Terminating,
    Terminated,
    Standby,
    Pausing,
    Paused,
    Recovering,
}

impl ChangeInfo for FlowStatusChange {}

#[derive(Default, Clone)]
pub enum FlowStatusChange {
    #[default]
    Pending,
    Running {
        is_recovered: bool,
    },
    Completed,
    Failed,
    Terminating,
    Terminated,
    Pausing,
    Paused,
    Recovering,
}

impl From<TaskStatusChange> for TaskStatus {
    fn from(value: TaskStatusChange) -> Self {
        match value {
            TaskStatusChange::Queuing => Self::Queuing,
            TaskStatusChange::Running { .. } => Self::Running,
            TaskStatusChange::Completed => Self::Completed,
            TaskStatusChange::Failed => Self::Failed,
            TaskStatusChange::Terminating => Self::Terminating,
            TaskStatusChange::Terminated => Self::Terminated,
            TaskStatusChange::Pausing => Self::Pausing,
            TaskStatusChange::Paused => Self::Paused,
            TaskStatusChange::Recovering => Self::Recovering,
        }
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
            NodeStatusChange::Recovering => Self::Recovering,
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
            FlowStatusChange::Recovering => Self::Recovering,
        }
    }
}
