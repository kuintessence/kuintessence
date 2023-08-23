use crate::prelude::*;
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
#[derive(JsonSchema, Serialize, Deserialize, Debug, Clone)]
#[serde(deny_unknown_fields, rename_all = "camelCase", untagged)]
/// 材料 json schema
pub enum MaterialSchema {
    Software(SoftwareMaterial),
    Usecase(Box<UsecaseMaterial>),
}

#[derive(JsonSchema, Serialize, Deserialize, Debug, Clone)]
#[serde(deny_unknown_fields, tag = "kind", content = "spec")]
/// 软件材料
pub enum SoftwareMaterial {
    /// 软件规格
    SoftwareSpec(SoftwareSpec),
    /// 参数输入列表
    ArgumentList(Vec<Argument>),
    /// 环境变量输入列表
    EnvironmentList(Vec<Environment>),
    /// 用例默认读取文件列表
    FilesomeInputList(Vec<FilesomeInput>),
    /// 输出使用文件的列表
    FilesomeOutputList(Vec<FilesomeOutput>),
}

#[derive(JsonSchema, Serialize, Deserialize, Debug, Clone)]
#[serde(deny_unknown_fields, tag = "kind", content = "spec")]
/// 用例材料
pub enum UsecaseMaterial {
    /// 用例规格
    UsecaseSpec(Box<UsecaseSpec>),
    CollectedOutList(Vec<CollectedOut>),
}
#[derive(JsonSchema, Serialize, Deserialize, Debug, Clone)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
/// 所需物理资源
pub struct Requirements {
    /// 核心数
    pub cpu_cores: Option<usize>,
    /// 节点数
    pub node_count: Option<isize>,
    /// 最长等待时间（s）
    pub max_wall_time: Option<usize>,
    /// 最大核时消耗 (s)
    pub max_cpu_time: Option<usize>,
    /// 定时终止 (utc 0 时区 时间戳)
    pub stop_time: Option<usize>,
}
