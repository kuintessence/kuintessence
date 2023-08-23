use crate::prelude::*;
use lib_co_repo::models::prelude::SoftwareSpec;
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
    /// 执行脚本
    ExecuteScript {
        /// 脚本信息
        #[serde(flatten)]
        script_info: ScriptInfo,
    },
    /// 文件传输
    FileUpload {
        file_id: String,
        path: String,
        is_package: bool,
    },
    FileDownload {
        kind: FileTransmitKind,
        path: String,
    },
}

#[derive(Clone, Serialize, Deserialize, Debug)]
pub enum FileTransmitKind {
    /// 从中心下载
    Center { file_id: Uuid, is_packaged: bool },
    /// P2P 下载
    P2P { file_id: Uuid, is_packaged: bool },
    /// 直接读取文字
    Text { content: String },
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
    File { path: String, id: Uuid },
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

/// 文件信息
/// TODO 删除
#[derive(Clone, Serialize, Deserialize, Debug)]
pub enum FileInfo {
    Input {
        /// 文件路径
        path: String,
        /// 是否打包
        is_package: bool,
        /// 输入文件形式
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

impl FileInfo {
    pub fn path(&self) -> &str {
        match self {
            FileInfo::Input { path, .. } => path,
            FileInfo::Output { path, .. } => path,
        }
    }
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
impl From<SoftwareSpec> for FacilityKind {
    fn from(l: SoftwareSpec) -> Self {
        match l {
            SoftwareSpec::Spack {
                name,
                argument_list,
            } => FacilityKind::Spack {
                name,
                argument_list,
            },
            SoftwareSpec::Singularity { image, tag } => FacilityKind::Singularity { image, tag },
        }
    }
}

/// 任务结果
#[derive(Clone, Serialize, Deserialize)]
pub struct TaskResult {
    /// 任务 id
    pub id: Uuid,
    /// 任务结果状态
    pub status: TaskResultStatus,
    /// 输出
    pub message: String,
    /// 资源使用
    pub used_resources: Option<TaskUsedResource>,
}

/// 任务执行完的状态
#[derive(Clone, Serialize, Deserialize)]
pub enum TaskResultStatus {
    /// 成功执行
    Success,
    /// 失败
    Failed,
    /// 暂停
    Paused,
    /// 继续
    Continued,
    /// 删除
    Deleted,
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
