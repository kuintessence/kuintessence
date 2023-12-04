use std::collections::HashMap;

use serde::{Deserialize, Serialize};
use uuid::Uuid;

#[derive(Serialize, Debug)]
#[serde(rename_all = "camelCase")]
/// Task to send
pub struct Task {
    pub id: Uuid,
    #[serde(flatten)]
    pub command: TaskCommand,
}

#[derive(Serialize, Debug)]
#[serde(tag = "type")]
pub enum TaskType {
    SoftwareDeployment,
    FileDownload,
    UsecaseExecution,
    FileUpload,
    OutputCollect,
    ExecuteScript,
}

/// 任务目标状态
#[derive(Serialize, Debug)]
#[serde(tag = "command")]
pub enum TaskCommand {
    // Serialized StartTaskBody
    #[serde(rename_all = "camelCase")]
    Start {
        node_id: Uuid,
        #[serde(flatten)]
        value: serde_json::Value,
    },
    Pause(TaskType),
    Resume(TaskType),
    Cancel(TaskType),
}

#[derive(Serialize, Debug)]
#[serde(rename_all = "camelCase")]
/// 输出校验器
pub struct OutValidator {
    /// 校验规则
    pub validate_rule: ValidateRule,
    /// 校验成功时的操作 (需逻辑检查与 failure_operation 至少有一个)
    #[serde(default = "ValidatedOperation::success")]
    pub pass_operation: ValidatedOperation,
    /// 校验失败时的操作
    #[serde(default = "ValidatedOperation::failure")]
    pub failure_operation: ValidatedOperation,
}

#[derive(Serialize, Debug)]
#[serde(tag = "type", content = "content")]
/// 校验规则
pub enum ValidateRule {
    /// 匹配正则
    Regex(String),
    /// 是否为空
    IsEmpty(bool),
}

#[derive(Serialize, Debug)]
/// 验证过后的操作
pub enum ValidatedOperation {
    /// 报告成功
    ReportSuccess,
    /// 报告失败
    ReportFailure,
}

#[derive(Serialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct DeploySoftware {
    pub facility_kind: FacilityKind,
}

#[derive(Serialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct DownloadFile {
    #[serde(flatten)]
    pub kind: FileTransmitKind,
    pub path: String,
}

#[derive(Serialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct ExecuteUsecase {
    /// 执行名称
    pub name: String,
    /// 任务软件环境技术
    pub facility_kind: FacilityKind,
    /// 参数列表
    /// 例如： ["-i a.txt","--debug"]
    pub arguments: Vec<String>,
    /// 环境变量列表，值为 None 时代表只设置键，值为空字符串
    pub environments: HashMap<String, String>,
    /// 标准输入
    pub std_in: Option<StdInKind>,
    /// 计算资源配置
    pub requirements: Option<Requirements>,
}

#[derive(Serialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct UploadFile {
    pub file_id: Uuid,
    pub path: String,
    ///是否打包上传
    pub is_package: bool,
    /// 上传前验证文件内容
    #[serde(flatten, skip_serializing_if = "Option::is_none")]
    pub validator: Option<OutValidator>,
    pub optional: bool,
}

#[derive(Serialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct CollectOutput {
    /// 从哪收集
    pub from: CollectFrom,
    /// 收集规则
    pub rule: CollectRule,
    /// 收集到哪里
    pub to: CollectTo,
    /// 如果收集不到是否报错（true 时不报错）
    pub optional: bool,
}

#[derive(Serialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct ScriptInfo {
    /// 脚本类型
    kind: ScriptKind,
    /// 输入插槽文件与路径对应关系
    input_path: HashMap<String, String>,
    /// 输出插槽文件与路径、验证规则对应关系
    output_path: HashMap<String, OutPathAndValidate>,
    /// 脚本来源
    origin: ScriptOriginKind,
}

#[derive(Serialize, Debug)]
#[serde(tag = "type", content = "body")]
pub enum StartTaskBody {
    /// 软件部署
    DeploySoftware(DeploySoftware),
    /// 文件下载
    DownloadFile(DownloadFile),
    /// 用例执行
    ExecuteUsecase(ExecuteUsecase),
    /// 文件上传
    UploadFile(UploadFile),
    /// 输出收集
    CollectOutput(CollectOutput),
    /// 执行脚本
    ExecuteScript(ScriptInfo),
}

/// 脚本来源
#[derive(Clone, Serialize, Deserialize, Debug)]
#[serde(tag = "type")]
pub enum ScriptOriginKind {
    /// 从 git 拉取
    #[serde(rename_all = "camelCase")]
    Git {
        /// 链接
        url: String,
    },
    /// 从工作流编辑
    #[serde(rename_all = "camelCase")]
    Edit {
        /// 内容
        content: String,
    },
}

/// 脚本输出路径和校验
#[derive(Serialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct OutPathAndValidate {
    /// 输出路径
    pub path: String,
    /// 校验规则
    #[serde(skip_serializing_if = "Option::is_none")]
    pub validator: Option<OutValidator>,
}

/// 脚本类型
#[derive(Clone, Serialize, Deserialize, Debug)]
pub enum ScriptKind {
    /// Python 脚本
    Python,
}

/// 节点使用资源需求
#[derive(Serialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Requirements {
    /// 核心数
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cpu_cores: Option<usize>,
    /// 节点数
    #[serde(skip_serializing_if = "Option::is_none")]
    pub node_count: Option<isize>,
    /// 最长等待时间（s）
    #[serde(skip_serializing_if = "Option::is_none")]
    pub max_wall_time: Option<usize>,
    /// 最大核时消耗 (s)
    #[serde(skip_serializing_if = "Option::is_none")]
    pub max_cpu_time: Option<usize>,
    /// 定时终止 (utc 0 时区 时间戳)
    #[serde(skip_serializing_if = "Option::is_none")]
    pub stop_time: Option<usize>,
}
impl From<crate::model::vo::Requirements> for Requirements {
    fn from(value: crate::model::vo::Requirements) -> Self {
        Self {
            cpu_cores: value.cpu_cores,
            node_count: value.node_count,
            max_wall_time: value.max_wall_time,
            max_cpu_time: value.max_cpu_time,
            stop_time: value.stop_time,
        }
    }
}
impl
    From<domain_content_repo::model::vo::abilities::software_computing::usecase::spec::Requirements>
    for Requirements
{
    fn from(
        value: domain_content_repo::model::vo::abilities::software_computing::usecase::spec::Requirements,
    ) -> Self {
        Self {
            cpu_cores: value.cpu_cores,
            node_count: value.node_count,
            max_wall_time: value.max_wall_time,
            max_cpu_time: value.max_cpu_time,
            stop_time: value.stop_time,
        }
    }
}
impl From<super::ScriptInfo> for ScriptInfo {
    fn from(value: super::ScriptInfo) -> Self {
        let mut map = HashMap::new();
        for (descriptor, out_path_validator) in value.output_path.into_iter() {
            let out_path_validator: OutPathAndValidate = out_path_validator.into();
            map.insert(descriptor, out_path_validator);
        }
        Self {
            kind: value.kind.into(),
            input_path: value.input_path,
            output_path: map,
            origin: value.origin.into(),
        }
    }
}
impl From<super::ScriptKind> for ScriptKind {
    fn from(value: super::ScriptKind) -> Self {
        match value {
            super::ScriptKind::Python => Self::Python,
        }
    }
}
impl From<super::OutPathAndValidate> for OutPathAndValidate {
    fn from(value: super::OutPathAndValidate) -> Self {
        Self {
            path: value.path,
            validator: value.validator.map(|v| v.into()),
        }
    }
}
impl From<super::ScriptOriginKind> for ScriptOriginKind {
    fn from(value: super::ScriptOriginKind) -> Self {
        match value {
            super::ScriptOriginKind::Git { url } => Self::Git { url },
            super::ScriptOriginKind::Edit { content } => Self::Edit { content },
        }
    }
}

#[derive(Serialize, Debug)]
#[serde(tag = "type")]
pub enum FileTransmitKind {
    /// 从中心下载
    #[serde(rename_all = "camelCase")]
    Center { file_id: Uuid, is_packaged: bool },
    /// P2P 下载
    #[serde(rename_all = "camelCase")]
    P2P { file_id: Uuid, is_packaged: bool },
    /// 直接读取文字
    Text { content: String },
}

/// 从哪里收集
#[derive(Serialize, Deserialize, Debug)]
#[serde(tag = "type")]
pub enum CollectFrom {
    /// 收集文件输出
    #[serde(rename_all = "camelCase")]
    FileOut { path: String },
    /// 收集标准输出
    Stdout,
    /// 收集标准错误输出
    Stderr,
}

/// 结果输出形式
#[derive(Serialize, Deserialize, Debug)]
#[serde(tag = "type")]
pub enum CollectTo {
    /// 输出为文件
    #[serde(rename_all = "camelCase")]
    File { path: String, id: Uuid },
    /// 输出为文字
    #[serde(rename_all = "camelCase")]
    Text { id: Uuid },
}

/// 收集规则
#[derive(Serialize, Deserialize, Debug)]
#[serde(tag = "type", content = "content")]
pub enum CollectRule {
    /// 正则匹配
    Regex(String),
    /// 最后几行
    BottomLines(usize),
    /// 前几行
    TopLines(usize),
}

#[derive(Serialize, Deserialize, Debug)]
#[serde(tag = "type")]
pub enum StdInKind {
    #[serde(rename_all = "camelCase")]
    Text { text: String },
    #[serde(rename_all = "camelCase")]
    File { path: String },
}

#[derive(Serialize, Deserialize, Debug)]
#[serde(tag = "type")]
/// 软件环境技术
pub enum FacilityKind {
    /// spack
    #[serde(rename_all = "camelCase")]
    Spack {
        /// 软件名称
        name: String,
        /// 安装参数
        argument_list: Vec<String>,
    },
    /// singularity
    #[serde(rename_all = "camelCase")]
    Singularity {
        /// 镜像名
        image: String,
        /// 镜像 tag
        tag: String,
    },
}

impl From<domain_content_repo::model::vo::abilities::common::ValidateRuleEnum> for ValidateRule {
    fn from(value: domain_content_repo::model::vo::abilities::common::ValidateRuleEnum) -> Self {
        match value {
            domain_content_repo::model::vo::abilities::common::ValidateRuleEnum::Regex(s) => {
                Self::Regex(s)
            }
            domain_content_repo::model::vo::abilities::common::ValidateRuleEnum::IsEmpty(b) => {
                Self::IsEmpty(b)
            }
        }
    }
}

impl From<domain_content_repo::model::vo::abilities::common::ValidatedOperation>
    for ValidatedOperation
{
    fn from(value: domain_content_repo::model::vo::abilities::common::ValidatedOperation) -> Self {
        match value {
            domain_content_repo::model::vo::abilities::common::ValidatedOperation::ReportSuccess => Self::ReportSuccess,
            domain_content_repo::model::vo::abilities::common::ValidatedOperation::ReportFailure => Self::ReportFailure,
        }
    }
}

impl From<domain_content_repo::model::vo::abilities::common::OutValidator> for OutValidator {
    fn from(value: domain_content_repo::model::vo::abilities::common::OutValidator) -> Self {
        Self {
            validate_rule: value.validate_rules.into(),
            pass_operation: value.pass_operation.into(),
            failure_operation: value.failure_operation.into(),
        }
    }
}

impl From<domain_content_repo::model::vo::abilities::software_computing::software::SoftwareSpec>
    for FacilityKind
{
    fn from(
        l: domain_content_repo::model::vo::abilities::software_computing::software::SoftwareSpec,
    ) -> Self {
        match l {
            domain_content_repo::model::vo::abilities::software_computing::software::SoftwareSpec::Spack {
                name,
                argument_list,
            } => FacilityKind::Spack {
                name,
                argument_list,
            },
            domain_content_repo::model::vo::abilities::software_computing::software::SoftwareSpec::Singularity {
                image,
                tag,
            } => FacilityKind::Singularity { image, tag },
        }
    }
}

pub mod result {
    use serde::{Deserialize, Serialize};
    use uuid::Uuid;

    /// 任务结果
    #[derive(Serialize, Deserialize)]
    #[serde(rename_all = "camelCase")]
    pub struct TaskResult {
        /// 任务 id
        pub id: Uuid,
        /// 任务结果状态
        pub status: TaskResultStatus,
        /// 输出信息
        pub message: Option<String>,
        /// 资源使用
        pub used_resources: Option<TaskUsedResource>,
    }

    /// 任务执行完的状态
    #[derive(Serialize, Deserialize, Clone)]
    pub enum TaskResultStatus {
        /// 任务暂不能执行，在agent上进入等待队列
        Queued,
        /// 任务开始运行
        Started,
        /// 成功执行
        Completed,
        /// 失败
        Failed,
        /// 暂停
        Paused,
        /// 继续
        Resumed,
        /// 删除
        Cancelled,
    }

    /// 资源使用
    #[derive(Clone, Serialize, Deserialize)]
    #[serde(rename_all = "camelCase")]
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

    impl From<TaskUsedResource> for domain_content_repo::model::vo::command_preview::TaskUsedResource {
        fn from(value: TaskUsedResource) -> Self {
            Self {
                cpu: value.cpu,
                memory: value.avg_memory,
                storage: value.storage,
                wall_time: value.wall_time,
                cpu_time: value.cpu_time,
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn serialize_task() {
        let task = Task {
            id: Uuid::nil(),
            command: TaskCommand::Resume(TaskType::SoftwareDeployment),
        };
        let task_json = serde_json::to_string_pretty(&task).unwrap();
        println!("{task_json}");
        // assert_eq!(
        //     indoc! {r#"
        //         {
        //           "id": "00000000-0000-0000-0000-000000000000",
        //           "command": "Continue",
        //           "type": "SoftwareDeployment"
        //         }"#,
        //     },
        //     task_json
        // )
    }

    #[test]
    fn serialize_task2() {
        let task = Task {
            id: Uuid::nil(),
            command: TaskCommand::Start {
                node_id: Uuid::nil(),
                value: serde_json::to_value(StartTaskBody::UploadFile(UploadFile {
                    file_id: Uuid::nil(),
                    path: String::new(),
                    is_package: false,
                    validator: None,
                    optional: false,
                }))
                .unwrap(),
            },
        };
        let task_json1 = serde_json::to_string_pretty(&task).unwrap();
        println!("{task_json1}");
        // let task_json2 = indoc! {r#"
        //     {
        //       "id": "00000000-0000-0000-0000-000000000000",
        //       "command": "Start",
        //       "body": {
        //         "fileId": "00000000-0000-0000-0000-000000000000",
        //         "isPackage": false,
        //         "optional": false
        //         "path": "",
        //       }
        //       "type": "UploadFile",
        //     }"#};
        // assert_eq!(task_json1, task_json2)
    }
}
