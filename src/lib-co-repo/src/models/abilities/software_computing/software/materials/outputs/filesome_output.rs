use crate::models::abilities::common::{FileKind, Metadata};
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};

#[derive(JsonSchema, Serialize, Deserialize, Debug, Clone)]
#[serde(rename_all = "camelCase")]
/// 用例默认读取和输出的文件列表
pub struct FilesomeOutput {
    /// 描述符
    pub descriptor: String,
    /// 文件计算材料类型
    pub file_kind: FileKind,
    /// 提供描述的元数据
    #[serde(default)]
    pub metadata: Metadata,
    #[serde(default)]
    pub optional: bool,
}
