use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;

#[derive(JsonSchema, Serialize, Deserialize, Debug, Clone, Default)]
#[serde(rename_all = "camelCase")]
/// 元数据
pub struct Metadata {
    #[serde(flatten, skip_serializing)]
    pub extra: HashMap<String, String>,
}

/// 文件计算材料类型
///
/// (如果用例使用这个作为输出时，没有加通过输入的覆盖，则使用这个名字，如果覆盖了，则采取用例中通过参数或者环境变量等赋予的新的名字)
#[derive(JsonSchema, Serialize, Deserialize, Debug, Clone)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub enum FileKind {
    #[serde(rename_all = "camelCase")]
    /// 单个文件 文件名或者单个文件的 wildcard
    Normal(String),
    /// 批量文件
    #[serde(rename_all = "camelCase")]
    Batched(
        /// 批量文件路径匹配规则 (使用 regex 语法进行匹配)
        String,
    ),
}

#[derive(JsonSchema, Serialize, Deserialize, Debug, Clone)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub enum ContentKind {
    PlainText,
    Json,
    Yaml,
}

#[derive(JsonSchema, Serialize, Deserialize, Debug, Clone)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
/// 输出校验器
pub struct OutValidator {
    /// 校验规则
    pub validate_rules: ValidateRuleEnum,
    /// 校验成功时的操作 (需逻辑检查与 failure_operation 至少有一个)
    #[serde(default = "ValidatedOperation::success")]
    pub pass_operation: ValidatedOperation,
    /// 校验失败时的操作
    #[serde(default = "ValidatedOperation::failure")]
    pub failure_operation: ValidatedOperation,
    /// 提供描述的元数据
    #[serde(default)]
    pub metadata: Metadata,
}

/// 校验规则
#[derive(JsonSchema, Serialize, Deserialize, Debug, Clone)]
#[serde(rename_all = "camelCase")]
pub enum ValidateRuleEnum {
    /// 匹配正则
    Regex(String),
    /// 是否为空
    IsEmpty(bool),
}

/// 验证过后的操作
#[derive(JsonSchema, Serialize, Deserialize, Debug, Clone)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub enum ValidatedOperation {
    /// 报告成功
    ReportSuccess,
    /// 报告失败
    ReportFailure,
}

impl FileKind {
    pub async fn expected_file_name(&self) -> Option<String> {
        match self {
            FileKind::Normal(file_name) => Some(file_name.clone()),
            FileKind::Batched(wildcard) => Some(wildcard.clone()),
        }
    }
    pub async fn is_batch(&self) -> bool {
        match self {
            FileKind::Normal(..) => false,
            FileKind::Batched(..) => true,
        }
    }
}

impl ValidatedOperation {
    pub fn success() -> Self {
        Self::ReportSuccess
    }
    pub fn failure() -> Self {
        Self::ReportFailure
    }
}
