use serde::{Deserialize, Serialize};

use crate::model::entity::task::TaskType;

#[derive(Clone, Default, Serialize, Deserialize, Debug, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub enum TaskDisplayType {
    SoftwareDeployment,
    UsecaseExecution,
    CollectedOut,
    #[default]
    Unknown,
}

impl From<TaskType> for TaskDisplayType {
    fn from(f: TaskType) -> Self {
        match f {
            TaskType::SoftwareDeployment { .. } => Self::SoftwareDeployment,
            TaskType::UsecaseExecution { .. } => Self::UsecaseExecution,
            TaskType::CollectedOut { .. } => Self::CollectedOut,
            TaskType::Unknown => Self::Unknown,
        }
    }
}

impl std::fmt::Display for TaskDisplayType {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(match self {
            Self::SoftwareDeployment => "SoftwareDeployment",
            Self::UsecaseExecution => "UsecaseExecution",
            Self::CollectedOut => "CollectedOut",
            Self::Unknown => "Unknown",
        })
    }
}
