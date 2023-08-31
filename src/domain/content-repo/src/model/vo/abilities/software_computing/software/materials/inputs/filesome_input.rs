use crate::model::vo::abilities::common::{FileKind, Metadata};
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};

/// 用例默认读取和输出的文件列表
#[derive(JsonSchema, Serialize, Deserialize, Debug, Clone)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct FilesomeInput {
    /// 描述符
    pub descriptor: String,
    /// 文件计算材料类型
    pub file_kind: FileKind,
    /// 文件计算材料提供的必要性，缺省值 false
    #[serde(default)]
    pub optional: bool,
    /// 提供描述的元数据
    #[serde(default)]
    pub metadata: Metadata,
}
