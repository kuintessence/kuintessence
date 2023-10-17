use super::*;
use std::fmt::Display;

#[derive(Default, Deserialize, Serialize, Clone, Debug)]
pub struct Task {
    pub id: uuid::Uuid,
    pub status: TaskStatus,
    pub body: Vec<SubTask>,
    pub update_time: chrono::DateTime<chrono::Utc>,
}

#[derive(Default, Deserialize, Serialize, Clone, Debug, Eq, PartialEq)]
pub enum TaskStatus {
    Queuing,
    Running,
    Suspended,
    Completing,
    Completed,
    Failed,
    Reported,
    #[default]
    Unknown,
}

#[derive(Clone, Default, Serialize, Deserialize, Debug)]
pub struct SubTask {
    pub id: uuid::Uuid,
    pub parent_id: uuid::Uuid,
    pub status: TaskStatus,
    pub facility_kind: FacilityKind,
    pub task_type: TaskType,
    pub job_id: String,
    pub failed_reason: String,
    pub resource_used: Option<TaskUsedResource>,
    pub requirements: Option<Requirements>,
}

impl IAggregateRoot for SubTask {}

#[derive(Clone, Default, Serialize, Deserialize, Debug)]
#[serde(tag = "type")]
pub enum TaskType {
    /// 软件部署
    SoftwareDeployment { status: SoftwareDeploymentStatus },
    /// 用例执行
    UsecaseExecution {
        /// 执行名称
        name: String,
        /// 参数列表
        /// 例如： ["-i a.txt","--debug"]
        arguments: Vec<String>,
        /// 环境变量列表，值为 None 时代表只设置键，值为空字符串
        environments: HashMap<String, String>,
        /// 标准输入
        std_in: StdInKind,
        /// 文件信息列表
        files: Vec<FileInfo>,
    },
    /// 输出收集
    CollectedOut {
        /// 从哪收集
        from: CollectFrom,
        /// 收集规则
        rule: CollectRule,
        /// 收集到哪里
        to: CollectTo,
        /// 如果收集不到是否报错（true 时不报错）
        optional: bool,
    },
    #[default]
    Unknown,
}

#[derive(Clone, Serialize, Deserialize, Debug, Default)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct Requirements {
    /// 核心数
    pub cpu_cores: Option<usize>,
    /// 节点数
    pub node_count: Option<isize>,
    /// 最长等待时间（s）
    pub max_wall_time: Option<usize>,
    /// 最大核时消耗（s）
    pub max_cpu_time: Option<usize>,
    /// 定时终止（utc 0 时区 时间戳）
    pub stop_time: Option<usize>,
}

#[derive(Clone, Default, Serialize, Deserialize, Debug, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub enum TaskDisplayType {
    SoftwareDeployment,
    UsecaseExecution,
    CollectedOut,
    #[default]
    Unknown,
}

impl Display for TaskDisplayType {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(
            f,
            "{}",
            match self {
                TaskDisplayType::SoftwareDeployment => "SoftwareDeployment",
                TaskDisplayType::UsecaseExecution => "UsecaseExecution",
                TaskDisplayType::CollectedOut => "CollectedOut",
                TaskDisplayType::Unknown => "Unknown",
            }
        )
    }
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

#[derive(Clone, Serialize, Deserialize, Debug, Default)]
pub enum SoftwareDeploymentStatus {
    #[default]
    Install,
    Uninstall,
}

/// 从哪里收集
#[derive(Clone, Serialize, Deserialize, Debug)]
pub enum CollectFrom {
    #[serde(rename_all = "camelCase")]
    /// 收集文件输出
    FileOut { path: String },
    /// 收集标准输出
    Stdout,
    /// 收集标准错误输出
    Stderr,
}

/// 结果输出形式
#[derive(Clone, Serialize, Deserialize, Debug)]
#[serde(tag = "type")]
pub enum CollectTo {
    /// 输出为文件
    #[serde(rename_all = "camelCase")]
    File { id: uuid::Uuid, path: String },
    /// 输出为文字
    Text { id: uuid::Uuid },
}

/// 收集规则
#[derive(Clone, Serialize, Deserialize, Debug)]
#[serde(tag = "type")]
pub enum CollectRule {
    /// 正则匹配
    Regex { exp: String },
    /// 最后几行
    BottomLines { n: usize },
    /// 前几行
    TopLines { n: usize },
}

#[derive(Clone, Serialize, Deserialize, Debug, Default)]
pub enum StdInKind {
    Text {
        text: String,
    },
    File {
        path: String,
    },
    #[default]
    Unknown,
}

#[derive(Default, Clone, Serialize, Deserialize, Debug)]
/// 文件信息
pub struct FileInfo {
    /// 文件 uuid
    pub id: uuid::Uuid,
    pub metadata_id: uuid::Uuid,
    /// 文件路径
    pub path: String,
    /// 是否打包
    pub is_package: bool,
    /// 是否可选收集
    pub optional: bool,
    pub file_type: FileType,
    pub text: String,
    pub is_generated: bool,
}

#[derive(Clone, Serialize, Deserialize, Debug, Default)]
/// 软件环境技术
pub enum FacilityKind {
    /// spack
    Spack {
        /// 软件名称
        name: String,
        /// 安装参数
        argument_list: Vec<String>,
    },
    /// singularity
    Singularity {
        /// 镜像名
        image: String,
        /// 镜像 tag
        tag: String,
    },
    #[default]
    Unknown,
}

impl IAggregateRoot for Task {}

#[derive(Default, Serialize, Deserialize, Debug)]
pub struct FileTransferCommand {
    pub id: uuid::Uuid,
    pub parent_id: uuid::Uuid,
    pub status: FileTransferStatus,
    pub task_file: Option<File>,
}

#[derive(Clone, Default, Serialize, Deserialize, Debug)]
pub struct SoftwareDeploymentCommand {
    pub id: uuid::Uuid,
    pub task_status: TaskStatus,
}

#[derive(Clone, Default, Serialize, Deserialize, Debug, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub enum DeployerType {
    Spack,
    Apptainer,
    #[default]
    Unknown,
}