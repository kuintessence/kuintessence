use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use uuid::Uuid;

#[derive(Clone, Serialize, Deserialize, Debug)]
/// 任务
pub struct Task {
    /// 任务 id
    pub id: Uuid,
    /// 任务内容
    pub body: Vec<TaskBody>,
    /// 任务目标状态
    pub command: TaskCommand,
}

/// 任务目标状态
#[derive(Clone, Serialize, Deserialize, Debug)]
pub enum TaskCommand {
    Start,
    Pause,
    Continue,
    Delete,
}

#[derive(Clone, Serialize, Deserialize, Debug)]
pub enum TaskBody {
    /// 软件部署
    SoftwareDeployment {
        /// 任务软件环境技术
        facility_kind: FacilityKind,
        #[serde(default = "Default::default")]
        command: SoftwareDeploymentCommand,
    },
    /// 用例执行
    UsecaseExecution {
        /// 执行名称
        name: String,
        /// 任务软件环境技术
        facility_kind: FacilityKind,
        /// 参数列表
        /// 例如： ["-i a.txt","--debug"]
        arguments: Vec<String>,
        /// 环境变量列表，值为 None 时代表只设置键，值为空字符串
        environments: HashMap<String, String>,
        /// 标准输入
        std_in: StdInKind,
        /// 文件信息列表
        files: Vec<FileInfo>,
        /// 计算资源配置
        requirements: Option<Requirements>,
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
pub enum CollectTo {
    /// 输出为文件
    #[serde(rename_all = "camelCase")]
    File { id: Uuid, path: String },
    /// 输出为文字
    Text { id: Uuid },
}

/// 收集规则
#[derive(Clone, Serialize, Deserialize, Debug)]
pub enum CollectRule {
    /// 正则匹配
    Regex(String),
    /// 最后几行
    BottomLines(usize),
    /// 前几行
    TopLines(usize),
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
    None,
}

#[derive(Clone, Serialize, Deserialize, Debug, Default)]
pub enum SoftwareDeploymentCommand {
    #[default]
    Install,
    Uninstall,
}

#[derive(Clone, Serialize, Deserialize, Debug)]
/// 文件信息
pub enum FileInfo {
    Input {
        /// 文件路径
        path: String,
        /// 是否打包
        is_package: bool,
        form: InFileForm,
    },
    Output {
        /// 文件 uuid
        id: Uuid,
        /// 文件路径
        path: String,
        /// 是否打包
        is_package: bool,
        /// 是否可选收集
        optional: bool,
    },
}

/// 输入文件传输形式
#[derive(Clone, Serialize, Deserialize, Debug)]
pub enum InFileForm {
    /// 传 id
    Id(Uuid),
    /// 传文件内容
    Content(String),
}

#[derive(Clone, Serialize, Deserialize, Debug)]
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
}
/// 任务结果
#[derive(Default, Clone, Serialize, Deserialize)]
pub struct TaskResult {
    /// 任务 id
    pub id: String,
    /// 任务结果状态
    pub status: TaskResultStatus,
    /// 输出
    pub message: String,
    /// 资源使用
    pub used_resources: Option<TaskUsedResource>,
}

/// 任务执行的状态
#[derive(Default, Clone, Serialize, Deserialize)]
pub enum TaskResultStatus {
    #[default]
    Success,
    /// 失败
    Failed,
    /// 暂停
    Paused,
    /// 继续
    Continued,
    /// 删除
    Deleted,
    /// 开始
    Start,
}

/// 资源使用
#[derive(Default, Deserialize, Serialize, Clone, Debug)]
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

#[derive(Default, Deserialize, Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct PreparePartialUploadFromNodeInstanceRequest {
    pub file_name: String,
    pub hash: String,
    pub hash_algorithm: String,
    pub size: u64,
    pub count: u64,
    pub node_instance_uuid: Uuid,
    pub file_metadata_id: Option<Uuid>,
}

#[derive(Deserialize, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct PreparePartialUploadResponse {
    pub result: PreparePartialUploadResponseResult,
    pub id: Uuid,
}

#[derive(Deserialize, Serialize, Clone, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum PreparePartialUploadResponseResult {
    Normal,
    Unfinished,
    FlashUpload,
}

#[derive(Clone, Serialize, Deserialize, Default, Debug)]
pub struct FileShards {
    pub file_metadata_id: Uuid,
    pub file_name: String,
    pub hash: String,
    pub hash_algorithm: String,
    pub size: usize,
    pub shards: Vec<bool>,
    pub via: Via,
    pub is_upload_failed: bool,
    pub failed_reson: Option<String>,
}

#[derive(Clone, Serialize, Deserialize, Default, Debug)]
pub enum Via {
    FlowEditor {
        /// 工作台上传文件在网盘中路径
        flow_draft_uuid: Uuid,
    },
    NetDisk {
        parent_id: Option<Uuid>,
    },
    NodeInstance {
        node_instance_id: Uuid,
    },
    #[default]
    Unkonwn,
}
