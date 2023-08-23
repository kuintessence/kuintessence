use super::default_value_format;
use crate::models::abilities::common::Metadata;
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};

#[derive(JsonSchema, Serialize, Deserialize, Debug, Clone)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
/// 用例输入参数计算材料
pub struct Environment {
    /// 描述符
    pub descriptor: String,
    /// 环境变量键名
    pub key: String,
    /// 环境变量值的写法例如 "{} {} "，如果占位符有多个，在 inputObj 挂载时使用 descriptor(1)、descriptor(2) 来指定是填充第几个"
    #[serde(default = "default_value_format")]
    pub value_format: String,
    /// 提供描述的元数据
    #[serde(default)]
    pub metadata: Metadata,
}
