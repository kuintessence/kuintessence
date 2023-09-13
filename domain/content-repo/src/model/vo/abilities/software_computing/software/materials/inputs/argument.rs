use super::default_value_format;
use crate::model::vo::abilities::common::Metadata;
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};

#[derive(JsonSchema, Serialize, Deserialize, Debug, Clone)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
/// 用例输入参数计算材料
pub struct Argument {
    /// 描述符
    pub descriptor: String,
    /// 该参数的写法，可包括前缀 flag、后缀 flag，以及参数值占位符，例如 "-u {} {} p"，如果占位符有多个，在 inputObj 挂载时使用 descriptor(0)、descriptor(1) 来指定是填充第几个"
    #[serde(default = "default_value_format")]
    pub value_format: String,
    /// 提供描述的元数据
    #[serde(default)]
    pub metadata: Metadata,
}
