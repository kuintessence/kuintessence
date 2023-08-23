use super::*;

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

#[derive(Default, Deserialize, Serialize, Clone, Debug, PartialEq, Ord, Eq, PartialOrd)]
pub struct TaskUsedResource {
    /// 核心数
    pub cpu: u64,
    /// 平均内存
    pub avg_memory: u64,
    /// 最大内存
    pub max_memory: u64,
    /// 存储空间
    pub storage: u64,
    /// 墙钟时间
    pub wall_time: u64,
    /// 核心时间
    pub cpu_time: u64,
    /// 节点数
    pub node: u64,
    /// 开始时间
    pub start_time: i64,
    /// 结束时间
    pub end_time: i64,
}
