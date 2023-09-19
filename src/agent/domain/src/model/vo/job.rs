use std::collections::HashMap;

use serde::{Deserialize, Serialize};

use crate::model::entity::task::{Requirements, StdInKind, TaskUsedResource};

#[derive(Default, Deserialize, Serialize, Debug, Clone, Ord, Eq, PartialOrd)]
pub struct Job {
    pub id: String,
    pub name: String,
    pub owner: String,
    pub state: JobState,
    pub exit_status_code: i32,
    pub error_output: String,
    pub resource_used: TaskUsedResource,
}

#[derive(Default, Deserialize, Serialize, Clone, Eq, PartialEq, Ord, PartialOrd, Debug)]
pub enum JobState {
    Queuing,
    Running,
    Suspended,
    Completing,
    Completed,
    Failed,
    #[default]
    Unknown,
}

impl PartialEq for Job {
    fn eq(&self, other: &Self) -> bool {
        self.id == other.id
            && self.name == other.name
            && self.owner == other.owner
            && self.state == other.state
    }
}

#[derive(Default, Deserialize, Serialize, Debug, Clone)]
pub struct ScriptInfo {
    pub id: String,
    pub is_mpi_before_loader: bool,
    pub parent_id: String,
    pub name: String,
    pub load_software: String,
    pub path: String,
    pub arguments: Vec<String>,
    pub environments: HashMap<String, String>,
    pub std_in: StdInKind,
    pub requirements: Option<Requirements>,
}
