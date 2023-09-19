use serde::*;
use std::collections::HashMap;

#[derive(Default, Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PBSJobs {
    pub timestamp: i64,
    #[serde(rename = "pbs_version")]
    pub pbs_version: String,
    #[serde(rename = "pbs_server")]
    pub pbs_server: String,
    #[serde(rename = "Jobs")]
    pub jobs: HashMap<String, PBSJob>,
}

#[derive(Default, Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PBSJob {
    #[serde(rename = "Job_Name")]
    pub job_name: String,
    #[serde(rename = "Job_Owner")]
    pub job_owner: String,
    #[serde(rename = "resources_used")]
    pub resources_used: ResourcesUsed,
    #[serde(rename = "job_state")]
    pub job_state: String,
    pub queue: String,
    pub server: String,
    #[serde(rename = "Checkpoint")]
    pub checkpoint: String,
    pub ctime: String,
    #[serde(rename = "Error_Path")]
    pub error_path: String,
    #[serde(rename = "exec_host")]
    pub exec_host: String,
    #[serde(rename = "exec_vnode")]
    pub exec_vnode: String,
    #[serde(rename = "Hold_Types")]
    pub hold_types: String,
    #[serde(rename = "Join_Path")]
    pub join_path: String,
    #[serde(rename = "Keep_Files")]
    pub keep_files: String,
    #[serde(rename = "Mail_Points")]
    pub mail_points: String,
    pub mtime: String,
    #[serde(rename = "Output_Path")]
    pub output_path: String,
    #[serde(rename = "Priority")]
    pub priority: i64,
    pub qtime: String,
    #[serde(rename = "Rerunable")]
    pub rerunable: String,
    #[serde(rename = "Resource_List")]
    pub resource_list: ResourceList,
    pub stime: String,
    #[serde(rename = "session_id")]
    pub session_id: i64,
    pub jobdir: String,
    pub substate: i64,
    #[serde(rename = "Variable_List")]
    pub variable_list: HashMap<String, String>,
    pub comment: String,
    pub etime: String,
    #[serde(rename = "run_count")]
    pub run_count: i64,
    #[serde(rename = "Stageout_status")]
    pub stageout_status: i64,
    #[serde(rename = "Exit_status")]
    pub exit_status: i32,
    #[serde(rename = "Submit_arguments")]
    pub submit_arguments: String,
    pub executable: Option<String>,
    #[serde(rename = "argument_list")]
    pub argument_list: Option<String>,
    #[serde(rename = "history_timestamp")]
    pub history_timestamp: i64,
    pub project: String,
}

#[derive(Default, Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ResourcesUsed {
    pub cpupercent: i64,
    pub cput: String,
    pub mem: String,
    pub ncpus: i64,
    pub vmem: String,
    pub walltime: String,
}

#[derive(Default, Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ResourceList {
    pub ncpus: i64,
    pub nodect: i64,
    pub place: String,
    pub select: String,
}
