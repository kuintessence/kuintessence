use serde::*;

#[derive(Default, Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct SlurmJob {
    #[serde(rename = "JobID")]
    pub job_id: String,
    #[serde(rename = "JobName")]
    pub job_name: String,
    #[serde(rename = "User")]
    pub user: String,
    #[serde(rename = "State")]
    pub state: String,
    #[serde(rename = "ExitCode")]
    pub exit_code: String,
    #[serde(rename = "WorkDir")]
    pub work_dir: String,
    #[serde(rename = "CPUTimeRaw")]
    pub cpu_time: u64,
    #[serde(rename = "ElapsedRaw")]
    pub elapsed: u64,
    #[serde(rename = "NCPUS")]
    pub ncpus: u64,
    #[serde(rename = "AveRSS")]
    pub ave_mem: u64,
    #[serde(rename = "MaxRSS")]
    pub mem: u64,
    #[serde(rename = "Start")]
    pub start: String,
    #[serde(rename = "End")]
    pub end: String,
    #[serde(rename = "NNodes")]
    pub nnodes: u64,
}
