use crate::model::entity::{node_instance::NodeInstanceStatus, task::TaskStatus};

use super::task_dto::result::TaskUsedResource;

/// Use as change info.
pub trait ChangeInfo {}

impl ChangeInfo for TaskChangeInfo {}

#[derive(Default)]
pub struct TaskChangeInfo {
    pub status: TaskStatus,
    pub message: Option<String>,
    pub used_resources: Option<TaskUsedResource>,
}

impl ChangeInfo for NodeChangeInfo {}

#[derive(Default)]
pub struct NodeChangeInfo {
    pub status: NodeInstanceStatus,
    pub message: Option<String>,
    pub used_resources: Option<TaskUsedResource>,
}
