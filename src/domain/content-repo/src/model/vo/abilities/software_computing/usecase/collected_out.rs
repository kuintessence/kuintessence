use crate::model::vo::abilities::common::{Metadata, OutValidator};
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};

/// 用例默认读取和输出的文件列表
#[derive(JsonSchema, Serialize, Deserialize, Debug, Clone)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct CollectedOut {
    /// 收集输出的描述符
    pub descriptor: String,
    /// 从哪里收集
    pub from: CollectFrom,
    /// 收集结果输出种类
    pub to: CollectTo,
    /// 收集规则
    pub collecting: CollectRule,
    /// 验证使用的验证器
    pub validator: Option<OutValidator>,
    /// 提供描述的元数据
    pub metadata: Metadata,
}

/// 收集什么输出
#[derive(JsonSchema, Serialize, Deserialize, Debug, Clone)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub enum CollectFrom {
    #[serde(rename_all = "camelCase")]
    /// 收集文件输出
    FileOut(String),
    /// 收集标准输出
    Stdout,
    /// 收集标准错误输出
    Stderr,
}

/// 收集结果输出种类
#[derive(JsonSchema, Serialize, Deserialize, Debug, Clone)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub enum CollectTo {
    /// 输出为文件
    #[serde(rename_all = "camelCase")]
    File(OutFile),
    /// 输出为文字
    Text,
}

#[derive(JsonSchema, Serialize, Deserialize, Debug, Clone)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub enum OutFile {
    Normal(String),
    Batched(String),
}
impl OutFile {
    pub fn get_path(&self) -> String {
        match self {
            OutFile::Normal(path) => path.to_owned(),
            OutFile::Batched(path) => path.to_owned(),
        }
    }
}
/// 收集规则
#[derive(JsonSchema, Serialize, Deserialize, Debug, Clone)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub enum CollectRule {
    /// 正则匹配
    Regex(String),
    /// 最后几行
    BottomLines(usize),
    /// 前几行
    TopLines(usize),
}
